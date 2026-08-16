/**
 * Zustand ストア（ADR-004 / FR-006 / FR-025）。
 *
 * ## 状態機械（FR-025）
 *
 * ```
 * loading-wasm ──成功──> ready ──入力変更──> generating ──> success
 *      │                   ▲                      │
 *      │                   └──────────────────────┴──> error
 *      └──失敗 / 10s タイムアウト──> init-failed ──再試行──> loading-wasm
 * ```
 *
 * `loading-wasm` は**正常系**であってエラーではない。UI は「準備中」を出し、
 * 出力ボタンを無効化し、**選択済みの入力は受け付けて保持する**
 * （入力系アクションは status に関係なく常に動く）。
 *
 * 許可されない遷移（例：stale なレスポンスによる success 通知）は
 * 例外にせず **no-op** として無視する。世代 ID による stale 破棄
 * （worker/protocol.ts）と二重の防御になる。
 *
 * ## BufferGeometry はここに置かない（ADR-004）
 *
 * CSG 結果の `THREE.BufferGeometry` を store に入れると、参照の差し替えの
 * たびに購読コンポーネントが再レンダリングされ、カメラ操作中の 60fps が
 * 崩れる。geometry 本体は React の外（ref）で保持し、store には
 * **メタデータ（GenerationSummary）だけ**を書く。
 */
import { create } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { StateCreator, StoreApi } from 'zustand/vanilla'
import type { PreflightWarning, SilhouetteSource } from '../geometry/types'
import type { CsgError } from '../worker/protocol'
import { clampHeightMm, DEFAULT_HEIGHT_MM } from '../studio/scale'

/** FR-025 の状態機械。`loading-wasm` はエラーではなく正常系 */
export type StudioStatus =
  | 'loading-wasm'
  | 'ready'
  | 'generating'
  | 'success'
  | 'error'
  | 'init-failed'

/** 視点 A / B の入力ペア。履歴（1 段）もこの単位でスナップショットする */
export interface StudioInput {
  a: SilhouetteSource
  b: SilhouetteSource
}

/** 生成オプション。台座の厚みは FR-015（既定 2.0mm、0.5〜5.0mm） */
export interface StudioOptions {
  /** 仮想ミラー（FR-024） */
  virtualMirror: boolean
  /** 台座（FR-015）。既定で無効 */
  baseplate: { enabled: boolean; thicknessMm: number }
  /** 実寸の共通シルエット高さ mm（FR-029。既定 60、範囲 10〜300） */
  heightMm: number
}

/**
 * 生成結果のメタデータ。geometry 本体は含めない（ADR-004）。
 * `GenerationResult`（geometry/types.ts）から geometry を除いた形。
 */
export interface GenerationSummary {
  /** 連結成分数。2 以上なら印刷時に分離する */
  componentCount: number
  volume: number
  triangleCount: number
  elapsedMs: number
}

/** FR-015 台座厚みの範囲 */
export const MIN_BASEPLATE_MM = 0.5
export const MAX_BASEPLATE_MM = 5.0
export const DEFAULT_BASEPLATE_MM = 2.0

/** FR-006: 「形状をリセット」の初期値。FR-025 の初期生成にも使う */
export const INITIAL_INPUT: StudioInput = {
  a: { kind: 'preset', id: 'square' },
  b: { kind: 'preset', id: 'circle' },
}

export interface StudioState {
  // ---- 状態機械（FR-025） ----
  status: StudioStatus
  /** 直近の失敗。`loading-wasm` では常に null（未準備はエラーではない） */
  lastError: CsgError | null

  // ---- 入力（FR-006） ----
  input: StudioInput
  /**
   * 直前の**受理された**入力ペア。SVG 拒否時の復帰先（FR-006）。
   * ちょうど 1 段のみ保持する。多段 undo はスコープ外。
   */
  lastValidInput: StudioInput

  // ---- オプション ----
  options: StudioOptions

  // ---- 生成結果 ----
  /** プリフライト・生成由来の警告（FR-012） */
  warnings: PreflightWarning[]
  /** 直近の成功した生成のメタデータ。geometry 本体は ref 保持（ADR-004） */
  lastResult: GenerationSummary | null

  // ---- 状態機械のアクション ----
  /** loading-wasm → ready（Wasm 初期化成功） */
  wasmReady: () => void
  /** loading-wasm → init-failed（初期化失敗 / 10s タイムアウト） */
  wasmInitFailed: (detail: string) => void
  /** init-failed → loading-wasm（再試行） */
  retryInit: () => void
  /** ready | success | error → generating（入力変更による再生成） */
  startGenerating: () => void
  /** generating → success */
  generationSucceeded: (summary: GenerationSummary) => void
  /** generating → error */
  generationFailed: (error: CsgError) => void

  // ---- 入力のアクション（status に依存せず常に受理・保持する。FR-025） ----
  setSilhouetteA: (source: SilhouetteSource) => void
  setSilhouetteB: (source: SilhouetteSource) => void
  /** FR-006: 視点 A / B を初期値（正方形 × 円）に戻す */
  resetShapes: () => void
  /**
   * FR-006: 直前の有効な入力へ復帰する（SVG 拒否時）。
   * 履歴は 1 段のみなので、続けて呼んでも 2 段戻ることはない（冪等）。
   */
  restoreLastValidInput: () => void

