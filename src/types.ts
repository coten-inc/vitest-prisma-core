export type PrismaTransactionIsolationLevel =
  | "ReadUncommitted"
  | "ReadCommitted"
  | "RepeatableRead"
  | "Snapshot"
  | "Serializable";

export interface PrismaClientLike {
  $connect: () => Promise<unknown>;
  $disconnect: () => Promise<unknown>;
  $transaction: (
    fn: (txClient: PrismaClientLike) => Promise<unknown>,
    options?: {
      maxWait: number;
      timeout: number;
      isolationLevel?: PrismaTransactionIsolationLevel;
    },
  ) => Promise<unknown>;
  $executeRawUnsafe: (query: string) => Promise<number>;
  $on?: (
    event: "query",
    callback: (event: {
      readonly query: string;
      readonly params: string;
    }) => unknown,
  ) => void;
}

export interface JestPrisma<T = PrismaClientLike> {
  /**
   * Prisma Client instance whose transactions are isolated for each test case.
   * The wrapping transaction is rolled back automatically after each test case.
   */
  readonly client: T;
  readonly originalClient: T;
  /**
   * Set a customized PrismaClient instance from a setup script.
   */
  readonly initializeClient: (client: unknown) => void;
}

export interface JestPrismaEnvironmentOptions {
  /**
   * If set true, each transaction is not rolled back but committed.
   */
  readonly disableRollback?: boolean;
  /**
   * If set to true, it will reproduce the rollback behavior when an error
   * occurs at the point where the transaction is used.
   *
   * Must not be true when using MongoDB as the database connector.
   */
  readonly enableExperimentalRollbackInTransaction?: boolean;
  /**
   * Display SQL queries in test cases to STDOUT.
   */
  readonly verboseQuery?: boolean;
  /**
   * The maximum amount of time Prisma Client will wait to acquire a
   * transaction from the database.  Default: 5 000 ms.
   */
  readonly maxWait?: number;
  /**
   * The maximum amount of time the interactive transaction can run before
   * being canceled and rolled back.  Default: 5 000 ms.
   */
  readonly timeout?: number;
  /**
   * Sets the transaction isolation level. By default this is set to the
   * value currently configured in your database.
   */
  readonly isolationLevel?: PrismaTransactionIsolationLevel;
  /**
   * Override the database connection URL.
   * Default is the url set in the `DATABASE_URL` environment variable.
   */
  readonly databaseUrl?: string;
}
