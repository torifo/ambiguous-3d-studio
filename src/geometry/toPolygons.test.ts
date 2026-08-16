import { describe, expect, it } from 'vitest'
import type { Contour } from './types'
import { toPolygons } from './toPolygons'

/** テスト用の Contour を簡潔に作る */
function contour(points: number[], isHole = false): Contour {
  return { points: new Float64Array(points), isHole }
}

describe('geometry/toPolygons', () => {
  it('converts a valid contour to the exact Vec2[][] shape', () => {
    const result = toPolygons([contour([0, 0, 1, 0, 1, 1, 0, 1])])
    expect(result).toEqual([
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ])
    // Wasm バインディング境界には TypedArray ではなく素の Array で渡す
    expect(Array.isArray(result)).toBe(true)
    expect(Array.isArray(result[0])).toBe(true)
    expect(Array.isArray(result[0][0])).toBe(true)
  })

  it('preserves contour order and converts holes without re-winding', () => {
    // 外輪郭 CCW + 穴 CW（巻き方向は normalize.ts 保証済みの前提。ここでは並びが保存されることだけ確認）
    const outer = contour([0, 0, 4, 0, 4, 4, 0, 4])
    const hole = contour([1, 1, 1, 3, 3, 3, 3, 1], true)
    const result = toPolygons([outer, hole])
    expect(result).toEqual([
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      [
        [1, 1],
        [1, 3],
        [3, 3],
        [3, 1],
      ],
    ])
  })

  it('rejects an empty contour list', () => {
    expect(() => toPolygons([])).toThrow(/contour list is empty/)
  })

  it('rejects an odd-length point buffer', () => {
    expect(() => toPolygons([contour([0, 0, 1, 0, 1, 1, 0])])).toThrow(
      /odd-length point buffer/,
    )
  })

  it('rejects a contour with fewer than 3 vertices', () => {
    expect(() => toPolygons([contour([0, 0, 1, 1])])).toThrow(
      /only 2 vertices.*at least 3/,
    )
  })

  it('rejects NaN coordinates', () => {
    expect(() => toPolygons([contour([0, 0, 1, NaN, 1, 1])])).toThrow(
      /non-finite coordinate/,
    )
  })

  it('rejects Infinity coordinates and names the offending vertex', () => {
    expect(() =>
      toPolygons([contour([0, 0, 1, 0, Infinity, 1])]),
    ).toThrow(/vertex 2.*non-finite coordinate.*x=Infinity/)
  })

  it('names the offending contour index in multi-contour input', () => {
    const good = contour([0, 0, 1, 0, 1, 1])
    const bad = contour([0, 0, 1])
    expect(() => toPolygons([good, bad])).toThrow(/contour\[1\]/)
  })
})
