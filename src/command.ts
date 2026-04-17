import { computed, signal, type Signal } from "@deijose/nix-js";
import { invalidateQueries } from "./query";

export type CommandStatus = "idle" | "pending" | "success" | "error" | "queued";
export type CommandMode = "latest" | "queue" | "parallel" | "queueOffline";

export interface CommandContext {
    signal: AbortSignal;
    commandKey: string;
}

export type RetryPolicy = number | ((failureCount: number, error: unknown) => boolean);
export type RetryDelayPolicy = number | ((failureCount: number, error: unknown) => number);

export interface OfflineCommandEntry<TVariables> {
    id: string;
    commandKey: string;
    variables: TVariables;
    attempts: number;
    createdAt: number;
    lastError?: string;
}

/**
 * Adapter contract for offline command queues.
 *
 * Users can provide any persistence strategy (memory, localStorage,
 * IndexedDB, Capacitor Preferences/SQLite, etc.) by implementing this API.
 */
export interface CommandQueueAdapter<TVariables> {
    enqueue(entry: OfflineCommandEntry<TVariables>): Promise<void> | void;
    list(commandKey?: string): Promise<OfflineCommandEntry<TVariables>[]> | OfflineCommandEntry<TVariables>[];
    update(entry: OfflineCommandEntry<TVariables>): Promise<void> | void;
    remove(id: string): Promise<void> | void;
}

export interface OfflineQueueOptions<TVariables, TResult> {
    adapter: CommandQueueAdapter<TVariables>;
    isOnline?: () => boolean | Promise<boolean>;
    replayOnReconnect?: boolean;
    maxReplayAttempts?: number;
    shouldEnqueue?: (error: unknown, variables: TVariables) => boolean;
    onEnqueue?: (entry: OfflineCommandEntry<TVariables>) => void | Promise<void>;
    onReplaySuccess?: (data: TResult, entry: OfflineCommandEntry<TVariables>) => void | Promise<void>;
    onReplayError?: (error: unknown, entry: OfflineCommandEntry<TVariables>) => void | Promise<void>;
}

export interface CommandOptions<TVariables, TResult, TContext = unknown> {
    mode?: CommandMode;
    dedupeWindowMs?: number;
    retry?: RetryPolicy;
    retryDelay?: RetryDelayPolicy;
    serializeByKey?: boolean;
    invalidate?: string[] | ((data: TResult, variables: TVariables) => string[]);
    onMutate?: (variables: TVariables) => TContext | Promise<TContext>;
    onSuccess?: (data: TResult, variables: TVariables, context: TContext | undefined) => void | Promise<void>;
    onError?: (error: unknown, variables: TVariables, context: TContext | undefined) => void | Promise<void>;
    onSettled?: (
        data: TResult | undefined,
        error: unknown | undefined,
        variables: TVariables,
        context: TContext | undefined
    ) => void | Promise<void>;
    /**
     * Experimental v1.3 queue-offline options.
     */
    offline?: OfflineQueueOptions<TVariables, TResult>;
}

export interface CommandResult<TVariables, TResult> {
    readonly status: Signal<CommandStatus>;
    readonly data: Signal<TResult | undefined>;
    readonly error: Signal<unknown>;
    readonly variables: Signal<TVariables | undefined>;
    readonly failureCount: Signal<number>;
    readonly inFlight: Signal<number>;
    readonly queuedCount: Signal<number>;
    readonly isIdle: Signal<boolean>;
    readonly isPending: Signal<boolean>;
    readonly isSuccess: Signal<boolean>;
    readonly isError: Signal<boolean>;
    readonly isQueued: Signal<boolean>;
    execute(variables: TVariables): void;
    executeAsync(variables: TVariables): Promise<TResult>;
    reset(): void;
    cancel(): void;
    replayQueue(): Promise<void>;
    clearQueue(): Promise<void>;
}

export class CommandQueuedError<TVariables = unknown> extends Error {
    readonly entry: OfflineCommandEntry<TVariables>;
    readonly code = "COMMAND_QUEUED_OFFLINE";

