import { defineConfig } from 'vitest/config'

// Wave 2 tests are pure geometry/logic — no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
  },
})
