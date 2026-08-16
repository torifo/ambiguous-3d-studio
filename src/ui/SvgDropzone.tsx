/**
 * SVG のドロップ領域 +「同等の機能を持つ `<input type="file">`」（FR-027 / US-002）。
 *
 * ここは**ファイルの受け取り口だけ**を提供する。拡張子・サイズの検証、
 * テキスト読み取り、ストアへのコミットは呼び出し側（SilhouettePicker）の責務。
 *
 * ドラッグ & ドロップはマウス専用の**追加経路**であり、キーボードと支援技術は
 * 実体のファイル入力（`<input type="file">`）から同じ機能に到達できる
 * （FR-027: ドロップ領域と同等の機能を持つ file input を提供する）。
 * ドロップ領域の div 自体はフォーカス対象にしない — 操作の実体は常に input。
 */
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'

export interface SvgDropzoneProps {
  /** `<input type="file">` の id。ラベルの `htmlFor` と対応する */
  inputId: string
  /** 補足説明（受け付ける形式など）の要素 id。`aria-describedby` に配線する */
  describedById?: string
  /** ストアに載っている現在の SVG ファイル名。null = SVG 未選択 */
  currentFileName: string | null
  /** ファイル確定時（ドロップ / ファイル選択の両方で同じコールバック） */
  onFile: (file: File) => void
}

/** SVG ファイルのドロップ領域とファイル入力。検証・読み取りは呼び出し側 */
export function SvgDropzone(props: SvgDropzoneProps) {
  const [dragActive, setDragActive] = useState(false)
  /**
   * dragenter/leave は子要素を跨ぐたびに発火するため、深さを数えて
   * 「領域から完全に出た」ときだけハイライトを解除する。
   */
  const dragDepth = useRef(0)

  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }

  const handleDragLeave = (): void => {
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragActive(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const file = event.dataTransfer.files.item(0)
    if (file !== null) props.onFile(file)
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.item(0) ?? null
    if (file !== null) props.onFile(file)
    // 値を空に戻し、同じファイルの再選択でも change を発火させる
    // （拒否 → ファイルを修正 → 同名のまま再投入、の動線を殺さない）
    event.target.value = ''
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded border border-dashed p-3 text-center ${
        dragActive ? 'border-sky-400 bg-sky-400/10' : 'border-neutral-600'
      }`}
    >
      <p className="text-xs text-neutral-300">
        {dragActive ? 'ここにドロップして読み込み' : 'SVG ファイルをここにドロップ'}
      </p>
      <p className="my-1 text-[11px] text-neutral-500">または</p>
      <label htmlFor={props.inputId} className="mb-1 block text-[11px] text-neutral-400">
        SVG ファイルを選択
      </label>
      <input
        id={props.inputId}
        type="file"
        accept=".svg,image/svg+xml"
        aria-describedby={props.describedById}
        onChange={handleChange}
        className="block w-full max-w-full text-[11px] text-neutral-300 file:mr-2 file:min-h-9 file:rounded file:border file:border-neutral-600 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      />
      {props.currentFileName !== null && (
        <p className="mt-2 text-[11px] break-all text-neutral-400">
          読み込み済み: {props.currentFileName}
        </p>
      )}
    </div>
  )
}
