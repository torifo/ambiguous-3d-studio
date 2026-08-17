import { expect, type Locator, type Page } from '@playwright/test'

/**
 * E2E 全体で使う共通ヘルパー（Task 8.2）。
 *
 * ここは `src/` を一切編集せず、実ブラウザから見える DOM・aria ロール・
 * `globalThis.__ambiguousPerf`（`src/studio/perf.ts` が公開する開発用ハンドル。
 * `package.json` の `build:e2e` は `VITE_ENABLE_PERF=true` を渡すので、この
 * E2E が対象にする本番ビルドでもこのハンドルが立つ）だけを頼りに操作する
 * 「ブラックボックス」の立場を保つ。テスト専用のフックを src/ 側に足さない
 * （タスクの制約）。
 */

/** GitHub Pages 用の base パス（vite.config.ts の base と同じ値） */
export const BASE_PATH = '/ambiguous-3d-studio/'

/** NFR-001 の測定対象 7 図形（FR-001）。sources/presets.ts の BUILDERS 先頭 7 件と同じ順 */
export const NFR001_SHAPES = [
  'circle',
  'square',
  'triangle',
  'heart',
  'star',
  'arrow',
  'cross',
] as const
export type Nfr001Shape = (typeof NFR001_SHAPES)[number]

/** プリセット図形の日本語ラベル（ui/SilhouettePicker.tsx の PRESET_LABELS と対応） */
export const PRESET_LABELS: Record<Nfr001Shape, string> = {
  circle: '円',
  square: '正方形',
  triangle: '正三角形',
  heart: 'ハート',
  star: '星',
  arrow: '矢印',
  cross: '十字',
}

/**
 * 「自由に作る」モードへ切り替える。SilhouettePicker と ExportPanel は
 * このモード（ui/Sidebar.tsx）でしかマウントされない（App.tsx: mode === 'free'
 * のときだけ <Sidebar /> を描画する）。
 */
export async function switchToFreeMode(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '自由に作る' }).click()
  // タブ切り替え直後は Sidebar がまだマウントされていないことがあるため、
  // 固定 sleep ではなく中の見出しが実際に現れるまで待つ
  await expect(page.getByRole('heading', { name: /^視点 A/ })).toBeVisible()
}

/**
 * 視点 A / B の SilhouettePicker セクションを返す。
 * 視点 C は既定で未設定（追加ボタンのみ）なのでここでは扱わない。
 */
