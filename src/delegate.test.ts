import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaEnvironmentDelegate } from "./delegate";
import type { PrismaClientLike } from "./types";

// ---------------------------------------------------------------------------
// Mock PrismaClient — simulates Prisma 7.5+ with concurrent nesting block
// ---------------------------------------------------------------------------

interface MockPrismaClient extends PrismaClientLike {
  _lastTxClient: PrismaClientLike | null;
}

function createMockPrismaClient(): MockPrismaClient {
  const client: MockPrismaClient = {
    _lastTxClient: null,
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
    $on: vi.fn(),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: unknown, _options?: unknown) => {
      if (typeof fn === "function") {
        const txClient = createPrisma7TxClient();
        client._lastTxClient = txClient;
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
  return client;
}

/**
 * Simulates Prisma 7.5+ tx client: exposes `$transaction` but blocks
 * concurrent nested calls, exactly like Prisma 7.
 */
function createPrisma7TxClient(): PrismaClientLike {
  let hasActiveNestedTx = false;

  const txClient: PrismaClientLike = {
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
    $on: vi.fn(),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: unknown) => {
      if (hasActiveNestedTx) {
        throw new Error(
          "Concurrent nested transactions are not supported",
        );
      }
      hasActiveNestedTx = true;
      try {
        if (typeof fn === "function") {
          return await (fn as (tx: PrismaClientLike) => Promise<unknown>)(
            txClient,
          );
        }
      } finally {
        hasActiveNestedTx = false;
      }
    }),
  };
  return txClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDelegate(): PrismaEnvironmentDelegate {
  return new PrismaEnvironmentDelegate(
    {
      projectConfig: { testEnvironmentOptions: {} as never },
      globalConfig: { rootDir: "" },
    },
    { testPath: "test/example.test.ts" },
  );
}

async function withTestLifecycle(
  delegate: PrismaEnvironmentDelegate,
  fn: () => Promise<void>,
): Promise<void> {
  const test = { name: "test", parent: null };
  await delegate.handleTestEvent({ name: "test_start", test });
  await delegate.handleTestEvent({ name: "test_fn_start", test });
  try {
    await fn();
  } finally {
    await delegate.handleTestEvent({ name: "test_done", test });
    await delegate.handleTestEvent({ name: "test_fn_success", test });
  }
}

// ===========================================================================
// Tests — concurrent nested transactions (the epic fix)
//
// Prisma 7 blocks concurrent nested $transaction() on the same client.
// jest-prisma wraps each test in a transaction, so all app $transaction()
// calls become nested. The RolloCategoryRepositoryDecorator pattern —
// write UoW calling a read UoW concurrently — triggers this.
//
// The fix: never delegate to txClient.$transaction(); always pass
// parentTxClient directly (passthrough).
// ===========================================================================

describe("concurrent nested transactions (epic fix)", () => {
  let mockClient: MockPrismaClient;
  let delegate: PrismaEnvironmentDelegate;

  beforeEach(async () => {
    mockClient = createMockPrismaClient();
    delegate = createDelegate();
    const jestPrisma = await delegate.preSetup();
    jestPrisma.initializeClient(mockClient);
  });

  it("mock txClient blocks concurrent nested calls (Prisma 7 behaviour)", async () => {
    // Prove the mock is realistic: calling txClient.$transaction
    // concurrently throws, just like Prisma 7 would.
    await withTestLifecycle(delegate, async () => {
      const txClient = mockClient._lastTxClient!;

      await expect(
        txClient.$transaction(async () => {
          return await txClient.$transaction(async () => "inner");
        }),
      ).rejects.toThrow(
        "Concurrent nested transactions are not supported",
      );
    });
  });

  it("proxy bypasses txClient.$transaction — no native nesting", async () => {
    await withTestLifecycle(delegate, async () => {
      const proxy = delegate.getClient()!;

      await proxy.$transaction(async () => {
        await proxy.$transaction(async () => "read-uow");
        return "write-uow";
      });

      expect(mockClient._lastTxClient!.$transaction).not.toHaveBeenCalled();
    });
  });

  it("write UoW + concurrent read UoW succeeds (the epic pattern)", async () => {
    await withTestLifecycle(delegate, async () => {
      const proxy = delegate.getClient()!;

      const result = await proxy.$transaction(async (writeTx) => {
        const writeData = { written: true };

        // RolloCategoryRepositoryDecorator opens a read UoW concurrently
        const readResult = await proxy.$transaction(async (readTx) => {
          // Both receive the same parentTxClient (passthrough)
          expect(readTx).toBe(writeTx);
          return { readData: "from-rollo" };
        });

        return { ...writeData, ...readResult };
      });

      expect(result).toEqual({ written: true, readData: "from-rollo" });
      expect(mockClient._lastTxClient!.$transaction).not.toHaveBeenCalled();
    });
  });
});
