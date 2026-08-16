/**
 * アプリシェル（Task 4.1）。生成パイプラインをここで**ちょうど 1 回**起動し、
 * サイドバー枠とビューポート枠を配置する。
 *
 * Wave 5 への継ぎ目：
 * - サイドバー枠（`<aside>`）→ Task 5.2 の `<Sidebar />` がここに入る
 * - ビューポート枠（`SidebarSlot` / `ViewportSlot` の中身）→ Task 5.1 の
 *   `<Viewport geometryRef={geometryRef} />` が `ViewportSlot` を置き換える。
 *   ジオメトリは React state ではなく `geometryRef`（ADR-004）で渡す —
 *   参照が最新になったことは store の `status: 'success'` 購読で知る
 * - `retry` は FR-025 の再試行。Wave 5 のサイドバーはこれをボタンに配線する
 */
import { useStudioStore, type StudioStatus } from './store/useStudioStore'
import {
  useGenerationPipeline,
  type GeometryRef,
} from './studio/useGenerationPipeline'

/**
 * FR-025: 状態 → 表示文言。`loading-wasm` は**正常系**であり、
 * エラーとして提示しない（「準備中」を出す）。
 */
const STATUS_LABELS: Record<StudioStatus, string> = {
  'loading-wasm': '準備中…',
  ready: '準備完了',
  generating: '生成中…',
  success: '生成完了',
  error: '生成に失敗しました',
  'init-failed': 'エンジンの初期化に失敗しました',
}

/**
 * サイドバー枠のプレースホルダ。Wave 5（Task 5.2）が `<Sidebar />` に
 * 差し替える。ここでは FR-025 の最小限（状態表示・init-failed の再試行）
 * だけを提示する。
 */
function SidebarSlot(props: { retry: () => void }) {
  const status = useStudioStore((s) => s.status)
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <h1 className="text-sm font-semibold tracking-wide">Ambiguous 3D Studio</h1>
      <p aria-live="polite" className="text-xs text-neutral-400">
        {STATUS_LABELS[status]}
      </p>
      {status === 'init-failed' && (
        <button
          type="button"
          onClick={props.retry}
          className="w-fit rounded border border-neutral-600 px-3 py-1 text-xs hover:bg-neutral-800"
        >
          再試行
        </button>
      )}
      <p className="mt-auto text-[10px] text-neutral-600">
        入力 UI は Wave 5（Task 5.2）がここに入る
      </p>
    </div>
  )
}

/**
 * ビューポート枠のプレースホルダ。Wave 5（Task 5.1）が
 * `<Viewport geometryRef={…} />` に差し替える。ref は描画トリガに
 * ならない（ADR-004）ため、ここでは参照が配線されていることだけを示す。
 */
function ViewportSlot(props: { geometryRef: GeometryRef }) {
  const hasGeometry = props.geometryRef.current !== null
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-xs text-neutral-600">
        3D ビューポート（Wave 5 Task 5.1）— geometry: {hasGeometry ? 'あり' : 'なし'}
      </p>
    </div>
  )
}

/**
 * アプリ本体。`useGenerationPipeline` はここで 1 回だけ呼ぶ
 * （design.md ディレクトリ表 / Task 4.1）。
 */
function App() {
  const { geometryRef, retry } = useGenerationPipeline()
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <aside
        aria-label="コントロールサイドバー"
        className="w-72 shrink-0 border-r border-neutral-800"
      >
        <SidebarSlot retry={retry} />
      </aside>
      <main aria-label="3D ビューポート" className="min-w-0 flex-1">
        <ViewportSlot geometryRef={geometryRef} />
      </main>
    </div>
  )
}

// main.tsx（Wave 1 所有）が default import で参照するため default を維持する
export default App
