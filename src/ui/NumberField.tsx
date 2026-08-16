/**
 * 数値入力（Sidebar.tsx から抽出。FR-015 / FR-029 / FR-102 の複数フィールドが
 * 同じ「打鍵中の跳ね返り防止」ロジックを必要とするための共通化）。
 *
 * 範囲内の値は打鍵中も即時コミットし（ステッパー操作を含む）、範囲外・
 * 入力途中の値は blur / Enter で確定する。これにより、下限を割る桁数の
 * 入力途中（例: 軸角 15〜165 の入力中に "1" だけ打った瞬間）に値が
 * 下限へ跳ねて次の桁が打てなくなる、という事故を避ける。
 *
 * 編集中テキスト（draft）は「どのストア値の上で編集を始めたか」のタグ付きで
 * 保持し、ストア値が変わればタグが外れて表示は自動的にストア値へ戻る —
 * effect でストア値を setState へ写す同期は行わない（レンダー中に導出する）。
 */
import { useState, type KeyboardEvent } from 'react'

export interface NumberFieldProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  describedById?: string
  /** 確定値の通知。丸め（clamp / step）はストア側の setter が行う */
  onCommit: (value: number) => void
}

export function NumberField(props: NumberFieldProps) {
  const [draft, setDraft] = useState<{ text: string; baseValue: number } | null>(null)
  const shown =
    draft !== null && draft.baseValue === props.value ? draft.text : String(props.value)

  const commitDraft = (): void => {
    setDraft(null)
    if (shown.trim() === '') return
    const parsed = Number(shown)
    if (Number.isFinite(parsed)) props.onCommit(parsed)
  }

  const handleChange = (raw: string): void => {
    setDraft({ text: raw, baseValue: props.value })
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed)) return
    if (parsed < props.min || parsed > props.max) return
    // 整数刻みのフィールドでは、小数の入力途中（例: 45.5）を即時コミットすると
    // ストア側の丸めが打鍵中の表示を跳ねさせるため、blur / Enter まで待つ
    if (Number.isInteger(props.step) && !Number.isInteger(parsed)) return
    props.onCommit(parsed)
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-xs text-neutral-300">
        {props.label}
      </label>
      <input
        id={props.id}
        type="number"
        value={shown}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        aria-describedby={props.describedById}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') commitDraft()
        }}
        className="min-h-11 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-100 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      />
    </div>
  )
}
