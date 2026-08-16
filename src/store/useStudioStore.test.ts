/**
 * store は React を経由せず vanilla API（createStudioStore）で直接テストする。
 * テスト環境は node（DOM なし）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import {
  clampAxisAngleDeg,
  createStudioStore,
  INITIAL_INPUT,
  selectCanExport,
  selectIsErrorState,
  selectIsOrthogonalAxes,
  selectViewpointCount,
  type GenerationSummary,
  type StudioState,
} from './useStudioStore'
import type { ViewpointPreflightWarning } from '../geometry/preflight'
import type { SilhouetteSource } from '../geometry/types'
import {
  DEFAULT_AXIS_ANGLE_DEG,
  MAX_AXIS_ANGLE_DEG,
  MIN_AXIS_ANGLE_DEG,
} from '../worker/protocol'

const star: SilhouetteSource = { kind: 'preset', id: 'star' }
const heart: SilhouetteSource = { kind: 'preset', id: 'heart' }
const badSvg: SilhouetteSource = {
  kind: 'svg',
  fileName: 'broken.svg',
  raw: '<svg><line x1="0" y1="0" x2="1" y2="1"/></svg>',
}

const summary: GenerationSummary = {
  componentCount: 1,
  volume: 4.19,
  triangleCount: 1024,
  elapsedMs: 180,
}

const emptyBandWarning: ViewpointPreflightWarning = {
  code: 'EMPTY_BAND',
  certainty: 'exact',
  message: 'この高さで立体が途切れます',
  band: [0.4, 0.6],
  side: 'A',
}

let store: StoreApi<StudioState>

beforeEach(() => {
  store = createStudioStore()
})

/** ready まで進めて 1 回生成を成功させる（パイプラインの正常系を再現） */
function generateSuccessfully(s: StoreApi<StudioState>): number {
  const epoch = s.getState().startGenerating()
  expect(epoch).not.toBeNull()
  s.getState().generationSucceeded(epoch!, summary)
  expect(s.getState().status).toBe('success')
  return epoch!
}

describe('初期状態', () => {
  it('loading-wasm で始まり、入力は正方形 × 円', () => {
    const s = store.getState()
    expect(s.status).toBe('loading-wasm')
    expect(s.input).toEqual(INITIAL_INPUT)
    expect(s.input.a).toEqual({ kind: 'preset', id: 'square' })
    expect(s.input.b).toEqual({ kind: 'preset', id: 'circle' })
  })

  it('オプション既定値：ミラー off・台座 off 2.0mm・高さ 60mm', () => {
    const { options } = store.getState()
    expect(options.virtualMirror).toBe(false)
    expect(options.baseplate).toEqual({ enabled: false, thicknessMm: 2.0 })
    expect(options.heightMm).toBe(60)
  })

  it('警告・エラー・結果は空、世代は 0', () => {
    const s = store.getState()
    expect(s.warnings).toEqual([])
    expect(s.lastError).toBeNull()
    expect(s.lastResult).toBeNull()
    expect(s.generationEpoch).toBe(0)
  })
})

