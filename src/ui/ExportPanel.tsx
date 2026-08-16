/**
 * 出力パネル（FR-030 / FR-031）。
 *
 * このアプリの存在理由は「錯視立体を 3D プリンタに渡すこと」であり、
 * `export/stl.ts` と `export/glb.ts` はその実装として完成していたが、
 * **UI からどこも import しておらず入口が存在しなかった**。Task 5.3 は
 * 「ボタンの配線はオーケストレーターが行う」前提で書かれ、Task 5.2 の
 * サイドバー仕様に出力ボタンが含まれていなかったため、2 つのタスクの
 * 境界に機能ごと落ちていた。ここがその入口。
 *
 * ## 出力できる条件
 * ジオメトリは store ではなく外部 ref にある（ADR-004）ため、
 * 「今 export してよいか」は status の購読で決める。`success` 以外の
 * 状態で ref を読むと、前回の入力のメッシュを書き出しうる。
 *
 * ## 分離パーツの警告
 * `componentCount > 1` の確認は `downloadStl` / `downloadGlb` の内側で
 * **バイト生成の前に**行われる（生成してから警告しても遅い）。ここでは
 * 戻り値の警告文を aria-live に流し、確認を通した場合も画面に残す。
 */
import { useCallback, useState } from 'react'

import { useStudioStore } from '../store/useStudioStore'
import { downloadStl } from '../export/stl'
import { downloadGlb } from '../export/glb'
import type { GeometryRef } from '../studio/useGenerationPipeline'

/** サイドバーのボタンと同じ見た目（44px 以上のタップ領域 + 可視フォーカス） */
const BUTTON_CLASS =
  'min-h-11 flex-1 rounded border border-neutral-600 px-3 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

export interface ExportPanelProps {
  /** ADR-004 のジオメトリ参照。`status === 'success'` のときだけ読む */
  geometryRef?: GeometryRef
}

/** STL / GLB の書き出し操作 */
export function ExportPanel({ geometryRef }: ExportPanelProps) {
  const status = useStudioStore((s) => s.status)
  const heightMm = useStudioStore((s) => s.options.heightMm)
  const componentCount = useStudioStore((s) => s.lastResult?.componentCount ?? 0)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canExport = status === 'success' && componentCount > 0

  const currentGeometry = useCallback(() => {
    // ref はレンダー中に読まない。押された瞬間に、状態を確かめてから読む
    if (useStudioStore.getState().status !== 'success') return null
    return geometryRef?.current ?? null
  }, [geometryRef])

  const handleStl = useCallback(() => {
    const geometry = currentGeometry()
    if (geometry === null) return
    const result = downloadStl({ geometry, heightMm, componentCount })
    setMessage(
      result.status === 'cancelled'
        ? `STL の書き出しを中止しました。${result.warning}`
        : result.warning !== null
          ? `STL を書き出しました（${result.fileName}）。${result.warning}`
          : `STL を書き出しました（${result.fileName}）。`,
    )
  }, [currentGeometry, heightMm, componentCount])

  const handleGlb = useCallback(() => {
    const geometry = currentGeometry()
    if (geometry === null) return
    setBusy(true)
    void downloadGlb({ geometry, heightMm, componentCount })
      .then((result) => {
        setMessage(
          result.status === 'cancelled'
            ? `GLB の書き出しを中止しました。${result.warning}`
            : result.warning !== null
              ? `GLB を書き出しました（${result.fileName}）。${result.warning}`
              : `GLB を書き出しました（${result.fileName}）。`,
        )
      })
      .catch((error: unknown) => {
        setMessage(`GLB の書き出しに失敗しました：${String(error)}`)
      })
      .finally(() => setBusy(false))
  }, [currentGeometry, heightMm, componentCount])

  return (
    <section aria-labelledby="export-heading" className="flex flex-col gap-1.5">
      <h2 id="export-heading" className="text-xs font-semibold text-neutral-200">
        書き出し
      </h2>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleStl}
          disabled={!canExport}
          className={BUTTON_CLASS}
          title="3D プリンタのスライサーへ渡すバイナリ STL（ミリメートル単位）"
        >
          STL 出力
        </button>
        <button
          type="button"
          onClick={handleGlb}
          disabled={!canExport || busy}
          className={BUTTON_CLASS}
          title="Blender や Web 共有向けの GLB（メートル単位）"
        >
          {busy ? 'GLB 生成中…' : 'GLB 出力'}
        </button>
      </div>
      <p className="text-[10px] text-neutral-500">
        {canExport
          ? `実寸の高さ ${heightMm}mm で書き出します。STL はミリメートル、GLB はメートル単位です。`
          : '立体が生成されると書き出せます。'}
      </p>
      {/* 常設の live リージョン。中身だけ差し替えて通知が確実に発火するようにする */}
      <p aria-live="polite" className="text-[10px] text-neutral-400">
        {message ?? ''}
      </p>
    </section>
  )
}
