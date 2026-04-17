import { describe, it, expect } from "vitest";
import { CommandQueuedError, createCommand, createQuery, getQueryData, setQueryData, type CommandQueueAdapter } from "../index";

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryAdapter<T>(): CommandQueueAdapter<T> {
    let items: Array<{
        id: string;
        commandKey: string;
        variables: T;
        attempts: number;
        createdAt: number;
        lastError?: string;
    }> = [];

    return {
        enqueue(entry) {
            items.push(entry);
        },
        list(commandKey) {
            return commandKey ? items.filter((i) => i.commandKey === commandKey) : [...items];
        },
        update(entry) {
            items = items.map((i) => (i.id === entry.id ? entry : i));
        },
        remove(id) {
            items = items.filter((i) => i.id !== id);
        },
    };
}

describe("createCommand", () => {
    it("updates status/data on success", async () => {
        const cmd = createCommand("profile/save", async (input: { name: string }) => {
            await wait(5);
            return { ok: true, name: input.name };
        });

        const result = await cmd.executeAsync({ name: "Deiver" });

        expect(result.ok).toBe(true);
        expect(cmd.status.value).toBe("success");
        expect(cmd.data.value?.name).toBe("Deiver");
        expect(cmd.error.value).toBeUndefined();
        expect(cmd.variables.value?.name).toBe("Deiver");
    });

    it("supports retry with dynamic policy", async () => {
        let attempts = 0;

        const cmd = createCommand(
            "events/sync",
            async () => {
                attempts += 1;
                if (attempts < 3) {
                    const err = new Error("temporary") as Error & { status?: number };
                    err.status = 503;
                    throw err;
                }
                return "ok";
            },
            {
                retry: (failureCount, error) => {
                    const status = (error as { status?: number })?.status;
                    return status !== undefined && status >= 500 && failureCount < 3;
                },
                retryDelay: 0,
            }
        );

        await expect(cmd.executeAsync(undefined)).resolves.toBe("ok");
        expect(attempts).toBe(3);
        expect(cmd.failureCount.value).toBe(0);
    });

    it("dedupes rapid duplicate mutations", async () => {
        let calls = 0;

        const cmd = createCommand(
            "profile/save",
            async (input: { name: string }) => {
                calls += 1;
                await wait(10);
                return input.name;
            },
            { dedupeWindowMs: 100 }
        );

        const p1 = cmd.executeAsync({ name: "A" });
        const p2 = cmd.executeAsync({ name: "B" });

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(calls).toBe(1);
        expect(r1).toBe("A");
        expect(r2).toBe("A");
    });

    it("mode latest cancels previous in-flight command", async () => {
        const cmd = createCommand(
            "members/save",
            async (value: number, { signal }) => {
                return new Promise<number>((resolve, reject) => {
                    const t = setTimeout(() => resolve(value), 25);
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(t);
                            const err = new Error("aborted") as Error & { name?: string };
                            err.name = "AbortError";
                            reject(err);
                        },
                        { once: true }
                    );
                });
            },
            { mode: "latest" }
        );

        const first = cmd.executeAsync(1);
        await wait(5);
        const second = cmd.executeAsync(2);

        await expect(first).rejects.toMatchObject({ name: "AbortError" });
        await expect(second).resolves.toBe(2);
        expect(cmd.data.value).toBe(2);
    });

    it("mode queue + serializeByKey runs commands sequentially across instances", async () => {
        let running = 0;
        let maxRunning = 0;

        const execute = async (value: number): Promise<number> => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await wait(10);
            running -= 1;
            return value;
        };

        const c1 = createCommand("events/create", execute, { mode: "queue", serializeByKey: true });
        const c2 = createCommand("events/create", execute, { mode: "queue", serializeByKey: true });

        const [a, b] = await Promise.all([c1.executeAsync(1), c2.executeAsync(2)]);
        expect([a, b]).toEqual([1, 2]);
        expect(maxRunning).toBe(1);
    });

    it("invalidates related queries after successful command", async () => {
        let queryFetches = 0;

        const q = createQuery(
            "events/list",
            async () => {
                queryFetches += 1;
                return queryFetches;
            },
            { refetchOnMount: false }
        );

        await Promise.resolve();
        expect(q.data.value).toBe(1);

        const cmd = createCommand(
            "events/create",
            async () => "ok",
            { invalidate: ["events/list"] }
        );

        await cmd.executeAsync(undefined);
        await wait(0);

        expect(queryFetches).toBe(2);
    });

    it("supports explicit optimistic rollback via onMutate context", async () => {
        type Item = { id: number; title: string };

        createQuery(
            "items/list",
            async () => [{ id: 1, title: "A" }] as Item[],
            { refetchOnMount: false }
        );

        await Promise.resolve();
        expect(getQueryData<Item[]>("items/list")?.length).toBe(1);

        const cmd = createCommand(
            "items/create",
            async (_input: Item) => {
                await wait(5);
                throw new Error("failed");
            },
            {
                onMutate: (input) => {
                    const previous = getQueryData<Item[]>("items/list") ?? [];
                    setQueryData<Item[]>("items/list", [...previous, input]);
                    return { previous };
                },
                onError: (_error, _variables, context) => {
                    setQueryData<Item[]>("items/list", context?.previous ?? []);
                },
            }
        );

        const p = cmd.executeAsync({ id: 2, title: "B" });

        // optimistic data applied immediately
        expect(getQueryData<Item[]>("items/list")?.length).toBe(2);

        await expect(p).rejects.toThrow("failed");

        // explicit rollback restored previous snapshot
        expect(getQueryData<Item[]>("items/list")?.length).toBe(1);
        expect(getQueryData<Item[]>("items/list")?.[0]?.title).toBe("A");
    });

    it("queueOffline enqueues commands through adapter when offline", async () => {
        const adapter = createMemoryAdapter<{ id: number }>();
        let online = false;

        const cmd = createCommand(
            "orders/create",
            async (payload: { id: number }) => payload.id,
            {
                mode: "queueOffline",
                offline: {
                    adapter,
                    replayOnReconnect: false,
                    isOnline: () => online,
                },
            }
        );

        await expect(cmd.executeAsync({ id: 1 })).rejects.toBeInstanceOf(CommandQueuedError);
        expect(cmd.status.value).toBe("queued");
        expect(cmd.queuedCount.value).toBe(1);

        const queued = await adapter.list("orders/create");
        expect(queued.length).toBe(1);
        expect(queued[0]?.variables.id).toBe(1);
    });

    it("queueOffline replays queued commands when online again", async () => {
        const adapter = createMemoryAdapter<{ id: number }>();
        let online = false;
        let executed = 0;

        const cmd = createCommand(
            "orders/create",
            async (payload: { id: number }) => {
                executed += 1;
                return payload.id;
            },
            {
                mode: "queueOffline",
                offline: {
                    adapter,
                    replayOnReconnect: false,
                    isOnline: () => online,
                },
            }
        );

        await expect(cmd.executeAsync({ id: 10 })).rejects.toBeInstanceOf(CommandQueuedError);
        expect(executed).toBe(0);

        online = true;
        await cmd.replayQueue();

        expect(executed).toBe(1);
        expect(cmd.queuedCount.value).toBe(0);
        expect((await adapter.list("orders/create")).length).toBe(0);
    });
});
