/**
 * アプリシェル（Task 4.1 / Wave 5 配線 → FR-100 / FR-103 で主従を入れ替え）。
 *
 * 生成パイプラインをここで**ちょうど 1 回**起動し、3 つのモード（カタログ /
 * 自由な組み合わせ / パズル）とビューポート（src/scene）を接続する。
 *
 * ## 3 モードとカタログの主従（FR-103「方向転換の本体」）
 *
 * `illusion-catalogue.md` の方向転換はここに集約される: このアプリは
 * 「任意の 2 シルエットを交差させる汎用ジェネレーター」から「既知の錯視立体を
 * 再現・体験・出力するサイト」へ主従を入れ替える。**その入れ替えは
 * 「最初に何が見えるか」で決まる** — 実装としては `ui/modeStore.ts` の
 * `INITIAL_MODE_STATE` が `catalogue` であること、ただ 1 点に宿る。
 *
 * - `catalogue`（既定）: `ui/Gallery.tsx`。FR-100 の入口そのもの
 * - `free`: 旧来の `<Sidebar />`（このアプリが以前は主役として見せていたもの）。
 *   そのまま・無編集で残す — 消すのではなく「副次的な手段」に格下げする
 * - `puzzle`: `ui/PuzzlePanel.tsx`。副次要素の副次要素（隠しおまけ）
 *
 * モード切り替えは `ui/modeStore.ts` の純粋なリデューサーで持つ。ズストアの
 * ストア（useStudioStore）に混ぜないのは、これがアプリ入力の一部ではなく
 * 「何を見せているか」という UI 専用の状態だからで、`useStudioStore` の
 * 入力を汚染しない。
 *
 * ## ステータス面は 3 モード共通（アドバイザリレビュー Finding 1 の是正）
 *
 * `<StatusBanner />`（生成中／生成完了・`EMPTY_RESULT` の説明・プリフライト
 * 警告・パーツ数・`init-failed` と再試行ボタン）は元々 `Sidebar` の内部にしか
 * なく、`Sidebar` は `mode === 'free'` のときしかマウントされない。既定モードは
 * `catalogue` なので、100% のユーザーが最初に着地する画面には `role="status"` も
 * `aria-live` も一切存在せず、FR-025 が要求する `init-failed` の再試行導線が
 * 到達不能になっていた。
 *
 * ここでは `<AppHeader />` として `<StatusBanner />` を aside の先頭
 * （`<ModeTabs />` の直後）へ**追加**する。ただし `mode === 'free'` のときは
 * 描画しない — `Sidebar` は無編集で残す方針（このタスクの制約）なので
 * `Sidebar` 自身の `<StatusBanner />` を消せない。両方を同時に出すと同じ
 * `role="status"` / `aria-live="polite"` リージョンが 2 つ並び、支援技術が同じ
 * 内容を二重に読み上げる。「今マウントされている方が唯一の状態面」という
 * 不変条件を保つため、`AppHeader` 側は `free` のときだけ自分を消して
 * `Sidebar` 側に譲る（ちょうどモードパネルが 1 つしかマウントしないのと同じ発想）。
 *
 * ## ジオメトリ・カメラ・合致状態はモードを跨いで共有する
 *
 * - ジオメトリ … `geometryRef`（ADR-004。React state を経由しない）。
 *   3 モードとも**同じ**ビューポートに描く — カタログがプリセットを、
 *   パズルが出題ペアを、自由モードがユーザー入力を、それぞれ同じ
 *   `useStudioStore.applyInput` / `setSilhouetteX` 経由でストアへ書き込むだけで、
 *   Viewport 側は何も知らずに済む
 * - カメラ操作 … `useViewerStore.requestSnap`（UI → scene）
 * - 合致状態 … `useViewerStore.matched`（scene → UI）。`free` モードでのみ
 *   Sidebar が SweetSpotIndicator として使う
 */
import { useCallback, useMemo, useReducer, useRef } from 'react'
import type { KeyboardEvent } from 'react'

import { Sidebar } from './ui/Sidebar'
import { Gallery } from './ui/Gallery'
import { PuzzlePanel } from './ui/PuzzlePanel'
import { StatusBanner } from './ui/StatusBanner'
import { Viewport } from './scene/Viewport'
import { useViewerStore, type SnapView } from './scene/SweetSpot'
import { useGenerationPipeline } from './studio/useGenerationPipeline'
import {
  INITIAL_MODE_STATE,
  MODE_LABELS,
  STUDIO_MODES,
  modeReducer,
  type StudioMode,
} from './ui/modeStore'