describe('FR-025 状態機械 — 全遷移', () => {
  it('loading-wasm → ready → generating → success', () => {
    store.getState().wasmReady()
    expect(store.getState().status).toBe('ready')

    const epoch = store.getState().startGenerating()
    expect(epoch).not.toBeNull()
    expect(store.getState().status).toBe('generating')

    store.getState().generationSucceeded(epoch!, summary)
    const s = store.getState()
    expect(s.status).toBe('success')
    expect(s.lastResult).toEqual(summary)
    expect(s.lastError).toBeNull()
  })

  it('generating → error', () => {
    store.getState().wasmReady()
    const epoch = store.getState().startGenerating()
    store.getState().generationFailed(epoch!, { code: 'EMPTY_RESULT' })
    const s = store.getState()
    expect(s.status).toBe('error')
    expect(s.lastError).toEqual({ code: 'EMPTY_RESULT' })
  })

  it('error → generating（再生成できる）', () => {
    store.getState().wasmReady()
    const epoch = store.getState().startGenerating()
    store.getState().generationFailed(epoch!, { code: 'EMPTY_RESULT' })
    expect(store.getState().startGenerating()).not.toBeNull()
    expect(store.getState().status).toBe('generating')
  })

  it('success → generating（再生成できる）', () => {
    store.getState().wasmReady()
    generateSuccessfully(store)
    expect(store.getState().startGenerating()).not.toBeNull()
    expect(store.getState().status).toBe('generating')
  })

  it('loading-wasm → init-failed', () => {
    store.getState().wasmInitFailed('timeout after 10s')
    const s = store.getState()
    expect(s.status).toBe('init-failed')
    expect(s.lastError).toEqual({
      code: 'WASM_INIT_FAILED',
      detail: 'timeout after 10s',
    })
  })

  it('init-failed → loading-wasm（再試行）→ ready（再試行成功）', () => {
    store.getState().wasmInitFailed('network error')
    store.getState().retryInit()
    expect(store.getState().status).toBe('loading-wasm')
    expect(store.getState().lastError).toBeNull()

    store.getState().wasmReady()
    expect(store.getState().status).toBe('ready')
  })

  it('許可されない遷移は no-op', () => {
    // ready のまま success 通知が来ても無視する（epoch が正しくても状態が不正）
    store.getState().wasmReady()
    store.getState().generationSucceeded(store.getState().generationEpoch, summary)
    expect(store.getState().status).toBe('ready')
    expect(store.getState().lastResult).toBeNull()

    // loading-wasm 以外からの wasmReady も無視する
    store.getState().startGenerating()
    store.getState().wasmReady()
    expect(store.getState().status).toBe('generating')

    // loading-wasm 中は生成を開始できない（null が返る）
    const fresh = createStudioStore()
    expect(fresh.getState().startGenerating()).toBeNull()
    expect(fresh.getState().status).toBe('loading-wasm')

    // init-failed 中も開始できない
    const failed = createStudioStore()
    failed.getState().wasmInitFailed('boom')
    expect(failed.getState().startGenerating()).toBeNull()
    expect(failed.getState().status).toBe('init-failed')
  })
})

describe('FR-025 — loading-wasm はエラーではない', () => {
  it('loading-wasm はエラー状態として提示されない', () => {
    const s = store.getState()
    expect(s.status).toBe('loading-wasm')
    expect(s.lastError).toBeNull()
    expect(selectIsErrorState(s)).toBe(false)
  })

  it('init-failed と error はエラー状態', () => {
    store.getState().wasmInitFailed('boom')
    expect(selectIsErrorState(store.getState())).toBe(true)
  })

  it('loading-wasm 中は出力を無効化する', () => {
    expect(selectCanExport(store.getState())).toBe(false)
  })

  it('出力は success かつ結果ありのときだけ有効', () => {
    store.getState().wasmReady()
    expect(selectCanExport(store.getState())).toBe(false)
    const epoch = store.getState().startGenerating()
    expect(selectCanExport(store.getState())).toBe(false)
    store.getState().generationSucceeded(epoch!, summary)
    expect(selectCanExport(store.getState())).toBe(true)
  })

  it('loading-wasm 中に選んだ入力は ready まで保持される', () => {
    // 準備中でも入力の選択は受け付ける（FR-025）
    store.getState().setSilhouetteA(star)
    expect(store.getState().status).toBe('loading-wasm')
    expect(store.getState().input.a).toEqual(star)

    store.getState().wasmReady()
    expect(store.getState().status).toBe('ready')
    expect(store.getState().input.a).toEqual(star)
  })
})

