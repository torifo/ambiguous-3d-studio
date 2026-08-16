import { describe, expect, it } from 'vitest'
import type { Contour } from './types'
import {
  boundsOf,
  fitToHeight,
  flipY,
  normalizeSilhouette,
  normalizeWinding,
  signedArea,
} from './normalize'

/** テスト用の許容誤差（浮動小数点比較） */
const TOL = 10

/** [x, y] ペアの列から Contour を作る */
function contour(pts: number[], isHole = false): Contour {
  return { points: new Float64Array(pts), isHole }
}

/** CCW の矩形（Y 上向き座標系で反時計回り） */
function rectCCW(minX: number, minY: number, maxX: number, maxY: number, isHole = false): Contour {
  return contour([minX, minY, maxX, minY, maxX, maxY, minX, maxY], isHole)
}

/** CW の矩形 */
function rectCW(minX: number, minY: number, maxX: number, maxY: number, isHole = false): Contour {
  return contour([minX, minY, minX, maxY, maxX, maxY, maxX, minY], isHole)
}

describe('signedArea', () => {
  it('CCW の矩形は正の面積', () => {
    // 2 × 3 の矩形 → 面積 6
    expect(signedArea(rectCCW(0, 0, 2, 3).points)).toBeCloseTo(6, TOL)
  })

  it('CW の矩形は負の面積', () => {
    expect(signedArea(rectCW(0, 0, 2, 3).points)).toBeCloseTo(-6, TOL)
  })

  it('CCW の三角形は正の面積（解析解と一致）', () => {
    // (0,0)-(4,0)-(0,3) → 面積 6
    expect(signedArea(new Float64Array([0, 0, 4, 0, 0, 3]))).toBeCloseTo(6, TOL)
  })
})

describe('boundsOf', () => {
  it('複数輪郭を包む bbox を返す', () => {
    const bounds = boundsOf([rectCCW(0, 0, 2, 3), rectCCW(-1, 1, 1, 5)])
    expect(bounds).toEqual({ minX: -1, minY: 0, maxX: 2, maxY: 5 })
  })
})

describe('normalizeWinding', () => {
  it('CW で書かれた外輪郭を CCW に反転する', () => {
    const [outer] = normalizeWinding([rectCW(0, 0, 2, 2, false)])
    expect(signedArea(outer.points)).toBeGreaterThan(0)
    expect(outer.isHole).toBe(false)
  })

  it('CCW で書かれた穴を CW に反転する', () => {
    const [hole] = normalizeWinding([rectCCW(0.5, 0.5, 1.5, 1.5, true)])
    expect(signedArea(hole.points)).toBeLessThan(0)
    expect(hole.isHole).toBe(true)
  })

  it('すでに正しい巻きの輪郭はそのまま（面積の絶対値も不変）', () => {
    const input = [rectCCW(0, 0, 2, 2, false), rectCW(0.5, 0.5, 1.5, 1.5, true)]
    const result = normalizeWinding(input)
    expect(signedArea(result[0].points)).toBeCloseTo(4, TOL)
    expect(signedArea(result[1].points)).toBeCloseTo(-1, TOL)
    // 頂点そのものも変わらない
    expect(Array.from(result[0].points)).toEqual(Array.from(input[0].points))
  })

  it('反転しても頂点集合は同じ（順序だけが逆）', () => {
    const [outer] = normalizeWinding([rectCW(0, 0, 2, 2, false)])
    const original = rectCW(0, 0, 2, 2, false)
    const toPairs = (pts: Float64Array) => {
      const pairs: string[] = []
      for (let i = 0; i < pts.length; i += 2) pairs.push(`${pts[i]},${pts[i + 1]}`)
      return pairs.sort()
    }
    expect(toPairs(outer.points)).toEqual(toPairs(original.points))
  })

  it('面積ゼロ（全点が一直線）の輪郭を拒否する', () => {
    const degenerate = contour([0, 0, 1, 1, 2, 2])
    expect(() => normalizeWinding([degenerate])).toThrow(/面積|巻き方向/)
  })
})