/**
 * 合致状態を SweetSpotIndicator の props に変換する。
 *
 * `matched` は**離散イベント**（合致した / 外れた）なので購読してよい。
 * 一方、毎フレーム変わる角度差（`sweetSpotLiveAngles`）は React state にも
 * props にも載せない — 載せると 60fps ぶんの再レンダリングが発生し
 * NFR-002 を壊す。FR-021 の「リアルタイム表示」は Viewport の `useFrame` が
 * インジケーターの DOM ノードへ直接書き込む経路で満たしてある
 * （scene/SweetSpot.ts の `setLiveAngleSink` / ui/SweetSpotIndicator.tsx）。
 * したがってこのフックが返すのは**離散状態だけ**であり、カメラを動かしても
 * 合致が切り替わらない限り再レンダリングは 1 回も起きない。
 */
function useSweetSpotProps() {
  const matched = useViewerStore((s) => s.matched)
  return useMemo(() => ({ target: matched, matched: matched !== null }), [matched])
}

/**
 * モード切り替えタブ（FR-103）。既存の WAI-ARIA tabs パターン
 * （SilhouettePicker.tsx: roving tabindex + 矢印キー / Home / End、
 * クリックと矢印移動の両方で即座に切り替わる自動活性化）をそのまま踏襲する
 * — タスクの指示どおり、ここで新しいパターンは発明しない。
 *
 * パネル側はタブごとに 1 つの `role="tabpanel"` を、現在のモードだけ描画する
 * （3 パネルとも常時マウントする SilhouettePicker とは異なる構成）。
 * カタログ / 自由 / パズルはそれぞれ独立した重いローカル状態
 * （Gallery の選択強調、Sidebar 一式、PuzzlePanel のタイマーと出題）を持ち、
 * 同時に 3 つとも生かしておく理由がない — 特にパズルは「シルエットピッカーを
 * 画面に出さない」ことが要件なので、そもそも `<Sidebar />` を裏で
 * マウントしたままにはできない。
 *
 * `role="tabpanel"` は現在のモードの分しか存在せず、その `id` はモードが
 * 変わるたびに変わる（`mode-panel-${mode}`）。そのため非活性タブの
 * `aria-controls` が指す id は DOM のどこにも存在しない（ダングリング参照。
 * アドバイザリレビュー Finding 4）。`SilhouettePicker.tsx` のように全パネルを
 * `hidden` 属性つきで常時マウントする手もあるが、それには上記の「パズルで
 * `Sidebar` を裏にも出せない」という制約と真っ向から対立する。したがって
 * ここでは `aria-controls` を**活性タブにだけ**付け、非活性タブでは省略する
 * — 存在しない id を参照しないという最小の修正。`aria-selected` /
 * `role="tabpanel"` の `aria-labelledby` の対応関係は変えていないので、
 * 選択の伝達と読み上げの契約は保ったまま。
 */