  // ---- オプションのアクション ----
  setVirtualMirror: (enabled: boolean) => void
  setBaseplateEnabled: (enabled: boolean) => void
  setBaseplateThicknessMm: (mm: number) => void
  /** FR-029 の範囲（10〜300mm、刻み 1mm）へ丸めて反映する */
  setHeightMm: (mm: number) => void

  // ---- 警告 ----
  setWarnings: (warnings: PreflightWarning[]) => void
}

/** 状態機械の遷移表。「現在の状態 → 到達してよい状態」以外は no-op */
const ALLOWED: Record<StudioStatus, readonly StudioStatus[]> = {
  'loading-wasm': ['ready', 'init-failed'],
  ready: ['generating'],
  generating: ['success', 'error'],
  success: ['generating'],
  error: ['generating'],
  'init-failed': ['loading-wasm'],
}

function canTransition(from: StudioStatus, to: StudioStatus): boolean {
  return ALLOWED[from].includes(to)
}

const studioStateCreator: StateCreator<StudioState> = (set, get) => ({
  status: 'loading-wasm',
  lastError: null,
  input: INITIAL_INPUT,
  lastValidInput: INITIAL_INPUT,
  options: {
    virtualMirror: false,
    baseplate: { enabled: false, thicknessMm: DEFAULT_BASEPLATE_MM },
    heightMm: DEFAULT_HEIGHT_MM,
  },
  warnings: [],
  lastResult: null,

  wasmReady: () => {
    if (!canTransition(get().status, 'ready')) return
    set({ status: 'ready' })
  },

  wasmInitFailed: (detail) => {
    if (!canTransition(get().status, 'init-failed')) return
    set({
      status: 'init-failed',
      lastError: { code: 'WASM_INIT_FAILED', detail },
    })
  },

  retryInit: () => {
    if (!canTransition(get().status, 'loading-wasm')) return
    // 再試行で loading-wasm に戻る。未準備はエラーではないので lastError を消す
    set({ status: 'loading-wasm', lastError: null })
  },

  startGenerating: () => {
    if (!canTransition(get().status, 'generating')) return
    set({ status: 'generating' })
  },

  generationSucceeded: (summary) => {
    if (!canTransition(get().status, 'success')) return
    set({ status: 'success', lastResult: summary, lastError: null })
  },

  generationFailed: (error) => {
    if (!canTransition(get().status, 'error')) return
    set({ status: 'error', lastError: error })
  },

  // 入力の受理 = 現在の入力を 1 段だけ履歴に退避してから上書きする。
  // loading-wasm 中でも受理する（FR-025: 選択済みの入力を保持する）
  setSilhouetteA: (source) =>
    set((s) => ({
      input: { a: source, b: s.input.b },
      lastValidInput: s.input,
    })),

  setSilhouetteB: (source) =>
    set((s) => ({
      input: { a: s.input.a, b: source },
      lastValidInput: s.input,
    })),

  resetShapes: () =>
    set((s) => ({
      input: INITIAL_INPUT,
      lastValidInput: s.input,
    })),

  restoreLastValidInput: () =>
    // lastValidInput は据え置く。これにより 2 回目以降の呼び出しは
    // 同じ入力へ戻るだけで、2 段目へは決して戻らない
    set((s) => ({ input: s.lastValidInput })),

  setVirtualMirror: (enabled) =>
    set((s) => ({ options: { ...s.options, virtualMirror: enabled } })),

  setBaseplateEnabled: (enabled) =>
    set((s) => ({
      options: {
        ...s.options,
        baseplate: { ...s.options.baseplate, enabled },
      },
    })),

  setBaseplateThicknessMm: (mm) =>
    set((s) => ({
      options: {
        ...s.options,
        baseplate: {
          ...s.options.baseplate,
          thicknessMm: Number.isFinite(mm)
            ? Math.min(MAX_BASEPLATE_MM, Math.max(MIN_BASEPLATE_MM, mm))
            : DEFAULT_BASEPLATE_MM,
        },
      },
    })),

  setHeightMm: (mm) =>
    set((s) => ({ options: { ...s.options, heightMm: clampHeightMm(mm) } })),

  setWarnings: (warnings) => set({ warnings }),
})

/**
 * テスト・非 React 環境用のファクトリ。毎回独立した vanilla store を返す。
 * テストはこれで作った store の `getState()` からアクションを直接呼ぶ。
 */
export function createStudioStore(): StoreApi<StudioState> {
  return createStore<StudioState>()(studioStateCreator)
}

/** アプリ本体が使う React フック（getState / setState / subscribe も持つ） */
export const useStudioStore = create<StudioState>()(studioStateCreator)

// ---- セレクタ ----

/**
 * 出力（STL / GLB / USDZ）ボタンを有効にしてよいか。
 * 成功した結果があるときだけ true。`loading-wasm` は正常系だが
 * まだ出力できないので false（FR-025: 出力ボタン無効）。
 */
export function selectCanExport(state: StudioState): boolean {
  return state.status === 'success' && state.lastResult !== null
}

/**
 * エラーとして提示すべき状態か。**`loading-wasm` は含めない**
 * （FR-025: 未準備状態をエラーとして提示しない）。
 */
export function selectIsErrorState(state: StudioState): boolean {
  return state.status === 'error' || state.status === 'init-failed'
}
