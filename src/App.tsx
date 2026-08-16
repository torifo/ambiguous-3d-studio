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
import { useCallback } from 'react'

import { Sidebar } from './ui/Sidebar'
import { Viewport } from './scene/Viewport'
import { useViewerStore, sweetSpotLiveAngles, type SnapView } from './scene/SweetSpot'
import { useGenerationPipeline } from './studio/useGenerationPipeline'

/**
 * 合致状態を SweetSpotIndicator の props に変換する。
 *
 * `matched` は**離散イベント**（合致した / 外れた）なので購読してよい。
 * 一方 `sweetSpotLiveAngles` は毎フレーム更新されるため、React state に
 * 載せると 60fps ぶんの再レンダリングが発生し NFR-002 を壊す。ここでは
 * 合致が変化した時点の値をサンプリングするに留める。
 *
 * 連続的な角度表示（FR-021 の「リアルタイムに表示」）は、React を経由せず
 * DOM を直接更新する必要がある。scene 側が `sweetSpotLiveAngles` を
 * 非リアクティブに公開しているのはそのためで、配線はまだ入れていない。
 */
function useSweetSpotProps() {
  const matched = useViewerStore((s) => s.matched)
  const angleRad = matched === 'A' ? sweetSpotLiveAngles.a : sweetSpotLiveAngles.b
  return {
    target: matched,
    angleDiffDeg: matched === null ? null : (angleRad * 180) / Math.PI,
    matched: matched !== null,
  }
}

function App() {
  const { geometryRef, retry } = useGenerationPipeline()
  const requestSnap = useViewerStore((s) => s.requestSnap)
  const sweetSpot = useSweetSpotProps()

  const handleSnapView = useCallback((view: SnapView) => requestSnap(view), [requestSnap])
  // FR-006 の「視点をリセット」は俯瞰へのスナップと同じ操作
  const handleResetView = useCallback(() => requestSnap('iso'), [requestSnap])

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <aside
        aria-label="コントロールサイドバー"
        className="w-80 shrink-0 border-r border-neutral-800"
      >
        <Sidebar
          onRetryInit={retry}
          onResetView={handleResetView}
          onSnapView={handleSnapView}
          geometryRef={geometryRef}
          sweetSpot={sweetSpot}
        />
      </aside>
      <main aria-label="3D ビューポート" className="min-w-0 flex-1">
        <Viewport geometryRef={geometryRef} />
      </main>
    </div>
  )
}

// main.tsx（Wave 1 所有）が default import で参照するため default を維持する
export default App
