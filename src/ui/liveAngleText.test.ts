/**
 * 連続角度表示の文字列の単体テスト（Task 7.1 / FR-021）。
 *
 * 検証するのは**毎フレーム DOM へ書き込む文字列**の形だけ。丸めの桁数が
 * そのまま書き込み頻度の上限になる（0.1° 動いたフレームだけ textContent が
 * 変わる）ため、桁数は仕様として固定する。
 */
import { describe, expect, it } from 'vitest'
import { formatLiveAngles } from './liveAngleText'

const rad = (deg: number): number => (deg * Math.PI) / 180

describe('formatLiveAngles', () => {
  it('A / B 両方の角度差を度で出す（FR-021「各目標視線ベクトルとの角度差」）', () => {
    expect(formatLiveAngles(rad(0), rad(90))).toBe('A 0.0° ・ B 90.0°')
  })

  it('小数 1 桁に丸める（この丸めが DOM 書き込みの頻度上限になる）', () => {
    expect(formatLiveAngles(rad(3.44), rad(86.56))).toBe('A 3.4° ・ B 86.6°')
  })

  it('π（不一致の初期値）でも壊れない', () => {
    expect(formatLiveAngles(Math.PI, Math.PI)).toBe('A 180.0° ・ B 180.0°')
  })
})
