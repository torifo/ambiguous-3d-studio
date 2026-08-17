import { expect, test } from '@playwright/test'

import { switchToFreeMode, waitForGenerationSuccess } from './helpers'

/**
 * scenario 7（Task 8.2）: モバイルレイアウト（FR-026）。
 *
 * 375×812（App.tsx のコメントにある想定端末サイズ）で、768px 未満の
 * ブレークポイント（Tailwind `md:`）を割ってサイドバーがボトムシート化し、
 * 3D ビューポートが画面の過半を占め、ビューポート上の 1 本指ドラッグが
 * ページスクロールを起こさないことを検証する。
 *
 * ## 「自由に作る」モードでドラッグを試す理由
 *
 * 既定のカタログモードは `scene/SweetSpot.ts` の `useViewerStore` 初期値が
 * `curatedMode: true` / `rotationLocked: true` — 「常に回転できるとすぐに
 * ネタバラシになる」ため、ユーザーが「仕組みを見る」を押すまで OrbitControls
 * のドラッグ回転自体を無効化する演出仕様（`CameraRig.tsx`）。この状態で
 * ドラッグしてもページがスクロールしないのは当然だが、それだけでは
 * 「ドラッグが実際にビューポートへ届いていた」ことの裏取りができない
 * （回転が起きないのが FR-026 の遵守なのか、単にイベントが握りつぶされて
 * 何も起きていないだけなのかを screenshot 差分から区別できない）。
 * `ui/Sidebar.tsx` は自由モードのマウント時に `curatedMode` / `rotationLocked`
 * を両方解除するため、ここでは自由モードへ切り替えてから検証する —
 * カメラが実際に反応しつつページはスクロールしない、という強い形で確認する。
 */
test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
})

test.describe('モバイルレイアウト（FR-026）', () => {
  test('サイドバーはボトムシート、ビューポートは画面の過半、1本指ドラッグでページはスクロールしない', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)
    await switchToFreeMode(page)

    const aside = page.getByLabel('コントロールサイドバー')
    const main = page.getByLabel('3D ビューポート')
    await expect(aside).toBeVisible()
    await expect(main).toBeVisible()

    const asideBox = await aside.boundingBox()
    const mainBox = await main.boundingBox()
    if (asideBox === null || mainBox === null) throw new Error('レイアウト要素の bounding box が取得できません')

    // ボトムシート: サイドバーは画面下側（main より下）に位置する
    // （App.tsx: flex-col-reverse で DOM 順 aside→main のまま視覚順を反転させる）
    expect(asideBox.y).toBeGreaterThan(mainBox.y)

    // 3D ビューポートに画面の過半を割り当てる（FR-026）。設計は 55dvh だが、
    // ここでは「過半」という要件そのものを緩めに検証する
    const viewportHeight = 812
    expect(mainBox.height).toBeGreaterThan(viewportHeight * 0.5)

    // 1 本指ドラッグでページがスクロールしない（FR-026）。
    // page.touchscreen は tap しか提供しないため、CDP の Input.dispatchTouchEvent
    // を直接使って touchstart → touchmove × N → touchend を合成する。
    const cdp = await page.context().newCDPSession(page)
    const startX = mainBox.x + mainBox.width / 2
    const startY = mainBox.y + mainBox.height / 2

    const beforeScreenshot = await page.screenshot()

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y: startY }],
    })
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + i * 3, y: startY - i * 15 }],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })

    const scrollTop = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)
    const scrollLeft = await page.evaluate(() => document.scrollingElement?.scrollLeft ?? 0)
    expect(scrollTop, 'ビューポート上の 1 本指ドラッグでページが縦スクロールしました').toBe(0)
    expect(scrollLeft, 'ビューポート上の 1 本指ドラッグでページが横スクロールしました').toBe(0)

    // ドラッグが実際にカメラへ届いていた（=イベントが握りつぶされていない）ことの
    // 軽い裏取り。厳密な差分検証ではなく、完全に同一バイト列でないことだけを見る
    const afterScreenshot = await page.screenshot()
    expect(Buffer.compare(beforeScreenshot, afterScreenshot)).not.toBe(0)
  })
})
