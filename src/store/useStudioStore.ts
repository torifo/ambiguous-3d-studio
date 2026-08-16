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
 * 例外にせず **no-op** として無視する。
 *
 * ## 生成世代（generationEpoch）と stale 破棄（US-001）
 *
 * 入力を変更した瞬間、直前の生成結果は「最新の入力に対応する結果」では
 * なくなる。そこで store は入力変更のたびに `generationEpoch` を進め、
 * **同じ set() の中で** `lastResult` / `warnings` を破棄し、status を
 * success / error から外す（出力ボタンは即座に無効化される）。
 *
 * 非同期の書き戻し（`generationSucceeded` / `generationFailed` /
 * `inputAccepted` / `restoreLastValidInput` / `setWarnings`）は発行時点の
 * epoch を持参し、現在値と一致しない場合は stale として無視する。
 * これにより「古い入力への遅延レスポンスが最新の結果として蘇る」ことは
 * 状態遷移表とは独立に遮断される（worker/client.ts の世代 ID 管理と
 * 二重の防御になる）。
 *
 * パイプライン（studio/ 側のオーケストレーション）が守るべき契約：
 * 1. 入力変更の直後に `generationEpoch` を捕捉し、解析・正規化の結果を
 *    その epoch で書き戻す — 成功なら `inputAccepted(epoch)`、
 *    拒否なら `restoreLastValidInput(epoch)`（FR-006）
 * 2. その後 `startGenerating()` を呼び、**戻り値の epoch** を Worker 応答の
 *    `generationSucceeded` / `generationFailed` に渡す（null なら開始不可）
 * 3. 開始した生成 1 回につき終端通知（succeeded / failed）をちょうど 1 回
 *    届ける。superseded で棄却されるのは構わないが、最新 epoch の生成には
 *    必ず終端通知を返す（さもないとスピナーが止まらない）
 * 4. `restoreLastValidInput` で入力が巻き戻った後も再生成を起動する
 *    （復帰した入力に対応するメッシュはまだ描画されていない）
 *
 * geometry 本体（BufferGeometry）は store の外（ref）にあるため、入力変更で
 * 古い geometry を破棄・差し替えるのは studio/ のオーケストレーション責務
 * （ADR-004）。store の責務は「stale な geometry が最新に見える状態を決して
 * 報告しない」こと（status / lastResult / 出力可否）まで。
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

  /**
   * 生成世代。入力変更のたび、および generating 中の再スタート
   * （supersede）のたびに増える単調カウンタ。epoch を持参する
   * アクションは、現在値と一致しない場合 stale として無視される。
   */
  generationEpoch: number

  // ---- 入力（FR-006） ----
  input: StudioInput
  /**
   * 直前の**受理された**入力ペア。SVG 拒否時の復帰先（FR-006）。
   * ちょうど 1 段のみ保持する。多段 undo はスコープ外。
   * 更新されるのは `inputAccepted` 経由のみ — 未検証の候補入力が
   * ここに昇格することは決してない。
   */
  lastValidInput: StudioInput

  // ---- オプション ----
  options: StudioOptions

  // ---- 生成結果 ----
  /** プリフライト・生成由来の警告（FR-012）。入力変更で破棄される */
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
  /**
   * ready | success | error → generating、または generating → generating
   * （supersede：実行中の生成を新しい世代で置き換える）。
   * 戻り値はこの生成が属する epoch。呼び出し側はこれを捕捉して
   * `generationSucceeded` / `generationFailed` に渡すこと。
   * loading-wasm / init-failed からは開始できず null を返す（no-op）。
   */
  startGenerating: () => number | null
  /**
   * generating → success。`epoch` が現在の generationEpoch と一致しない
   * 場合（superseded な入力への遅延レスポンス）は無視する — 古い結果が
   * 出力可能として蘇ることはない（US-001）。
   */
  generationSucceeded: (epoch: number, summary: GenerationSummary) => void
  /** generating → error。epoch 不一致（stale）は無視する */
  generationFailed: (epoch: number, error: CsgError) => void

  // ---- 入力のアクション（status に依存せず常に受理・保持する。FR-025） ----
  // いずれも「入力変更」であり、同じ set() の中で直前の生成結果を破棄する
  setSilhouetteA: (source: SilhouetteSource) => void
  setSilhouetteB: (source: SilhouetteSource) => void
  /** FR-006: 視点 A / B を初期値（正方形 × 円）に戻す */
  resetShapes: () => void
  /**
   * 現在の入力が解析・正規化を通過した（= 受理された）ことの通知。
   * パイプラインが呼ぶ。`epoch` が現在値と一致するときだけ現在の入力を
   * `lastValidInput` へ昇格する。不一致（受理判定より後にユーザーが
   * 再編集している）なら無視する — さもないと現在の**未検証**入力を
   * 「有効」として昇格してしまう。
   */
  inputAccepted: (epoch: number) => void
  /**
   * FR-006: 直前の有効な入力へ復帰する（SVG 拒否時）。
   * `epoch` は拒否された入力の世代。現在値と一致しない場合
   * （拒否が届く前にユーザーが再編集している）は無視する — 遅延した
   * 拒否が最新の編集を上書きしてはならない。
   * 復帰自体も入力変更なので epoch が進み、生成結果は破棄される。
   * `lastValidInput` は据え置くため、続けて呼んでも 2 段戻ることはない。
   */
  restoreLastValidInput: (epoch: number) => void

  // ---- オプションのアクション ----
  setVirtualMirror: (enabled: boolean) => void
  setBaseplateEnabled: (enabled: boolean) => void
  setBaseplateThicknessMm: (mm: number) => void
  /** FR-029 の範囲（10〜300mm、刻み 1mm）へ丸めて反映する */
  setHeightMm: (mm: number) => void

  // ---- 警告 ----
  /**
   * 警告リストの差し替え。`epoch` は警告の算出を始めた時点の世代。
   * 不一致（stale なプリフライト結果）は無視する — 古い入力の警告が
   * 最新の入力の警告として表示されることはない。
   */
  setWarnings: (epoch: number, warnings: PreflightWarning[]) => void
}