describe('US-001 — 入力変更は直前の生成結果を破棄する', () => {
  beforeEach(() => {
    store.getState().wasmReady()
  })

  it('success 後に入力を変更すると結果は破棄され、出力は無効になる', () => {
    generateSuccessfully(store)
    store.getState().setWarnings(store.getState().generationEpoch, [emptyBandWarning])
    expect(selectCanExport(store.getState())).toBe(true)

    // レビュー指摘のシーケンス：square × circle の成功後に A を star へ
    store.getState().setSilhouetteA(star)

    const s = store.getState()
    expect(s.status).not.toBe('success')
    expect(s.status).toBe('ready')
    expect(s.lastResult).toBeNull()
    expect(s.warnings).toEqual([])
    // 旧入力（square × circle）のメッシュを出力できてはならない
    expect(selectCanExport(s)).toBe(false)
  })

  it('setSilhouetteB / resetShapes / restoreLastValidInput も同様に破棄する', () => {
    generateSuccessfully(store)
    store.getState().setSilhouetteB(heart)
    expect(selectCanExport(store.getState())).toBe(false)
    expect(store.getState().lastResult).toBeNull()

    generateSuccessfully(store)
    store.getState().resetShapes()
    expect(selectCanExport(store.getState())).toBe(false)
    expect(store.getState().lastResult).toBeNull()

    generateSuccessfully(store)
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(selectCanExport(store.getState())).toBe(false)
    expect(store.getState().lastResult).toBeNull()
  })

  it('error 後の入力変更は stale なエラー表示も取り下げる', () => {
    const epoch = store.getState().startGenerating()
    store.getState().generationFailed(epoch!, { code: 'EMPTY_RESULT' })
    expect(selectIsErrorState(store.getState())).toBe(true)

    store.getState().setSilhouetteA(star)
    expect(store.getState().status).toBe('ready')
    expect(store.getState().lastError).toBeNull()
  })

  it('superseded な入力への遅延 success は無視される（結果が蘇らない）', () => {
    const e1 = store.getState().startGenerating()

    // 生成中にユーザーが入力を変更 → 実行中の生成は無効になる
    store.getState().setSilhouetteA(star)
    expect(store.getState().status).toBe('generating') // スピナーは維持

    // 旧入力への遅延レスポンスが届く → 無視。出力可能になってはならない
    store.getState().generationSucceeded(e1!, summary)
    expect(store.getState().status).toBe('generating')
    expect(store.getState().lastResult).toBeNull()
    expect(selectCanExport(store.getState())).toBe(false)

    // 最新入力の生成は開始でき（no-op ではない）、その結果は反映される
    const e2 = store.getState().startGenerating()
    expect(e2).not.toBeNull()
    expect(e2).not.toBe(e1)
    store.getState().generationSucceeded(e2!, summary)
    expect(store.getState().status).toBe('success')
    expect(selectCanExport(store.getState())).toBe(true)
  })

  it('generating 中の startGenerating は supersede（新しい epoch を返す）', () => {
    const e1 = store.getState().startGenerating()
    const e2 = store.getState().startGenerating()
    expect(e2).not.toBeNull()
    expect(e2).not.toBe(e1)
    expect(store.getState().status).toBe('generating')

    // 置き換えられた旧生成の失敗通知も無視される（スピナーは新生成が畳む）
    store.getState().generationFailed(e1!, { code: 'EMPTY_RESULT' })
    expect(store.getState().status).toBe('generating')

    store.getState().generationFailed(e2!, { code: 'EMPTY_RESULT' })
    expect(store.getState().status).toBe('error')
  })

  it('stale な setWarnings は無視される', () => {
    const staleEpoch = store.getState().generationEpoch
    store.getState().setSilhouetteA(star)
    store.getState().setWarnings(staleEpoch, [emptyBandWarning])
    expect(store.getState().warnings).toEqual([])
  })
})