describe('flipY', () => {
  it('Y 座標の符号を反転する', () => {
    const [flipped] = flipY([contour([0, 1, 2, 1, 1, 3])])
    const ys = [flipped.points[1], flipped.points[3], flipped.points[5]].sort((a, b) => a - b)
    expect(ys).toEqual([-3, -1, -1])
  })

  it('反転後に巻き方向が再正規化されている（外輪郭 CCW / 穴 CW）', () => {
    // Y 下向き（SVG）座標系で「正しく」巻かれた入力を用意する：
    // Y 上向きの数学では外輪郭が CW（負の面積）・穴が CCW（正の面積）に見える
    const svgOuter = rectCW(0, 0, 4, 4, false) // Y 上向き解釈で面積 -16
    const svgHole = rectCCW(1, 1, 3, 3, true) // Y 上向き解釈で面積 +4
    const result = flipY([svgOuter, svgHole])
    // Y 反転は面積の符号を裏返すので、素朴に反転だけすると外輪郭 +16 / 穴 -4 …
    // に見えるが、逆に「反転前に正規化していた」場合は全部が逆になる。
    // flipY は反転後に必ず再判定するので、常に 外輪郭 > 0 / 穴 < 0 で返る。
    expect(signedArea(result[0].points)).toBeGreaterThan(0)
    expect(result[0].isHole).toBe(false)
    expect(signedArea(result[1].points)).toBeLessThan(0)
    expect(result[1].isHole).toBe(true)
  })

  it('回帰：正規化済みの輪郭を flipY しても穴は穴のまま', () => {
    // 「巻き正規化 → Y 反転」の順で処理してしまうと、反転で全巻きが逆転し
    // 穴が外輪郭の巻きになる（メッシュが無言で中実になる事故）。
    // flipY が再正規化を内包していることをここで固定する。
    const normalized = normalizeWinding([
      rectCCW(0, 0, 4, 4, false),
      rectCW(1, 1, 3, 3, true),
    ])
    const flipped = flipY(normalized)
    expect(signedArea(flipped[0].points)).toBeGreaterThan(0) // 外輪郭 CCW
    expect(flipped[0].isHole).toBe(false)
    expect(signedArea(flipped[1].points)).toBeLessThan(0) // 穴 CW のまま
    expect(flipped[1].isHole).toBe(true)
  })

  it('2 回反転して巻きを直すと元の図形に戻る（自己整合性）', () => {
    const input = [rectCCW(0, -2, 3, 5, false)]
    const twice = flipY(flipY(input))
    expect(boundsOf(twice)).toEqual(boundsOf(input))
    expect(signedArea(twice[0].points)).toBeCloseTo(signedArea(input[0].points), TOL)
  })
})

describe('fitToHeight', () => {
  const H = 2

  it.each([
    ['縦長', rectCCW(0, 0, 1, 10)],
    ['横長', rectCCW(0, 0, 10, 1)],
    ['正方形', rectCCW(-3, -3, 3, 3)],
    ['原点から離れた矩形', rectCCW(100, 200, 104, 203)],
  ])('%s の入力で bbox 高さが H・中心が原点になる', (_label, input) => {
    const bounds = boundsOf(fitToHeight([input], H))
    expect(bounds.maxY - bounds.minY).toBeCloseTo(H, TOL)
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, TOL)
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(0, TOL)
  })

  it('縦横比を保つ（X/Y を独立にスケールしない）', () => {
    const input = rectCCW(0, 0, 10, 4) // アスペクト比 2.5
    const bounds = boundsOf(fitToHeight([input], H))
    const ratio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY)
    expect(ratio).toBeCloseTo(2.5, TOL)
  })

  it('スケーリングとセンタリングで巻き方向が変わらない', () => {
    const fitted = fitToHeight([rectCCW(5, 5, 7, 9, false), rectCW(5.5, 6, 6.5, 8, true)], H)
    expect(signedArea(fitted[0].points)).toBeGreaterThan(0)
    expect(signedArea(fitted[1].points)).toBeLessThan(0)
  })

  it('高さゼロの bbox を拒否する', () => {
    const flat = contour([0, 1, 2, 1, 4, 1]) // 全点 y = 1
    expect(() => fitToHeight([flat], H)).toThrow(/高さ/)
  })

  it('targetHeight が 0 以下・非有限なら拒否する', () => {
    const square = rectCCW(0, 0, 1, 1)
    expect(() => fitToHeight([square], 0)).toThrow(/targetHeight/)
    expect(() => fitToHeight([square], -1)).toThrow(/targetHeight/)
    expect(() => fitToHeight([square], NaN)).toThrow(/targetHeight/)
    expect(() => fitToHeight([square], Infinity)).toThrow(/targetHeight/)
  })
})