/** 状態機械の遷移表。「現在の状態 → 到達してよい状態」以外は no-op */
const ALLOWED: Record<StudioStatus, readonly StudioStatus[]> = {
  'loading-wasm': ['ready', 'init-failed'],
  ready: ['generating'],
  // generating → generating は supersede（実行中の生成の置き換え）
  generating: ['success', 'error', 'generating'],
  success: ['generating'],
  error: ['generating'],
  'init-failed': ['loading-wasm'],
}

function canTransition(from: StudioStatus, to: StudioStatus): boolean {
  return ALLOWED[from].includes(to)
}

/**
 * 入力変更に伴う無効化（US-001: 入力を変更したら直前の生成結果を破棄する）。
 * 入力を書き換えるアクションは必ずこれを**同じ set() に**混ぜること。
 *
 * - epoch を進める → 実行中・応答待ちの stale な書き戻しをすべて棄却する
 * - lastResult / warnings を破棄 → 古いメタデータ・警告が最新に見えない
 * - success | error → ready：出力ボタンを即座に無効化し、エラー表示も
 *   古い入力のものなので取り下げる
 * - generating はそのまま：スピナーを維持しつつ、実行中の生成は epoch
 *   不一致で棄却される。パイプラインが最新入力で startGenerating() し直す
 * - loading-wasm / init-failed もそのまま（FR-025: 入力は保持のみ）
 *
 * 外部 ref に保持されている古い BufferGeometry の破棄は studio/ の責務
 * （ADR-004）。ここでは「stale が最新に見える報告」を断つ。
 */
function invalidateForInputChange(s: StudioState): Partial<StudioState> {
  const base = {
    generationEpoch: s.generationEpoch + 1,
    lastResult: null,
    warnings: [] as PreflightWarning[],
  }
  if (s.status === 'success' || s.status === 'error') {
    return { ...base, status: 'ready' as const, lastError: null }
  }
  return base
}

const studioStateCreator: StateCreator<StudioState> = (set, get) => ({
  status: 'loading-wasm',
  lastError: null,
  generationEpoch: 0,
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
    const s = get()
    if (!canTransition(s.status, 'generating')) return null
    if (s.status === 'generating') {
      // supersede：実行中の生成を新しい世代で置き換える。古い方の
      // 終端通知は epoch 不一致で棄却されるため、no-op にしない
      const epoch = s.generationEpoch + 1
      set({ status: 'generating', generationEpoch: epoch })
      return epoch
    }
    set({ status: 'generating' })
    return s.generationEpoch
  },

  generationSucceeded: (epoch, summary) => {
    const s = get()
    // stale（superseded な入力/生成への遅延レスポンス）は無視する。
    // これを通すと、古い入力のメッシュが「最新・出力可能」として蘇る
    if (epoch !== s.generationEpoch) return
    if (!canTransition(s.status, 'success')) return
    set({ status: 'success', lastResult: summary, lastError: null })
  },

  generationFailed: (epoch, error) => {
    const s = get()
    if (epoch !== s.generationEpoch) return
    if (!canTransition(s.status, 'error')) return
    set({ status: 'error', lastError: error })
  },

  // 入力の書き換え = 候補の受理。直前の生成結果は同じ set() で破棄する。
  // loading-wasm 中でも受理する（FR-025: 選択済みの入力を保持する）。
  // lastValidInput はここでは触らない — 昇格は inputAccepted 経由のみ
  setSilhouetteA: (source) =>
    set((s) => ({
      ...invalidateForInputChange(s),
      input: { a: source, b: s.input.b },
    })),

  setSilhouetteB: (source) =>
    set((s) => ({
      ...invalidateForInputChange(s),
      input: { a: s.input.a, b: source },
    })),

  resetShapes: () =>
    set((s) => ({
      ...invalidateForInputChange(s),
      input: INITIAL_INPUT,
    })),

  inputAccepted: (epoch) => {
    const s = get()
    // stale な受理通知（受理判定より後に再編集済み）は無視する
    if (epoch !== s.generationEpoch) return
    set({ lastValidInput: s.input })
  },

  restoreLastValidInput: (epoch) => {
    const s = get()
    // stale な拒否（拒否が届く前に再編集済み）による復帰は無視する
    if (epoch !== s.generationEpoch) return
    // lastValidInput は据え置く。これにより 2 回目以降の呼び出しは
    // 同じ入力へ戻るだけで、2 段目へは決して戻らない
    set({
      ...invalidateForInputChange(s),
      input: s.lastValidInput,
    })
  },

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

  setWarnings: (epoch, warnings) => {
    // stale なプリフライト結果（算出開始後に入力が変わった）は無視する
    if (epoch !== get().generationEpoch) return
    set({ warnings })
  },
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
 * 入力を変更した瞬間に status が success から外れるため、stale な
 * geometry が出力可能に見えることはない（US-001）。
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