describe('FR-006 — リセットと直前入力の復帰', () => {
  it('resetShapes() で正方形 × 円に戻る', () => {
    store.getState().setSilhouetteA(star)
    store.getState().setSilhouetteB(heart)
    store.getState().resetShapes()
    expect(store.getState().input).toEqual(INITIAL_INPUT)
  })

  it('受理された入力だけが lastValidInput へ昇格する', () => {
    // 設定しただけでは候補にすぎない
    store.getState().setSilhouetteA(star)
    expect(store.getState().lastValidInput).toEqual(INITIAL_INPUT)

    // パイプラインが受理を通知して初めて昇格する
    store.getState().inputAccepted(store.getState().generationEpoch)
    // 初期値からの差分だけを書く（視点 C・軸角のような追加フィールドが増えても
    // 「A だけ差し替わった」という主張が壊れない）
    expect(store.getState().lastValidInput).toEqual({ ...INITIAL_INPUT, a: star })
  })

  it('SVG 拒否 → restoreLastValidInput() で直前の受理済み入力に戻る', () => {
    // star が受理される
    store.getState().setSilhouetteA(star)
    store.getState().inputAccepted(store.getState().generationEpoch)

    // 後に拒否される SVG がいったん候補として受け付けられる
    store.getState().setSilhouetteA(badSvg)
    expect(store.getState().input.a).toEqual(badSvg)

    // パイプラインが SVG を拒否 → 復帰
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input.a).toEqual(star)
    expect(store.getState().input.b).toEqual(INITIAL_INPUT.b)
  })

  it('履歴は 1 段のみ — 続けて呼んでも 2 段戻らない', () => {
    store.getState().setSilhouetteA(star)
    store.getState().inputAccepted(store.getState().generationEpoch) // star を受理
    store.getState().setSilhouetteA(badSvg) // 候補（未受理）

    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input.a).toEqual(star)

    // もう一度呼んでも star のまま。square（2 段前）へは戻らない
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input.a).toEqual(star)
  })

  it('B 側の変更も受理されれば復帰先になる', () => {
    store.getState().setSilhouetteB(heart)
    store.getState().inputAccepted(store.getState().generationEpoch)
    store.getState().setSilhouetteB(badSvg)
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input.b).toEqual(heart)
  })

  it('検証中に別の編集が入っても未検証の入力は lastValidInput にならない', () => {
    // レビュー指摘のレース：
    // 1. 受理済みは square × circle（初期値）
    // 2. A に不正 SVG → パイプラインが epoch を捕捉して検証を開始
    store.getState().setSilhouetteA(badSvg)
    const validatingEpoch = store.getState().generationEpoch

    // 3. 拒否が返る**前**に B を heart へ変更
    store.getState().setSilhouetteB(heart)

    // badSvg を含むペアが復帰先に昇格していてはならない
    expect(store.getState().lastValidInput).toEqual(INITIAL_INPUT)

    // 4. 遅れて届いた拒否（stale epoch）による復帰は無視される —
    //    最新の編集（badSvg × heart の検証待ち）を上書きしない
    store.getState().restoreLastValidInput(validatingEpoch)
    expect(store.getState().input).toEqual({ ...INITIAL_INPUT, a: badSvg, b: heart })

    // 最新 epoch での拒否 → 受理済みの square × circle へ復帰。
    // 不正 SVG が復元されることは決してない
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input).toEqual(INITIAL_INPUT)
  })

  it('stale な受理通知は現在の未検証入力を昇格させない', () => {
    store.getState().setSilhouetteA(star)
    const staleEpoch = store.getState().generationEpoch

    // star の検証が終わる前に badSvg へ再編集
    store.getState().setSilhouetteA(badSvg)

    // 遅れて届いた star の受理通知 — 現在の入力は badSvg なので、
    // これを昇格させてはならない
    store.getState().inputAccepted(staleEpoch)
    expect(store.getState().lastValidInput).toEqual(INITIAL_INPUT)
  })
})

