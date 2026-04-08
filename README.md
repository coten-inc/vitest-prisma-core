# @coten-inc/vitest-prisma-core

Transaction-isolated Prisma test environments for Vitest.

Forked from [`@quramy/jest-prisma-core`](https://github.com/Quramy/jest-prisma) (v1.8.2, MIT License) with a fix for Prisma 7's concurrent nested transaction restriction.

## Why this fork?

Prisma 7 introduced SAVEPOINT-based nested transactions and blocks concurrent `$transaction()` calls on the same client. When `@quramy/jest-prisma-core` wraps each test in a transaction, its proxy causes all `$transaction()` calls to become nested — triggering `Concurrent nested transactions are not supported` errors in application code that opens multiple transactions concurrently (e.g. a write UoW calling a read UoW).

This fork removes the native `parentTxClient.$transaction()` delegation and always passes `parentTxClient` directly to callbacks (passthrough). All queries execute on the same connection within the root test transaction, avoiding the concurrency restriction while maintaining per-test rollback isolation.

## Trade-offs

- Nested transaction rollback semantics are **not** preserved — inner "transactions" share the outer connection
- This matches the pre-Prisma-7 test behaviour of `@quramy/jest-prisma-core`
- Production code is unaffected since nested transactions only surface through the test proxy

## Installation

```bash
npm install -E @coten-inc/vitest-prisma-core
```

## Usage

Same API as `@quramy/jest-prisma-core`. See the [original documentation](https://github.com/Quramy/jest-prisma) for details.

```typescript
import { PrismaEnvironmentDelegate } from "@coten-inc/vitest-prisma-core";
```

## License

MIT — see [LICENSE](./LICENSE).
