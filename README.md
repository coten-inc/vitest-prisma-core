# @coten-inc/vitest-prisma-core

Transaction-isolated Prisma test environments for Vitest.

Forked from [`@quramy/jest-prisma-core`](https://github.com/Quramy/jest-prisma) (v1.8.2, MIT License).

## Changes from upstream

- Removed Jest type dependencies (`@jest/types`, `@jest/environment`) — uses minimal inline types
- Removed `loadDefaultClient` — consumers must call `initializeClient()` with their own PrismaClient
- Replaced `chalk` with plain `console.log` for query logging
- Build with tsup (CJS + ESM + DTS)

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