describe('オプション', () => {
  it('setHeightMm は FR-029 の範囲（10〜300）へ丸める', () => {
    store.getState().setHeightMm(5)
    expect(store.getState().options.heightMm).toBe(10)

    store.getState().setHeightMm(999)
    expect(store.getState().options.heightMm).toBe(300)

    store.getState().setHeightMm(72.6)
    expect(store.getState().options.heightMm).toBe(73)

    store.getState().setHeightMm(Number.NaN)
    expect(store.getState().options.heightMm).toBe(60)
  })

  it('台座の厚みは FR-015 の範囲（0.5〜5.0mm）へ丸める', () => {
    store.getState().setBaseplateThicknessMm(0.1)
    expect(store.getState().options.baseplate.thicknessMm).toBe(0.5)

    store.getState().setBaseplateThicknessMm(10)
    expect(store.getState().options.baseplate.thicknessMm).toBe(5.0)

    store.getState().setBaseplateThicknessMm(3.5)
    expect(store.getState().options.baseplate.thicknessMm).toBe(3.5)
  })

  it('仮想ミラーと台座の on/off', () => {
    store.getState().setVirtualMirror(true)
    expect(store.getState().options.virtualMirror).toBe(true)

    store.getState().setBaseplateEnabled(true)
    expect(store.getState().options.baseplate.enabled).toBe(true)
    // 有効化しても厚みは維持される
    expect(store.getState().options.baseplate.thicknessMm).toBe(2.0)
  })
})

describe('視点 C と軸角（FR-101 / FR-102）', () => {
  beforeEach(() => {
    store.getState().wasmReady()
  })

  it('初期状態は 2 視点・直交（従来と同じ入力）', () => {
    const s = store.getState()
    expect(s.input.c).toBeNull()
    expect(s.input.axisAngleDeg).toBe(DEFAULT_AXIS_ANGLE_DEG)
    expect(selectViewpointCount(s)).toBe(2)
    expect(selectIsOrthogonalAxes(s)).toBe(true)
  })

  it('setSilhouetteC で 3 視点になり、null で 2 視点へ完全に戻る', () => {
    generateSuccessfully(store)
    store.getState().setSilhouetteC(star)
    expect(selectViewpointCount(store.getState())).toBe(3)
    // 入力変更なので直前の結果は破棄される（US-001）
    expect(store.getState().lastResult).toBeNull()
    expect(selectCanExport(store.getState())).toBe(false)

    generateSuccessfully(store)
    store.getState().setSilhouetteC(null)
    expect(selectViewpointCount(store.getState())).toBe(2)
    // 外した後の入力は、C を一度も使わなかった状態と等しい
    expect(store.getState().input).toEqual(INITIAL_INPUT)
  })

  it('setAxisAngleDeg は 15〜165° へ丸め、入力変更として結果を破棄する', () => {
    expect(clampAxisAngleDeg(45)).toBe(45)
    expect(clampAxisAngleDeg(0)).toBe(MIN_AXIS_ANGLE_DEG)
    expect(clampAxisAngleDeg(200)).toBe(MAX_AXIS_ANGLE_DEG)
    expect(clampAxisAngleDeg(Number.NaN)).toBe(DEFAULT_AXIS_ANGLE_DEG)

    generateSuccessfully(store)
    store.getState().setAxisAngleDeg(45)
    expect(store.getState().input.axisAngleDeg).toBe(45)
    expect(selectIsOrthogonalAxes(store.getState())).toBe(false)
    expect(store.getState().lastResult).toBeNull()

    store.getState().setAxisAngleDeg(1000)
    expect(store.getState().input.axisAngleDeg).toBe(MAX_AXIS_ANGLE_DEG)
  })

  it('視点 A/B の差し替えは C と軸角を保持する', () => {
    store.getState().setSilhouetteC(star)
    store.getState().setAxisAngleDeg(45)
    store.getState().setSilhouetteA(heart)
    const s = store.getState()
    expect(s.input.a).toEqual(heart)
    expect(s.input.c).toEqual(star)
    expect(s.input.axisAngleDeg).toBe(45)
  })

  it('applyInput は入力一式を 1 トランザクションで差し替える（epoch は 1 回だけ進む）', () => {
    const before = store.getState().generationEpoch
    store.getState().applyInput({ a: star, b: heart, c: star, axisAngleDeg: 45 })
    const s = store.getState()
    expect(s.generationEpoch).toBe(before + 1)
    expect(s.input).toEqual({ a: star, b: heart, c: star, axisAngleDeg: 45 })
    expect(selectViewpointCount(s)).toBe(3)
  })

  it('applyInput の省略フィールドは既定（C なし・直交）に落ちる', () => {
    store.getState().applyInput({ a: star, b: heart, c: star, axisAngleDeg: 45 })
    // カタログの 2 視点エントリを適用したら、C と斜交は必ず解除される
    store.getState().applyInput({ a: heart, b: star })
    expect(store.getState().input).toEqual({
      a: heart,
      b: star,
      c: null,
      axisAngleDeg: DEFAULT_AXIS_ANGLE_DEG,
    })
  })

  it('applyInput の軸角も範囲へ丸める', () => {
    store.getState().applyInput({ a: star, b: heart, axisAngleDeg: -30 })
    expect(store.getState().input.axisAngleDeg).toBe(MIN_AXIS_ANGLE_DEG)
  })

  it('resetShapes は C と軸角も初期値へ戻す（FR-006）', () => {
    store.getState().applyInput({ a: star, b: heart, c: star, axisAngleDeg: 45 })
    store.getState().resetShapes()
    expect(store.getState().input).toEqual(INITIAL_INPUT)
    expect(selectViewpointCount(store.getState())).toBe(2)
  })

  it('C を含む入力も 1 段の復帰（lastValidInput）で丸ごと巻き戻る', () => {
    store.getState().applyInput({ a: star, b: heart, c: star, axisAngleDeg: 45 })
    store.getState().inputAccepted(store.getState().generationEpoch)

    store.getState().setSilhouetteC(badSvg)
    store.getState().restoreLastValidInput(store.getState().generationEpoch)
    expect(store.getState().input).toEqual({ a: star, b: heart, c: star, axisAngleDeg: 45 })
  })

  it('視点 C の空帯警告は側を機械可読に持つ', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: 'C に材料がありません',
      band: [0.1, 0.3],
      side: 'C',
    }
    store.getState().setWarnings(store.getState().generationEpoch, [warning])
    const stored = store.getState().warnings[0]
    expect(stored.code).toBe('EMPTY_BAND')
    if (stored.code !== 'EMPTY_BAND') return
    expect(stored.side).toBe('C')
  })
})

