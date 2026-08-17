/**
 * 表示モードの状態（FR-103「主従の入れ替え」）。
 *
 * このアプリはカタログ（既定） / 自由な組み合わせ / パズルの 3 モードを持つ。
 * どれを見せるかは App.tsx の関心事だが、その切り替えロジック自体は DOM にも
 * ストアにも依存しない純粋なリデューサーとして切り出す — これが
 * `illusion-catalogue.md` FR-103 の「カタログを主たる入口として提示し、
 * 任意ペアの自由な組み合わせは副次的な手段として提供する」の実体であり、
 * 「主役が何か」はテストで固定できる（{@link INITIAL_MODE_STATE} が
 * `catalogue` であること）。
 *
 * UI 側（App.tsx）はこれを `useReducer(modeReducer, INITIAL_MODE_STATE)` で
 * 使う。タブの並び・ラベルもここに置き、UI とテストの両方が同じ 1 つの
 * 定義を参照する。
 */

/** 表示モード。既定は `catalogue`（FR-103 の本体） */
export type StudioMode = 'catalogue' | 'free' | 'puzzle'

/** モードの表示順（= タブの並び順）。カタログが常に先頭 */
export const STUDIO_MODES: readonly StudioMode[] = ['catalogue', 'free', 'puzzle']

/**
 * モードのタブラベル（日本語）。
 *
 * **3 つとも 6 文字以内に収める。** タブは横並びで幅が限られており、
 * 1 つでも長いとそこだけ 2 行に折り返して並びが崩れる（「自由に組み合わせる」
 * が実際にそうなっていた）。折り返しは狭い画面ほど早く起きるので、
 * 短くしておくことがそのままモバイル対応になる。
 */
export const MODE_LABELS: Record<StudioMode, string> = {
  catalogue: '錯視カタログ',
  free: '自由に作る',
  puzzle: 'クイズ',
}

export interface ModeState {
  mode: StudioMode
}

/** 既定モード。**カタログ**が最初に見える体験そのもの（FR-103） */
export const INITIAL_MODE_STATE: ModeState = { mode: 'catalogue' }

export type ModeAction = { type: 'mode-selected'; mode: StudioMode }

/**
 * モード切り替えの純粋なリデューサー。DOM にもストアにも触れない。
 * 同じモードへの選択は参照を変えない（無駄な再レンダーを避ける）。
 */
export function modeReducer(state: ModeState, action: ModeAction): ModeState {
  switch (action.type) {
    case 'mode-selected':
      return state.mode === action.mode ? state : { mode: action.mode }
    default: {
      // 判別共用体を網羅していない呼び出しはコンパイル時に弾かれる（puzzle.ts と同じ方針）
      const exhaustiveCheck: never = action.type
      throw new Error(`未知の ModeAction です: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}
