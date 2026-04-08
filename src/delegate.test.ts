import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaEnvironmentDelegate } from "./delegate";
import type { PrismaClientLike } from "./types";

// ---------------------------------------------------------------------------
// Mock PrismaClient — simulates Prisma 7.5+ interactive transactions
// ---------------------------------------------------------------------------

function createMockPrismaClient(): PrismaClientLike & {
  _activeTransaction: boolean;
} {
  const client: PrismaClientLike & { _activeTransaction: boolean } = {
    _activeTransaction: false,
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
    $on: vi.fn(),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: unknown, _options?: unknown) => {
      if (typeof fn === "function") {
        // Simulate interactive transaction — create a "tx client" that
        // also exposes $transaction (like Prisma 7.5+)
        const txClient = createTxClient(client);
        return await (fn as (tx: PrismaClientLike) => Promise<unknown>)(
          txClient,
        );
      }
      // batch — just resolve each promise
      const results: unknown[] = [];
      for (const p of fn as unknown[]) {
        results.push(await p);
      }
      return results;
    }),
  };
  return client;
}

/**
 * Create a mock tx client that simulates Prisma 7.5+ behaviour:
 * - Has $transaction (native nested SAVEPOINTs)
 * - Has $executeRawUnsafe
 * - Has model-like methods (user, post)
 */
function createTxClient(
  _rootClient: PrismaClientLike,
): PrismaClientLike {
  const txClient: PrismaClientLike = {
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
    $on: vi.fn(),
    $executeRawUnsafe: vi.fn(async () => 0),
    // Prisma 7.5+ exposes $transaction on tx clients
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        return await (fn as (tx: PrismaClientLike) => Promise<unknown>)(
          txClient,
        );
      }
      const results: unknown[] = [];
      for (const p of fn as unknown[]) {
        results.push(await p);
      }
      return results;
    }),
  };

  // Simulate model delegates
  Object.defineProperty(txClient, "user", {
    value: { findMany: vi.fn(async () => [{ id: 1 }]) },
    enumerable: true,
  });
  Object.defineProperty(txClient, "post", {
    value: { create: vi.fn(async () => ({ id: 99 })) },
    enumerable: true,
  });

  return txClient;
}

// ---------------------------------------------------------------------------
// Helper: set up delegate + run a "test lifecycle"
// ---------------------------------------------------------------------------

function createDelegate(
  options: Record<string, unknown> = {},
): PrismaEnvironmentDelegate {
  return new PrismaEnvironmentDelegate(
    {
      projectConfig: { testEnvironmentOptions: options as never },
      globalConfig: { rootDir: "" },
    },
    { testPath: "test/example.test.ts" },
  );
}

