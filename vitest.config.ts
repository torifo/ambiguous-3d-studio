import { configDefaults, defineConfig } from 'vitest/config'

// Wave 2 tests are pure geometry/logic — no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
    // Task 8.2: e2e/*.spec.ts は Playwright（playwright.config.ts の testDir）が
    // 実行する。Vitest の既定 include はこれらも `*.spec.ts` として拾ってしまい、
    // Playwright の `test.describe` を Vitest 内で呼んで衝突するため除外する。
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