    constructor(entry: OfflineCommandEntry<TVariables>) {
        super(`Command queued offline: ${entry.commandKey}`);
        this.name = "CommandQueuedError";
        this.entry = entry;
    }
}

const _globalCommandQueues = new Map<string, Promise<unknown>>();
const _globalLatestControllers = new Map<string, AbortController>();
const _globalReplayLocks = new Set<string>();

function _isAbortError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const withName = err as { name?: string; cause?: { name?: string } };
    return withName.name === "AbortError" || withName.cause?.name === "AbortError";
}

function _abortError(): Error {
    try {
        return new DOMException("Aborted", "AbortError") as unknown as Error;
    } catch {
        const err = new Error("Aborted") as Error & { name: string };
        err.name = "AbortError";
        return err;
    }
}

function _computeRetryDelay(
    policy: RetryDelayPolicy | undefined,
    failureCount: number,
    error: unknown
): number {
    if (typeof policy === "function") {
        return Math.max(0, policy(failureCount, error));
    }
    if (typeof policy === "number") {
        return Math.max(0, policy);
    }
    return Math.min(1000 * 2 ** Math.max(0, failureCount - 1), 30_000);
}

function _shouldRetry(policy: RetryPolicy | undefined, failureCount: number, error: unknown): boolean {
    if (typeof policy === "function") {
        return policy(failureCount, error);
    }
    if (typeof policy === "number") {
        return failureCount <= Math.max(0, policy);
    }
    return false;
}

function _sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(_abortError());
            return;
        }
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(t);
                reject(_abortError());
            },
            { once: true }
        );
    });
}

function _defaultIsOnline(): boolean {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
        return navigator.onLine;
    }
    return true;
}

function _toErrorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

