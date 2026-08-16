/**
 * 視点 B の押し出し軸角コントロール（FR-102）。
 *
 * 既定 90°（直交）が従来と 1 ビットも変わらない経路で、逸脱を許すのは
 * アンビギュアス・シリンダー（illusion-catalogue.md #1・杉原厚吉）が
 * 45° 系だから。「ずらしても戻れる」を UI で保証するため、直交からの逸脱を
 * 色だけに頼らないテキストバッジで常時提示し、既定に戻すボタンを常設する
 * （すでに 90° のときはボタンを無効化し、押す意味がないことを示す）。
 *
 * Sidebar.tsx から独立ファイルにしてあるのは、肥大化の回避と
 * NumberField.tsx と同じく Fast Refresh を効かせるため。
 */
import { useId } from 'react'
import { selectIsOrthogonalAxes, useStudioStore } from '../store/useStudioStore'
import { DEFAULT_AXIS_ANGLE_DEG, MAX_AXIS_ANGLE_DEG, MIN_AXIS_ANGLE_DEG } from '../worker/protocol'
import { NumberField } from './NumberField'

const RESET_BUTTON_CLASS =
  'min-h-11 rounded border border-neutral-600 px-3 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

/** 視点 B の押し出し軸角（度、FR-102）。既定 90°（直交）、範囲 15〜165° */
export function AxisAngleControl() {
  const baseId = useId()
  const axisAngleDeg = useStudioStore((s) => s.input.axisAngleDeg)
  const setAxisAngleDeg = useStudioStore((s) => s.setAxisAngleDeg)
  const orthogonal = useStudioStore(selectIsOrthogonalAxes)

  const headingId = `${baseId}-heading`
  const fieldId = `${baseId}-field`
  const descId = `${baseId}-desc`

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-xs font-semibold text-neutral-200">
          視点 B の軸角
        </h2>
        {/* 直交 / 斜交はテキストバッジでも提示する（色だけに依存しない。警告表示と同じ規約） */}
        <span
          className={`rounded border border-current px-1 text-[10px] ${
            orthogonal ? 'text-sky-300' : 'text-amber-300'
          }`}
        >
          {orthogonal ? '直交（既定）' : '斜交'}
        </span>
      </div>

      <NumberField
        id={fieldId}
        label={`軸角（度、${MIN_AXIS_ANGLE_DEG}〜${MAX_AXIS_ANGLE_DEG}。既定 ${DEFAULT_AXIS_ANGLE_DEG} = 直交）`}
        value={axisAngleDeg}
        min={MIN_AXIS_ANGLE_DEG}
        max={MAX_AXIS_ANGLE_DEG}
        step={1}
        describedById={descId}
        onCommit={setAxisAngleDeg}
      />

      <p id={descId} className="text-[11px] text-neutral-500">
        {orthogonal
          ? '既定の 90° は直交です。アンビギュアス・シリンダー（杉原厚吉）は 45° 系です。'
          : `既定の直交（90°）から外れています（現在 ${axisAngleDeg}°）。下のボタンでいつでも戻せます。`}
      </p>

      <button
        type="button"
        onClick={() => setAxisAngleDeg(DEFAULT_AXIS_ANGLE_DEG)}
        disabled={orthogonal}
        className={RESET_BUTTON_CLASS}
      >
        既定の直交（{DEFAULT_AXIS_ANGLE_DEG}°）に戻す
      </button>
    </section>
  )
}
