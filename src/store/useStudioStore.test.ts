/**
 * store は React を経由せず vanilla API（createStudioStore）で直接テストする。
 * テスト環境は node（DOM なし）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import {
  createStudioStore,
  INITIAL_INPUT,
  selectCanExport,
  selectIsErrorState,
  type GenerationSummary,
  type StudioState,
} from './useStudioStore'
import type { SilhouetteSource } from '../geometry/types'

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

let store: StoreApi<StudioState>

beforeEach(() => {
  store = createStudioStore()
})

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

  it('警告・エラー・結果は空', () => {
    const s = store.getState()
    expect(s.warnings).toEqual([])
    expect(s.lastError).toBeNull()
    expect(s.lastResult).toBeNull()
  })
})

describe('FR-025 状態機械 — 全遷移', () => {
  it('loading-wasm → ready → generating → success', () => {
    store.getState().wasmReady()
    expect(store.getState().status).toBe('ready')

    store.getState().startGenerating()
    expect(store.getState().status).toBe('generating')

    store.getState().generationSucceeded(summary)
    const s = store.getState()
    expect(s.status).toBe('success')
    expect(s.lastResult).toEqual(summary)
    expect(s.lastError).toBeNull()
  })

  it('generating → error', () => {
    store.getState().wasmReady()
    store.getState().startGenerating()
    store.getState().generationFailed({ code: 'EMPTY_RESULT' })
    const s = store.getState()
    expect(s.status).toBe('error')
    expect(s.lastError).toEqual({ code: 'EMPTY_RESULT' })
  })

  it('error → generating（入力変更で再生成できる）', () => {
    store.getState().wasmReady()
    store.getState().startGenerating()
    store.getState().generationFailed({ code: 'EMPTY_RESULT' })
    store.getState().startGenerating()
    expect(store.getState().status).toBe('generating')
  })

  it('success → generating（入力変更で再生成できる）', () => {
    store.getState().wasmReady()
    store.getState().startGenerating()
    store.getState().generationSucceeded(summary)
    store.getState().startGenerating()
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

  it('許可されない遷移は no-op（stale なレスポンスなど）', () => {
    // ready のまま success 通知が来ても無視する
    store.getState().wasmReady()
    store.getState().generationSucceeded(summary)
    expect(store.getState().status).toBe('ready')
    expect(store.getState().lastResult).toBeNull()

    // loading-wasm 以外からの wasmReady も無視する
    store.getState().startGenerating()
    store.getState().wasmReady()
    expect(store.getState().status).toBe('generating')

    // loading-wasm 中は生成を開始できない
    const fresh = createStudioStore()
    fresh.getState().startGenerating()
    expect(fresh.getState().status).toBe('loading-wasm')
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
    store.getState().startGenerating()
    expect(selectCanExport(store.getState())).toBe(false)
    store.getState().generationSucceeded(summary)
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

describe('FR-006 — リセットと直前入力の復帰', () => {
  it('resetShapes() で正方形 × 円に戻る', () => {
    store.getState().setSilhouetteA(star)
    store.getState().setSilhouetteB(heart)
    store.getState().resetShapes()
    expect(store.getState().input).toEqual(INITIAL_INPUT)
  })

  it('SVG 拒否 → restoreLastValidInput() で直前の有効入力に戻る', () => {
    // 有効な入力を受理
    store.getState().setSilhouetteA(star)
    // 後に拒否される SVG がいったん受理される
    store.getState().setSilhouetteA(badSvg)
    expect(store.getState().input.a).toEqual(badSvg)

    // パイプラインが SVG を拒否 → 復帰
    store.getState().restoreLastValidInput()
    expect(store.getState().input.a).toEqual(star)
    expect(store.getState().input.b).toEqual(INITIAL_INPUT.b)
  })

  it('履歴は 1 段のみ — 続けて呼んでも 2 段戻らない', () => {
    store.getState().setSilhouetteA(star) // 1 段目（square → star）
    store.getState().setSilhouetteA(badSvg) // 2 段目（star → badSvg）

    store.getState().restoreLastValidInput()
    expect(store.getState().input.a).toEqual(star)

    // もう一度呼んでも star のまま。square（2 段前）へは戻らない
    store.getState().restoreLastValidInput()
    expect(store.getState().input.a).toEqual(star)
  })

  it('B 側の変更も履歴になる', () => {
    store.getState().setSilhouetteB(heart)
    store.getState().setSilhouetteB(badSvg)
    store.getState().restoreLastValidInput()
    expect(store.getState().input.b).toEqual(heart)
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

describe('警告と結果メタデータ', () => {
  it('setWarnings が警告リストを差し替える', () => {
    store.getState().setWarnings([
      {
        code: 'EMPTY_BAND',
        certainty: 'exact',
        message: 'この高さで立体が途切れます',
        band: [0.4, 0.6],
      },
    ])
    expect(store.getState().warnings).toHaveLength(1)
    expect(store.getState().warnings[0]!.code).toBe('EMPTY_BAND')
  })

  it('成功時のメタデータに geometry を含まない（ADR-004）', () => {
    store.getState().wasmReady()
    store.getState().startGenerating()
    store.getState().generationSucceeded(summary)
    const result = store.getState().lastResult
    expect(result).toEqual(summary)
    expect(result).not.toHaveProperty('geometry')
  })
})
