/**
 * @coten-inc/vitest-prisma-core
 *
 * Forked from @quramy/jest-prisma-core v1.8.2 (MIT License)
 * Original author: Quramy <https://github.com/Quramy/jest-prisma>
 *
 * Key change from upstream:
 *   Removed native `parentTxClient.$transaction(arg)` delegation for
 *   interactive (callback) transactions.  Instead, the callback always
 *   receives `parentTxClient` directly (passthrough).
 *
 *   This avoids Prisma 7's "Concurrent nested transactions are not
 *   supported" error that occurs when application code opens multiple
 *   `$transaction()` calls concurrently inside a single test — e.g.
 *   a write UoW whose callback triggers a separate read UoW.
 *
 *   The trade-off is that nested transaction rollback semantics are not
 *   preserved (inner "transactions" share the outer connection), which
 *   matches the pre-Prisma-7 test behaviour.
 */

import type {
  JestPrisma,
  JestPrismaEnvironmentOptions,
  PrismaClientLike,
} from "./types";

// ---------------------------------------------------------------------------
// Minimal config types — replaces @jest/types & @jest/environment
// ---------------------------------------------------------------------------

export interface DelegateConfig {
  projectConfig: {
    testEnvironmentOptions: JestPrismaEnvironmentOptions;
  };
  globalConfig: {
    rootDir: string;
  };
}

export interface DelegateContext {
  testPath: string;
}

// ---------------------------------------------------------------------------
// Test event types (subset of Circus.Event used by vitest adapters)
// ---------------------------------------------------------------------------

interface TestBlock {
  name: string;
  parent: TestBlock | null;
}

export type TestEvent =
  | { name: "test_start"; test: TestBlock }
  | { name: "test_done"; test: TestBlock }
  | { name: "test_skip"; test: TestBlock }
  | { name: "test_todo"; test: TestBlock }
  | { name: "test_fn_start"; test: TestBlock }
  | { name: "test_fn_success"; test: TestBlock }
  | { name: "test_fn_failure"; test: TestBlock };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_WAIT = 5_000;
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_ISOLATION_LEVEL = undefined; // use database default

// ---------------------------------------------------------------------------
// PrismaEnvironmentDelegate
// ---------------------------------------------------------------------------

export class PrismaEnvironmentDelegate {
  private _originalClient: PrismaClientLike | undefined;
  private prismaClientProxy: PrismaClientLike | undefined;
  private connected = false;
  private triggerTransactionEnd: () => void = () => null;
  private readonly options: JestPrismaEnvironmentOptions;
  private readonly testPath: string;
  private logBuffer: Array<{ query: string; params: string }> | undefined;

  getClient(): PrismaClientLike | undefined {
    return this.prismaClientProxy;
  }

  constructor(config: DelegateConfig, context: DelegateContext) {
    this.options = config.projectConfig.testEnvironmentOptions;
    this.testPath = context.testPath
      .replace(config.globalConfig.rootDir, "")
      .slice(1);
  }

  async preSetup<T = PrismaClientLike>(): Promise<JestPrisma<T>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const jestPrisma: JestPrisma<T> = {
      initializeClient: (client: unknown) => {
        if (this._originalClient) {
          console.warn(
            "jestPrisma has already set Prisma client instance.",
          );
        }
        this._originalClient = client as PrismaClientLike;
        this._originalClient.$on?.("query", (event) => {
          this.logBuffer?.push(event);
        });
      },
      client: new Proxy({} as object, {
        get: (_: unknown, name: string) => {
          if (!this.prismaClientProxy) {
            if (name !== "__esModule") {
              console.warn(
                "jestPrisma.client should be used in test or beforeEach functions because transaction has not yet started.",
              );
              console.warn(
                "If you want to access Prisma client in beforeAll or afterAll, use jestPrisma.originalClient.",
              );
            }
          } else {
            return (this.prismaClientProxy as unknown as Record<string, unknown>)[
              name
            ];
          }
        },
      }) as unknown as T,
      get originalClient() {
        return self.originalClient as unknown as T;
      },
    };

