import { defineConfig, devices } from '@playwright/test'

/**
 * E2E 設定（Task 8.2）。
 *
 * ## なぜ本番ビルドに対してだけ走らせるのか
 *
 * design.md「Deployment」がすでに 2 回踏んだ事故（Worker/Wasm のアセット解決が
 * dev サーバでは動いて本番だけ 404 になる）は、dev サーバを叩くテストでは
 * 検出できない。`webServer` は毎回:
 *   1. `npm run build:e2e`（`vite build` を `VITE_ENABLE_AR=false` で実行 — Pages
 *      公開ビルドと同じ条件。`VITE_ENABLE_PERF=true` だけ追加する）
 *   2. `vite preview` で `dist/` を `base`（`/ambiguous-3d-studio/`）配下に
 *      静的配信
 * を行ってから Playwright を起動する。dev サーバ（`vite`）は一切使わない。
 *
 * `VITE_ENABLE_PERF=true` を付ける理由は 1 つ：NFR-001 の内訳計測
 * （`src/studio/perf.ts` が公開する `globalThis.__ambiguousPerf`）は、既定の
 * 公開ビルドでは `import.meta.env.DEV` が false かつこのフラグも false なので
 * 丸ごと DCE で消える（perf.ts 冒頭のコメント）。フラグは `base` / `worker.format`
 * / Wasm アセット解決には一切影響しない（perf.ts が触るのは
 * `performance.mark/measure` の呼び出しの有無だけ）ので、これでもなお
 * 「本番ビルド」として Wasm 404 クラスの不具合を検出できる対象であることに
 * 変わりはない。Task 8.1 の CI は `VITE_ENABLE_PERF` なしの厳密な公開ビルドの
 * 方も別途 grep で検証済み。
 *
 * ## なぜ 1 ワーカー直列か
 *
 * NFR-001 / NFR-002 は同一マシンでの実測レイテンシ・フレーム間隔を扱う。
 * 複数のテストが並行して同じ CPU / GPU を奪い合うと、ジッタが「アプリの遅さ」
 * ではなく「テストランナーの並行度」に由来してしまい、計測の意味が壊れる。
 */
const PORT = 4173
const BASE_PATH = '/ambiguous-3d-studio/'
export const BASE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // ヘッドレス Chromium でも実 GPU（macOS の ANGLE/Metal）で WebGL を描かせる。
    // ソフトウェアラスタライザ（SwiftShader）任せだと NFR-002 のフレーム間隔が
    // アプリの性能ではなくテスト環境のせいで悪化しうるため。
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=metal',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        '--disable-gpu-sandbox',
      ],
    },
  },
  webServer: {
    command: `npm run build:e2e && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