describe('警告と結果メタデータ', () => {
  it('setWarnings が警告リストを差し替える（現在の epoch なら反映）', () => {
    store.getState().setWarnings(store.getState().generationEpoch, [
      emptyBandWarning,
    ])
    expect(store.getState().warnings).toHaveLength(1)
    expect(store.getState().warnings[0]!.code).toBe('EMPTY_BAND')
  })

  it('setWarnings は live 帯（FR-101）も同じトランザクションで反映し、入力変更で捨てる', () => {
    const epoch = store.getState().generationEpoch
    store.getState().setWarnings(epoch, [emptyBandWarning], [-0.4, 0.8])
    expect(store.getState().liveYRange).toEqual([-0.4, 0.8])

    // live 帯を渡さない呼び出しは「知らない」であって「据え置き」ではない
    store.getState().setWarnings(store.getState().generationEpoch, [])
    expect(store.getState().liveYRange).toBeNull()

    store.getState().setWarnings(store.getState().generationEpoch, [], [0, 1])
    store.getState().setSilhouetteA(star)
    expect(store.getState().liveYRange).toBeNull()
  })

  it('成功時のメタデータに geometry を含まない（ADR-004）', () => {
    store.getState().wasmReady()
    const epoch = store.getState().startGenerating()
    store.getState().generationSucceeded(epoch!, summary)
    const result = store.getState().lastResult
    expect(result).toEqual(summary)
    expect(result).not.toHaveProperty('geometry')
  })
})