    return jestPrisma;
  }

  handleTestEvent(event: TestEvent): Promise<void> | undefined {
    if (event.name === "test_start") {
      return this.beginTransaction();
    } else if (
      event.name === "test_done" ||
      event.name === "test_skip" ||
      event.name === "test_todo"
    ) {
      return this.endTransaction();
    } else if (event.name === "test_fn_start") {
      this.logBuffer = [];
    } else if (
      event.name === "test_fn_success" ||
      event.name === "test_fn_failure"
    ) {
      this.dumpQueryLog(event.test);
      this.logBuffer = undefined;
    }
  }

  async teardown(): Promise<void> {
    await this.originalClient.$disconnect();
  }

  // ---------- private ------------------------------------------------------

  private get originalClient(): PrismaClientLike {
    if (!this._originalClient) {
      throw new Error(
        "PrismaClient has not been initialized. Call jestPrisma.initializeClient(client) in your setup file.",
      );
    }
    return this._originalClient;
  }

  private async checkInteractiveTransaction(): Promise<boolean> {
    try {
      await this.originalClient.$transaction(() => Promise.resolve(null));
      return true;
    } catch {
      return false;
    }
  }

  private async beginTransaction(): Promise<void> {
    if (!this.connected) {
      await this.originalClient.$connect();
      const hasInteractiveTransaction =
        await this.checkInteractiveTransaction();
      if (!hasInteractiveTransaction) {
        throw new Error(
          "vitest-prisma-core needs interactive transactions support.",
        );
      }
      this.connected = true;
    }

    return new Promise<void>((resolve) =>
      this.originalClient
        .$transaction(
          (transactionClient) => {
            this.prismaClientProxy = createProxy(
              transactionClient as PrismaClientLike,
              this.originalClient,
              this.options,
            );
            resolve();
            return new Promise<void>((resolve, reject) => {
              this.triggerTransactionEnd = this.options.disableRollback
                ? resolve
                : reject;
            });
          },
          {
            maxWait: this.options.maxWait ?? DEFAULT_MAX_WAIT,
            timeout: this.options.timeout ?? DEFAULT_TIMEOUT,
            isolationLevel:
              this.options.isolationLevel ?? DEFAULT_ISOLATION_LEVEL,
          },
        )
        .catch(() => true),
    );
  }

  private async endTransaction(): Promise<void> {
    this.triggerTransactionEnd();
  }

  private dumpQueryLog(test: TestBlock): void {
    if (
      this.options.verboseQuery &&
      this.logBuffer &&
      this.logBuffer.length
    ) {
      let parentBlock: TestBlock | null = test.parent;
      const nameFragments: string[] = [test.name];
      while (parentBlock) {
        nameFragments.push(parentBlock.name);
        parentBlock = parentBlock.parent;
      }
      const breadcrumb = [
        this.testPath,
        ...nameFragments.reverse().slice(1),
      ].join(" > ");

      console.log(`[QUERY] ${breadcrumb}`);
      for (const event of this.logBuffer) {
        console.log(
          `  vitest-prisma:query ${event.query} -- params:${event.params}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fake $transaction — the core proxy mechanism
// ---------------------------------------------------------------------------

function fakeInnerTransactionFactory(
  parentTxClient: PrismaClientLike,
  enableExperimentalRollbackInTransaction: boolean,
): (arg: unknown) => Promise<unknown> {
  let seq = 1;

  const fakeTransactionMethod = async (arg: unknown): Promise<unknown> => {
    const savePointId = `test_${seq++}`;

    if (enableExperimentalRollbackInTransaction) {
      await parentTxClient.$executeRawUnsafe(`SAVEPOINT ${savePointId};`);
    }

    if (Array.isArray(arg)) {
      // --- Sequential (batch) transaction: [PrismaPromise, ...] ----------
      try {
        const results: unknown[] = [];
        for (const prismaPromise of arg) {
          const result = await prismaPromise;
          results.push(result);
        }
        if (enableExperimentalRollbackInTransaction) {
          await parentTxClient.$executeRawUnsafe(
            `RELEASE SAVEPOINT ${savePointId};`,
          );
        }
        return results;
      } catch (err) {
        if (enableExperimentalRollbackInTransaction) {
          await parentTxClient.$executeRawUnsafe(
            `ROLLBACK TO SAVEPOINT ${savePointId};`,
          );
        }
        throw err;
      }
    } else {
      // --- Interactive (callback) transaction ----------------------------
      //
      // KEY DIFFERENCE FROM UPSTREAM:
      //
      // Upstream (v1.8.2) delegates to `parentTxClient.$transaction(arg)`
      // when Prisma 7.5+ exposes `$transaction` on the tx client.  This
      // creates real SAVEPOINTs via Prisma's native nesting — but Prisma 7
      // blocks **concurrent** nested transactions on the same client.
      //
      // We always pass `parentTxClient` directly to the callback instead.
      // All queries execute on the same connection within the root test
      // transaction, avoiding the concurrency restriction.
      //
      try {
        const result = await (arg as (client: PrismaClientLike) => Promise<unknown>)(parentTxClient);
        if (enableExperimentalRollbackInTransaction) {
          await parentTxClient.$executeRawUnsafe(
            `RELEASE SAVEPOINT ${savePointId};`,
          );
        }
        return result;
      } catch (err) {
        if (enableExperimentalRollbackInTransaction) {
          await parentTxClient.$executeRawUnsafe(
            `ROLLBACK TO SAVEPOINT ${savePointId};`,
          );
        }
        throw err;
      }
    }
  };

  return fakeTransactionMethod;
}

// ---------------------------------------------------------------------------
// Proxy — intercepts $transaction on the tx client
// ---------------------------------------------------------------------------

function createProxy(
  txClient: PrismaClientLike,
  originalClient: PrismaClientLike,
  options: JestPrismaEnvironmentOptions,
): PrismaClientLike {
  const boundFakeTransactionMethod = fakeInnerTransactionFactory(
    txClient,
    options.enableExperimentalRollbackInTransaction ?? false,
  );

  return new Proxy(txClient, {
    get: (target, name: string | symbol) => {
      // Always intercept $transaction — must be checked BEFORE target lookup
      // because Prisma 7.5+ exposes $transaction on tx clients.
      if (name === "$transaction") {
        return boundFakeTransactionMethod;
      }
      const delegate = (target as unknown as Record<string | symbol, unknown>)[name];
      if (delegate) return delegate;
      if ((originalClient as unknown as Record<string | symbol, unknown>)[name]) {
        throw new Error(`Unsupported property: ${name.toString()}`);
      }
    },
  }) as PrismaClientLike;
}