async function withTestLifecycle(
  delegate: PrismaEnvironmentDelegate,
  fn: () => Promise<void>,
): Promise<void> {
  await delegate.handleTestEvent({
    name: "test_start",
    test: { name: "test", parent: null },
  });
  await delegate.handleTestEvent({
    name: "test_fn_start",
    test: { name: "test", parent: null },
  });
  try {
    await fn();
  } finally {
    await delegate.handleTestEvent({
      name: "test_done",
      test: { name: "test", parent: null },
    });
    await delegate.handleTestEvent({
      name: "test_fn_success",
      test: { name: "test", parent: null },
    });
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("PrismaEnvironmentDelegate", () => {
  let mockClient: ReturnType<typeof createMockPrismaClient>;
  let delegate: PrismaEnvironmentDelegate;
  let jestPrisma: Awaited<ReturnType<typeof delegate.preSetup>>;

  beforeEach(async () => {
    mockClient = createMockPrismaClient();
    delegate = createDelegate();
    jestPrisma = await delegate.preSetup();
    jestPrisma.initializeClient(mockClient);
  });

  describe("proxy $transaction interception", () => {
    it("intercepts $transaction and returns the fake method", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        // $transaction should be the fake, not the original
        expect(client.$transaction).toBeDefined();
        expect(client.$transaction).not.toBe(mockClient.$transaction);
      });
    });

    it("passes through model delegates from txClient", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()! as Record<string, unknown>;
        // model methods should be accessible through the proxy
        expect(client.user).toBeDefined();
        expect(client.post).toBeDefined();
      });
    });

    it("throws on properties that exist on originalClient but not txClient", async () => {
      // Add a property only to the original client
      (mockClient as Record<string, unknown>)._specialProp = "exists";

      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()! as Record<string, unknown>;
        expect(() => client._specialProp).toThrow("Unsupported property");
      });
    });
  });

  describe("interactive (callback) transaction — passthrough", () => {
    it("passes parentTxClient to the callback", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        let receivedClient: unknown;

        await client.$transaction(async (tx) => {
          receivedClient = tx;
          return null;
        });

        // The callback should receive the txClient (parentTxClient), NOT
        // a new nested transaction client
        expect(receivedClient).toBeDefined();
        // Verify it has model methods — proving it's the txClient
        expect(
          (receivedClient as Record<string, unknown>).user,
        ).toBeDefined();
      });
    });

    it("does NOT call parentTxClient.$transaction (no native nesting)", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;

        // Get the txClient that was created inside beginTransaction
        // We can't access it directly, but we can track $transaction calls
        // on the mock. The root client's $transaction is called once for
        // beginTransaction. The txClient's $transaction should NOT be called.
        const rootTxCallsBefore = (
          mockClient.$transaction as ReturnType<typeof vi.fn>
        ).mock.calls.length;

        await client.$transaction(async () => "result");

        const rootTxCallsAfter = (
          mockClient.$transaction as ReturnType<typeof vi.fn>
        ).mock.calls.length;

        // No additional $transaction calls on the root client
        expect(rootTxCallsAfter).toBe(rootTxCallsBefore);
      });
    });

    it("returns the callback result", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        const result = await client.$transaction(async () => ({
          id: 42,
        }));
        expect(result).toEqual({ id: 42 });
      });
    });

    it("propagates callback errors", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        await expect(
          client.$transaction(async () => {
            throw new Error("tx failure");
          }),
        ).rejects.toThrow("tx failure");
      });
    });
  });

  describe("concurrent interactive transactions (the key fix)", () => {
    it("allows concurrent $transaction calls without errors", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;

        // Simulate the pattern:
        //   write UoW starts $transaction
        //     → inside, decorator starts another $transaction concurrently
        const writeResult = await client.$transaction(async (tx) => {
          // Simulate a write
          const writeData = { written: true };

          // Concurrently, the decorator opens a read transaction
          const readResult = await client.$transaction(async (readTx) => {
            // readTx should be the same parentTxClient
            expect(readTx).toBe(tx);
            return { readData: "from-rollo" };
          });

          return { ...writeData, ...readResult };
        });

        expect(writeResult).toEqual({
          written: true,
          readData: "from-rollo",
        });
      });
    });

    it("allows deeply nested concurrent transactions", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;

        const result = await client.$transaction(async () => {
          const a = await client.$transaction(async () => {
            const b = await client.$transaction(async () => "deep");
            return `${b}-nested`;
          });
          return `${a}-done`;
        });

        expect(result).toBe("deep-nested-done");
      });
    });
  });

  describe("batch (array) transaction", () => {
    it("resolves each promise sequentially", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        const results = await client.$transaction([
          Promise.resolve("a"),
          Promise.resolve("b"),
          Promise.resolve("c"),
        ] as never);
        expect(results).toEqual(["a", "b", "c"]);
      });
    });

    it("rejects if any promise fails", async () => {
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        await expect(
          client.$transaction([
            Promise.resolve("ok"),
            Promise.reject(new Error("batch fail")),
          ] as never),
        ).rejects.toThrow("batch fail");
      });
    });
  });

  describe("test lifecycle", () => {
    it("rolls back transaction after test_done (default)", async () => {
      // After endTransaction (reject), the root $transaction should
      // catch the rejection. Verify delegate resets properly by running
      // two consecutive test lifecycles.
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        expect(client).toBeDefined();
      });

      // Second lifecycle should also work
      await withTestLifecycle(delegate, async () => {
        const client = delegate.getClient()!;
        expect(client).toBeDefined();
      });
    });

    it("getClient returns undefined before beginTransaction", () => {
      expect(delegate.getClient()).toBeUndefined();
    });
  });

  describe("enableExperimentalRollbackInTransaction", () => {
    let savepointDelegate: PrismaEnvironmentDelegate;
    let savepointJestPrisma: Awaited<ReturnType<typeof delegate.preSetup>>;

    beforeEach(async () => {
      savepointDelegate = createDelegate({
        enableExperimentalRollbackInTransaction: true,
      });
      savepointJestPrisma = await savepointDelegate.preSetup();
      savepointJestPrisma.initializeClient(mockClient);
    });

    it("creates and releases savepoints for interactive transactions", async () => {
      await withTestLifecycle(savepointDelegate, async () => {
        const client = savepointDelegate.getClient()!;

        // Get reference to the txClient's $executeRawUnsafe
        let txExecuteRaw: ReturnType<typeof vi.fn>;
        await client.$transaction(async (tx) => {
          txExecuteRaw = tx.$executeRawUnsafe as ReturnType<typeof vi.fn>;
          return null;
        });

        const calls = txExecuteRaw!.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(calls).toContain("SAVEPOINT test_1;");
        expect(calls).toContain("RELEASE SAVEPOINT test_1;");
      });
    });

    it("rolls back savepoint on error", async () => {
      await withTestLifecycle(savepointDelegate, async () => {
        const client = savepointDelegate.getClient()!;

        let txExecuteRaw: ReturnType<typeof vi.fn>;
        await client
          .$transaction(async (tx) => {
            txExecuteRaw = tx.$executeRawUnsafe as ReturnType<typeof vi.fn>;
            throw new Error("rollback me");
          })
          .catch(() => {});

        const calls = txExecuteRaw!.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(calls).toContain("SAVEPOINT test_1;");
        expect(calls).toContain("ROLLBACK TO SAVEPOINT test_1;");
        expect(calls).not.toContain("RELEASE SAVEPOINT test_1;");
      });
    });
  });
});
