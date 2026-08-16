import { expect, test } from '@playwright/test'

import { statusRegion, waitForGenerationSuccess } from './helpers'

/**
 * scenario 1（Task 8.2）: 初期表示（FR-025）。
 *
 * `loading-wasm` は「準備中」として提示され、エラーの語彙は使わない
 * （StatusBanner.tsx の STATUS_LABELS）。その後 Wasm 初期化が終わると
 * 保持していた初期入力（正方形 × 円）で 1 回だけ生成が走り、立体が描画される。
 */
test.describe('初期表示（FR-025）', () => {
  test('loading-wasm は準備中として提示され、続いて既定の正方形×円が描画される', async ({ page }) => {
    // Wasm 応答を意図的に遅らせ、loading-wasm を確実に観測できるようにする。
    // 「固定 sleep で待つ」のではなく、ネットワーク応答そのものを遅延させて
    // 状態遷移が起こる余地を作り、その後は実際の DOM 変化を待つ
    // （固定 sleep を待機条件の代用にしないというタスクの制約に沿う）。
    await page.route('**/*.wasm', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      await route.continue()
    })

    await page.goto('/')

    // loading-wasm: 「準備中」であり、エラー・失敗の語彙は一切出ない
    await expect(statusRegion(page)).toContainText('準備中')
    await expect(statusRegion(page)).not.toContainText('失敗')
    await expect(statusRegion(page)).not.toContainText('できませんでした')
    // FR-025: 出力ボタン等は無効化されるが「入力は保持」されるので、
    // カタログ（既定モード）のカードは操作可能なまま出ている
    await expect(page.getByRole('heading', { name: '錯視立体カタログ' })).toBeVisible()

    // ready → generating → success。既定入力（正方形×円）で 1 回だけ生成される
    await waitForGenerationSuccess(page, 20_000)
    await expect(statusRegion(page)).toContainText(/パーツ\s*1/)
    await expect(statusRegion(page)).toContainText(/三角形/)

    // 立体を描く canvas が実際に存在し、可視である
    await expect(page.locator('canvas')).toBeVisible()
  })
})