describe('normalizeSilhouette', () => {
  const H = 2

  it.each([
    ['縦長', [rectCW(0, 0, 1, 10, false)]],
    ['横長', [rectCW(0, 0, 10, 1, false)]],
    ['正方形', [rectCW(-3, -3, 3, 3, false)]],
  ])('%s：高さ H・中心原点・外輪郭 CCW で返る', (_label, input) => {
    const { contours } = normalizeSilhouette(input, H)
    const bounds = boundsOf(contours)
    expect(bounds.maxY - bounds.minY).toBeCloseTo(H, TOL)
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, TOL)
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(0, TOL)
    expect(signedArea(contours[0].points)).toBeGreaterThan(0)
  })

  it('正規化前後で縦横比が変わらない', () => {
    const input = [rectCCW(2, 3, 9, 5)] // 7 × 2
    const before = boundsOf(input)
    const beforeRatio = (before.maxX - before.minX) / (before.maxY - before.minY)
    const after = boundsOf(normalizeSilhouette(input, H).contours)
    const afterRatio = (after.maxX - after.minX) / (after.maxY - after.minY)
    expect(afterRatio).toBeCloseTo(beforeRatio, TOL)
  })

  it('sourceBounds は正規化前の元 bbox を保持する', () => {
    const input = [rectCCW(2, 3, 9, 5)]
    const { sourceBounds } = normalizeSilhouette(input, H)
    expect(sourceBounds).toEqual({ minX: 2, minY: 3, maxX: 9, maxY: 5 })
  })

  it('外輪郭と穴が混在するドーナツで巻きと isHole が揃う', () => {
    // わざと両方とも逆巻きで与える
    const input = [rectCW(0, 0, 4, 4, false), rectCCW(1, 1, 3, 3, true)]
    const { contours } = normalizeSilhouette(input, H)
    expect(signedArea(contours[0].points)).toBeGreaterThan(0)
    expect(contours[0].isHole).toBe(false)
    expect(signedArea(contours[1].points)).toBeLessThan(0)
    expect(contours[1].isHole).toBe(true)
  })

  it('flipY と合成しても SVG 由来の穴が穴として残る（Task 2.1 Done 条件）', () => {
    // SVG（Y 下向き）で作者が「正しく」巻いたドーナツ：
    // Y 上向き解釈では外輪郭が CW / 穴が CCW に見える
    const svgInput = [rectCW(0, 0, 4, 6, false), rectCCW(1, 2, 3, 4, true)]
    const { contours } = normalizeSilhouette(flipY(svgInput), H)
    expect(signedArea(contours[0].points)).toBeGreaterThan(0)
    expect(contours[0].isHole).toBe(false)
    expect(signedArea(contours[1].points)).toBeLessThan(0)
    expect(contours[1].isHole).toBe(true)
    // 幾何も正しく正規化されている
    const bounds = boundsOf(contours)
    expect(bounds.maxY - bounds.minY).toBeCloseTo(H, TOL)
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, TOL)
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(0, TOL)
  })

  it('点の形式はフラット Float64Array のまま', () => {
    const { contours } = normalizeSilhouette([rectCCW(0, 0, 2, 3)], H)
    expect(contours[0].points).toBeInstanceOf(Float64Array)
    expect(contours[0].points.length % 2).toBe(0)
  })

  describe('縮退入力の拒否（NaN を作らない）', () => {
    it('輪郭ゼロ個', () => {
      expect(() => normalizeSilhouette([], H)).toThrow(/輪郭が 0 個/)
    })

    it('3 頂点未満', () => {
      const twoPoints = contour([0, 0, 1, 1])
      expect(() => normalizeSilhouette([twoPoints], H)).toThrow(/3 頂点/)
    })

    it('奇数長のフラット配列', () => {
      const odd: Contour = { points: new Float64Array([0, 0, 1, 0, 1]), isHole: false }
      expect(() => normalizeSilhouette([odd], H)).toThrow(/奇数長/)
    })

    it('高さゼロの bbox', () => {
      // 全点 y = 1 の輪郭は面積ゼロでもあるため、パイプラインでは
      // 巻き方向判定（面積）の段階で先に弾かれる。どちらの文言でも
      // 「明確なエラーで拒否され NaN を作らない」ことが要件
      const flat = contour([0, 1, 2, 1, 4, 1])
      expect(() => normalizeSilhouette([flat], H)).toThrow(/面積|高さ/)
    })

    it('NaN を含む座標', () => {
      const nan = contour([0, 0, 1, NaN, 1, 1])
      expect(() => normalizeSilhouette([nan], H)).toThrow(/有限値/)
    })
  })
})