export function viewpointSection(page: Page, viewpoint: 'A' | 'B'): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^視点 ${viewpoint}`) }) })
}

/**
 * 視点 `viewpoint` のプリセットを `id` に設定する。
 *
 * ラジオ input 自体は `sr-only`（視覚的に隠す）で、常に可視の `<label>` が
 * それを包んでいる（SilhouettePicker.tsx）。ネイティブの label-click 委譲で
 * ラジオが切り替わるため、常に label をクリックする — input を直接操作しない。
 */
export async function selectPreset(page: Page, viewpoint: 'A' | 'B', id: Nfr001Shape): Promise<void> {
  const section = viewpointSection(page, viewpoint)
  const presetTab = section.getByRole('tab', { name: 'プリセット' })
  if (!(await presetTab.getAttribute('aria-selected'))?.includes('true')) {
    await presetTab.click()
  }
  // すでに選択済みの id へクリックしても change は発火せず、新しい生成は起きない
  // （呼び出し側が「クリックした＝1 サンプル増えた」と仮定して待つと無音でハングする）。
  // 黙って no-op にせず、呼び出し側の想定が壊れていることをすぐ分かる形で落とす
  const radio = section.locator(`input[type="radio"][value="${id}"]`)
  if (await radio.isChecked()) {
    throw new Error(
      `selectPreset: 視点 ${viewpoint} は既に "${id}" が選択されています。同じ値へのクリックは ` +
        '新しい生成を起こさないため、呼び出し側は別の形状を選ぶ必要があります。',
    )
  }
  await section.locator('label').filter({ hasText: PRESET_LABELS[id] }).click()
}

/** role="status" のステータス行（StatusBanner.tsx）。表示中のモードに関わらず常に 1 つだけ存在する */
export function statusRegion(page: Page): Locator {
  return page.getByRole('status')
}

/** 生成完了（success）まで待つ */
export async function waitForGenerationSuccess(page: Page, timeout = 15_000): Promise<void> {
  await expect(statusRegion(page)).toContainText('生成完了', { timeout })
}

// ---------------------------------------------------------------------------
// perf.ts（globalThis.__ambiguousPerf）まわり — NFR-001 計測用
// ---------------------------------------------------------------------------

/** `src/studio/perf.ts` の `PerfSample` と同じ形（型だけの複製。実行時の依存は持たない） */
export interface PerfSampleLike {
  epoch: number
  totalMs: number
  stages: Record<string, number>
  unaccountedMs: number
  missingStages: string[]
  worker: Record<string, number> | null
}

/**
 * ブラウザ側の `window.__ambiguousPerf` の型（実行時は `unknown` 経由で読む）。
 * `page.evaluate` に渡すコールバックはブラウザの隔離された realm で実行され、
 * このファイル（Node 側）のクロージャを参照できない — 呼び出す側は毎回
 * インラインで `window` を読むこと（他の関数へ切り出さない）。
 */
type PerfDevHandleLike = {
  samples: () => PerfSampleLike[]
  abandoned: () => Record<string, number>
  clear: () => void
}
type WithPerfHandle = typeof window & { __ambiguousPerf?: PerfDevHandleLike }

/**
 * perf ハンドルが立っていることを確認する。`build:e2e`（VITE_ENABLE_PERF=true）
 * でビルドしていないとここで落ちる — 「サンプルが 0 件のまま先へ進む」という
 * 静かな失敗を避けるためのガード（トラップ「rAF が止まると空の結果を信じてしまう」
 * と同じ種類の事故を計測ハンドルの不在についても起こさないため）。
 */
export async function expectPerfHandle(page: Page): Promise<void> {
  const present = await page.evaluate(() => (window as WithPerfHandle).__ambiguousPerf !== undefined)
  if (!present) {
    throw new Error(
      '`globalThis.__ambiguousPerf` が見つかりません。playwright.config.ts の webServer が ' +
        '`npm run build:e2e`（VITE_ENABLE_PERF=true）でビルドしているか確認してください。',
    )
  }
}

/** 現在の perf サンプル一覧を読む */
export async function readPerfSamples(page: Page): Promise<PerfSampleLike[]> {
  return page.evaluate(() => (window as WithPerfHandle).__ambiguousPerf!.samples())
}

/** 中断された run の理由別回数（診断用） */
export async function readAbandonedRuns(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as WithPerfHandle).__ambiguousPerf!.abandoned())
}

/** perf サンプルと中断理由をクリアする */
export async function clearPerfSamples(page: Page): Promise<void> {
  await page.evaluate(() => (window as WithPerfHandle).__ambiguousPerf!.clear())
}

/**
 * perf サンプル数が `count` 以上になるまで待つ。
 *
 * 到達しなかった場合は中断理由の内訳を添えて例外にする —
 * 「なぜこの組み合わせだけ生成が終わらなかったか」を後から追えるようにする
 * （EMPTY_INTERSECTION 等でその場が終端し、`finishRun` に届かないケースの検出）。
 */
export async function waitForPerfSampleCount(page: Page, count: number, timeout = 10_000): Promise<void> {
  try {
    await page.waitForFunction(
      (n) => (window as WithPerfHandle).__ambiguousPerf!.samples().length >= n,
      count,
      { timeout, polling: 20 },
    )
  } catch (err) {
    const abandoned = await readAbandonedRuns(page)
    const actual = (await readPerfSamples(page)).length
    throw new Error(
      `perf サンプルが ${count} 件に届きませんでした（実際 ${actual} 件）。` +
        `中断理由の内訳: ${JSON.stringify(abandoned)}`,
      { cause: err },
    )
  }
}

/** P95（「ceil(0.95×n) 番目に小さい値」方式。サンプル数が少なくても定義が単純） */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile: empty input')
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1)
  return sorted[index]
}
