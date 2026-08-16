/**
 * Sweet Spot インジケーター（FR-021 / FR-027 / US-003）。
 *
 * カメラ視線と目標視線（視点 A = 正面 / 視点 B = 側面）の角度差を提示し、
 * 3.5° 未満の「シルエット合致」を知らせる。**判定そのものは行わない** —
 * 角度差の算出と閾値判定は scene/SweetSpot.ts（Task 5.4）の責務で、
 * このコンポーネントは判定結果を受け取って表示するだけの純粋な表示部品。
 * シーンが未接続の間は「未計測」（angleDiffDeg: null）として描画できる。
 *
 * ## アクセシビリティ（FR-027）
 * - 合致状態は**色だけでなく**テキストと形状で提示する：
 *   合致 = 塗りつぶしのダイヤ + チェックマーク、未合致 = 破線の円
 * - aria-live で通知するのは**合致状態のテキストのみ**。毎フレーム変わる
 *   角度数値を live リージョンに入れると読み上げが洪水になるため、
 *   数値は live リージョンの**外**（通常テキスト）に置く
 */

/** Sweet Spot 表示に必要な状態。scene/SweetSpot.ts（Task 5.4）の判定結果を渡す */
export interface SweetSpotIndicatorProps {
  /** 判定対象になっている目標視点。null = どの目標にも向いていない（自由視点） */
  target: 'A' | 'B' | null
  /** カメラ視線と目標視線の角度差（度）。null = 未計測（シーン未接続を含む） */
  angleDiffDeg: number | null
  /** 合致判定（角度差 3.5° 未満。FR-021）。判定は scene 側が行う */
  matched: boolean
}

/**
 * 合致状態の読み上げテキスト。matched / target の変化時のみ変わる文字列に
 * 限定してあり、これだけを aria-live リージョンに入れる。
 */
function liveText(target: 'A' | 'B' | null, matched: boolean): string {
  if (target === null) return '自由視点です'
  if (matched) return `シルエット ${target} に合致しています`
  return `視点 ${target} に接近中（未合致）です`
}

/** Sweet Spot の合致状態を色・形状・テキストの 3 経路で提示する */
export function SweetSpotIndicator(props: SweetSpotIndicatorProps) {
  const { target, angleDiffDeg, matched } = props
  return (
    <div
      className={`flex items-center gap-2 rounded border p-2 ${
        matched ? 'border-emerald-400 text-emerald-300' : 'border-neutral-700 text-neutral-300'
      }`}
    >
      {/* 形状による提示：合致 = 塗りダイヤ + チェック / 未合致 = 破線円（色に依存しない） */}
      <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden="true">
        {matched ? (
          <>
            <path d="M10 1 19 10 10 19 1 10 Z" fill="currentColor" />
            <path
              d="M6.5 10.5 9 13 13.8 7.6"
              fill="none"
              stroke="#0a0a0a"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
        )}
      </svg>
      <div className="min-w-0 text-xs">
        <p aria-live="polite">{liveText(target, matched)}</p>
        {/* 毎フレーム変わる数値は live リージョンの外に置く（読み上げ洪水の防止） */}
        <p className="text-[11px] text-neutral-500">
          角度差 {angleDiffDeg === null ? '—' : `${angleDiffDeg.toFixed(1)}°`}（3.5° 未満で合致）
        </p>
      </div>
    </div>
  )
}