function ModeTabs(props: { mode: StudioMode; onSelect: (mode: StudioMode) => void }) {
  const { mode, onSelect } = props
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (index + 1) % STUDIO_MODES.length
    else if (event.key === 'ArrowLeft') next = (index + STUDIO_MODES.length - 1) % STUDIO_MODES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = STUDIO_MODES.length - 1
    if (next === null) return
    event.preventDefault()
    onSelect(STUDIO_MODES[next])
    tabRefs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="表示モード"
      className="flex shrink-0 gap-1 border-b border-neutral-800 pt-4 pb-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
    >
      {STUDIO_MODES.map((m, index) => (
        <button
          key={m}
          ref={(el) => {
            tabRefs.current[index] = el
          }}
          type="button"
          role="tab"
          id={`mode-tab-${m}`}
          aria-selected={mode === m}
          // 非活性タブでは付けない（上記コメント参照。mode-panel-${m} は
          // 活性モードのものしか DOM に存在しないため、常に付けると
          // 2 タブぶんダングリング参照になる）
          aria-controls={mode === m ? `mode-panel-${m}` : undefined}
          tabIndex={mode === m ? 0 : -1}
          onClick={() => onSelect(m)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          className="min-h-11 flex-1 rounded border border-neutral-700 px-1.5 text-[11px] text-neutral-400 aria-selected:border-sky-400 aria-selected:bg-sky-400/10 aria-selected:text-sky-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  )
}

/**
 * 3 モード共通のステータス面（アドバイザリレビュー Finding 1 / Finding 4）。
 *
 * 持たせるのは 2 つだけ：
 * - 製品名の `<h1>`。従来は `Sidebar` の内部にしかなく、`free` 以外のモード
 *   （既定の `catalogue` を含む）では画面のどこにも製品名が出ていなかった
 * - `<StatusBanner />`。生成中／生成完了・`EMPTY_RESULT` の説明・プリフライト
 *   警告・パーツ数・`init-failed` の再試行ボタンをまとめて持つ、唯一の
 *   `role="status"` / `aria-live` リージョン一式
 *
 * `mode === 'free'` のときは何も描画しない。`Sidebar`（無編集で残す方針）が
 * 同じ内容（同じ `<h1>Ambiguous 3D Studio</h1>` と同じ `<StatusBanner />`）を
 * 自前で持っているため、ここでも描画すると見出しが 2 つ・生成ステータスの
 * live リージョンが 2 つ同時に存在し、支援技術が同じ内容を二重に読み上げる。
 * 「今どのモードでも状態面はちょうど 1 つ」という不変条件は、モードパネルが
 * 常に 1 つしかマウントされないのと同じ考え方で保っている。
 */
function AppHeader(props: { mode: StudioMode; onRetryInit: () => void }) {
  const { mode, onRetryInit } = props
  if (mode === 'free') return null
  return (
    <div className="shrink-0 border-b border-neutral-800 pt-3 pb-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <h1 className="text-sm font-semibold tracking-wide text-neutral-100">Ambiguous 3D Studio</h1>
      <div className="mt-2">
        <StatusBanner onRetryInit={onRetryInit} />
      </div>
    </div>
  )
}

function App() {
  const { geometryRef, retry } = useGenerationPipeline()
  const requestSnap = useViewerStore((s) => s.requestSnap)
  const sweetSpot = useSweetSpotProps()
  const [modeState, dispatchMode] = useReducer(modeReducer, INITIAL_MODE_STATE)
  const { mode } = modeState

  const handleSnapView = useCallback((view: SnapView) => requestSnap(view), [requestSnap])
  // FR-006 の「視点をリセット」は俯瞰へのスナップと同じ操作
  const handleResetView = useCallback(() => requestSnap('iso'), [requestSnap])
  const handleModeSelect = useCallback(
    (next: StudioMode) => dispatchMode({ type: 'mode-selected', mode: next }),
    [],
  )

  return (
    /*
      レイアウト（FR-026 / Task 7.1、維持）。**モバイルが既定**で、768px 以上
      （Tailwind の `md:`）から従来の 2 カラムに戻る：

      - 〜767px: `flex-col-reverse` の縦積み。DOM 順は aside → main のまま
        （キーボードと支援技術は先にコントロールへ入る）だが、描画はサイド
        バーが下端の**ボトムシート**になる。高さは 45dvh に固定し、3D
        ビューポートに 55dvh —「画面の過半」を渡す
      - 768px〜: 左 320px のサイドバー + 残り全部のビューポート（従来どおり）

      高さの単位は `dvh`。iOS Safari の `vh` は URL バーが隠れている前提の
      値なので、`100vh` だとツールバー表示時にシート下端が画面外へ潜り、
      セーフエリア回避（FR-026）ごと無効になる。

      この外枠・高さ・順序は今回のモード追加でも変更していない
      （変えたのは aside の**中身**だけ — 下記コメント参照）。
    */
    <div className="flex h-dvh flex-col-reverse overflow-hidden bg-neutral-950 text-neutral-100 md:flex-row">
      <aside
        aria-label="コントロールサイドバー"
        className="flex h-[45dvh] w-full shrink-0 flex-col overflow-hidden border-t border-neutral-800 md:h-full md:w-80 md:border-t-0 md:border-r"
      >
        {/*
          モードタブ（新規）は aside の先頭に固定し、その下の 1 パネルだけが
          残り高さいっぱいに広がって内部スクロールする（`min-h-0 flex-1`）。
          Sidebar 自身は `h-full` 前提の作り（無編集で流用するため）なので、
          この flex 構成で初めて元どおりのサイズ計算が成立する。
        */}
        <ModeTabs mode={mode} onSelect={handleModeSelect} />
        <AppHeader mode={mode} onRetryInit={retry} />
        <div
          role="tabpanel"
          id={`mode-panel-${mode}`}
          aria-labelledby={`mode-tab-${mode}`}
          className="min-h-0 flex-1"
        >
          {mode === 'catalogue' && <Gallery />}
          {mode === 'free' && (
            <Sidebar
              onRetryInit={retry}
              onResetView={handleResetView}
              onSnapView={handleSnapView}
              geometryRef={geometryRef}
              sweetSpot={sweetSpot}
            />
          )}
          {mode === 'puzzle' && <PuzzlePanel />}
        </div>
      </aside>
      <main aria-label="3D ビューポート" className="min-h-0 min-w-0 flex-1">
        <Viewport geometryRef={geometryRef} />
      </main>
    </div>
  )
}

// main.tsx（Wave 1 所有）が default import で参照するため default を維持する
export default App