export function createCommand<TVariables, TResult, TContext = unknown>(
    commandKey: string,
    executeFn: (variables: TVariables, context: CommandContext) => Promise<TResult>,
    options: CommandOptions<TVariables, TResult, TContext> = {}
): CommandResult<TVariables, TResult> {
    const {
        mode = "latest",
        dedupeWindowMs = 0,
        retry,
        retryDelay,
        serializeByKey = true,
        invalidate,
        onMutate,
        onSuccess,
        onError,
        onSettled,
        offline,
    } = options;

    if (mode === "queueOffline" && !offline?.adapter) {
        throw new Error("createCommand(queueOffline): options.offline.adapter is required.");
    }

    const status = signal<CommandStatus>("idle");
    const data = signal<TResult | undefined>(undefined);
    const error = signal<unknown>(undefined);
    const variables = signal<TVariables | undefined>(undefined);
    const failureCount = signal(0);
    const inFlight = signal(0);
    const queuedCount = signal(0);

    const isIdle = computed(() => status.value === "idle");
    const isPending = computed(() => status.value === "pending");
    const isSuccess = computed(() => status.value === "success");
    const isError = computed(() => status.value === "error");
    const isQueued = computed(() => status.value === "queued");

    let _lastInvokeAt = 0;
    let _lastPromise: Promise<TResult> | null = null;
    let _latestToken = 0;
    let _localQueue = Promise.resolve() as Promise<unknown>;
    const _controllers = new Set<AbortController>();

    const _incInFlight = () => {
        inFlight.update((n) => n + 1);
        status.value = "pending";
    };

    const _decInFlight = (): number => {
        let next = 0;
        inFlight.update((n) => {
            next = Math.max(0, n - 1);
            return next;
        });
        return next;
    };

    const _isOnline = async (): Promise<boolean> => {
        if (!offline?.isOnline) return _defaultIsOnline();
        return await offline.isOnline();
    };

    const _loadQueuedCount = async (): Promise<void> => {
        if (!offline?.adapter) return;
        const items = await offline.adapter.list(commandKey);
        queuedCount.value = items.length;
    };

    const _enqueueOffline = async (runVariables: TVariables): Promise<OfflineCommandEntry<TVariables>> => {
        if (!offline?.adapter) {
            throw new Error("No offline adapter configured.");
        }

        const entry: OfflineCommandEntry<TVariables> = {
            id: `${commandKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            commandKey,
            variables: runVariables,
            attempts: 0,
            createdAt: Date.now(),
        };

        await offline.adapter.enqueue(entry);
        await _loadQueuedCount();
        variables.value = runVariables;
        error.value = undefined;
        status.value = "queued";

        if (offline.onEnqueue) {
            await offline.onEnqueue(entry);
        }

        return entry;
    };

    const _executeWithRetry = async (
        runVariables: TVariables,
        controller: AbortController,
        token: number
    ): Promise<TResult> => {
        let failures = 0;

        while (true) {
            if (controller.signal.aborted) throw _abortError();

            try {
                const result = await executeFn(runVariables, {
                    signal: controller.signal,
                    commandKey,
                });

                if (mode === "latest" && token !== _latestToken) {
                    throw _abortError();
                }

                return result;
            } catch (err) {
                if (controller.signal.aborted || _isAbortError(err)) {
                    throw err;
                }

                failures += 1;
                failureCount.value = failures;

                const shouldRetry = _shouldRetry(retry, failures, err);
                if (!shouldRetry) {
                    if (mode === "queueOffline" && offline?.shouldEnqueue?.(err, runVariables)) {
                        const entry = await _enqueueOffline(runVariables);
                        throw new CommandQueuedError({
                            ...entry,
                            attempts: failures,
                            lastError: _toErrorText(err),
                        });
                    }
                    throw err;
                }

                const delayMs = _computeRetryDelay(retryDelay, failures, err);
                if (delayMs > 0) {
                    await _sleep(delayMs, controller.signal);
                }
            }
        }
    };

    const _run = async (runVariables: TVariables, token: number): Promise<TResult> => {
        const controller = new AbortController();
        let commandContext: TContext | undefined = undefined;

        if (mode === "latest") {
            if (serializeByKey) {
                const active = _globalLatestControllers.get(commandKey);
                if (active) active.abort();
                _globalLatestControllers.set(commandKey, controller);
            } else {
                for (const c of _controllers) c.abort();
            }
        }

        _controllers.add(controller);
        _incInFlight();
        variables.value = runVariables;
        error.value = undefined;

        let settled: CommandStatus = "idle";

        try {
            if (onMutate) {
                commandContext = await onMutate(runVariables);
            }

            const result = await _executeWithRetry(runVariables, controller, token);
            data.value = result;
            error.value = undefined;
            failureCount.value = 0;
            settled = "success";

            if (onSuccess) {
                await onSuccess(result, runVariables, commandContext);
            }

            if (invalidate) {
                const keys = typeof invalidate === "function" ? invalidate(result, runVariables) : invalidate;
                for (const key of keys) {
                    invalidateQueries(key);
                }
            }

            if (onSettled) {
                await onSettled(result, undefined, runVariables, commandContext);
            }

            return result;
        } catch (err) {
            if (!_isAbortError(err) && !(err instanceof CommandQueuedError)) {
                error.value = err;
                settled = "error";

                if (onError) {
                    await onError(err, runVariables, commandContext);
                }

                if (onSettled) {
                    await onSettled(undefined, err, runVariables, commandContext);
                }
            }

            if (err instanceof CommandQueuedError) {
                settled = "queued";
                if (onSettled) {
                    await onSettled(undefined, err, runVariables, commandContext);
                }
            }

            throw err;
        } finally {
            _controllers.delete(controller);

            if (mode === "latest" && serializeByKey) {
                const active = _globalLatestControllers.get(commandKey);
                if (active === controller) {
                    _globalLatestControllers.delete(commandKey);
                }
            }

            const remaining = _decInFlight();
            if (remaining === 0) {
                status.value = settled;
            }
        }
    };

    const _runByMode = (runVariables: TVariables): Promise<TResult> => {
        const token = mode === "latest" ? ++_latestToken : 0;

        if (mode === "parallel") {
            return _run(runVariables, token);
        }

        if (mode === "queue" || mode === "queueOffline") {
            if (serializeByKey) {
                const prev = _globalCommandQueues.get(commandKey) ?? Promise.resolve();
                const next = prev.catch(() => undefined).then(() => _run(runVariables, token));
                _globalCommandQueues.set(commandKey, next);
                next.finally(() => {
                    const current = _globalCommandQueues.get(commandKey);
                    if (current === next) {
                        _globalCommandQueues.delete(commandKey);
                    }
                });
                return next as Promise<TResult>;
            }

            _localQueue = _localQueue.catch(() => undefined).then(() => _run(runVariables, token));
            return _localQueue as Promise<TResult>;
        }

        return _run(runVariables, token);
    };

    const replayQueue = async (): Promise<void> => {
        if (mode !== "queueOffline" || !offline?.adapter) return;
        if (_globalReplayLocks.has(commandKey)) return;

        _globalReplayLocks.add(commandKey);
        try {
            const online = await _isOnline();
            if (!online) return;

            let items = await offline.adapter.list(commandKey);
            items = [...items].sort((a, b) => a.createdAt - b.createdAt);
            queuedCount.value = items.length;

            for (const entry of items) {
                if (
                    typeof offline.maxReplayAttempts === "number" &&
                    offline.maxReplayAttempts > 0 &&
                    entry.attempts >= offline.maxReplayAttempts
                ) {
                    continue;
                }

                try {
                    const result = await _runByMode(entry.variables);
                    await offline.adapter.remove(entry.id);
                    if (offline.onReplaySuccess) {
                        await offline.onReplaySuccess(result, entry);
                    }
                } catch (err) {
                    const updated: OfflineCommandEntry<TVariables> = {
                        ...entry,
                        attempts: entry.attempts + 1,
                        lastError: _toErrorText(err),
                    };
                    await offline.adapter.update(updated);
                    if (offline.onReplayError) {
                        await offline.onReplayError(err, updated);
                    }
                    // Preserve command ordering in queue on failure.
                    break;
                }
            }

            await _loadQueuedCount();
            if (queuedCount.value === 0 && inFlight.value === 0 && status.value === "queued") {
                status.value = "idle";
            }
        } finally {
            _globalReplayLocks.delete(commandKey);
        }
    };

    const clearQueue = async (): Promise<void> => {
        if (mode !== "queueOffline" || !offline?.adapter) return;
        const entries = await offline.adapter.list(commandKey);
        for (const entry of entries) {
            await offline.adapter.remove(entry.id);
        }
        queuedCount.value = 0;
        if (status.value === "queued" && inFlight.value === 0) {
            status.value = "idle";
        }
    };

    const executeAsync = async (runVariables: TVariables): Promise<TResult> => {
        const now = Date.now();
        if (_lastPromise && dedupeWindowMs > 0 && now - _lastInvokeAt <= dedupeWindowMs) {
            return _lastPromise;
        }

        const promise = (async () => {
            if (mode === "queueOffline") {
                const online = await _isOnline();
                if (!online) {
                    const entry = await _enqueueOffline(runVariables);
                    throw new CommandQueuedError(entry);
                }
            }
            return _runByMode(runVariables);
        })();

        _lastInvokeAt = now;
        _lastPromise = promise;
        return promise;
    };

    const execute = (runVariables: TVariables): void => {
        void executeAsync(runVariables).catch(() => {
            // execute is fire-and-forget; state signals carry errors.
        });
    };

    const reset = (): void => {
        status.value = queuedCount.value > 0 ? "queued" : "idle";
        data.value = undefined;
        error.value = undefined;
        variables.value = undefined;
        failureCount.value = 0;
    };

    const cancel = (): void => {
        for (const controller of _controllers) {
            controller.abort();
        }
    };

    void _loadQueuedCount();

    if (mode === "queueOffline" && offline?.replayOnReconnect !== false) {
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("online", () => {
                void replayQueue();
            });
        }
    }

    return {
        status,
        data,
        error,
        variables,
        failureCount,
        inFlight,
        queuedCount,
        isIdle,
        isPending,
        isSuccess,
        isError,
        isQueued,
        execute,
        executeAsync,
        reset,
        cancel,
        replayQueue,
        clearQueue,
    };
}
