/**
 * アプリシェル（Task 4.1 / Wave 5 配線）。生成パイプラインをここで**ちょうど 1 回**
 * 起動し、サイドバー（src/ui）とビューポート（src/scene）を接続する。
 *
 * このファイルが 2 つの Wave 5 エージェントの接合点であり、どちらにも
 * 所有させていない（同一ファイルの奪い合いを避けるため — tasks.md の所有権の原則）。
 * ここで繋ぐのは 3 本だけ：
 *
 * - ジオメトリ … `geometryRef`（ADR-004。React state を経由しない）
 * - カメラ操作 … `useViewerStore.requestSnap`（UI → scene）
 * - 合致状態 … `useViewerStore.matched`（scene → UI）
 */
import { useCallback, useMemo } from 'react'

import { Sidebar } from './ui/Sidebar'
import { Viewport } from './scene/Viewport'
import { useViewerStore, type SnapView } from './scene/SweetSpot'
import { useGenerationPipeline } from './studio/useGenerationPipeline'

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

function App() {
  const { geometryRef, retry } = useGenerationPipeline()
  const requestSnap = useViewerStore((s) => s.requestSnap)
  const sweetSpot = useSweetSpotProps()

  const handleSnapView = useCallback((view: SnapView) => requestSnap(view), [requestSnap])
  // FR-006 の「視点をリセット」は俯瞰へのスナップと同じ操作
  const handleResetView = useCallback(() => requestSnap('iso'), [requestSnap])

  return (
    /*
      レイアウト（FR-026 / Task 7.1）。**モバイルが既定**で、768px 以上
      （Tailwind の `md:`）から従来の 2 カラムに戻る：

      - 〜767px: `flex-col-reverse` の縦積み。DOM 順は aside → main のまま
        （キーボードと支援技術は先にコントロールへ入る）だが、描画はサイド
        バーが下端の**ボトムシート**になる。高さは 45dvh に固定し、3D
        ビューポートに 55dvh —「画面の過半」を渡す
      - 768px〜: 左 320px のサイドバー + 残り全部のビューポート（従来どおり）

      高さの単位は `dvh`。iOS Safari の `vh` は URL バーが隠れている前提の
      値なので、`100vh` だとツールバー表示時にシート下端が画面外へ潜り、
      セーフエリア回避（FR-026）ごと無効になる。
    */
    <div className="flex h-dvh flex-col-reverse overflow-hidden bg-neutral-950 text-neutral-100 md:flex-row">
      <aside
        aria-label="コントロールサイドバー"
        className="h-[45dvh] w-full shrink-0 border-t border-neutral-800 md:h-full md:w-80 md:border-t-0 md:border-r"
      >
        <Sidebar
          onRetryInit={retry}
          onResetView={handleResetView}
          onSnapView={handleSnapView}
          geometryRef={geometryRef}
          sweetSpot={sweetSpot}
        />
      </aside>
      <main aria-label="3D ビューポート" className="min-h-0 min-w-0 flex-1">
        <Viewport geometryRef={geometryRef} />
      </main>
    </div>
  )
}

// main.tsx（Wave 1 所有）が default import で参照するため default を維持する
export default App
