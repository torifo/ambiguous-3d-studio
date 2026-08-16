/**
 * Sweet Spot の角度差を表す**連続表示の文字列**（Task 7.1 / FR-021）。
 *
 * SweetSpotIndicator が毎フレーム `textContent` に書き込む値をここで作る。
 * コンポーネントと同じファイルに置くと Fast Refresh が効かなくなる
 * （react-refresh/only-export-components）ため、純関数だけを切り出してある。
 *
 * 丸めの桁数はそのまま**書き込み頻度の上限**になる：小数 1 桁なので、
 * カメラが 0.1° 動いたフレームだけ DOM が変わる（NFR-002）。
 */

/** rad → 表示用の度（小数 1 桁） */
function toDeg(rad: number): string {
  return ((rad * 180) / Math.PI).toFixed(1)
}

/**
 * 連続表示の文言。FR-021 は「**各**目標視線ベクトルとの角度差」なので、
 * 合致中かどうかに関わらず A / B 両方を常に出す（自由視点でも「どちらへ
 * どれだけ回せば合うか」が読める）。
 */
export function formatLiveAngles(angleA: number, angleB: number): string {
  return `A ${toDeg(angleA)}° ・ B ${toDeg(angleB)}°`
}
