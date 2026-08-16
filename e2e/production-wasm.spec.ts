import { expect, test } from '@playwright/test'

import { BASE_PATH, waitForGenerationSuccess } from './helpers'

/**
 * scenario 6（Task 8.2）: 本番 Wasm パス（design.md「Deployment」）。
 *
 * このアプリが 2 度事故った箇所（dev では動いて本番の Pages サブパス配下だけ
 * `.wasm` が 404 になる）を、実ブラウザのネットワークイベントで検証する。
 * Task 8.1 は CI で built JS を grep する静的チェックを持っているが、ここでは
 * 実際にブラウザがそのアセットを取得して 200 を得られることまで見る。
 */
test.describe('本番 Wasm パス（design.md「Deployment」）', () => {
  test('Worker チャンクが読み込まれ、参照する .wasm が base 配下で 200 を返す', async ({ page }) => {
    const responses: Array<{ url: string; status: number }> = []
    page.on('response', (response) => {
      responses.push({ url: response.url(), status: response.status() })
    })

    await page.goto('/')
    // 初回生成が成功する = Worker の起動と Wasm 初期化が完了している
    await waitForGenerationSuccess(page, 20_000)

    const seenUrls = () => responses.map((r) => r.url).join('\n')

    const workerChunk = responses.find((r) => /\/assets\/csg\.worker-[^/]+\.js(\?.*)?$/.test(r.url))
    expect(workerChunk, `Worker チャンクへのリクエストが観測できませんでした。観測した URL:\n${seenUrls()}`).toBeDefined()
    expect(workerChunk?.status).toBe(200)

    const wasmResponse = responses.find((r) => /\.wasm(\?.*)?$/.test(r.url))
    expect(wasmResponse, `.wasm へのリクエストが観測できませんでした。観測した URL:\n${seenUrls()}`).toBeDefined()
    expect(wasmResponse!.url).toContain(BASE_PATH)
    expect(wasmResponse!.status).toBe(200)
  })
})
