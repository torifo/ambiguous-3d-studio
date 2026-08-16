import { expect, test } from '@playwright/test'

import { statusRegion, waitForGenerationSuccess } from './helpers'

/**
 * scenario 8（Task 8.2）: 錯視立体カタログ（FR-100）。
 *
 * `catalogue/illusions.ts` は生成できる項目（buildable: true）と
 * できない項目（buildable: false）を同じ型で持つ。UI（IllusionCard.tsx）は
 * buildable のときだけ「この立体を作る」ボタンを出し、そうでないときは
 * `notBuildableReason` を主役に据えてボタンを出さない。
 */
test.describe('錯視立体カタログ（FR-100）', () => {
  test('生成できる項目はボタンから立体が生成される', async ({ page }) => {
    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)

    // プリセットのみで完結し、文字/フォント読み込みを経由しない項目を選ぶ
    // （「トランプマークの変身立体」: preset a=spade, b=heart, mirror 有効）
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'トランプマークの変身立体' }) })
    await expect(card).toBeVisible()

    const buildButton = card.getByRole('button', { name: 'この立体を作る' })
    await expect(buildButton).toBeVisible()
    await buildButton.click()

    await waitForGenerationSuccess(page, 20_000)
    // 選択中のカードとしてハイライトされる（Gallery.tsx: findAppliedEntryId が
    // 現在の入力から導出する選択状態。border-sky-400 が selected の印）
    await expect(card).toHaveClass(/border-sky-400/)
  })

  test('生成できない項目は理由を示し、生成ボタンを出さない', async ({ page }) => {
    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)

    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'ペンローズの三角形' }) })
    await expect(card).toBeVisible()

    await expect(card.getByText('この方式では作れない理由')).toBeVisible()
    // notBuildableReason の本文が実際に表示されている（空でない）
    const reasonBlock = card.locator('p').filter({ hasText: /視点|シルエット|遮蔽|接続/ })
    await expect(reasonBlock.first()).toBeVisible()

    // 生成ボタンはこのカードの中に一切存在しない
    await expect(card.getByRole('button', { name: 'この立体を作る' })).toHaveCount(0)
    await expect(card.getByText('この方式では生成しません。理由は上記のとおりです。')).toBeVisible()

    // 生成できない項目を見ても、既定入力（正方形×円）の生成状態は変わらない
    await expect(statusRegion(page)).toContainText('生成完了')
  })
})
