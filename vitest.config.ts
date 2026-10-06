import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // 21 teaching-package suites each spin up their own PGlite (WASM Postgres)
    // instance; every one is closed, so this is CPU contention across parallel
    // workers, not a leak. Under that contention individual cases and the
    // schema-bootstrap hooks exceed Vitest's 5s/10s defaults and fail
    // non-deterministically, while passing in isolation — which makes a real
    // regression indistinguishable from noise. These raise the ceiling only;
    // a genuinely hung test still fails, just later.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
