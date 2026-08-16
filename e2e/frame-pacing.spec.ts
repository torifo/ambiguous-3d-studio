import { expect, test } from '@playwright/test'

import { waitForGenerationSuccess } from './helpers'

/**
 * scenario 3（Task 8.2）: NFR-002「カメラ操作中のフレームレート」。
 *
 * 測定条件（requirements.md）: 基準機で 10 秒間の連続カメラ回転中、
 * フレーム間隔の P95 が 16.7ms 以内、かつ 50ms を超えるロングタスクがゼロ。
 *
 * これは `src/studio/perf.ts`（生成パイプラインの工程計測）の対象外 —
 * 生の `requestAnimationFrame` 間隔と `PerformanceObserver({entryTypes:['longtask']})`
 * をこのテストが直接ページへ注入して計測する。src/ には一切手を入れない。
 *
 * ## トラップ: バックグラウンドタブは rAF を止める
 * このテストはページを 1 つしか開かず、フォアグラウンドに置いたまま
 * ドラッグを送り続ける。収集した interval 配列が空でないことを明示的に
 * 検証し、「rAF が 1 度も呼ばれず、空の配列を『問題なし』と誤読する」事故を防ぐ。
 */
test.describe('NFR-002: カメラ回転中のフレーム間隔とロングタスク', () => {
  test('10秒間の連続回転でフレーム間隔 P95 < 16.7ms、50ms超のロングタスクはゼロ', async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)

    const viewportEl = page.getByRole('application', { name: /3D ビュー/ })
    const box = await viewportEl.boundingBox()
    if (box === null) throw new Error('3D ビューポートの bounding box が取得できません')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    // 計測器の注入。__collecting が true の間だけフレーム間隔を貯める
    // （「カメラ回転中」だけを対象にする測定条件どおりにするため）
    await page.evaluate(() => {
      const w = window as unknown as {
        __frameIntervals: number[]
        __longTasks: number[]
        __collecting: boolean
      }
      w.__frameIntervals = []
      w.__longTasks = []
      w.__collecting = false

      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(entry.duration)
      })
      observer.observe({ entryTypes: ['longtask'] })

      let last = performance.now()
      function loop(now: number): void {
        if (w.__collecting) w.__frameIntervals.push(now - last)
        last = now
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })

    await page.mouse.move(centerX, centerY)
    await page.mouse.down()
    await page.evaluate(() => {
      ;(window as unknown as { __collecting: boolean }).__collecting = true
    })

    // 10 秒間、ビューポート内で連続的に往復ドラッグしてカメラを回し続ける
    const durationMs = 10_000
    const start = Date.now()
    let x = centerX
    let direction = 1
    const margin = 20
    while (Date.now() - start < durationMs) {
      x += direction * 40
      if (x > box.x + box.width - margin || x < box.x + margin) direction *= -1
      await page.mouse.move(x, centerY, { steps: 3 })
    }

    await page.evaluate(() => {
      ;(window as unknown as { __collecting: boolean }).__collecting = false
    })
    await page.mouse.up()

    const result = await page.evaluate(() => {
      const w = window as unknown as { __frameIntervals: number[]; __longTasks: number[] }
      return { intervals: w.__frameIntervals, longTasks: w.__longTasks }
    })

    // トラップ対策: フレームが 1 件も取れていない状態で「P95 は空だから合格」に
    // ならないよう、まずサンプルが実際に集まったことを検証する
    expect(
      result.intervals.length,
      '回転中に rAF フレームが 1 件も記録されませんでした（タブがバックグラウンド化していないか確認してください）',
    ).toBeGreaterThan(0)

    const sorted = [...result.intervals].sort((a, b) => a - b)
    const idx = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1)
    const p95Interval = sorted[idx]
    const longTasksOver50 = result.longTasks.filter((d) => d > 50)

    console.log('=== NFR-002 frame pacing report (10s continuous rotation) ===')
    console.log(`frames observed: ${result.intervals.length}`)
    console.log(`frame interval P95: ${p95Interval.toFixed(2)}ms  (budget: 16.7ms)`)
    console.log(`max frame interval: ${Math.max(...result.intervals).toFixed(2)}ms`)
    console.log(`long tasks total observed: ${result.longTasks.length}`)
    console.log(`long tasks > 50ms: ${longTasksOver50.length}${longTasksOver50.length > 0 ? ' ' + JSON.stringify(longTasksOver50) : ''}`)

    expect(
      longTasksOver50.length,
      `50ms を超えるロングタスクが ${longTasksOver50.length} 件ありました（NFR-002）: ${JSON.stringify(longTasksOver50)}`,
    ).toBe(0)
    expect(p95Interval, `frame interval P95 ${p95Interval.toFixed(2)}ms が 16.7ms 予算（NFR-002）を超えました`).toBeLessThan(
      16.7,
    )
  })
})
