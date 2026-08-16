import { expect, test } from '@playwright/test'

import {
  NFR001_SHAPES,
  clearPerfSamples,
  expectPerfHandle,
  percentile,
  readPerfSamples,
  selectPreset,
  switchToFreeMode,
  waitForGenerationSuccess,
  waitForPerfSampleCount,
  type PerfSampleLike,
} from './helpers'

/**
 * scenario 2（Task 8.2）: NFR-001「入力変更→メッシュ描画完了」の P95 レイテンシ。
 *
 * 測定条件は requirements.md に厳密に書かれている:
 *   プリセット図形同士の 7×7 全組み合わせを各 3 回、ウォームアップ 5 回の後に
 *   計測（計 147 サンプル）。基準機は開発機（Apple Silicon / Chrome 最新版）。
 *
 * `src/studio/perf.ts` が公開する `globalThis.__ambiguousPerf`（build:e2e が
 * VITE_ENABLE_PERF=true でビルドするので本番ビルドでも立つ）を読む。
 * これは「1 回の生成の工程別内訳」をアプリ自身が `performance.mark/measure` で
 * 記録したものであり、Playwright 側のポーリング間隔などのテストハーネス
 * オーバーヘッドは一切含まれない — `sample.totalMs` を計測値として扱う。
 *
 * ## 「7×7 を 3 回」をどう UI 操作に落とすか
 *
 * 視点 A・B はどちらも `<input type=radio>` をラジオボタンで切り替える UI で、
 * 同じ値へ再度クリックしても change は発火しない（＝新しい生成は起きない）。
 * そこで 49 通りを「独立した 3 回」ではなく、**49 通り全体を 3 パス**行う
 * 構成にする: 各パスは A を 7 行ぶん切り替え、各行で B を 7 通り切り替える。
 * A の切り替え（行の先頭）自体も入力変更なので生成が 1 回走るが、これは
 * 「直前の B のままの A 変更」に対する生成であり、目的の 49 ペアには
 * 数えない（147 件には含めない）。B の切り替えだけを 147 件として集計する。
 * これにより実際の 49 ペアぶんの相異なる組み合わせに 3 回ずつ、時間的にも
 * 分散して到達する（連続 3 回同一ペアを再クリックする不可能な操作を避けつつ、
 * 測定条件が求める「各組み合わせ 3 回」を満たす）。
 */
const PERF_STAGES = [
  'contour',
  'normalize',
  'preflight',
  'dispatch',
  'debounce',
  'transport',
  'csg',
  'mesh',
  'render',
] as const

test.describe('NFR-001: 入力変更 → メッシュ描画完了の P95 レイテンシ', () => {
  test('7×7 プリセット全組み合わせ×3、ウォームアップ5回後の147サンプルで測定する', async ({ page }) => {
    test.setTimeout(240_000)

    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)
    await expectPerfHandle(page)
    await switchToFreeMode(page)

    let sampleCount = (await readPerfSamples(page)).length

    // ウォームアップ 5 回（NFR-001 の測定条件）。B を 5 回変えるだけで、
    // 実装のあらゆる経路（デバウンス・Worker 往復・描画ハンドオフ）を
    // 一巡させるのに十分。既定入力の B は 'circle'（NFR001_SHAPES[0]）なので
    // 1 個ずらして開始し、初回クリックが「既に選択済みの値」にならないようにする
    for (let i = 0; i < 5; i++) {
      await selectPreset(page, 'B', NFR001_SHAPES[(i + 1) % NFR001_SHAPES.length])
      sampleCount++
      await waitForPerfSampleCount(page, sampleCount)
    }

    await clearPerfSamples(page)

    const realSamples: PerfSampleLike[] = []
    let expected = 0
    for (let pass = 0; pass < 3; pass++) {
      for (const a of NFR001_SHAPES) {
        await selectPreset(page, 'A', a)
        expected++
        await waitForPerfSampleCount(page, expected) // 行頭の distractor（147 件には数えない）

        for (const b of NFR001_SHAPES) {
          await selectPreset(page, 'B', b)
          expected++
          await waitForPerfSampleCount(page, expected)
          const samples = await readPerfSamples(page)
          realSamples.push(samples[expected - 1])
        }
      }
    }

    expect(realSamples.length, '147 サンプルに届きませんでした').toBe(147)

    const totals = realSamples.map((s) => s.totalMs)
    const p95Total = percentile(totals, 95)

    const stageP95: Record<string, number> = {}
    for (const stage of PERF_STAGES) {
      const values = realSamples.map((s) => s.stages[stage]).filter((v): v is number => typeof v === 'number')
      stageP95[stage] = values.length > 0 ? percentile(values, 95) : NaN
    }

    const withMissingStages = realSamples.filter((s) => s.missingStages.length > 0)
    const withUnaccountedGap = realSamples.filter((s) => Math.abs(s.unaccountedMs) > 1)

    console.log('=== NFR-001 latency report (147 samples, 7x7 preset pairs x3, after 5 warm-ups) ===')
    console.log(`P95 total: ${p95Total.toFixed(2)}ms  (budget: 300ms)`)
    console.log('per-stage P95 breakdown:')
    for (const stage of PERF_STAGES) {
      console.log(`  ${stage.padEnd(10)} P95 ${stageP95[stage].toFixed(2)}ms`)
    }
    console.log(`samples with missing stages (wiring gap): ${withMissingStages.length}`)
    console.log(`samples with |unaccountedMs| > 1ms: ${withUnaccountedGap.length}`)
    console.log(`min total: ${Math.min(...totals).toFixed(2)}ms  max total: ${Math.max(...totals).toFixed(2)}ms`)

    // perf.ts 冒頭の前提（工程の合計が実測エンドツーエンドと一致すること）が
    // 崩れていれば、以下の P95 判定自体の土台が壊れている。まずそれを確認する
    expect(withMissingStages.length, '工程の配線漏れがあるサンプルが存在します（perf.ts の前提が崩れています）').toBe(0)

    // NFR-001 の判定そのもの。超過時は理由となる工程を上のログで名指しできる
    // 状態のまま失敗させる — 測定条件やしきい値を調整して通そうとしない
    expect(p95Total, `P95 latency ${p95Total.toFixed(2)}ms が 300ms 予算（NFR-001）を超えました`).toBeLessThan(300)
  })
})
