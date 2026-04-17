import { signal, type Signal } from "@deijose/nix-js";

export type QueryStatus = "pending" | "success" | "error";

export interface QueryResult<T> {
    readonly status: Signal<QueryStatus>;
    readonly data: Signal<T | undefined>;
    readonly error: Signal<unknown>;
    refetch(): void;
}

export interface QueryOptions {
    /**
     * Time in ms that cached data is considered fresh.
     * While fresh, mounting will not trigger a background refetch.
     * @default 0
     */
    staleTime?: number;
    /**
     * - "always" — background refetch on every mount (default).
     * - "stale"  — refetch only when data has exceeded `staleTime`.
     * - `false`   — never refetch on mount; only via `refetch()` or `invalidateQueries()`.
     * @default "always"
     */
    refetchOnMount?: "always" | "stale" | false;
}

interface CacheEntry<T = unknown> {
    data?: T;
    fetchedAt: number;
    subscribers: number;
}

type QuerySyncHandler = () => void;

const _queryCache = new Map<string, CacheEntry>();

const DEFAULT_CACHE_TIME = 5 * 60 * 1000;
let _gcTimer: ReturnType<typeof setInterval> | null = null;
let _cacheTime = DEFAULT_CACHE_TIME;

function _startGC(): void {
    if (_gcTimer !== null) return;
    _gcTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of _queryCache) {
            if (entry.subscribers <= 0 && now - entry.fetchedAt > _cacheTime) {
                _queryCache.delete(key);
            }
        }
        if (_queryCache.size === 0 && _gcTimer !== null) {
            clearInterval(_gcTimer);
            _gcTimer = null;
        }
    }, 60_000);
}

function _getCacheEntry<T>(key: string): CacheEntry<T> | undefined {
    const entry = _queryCache.get(key);
    if (entry && entry.fetchedAt > 0) return entry as CacheEntry<T>;
    return undefined;
}

function _setCacheEntry<T>(key: string, data: T): void {
    const existing = _queryCache.get(key);
    _queryCache.set(key, {
        data,
        fetchedAt: Date.now(),
        subscribers: existing?.subscribers ?? 0,
    });
    _startGC();
}

function _isFresh(key: string, staleTime: number): boolean {
    const entry = _queryCache.get(key);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < staleTime;
}

const _queryRegistry = new Map<string, Set<() => void>>();
const _querySyncRegistry = new Map<string, Set<QuerySyncHandler>>();

const _queryLifecycleCleanup = new FinalizationRegistry<{
    key: string;
    run: () => void;
    sync: QuerySyncHandler;
}>(({ key, run, sync }) => {
    const handlers = _queryRegistry.get(key);
    if (handlers) {
        handlers.delete(run);
        if (handlers.size === 0) _queryRegistry.delete(key);
    }

    const syncHandlers = _querySyncRegistry.get(key);
    if (syncHandlers) {
        syncHandlers.delete(sync);
        if (syncHandlers.size === 0) _querySyncRegistry.delete(key);
    }
});

function _notifyQuerySync(key: string): void {
    const handlers = _querySyncRegistry.get(key);
    if (!handlers) return;
    for (const fn of handlers) {
        fn();
    }
}

/**
 * Clears one or all entries from the global query cache.
 * Passing no argument clears everything.
 */
export function clearQueryCache(key?: string): void {
    if (key !== undefined) {
        _queryCache.delete(key);
        _notifyQuerySync(key);
    } else {
        const keys = Array.from(_queryCache.keys());
        _queryCache.clear();
        for (const k of keys) _notifyQuerySync(k);
        if (_gcTimer !== null) {
            clearInterval(_gcTimer);
            _gcTimer = null;
        }
    }
}

/**
 * Sets how long cache entries with zero subscribers are kept alive.
 * @param ms Milliseconds. Pass `Infinity` to keep entries forever.
 */
export function setQueryCacheTime(ms: number): void {
    _cacheTime = ms;
}

/**
 * Reads the current cached data for a key (if present).
 */
export function getQueryData<T>(key: string): T | undefined {
    const entry = _getCacheEntry<T>(key);
    return entry?.data;
}

/**
 * Writes data directly into query cache and updates active query signals.
 */
export function setQueryData<T>(key: string, data: T): void {
    _setCacheEntry(key, data);
    _notifyQuerySync(key);
}

/**
 * Atomically updates cached data from previous value and updates active query signals.
 */
export function updateQueryData<T>(
    key: string,
    updater: (current: T | undefined) => T
): T {
    const next = updater(getQueryData<T>(key));
    setQueryData(key, next);
    return next;
}

/**
 * Forces all active `createQuery()` instances with the given key to re-fetch.
 * Clears the cached data so subsequent mounts also fetch fresh data.
 * Instances that have been garbage-collected are pruned automatically.
 */
export function invalidateQueries(key: string): void {
    _queryCache.delete(key);
    _notifyQuerySync(key);
    const handlers = _queryRegistry.get(key);
    if (!handlers) return;
    for (const run of handlers) run();
}

/**
 * Key-based async data fetching with global cache and invalidation.
 * Returns reactive signals for pending/success/error flows.
 */
export function createQuery<T>(
    key: string,
    asyncFn: () => Promise<T>,
    options: QueryOptions = {}
): QueryResult<T> {
    const { staleTime = 0, refetchOnMount = "always" } = options;

    const cached = _getCacheEntry<T>(key);
    const status = signal<QueryStatus>(cached ? "success" : "pending");
    const data = signal<T | undefined>(cached?.data);
    const error = signal<unknown>(undefined);

    const _fetch = (): void => {
        asyncFn().then(
            (result) => {
                _setCacheEntry(key, result);
                data.value = result;
                error.value = undefined;
                status.value = "success";
            },
            (err) => {
                error.value = err;
                status.value = "error";
            }
        );
    };

    const _run = (): void => {
        if (status.peek() === "pending") {
            data.value = undefined;
            error.value = undefined;
        }
        _fetch();
    };

    if (!_queryRegistry.has(key)) _queryRegistry.set(key, new Set());
    const handlers = _queryRegistry.get(key)!;
    handlers.add(_run);

    const _syncFromCache: QuerySyncHandler = () => {
        const next = _getCacheEntry<T>(key);
        if (next && next.data !== undefined) {
            status.value = "success";
            data.value = next.data;
            error.value = undefined;
            return;
        }
        status.value = "pending";
        error.value = undefined;
        data.value = undefined;
    };

    if (!_querySyncRegistry.has(key)) _querySyncRegistry.set(key, new Set());
    const syncHandlers = _querySyncRegistry.get(key)!;
    syncHandlers.add(_syncFromCache);

    _queryLifecycleCleanup.register(status as object, { key, run: _run, sync: _syncFromCache });

    const fresh = _isFresh(key, staleTime);
    if (!cached) {
        _run();
    } else if (refetchOnMount === false) {
        // skip
    } else if (refetchOnMount === "stale" && fresh) {
        // skip
    } else if (refetchOnMount === "always" && fresh && staleTime > 0) {
        // skip
    } else {
        _fetch();
    }

    return {
        status,
        data,
        error,
        refetch: () => {
            _queryCache.delete(key);
            _run();
        },
    };
}
