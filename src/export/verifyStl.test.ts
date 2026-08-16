import { describe, expect, it } from 'vitest'
import type { Vec3 } from './verifyStl'
import { parseBinaryStl, verifyStlBytes } from './verifyStl'

type Triangle = [Vec3, Vec3, Vec3]

/**
 * 検証対象のバイナリ STL をバイトから直接組み立てる。
 * stl.ts（書き出し側）を経由しないので、この検証器のテストは書き出し側の
 * バグとは独立に成立する。法線は全ゼロ（一般的なツールが許容する慣例。
 * 検証器は法線の値ではなく巻き方向を見る）。
 */
function craftBinaryStl(triangles: Triangle[]): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * triangles.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(80, triangles.length, true)
  let offset = 84
  for (const tri of triangles) {
    offset += 12 // 法線 = (0, 0, 0)
    for (const v of tri) {
      view.setFloat32(offset, v[0], true)
      view.setFloat32(offset + 4, v[1], true)
      view.setFloat32(offset + 8, v[2], true)
      offset += 12
    }
    offset += 2 // 属性バイト数 = 0
  }
  return bytes
}

/**
 * mm 座標の閉四面体（外向き CCW・一貫巻き）。
 * 頂点: (0,-30,0) (60,-30,0) (0,30,0) (0,-30,60) — Y 範囲 60mm。
 */
const V0: Vec3 = [0, -30, 0]
const V1: Vec3 = [60, -30, 0]
const V2: Vec3 = [0, 30, 0]
const V3: Vec3 = [0, -30, 60]

function closedTetrahedron(): Triangle[] {
  return [
    [V0, V2, V1], // 底面 (-z)
    [V0, V1, V3], // 側面 (-y)
    [V0, V3, V2], // 側面 (-x)
    [V1, V2, V3], // 斜面
  ]
}

describe('export/verifyStl', () => {
  describe('parseBinaryStl', () => {
    it('parses triangle count, normals, and vertices little-endian', () => {
      const parsed = parseBinaryStl(craftBinaryStl(closedTetrahedron()))
      expect(parsed.triangleCount).toBe(4)
      expect(parsed.triangles).toHaveLength(4)
      expect(parsed.triangles[0].normal).toEqual([0, 0, 0])
      expect(parsed.triangles[0].vertices).toEqual([V0, V2, V1])
      expect(parsed.triangles[3].vertices).toEqual([V1, V2, V3])
    })

    it('throws when the file is shorter than header + count', () => {
      expect(() => parseBinaryStl(new Uint8Array(83))).toThrow(
        /83 bytes is too short/,
      )
    })

    it('throws when the declared triangle count disagrees with the byte length', () => {
      const bytes = craftBinaryStl(closedTetrahedron())
      // ヘッダは 4 のままレコードを 1 件切り落とす
      const truncated = bytes.slice(0, bytes.byteLength - 50)
      expect(() => parseBinaryStl(truncated)).toThrow(
        /header declares 4 triangles \(284 bytes\) but the file is 234 bytes/,
      )
      // 逆に、ヘッダだけ水増しした場合も一致しない
      const inflated = craftBinaryStl(closedTetrahedron())
      new DataView(inflated.buffer).setUint32(80, 5, true)
      expect(() => parseBinaryStl(inflated)).toThrow(/declares 5 triangles/)
    })
  })

  describe('verifyStlBytes', () => {
    it('accepts a closed, consistently wound solid and reports its bounds', () => {
      const report = verifyStlBytes(craftBinaryStl(closedTetrahedron()), {
        heightMm: 60,
        widthMm: 60,
        depthMm: 60,
      })
      expect(report.issues).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.triangleCount).toBe(4)
      expect(report.bounds).toEqual({ min: [0, -30, 0], max: [60, 30, 60] })
    })

    it('rejects a closed solid with one triangle removed (edge pairing catches the hole)', () => {
      const report = verifyStlBytes(
        craftBinaryStl(closedTetrahedron().slice(0, 3)),
      )
      expect(report.ok).toBe(false)
      // 抜いた斜面 (V1, V2, V3) の 3 辺だけが対を失う
      const boundary = report.issues.filter((i) => i.code === 'BOUNDARY_EDGE')
      expect(boundary).toHaveLength(3)
      expect(report.issues).toHaveLength(3) // 他の問題は報告されない
      for (const issue of boundary) {
        expect(issue.message).toMatch(/appears only once.*hole/)
      }
    })

    it('rejects a flipped triangle (edges appear twice in the same direction)', () => {
      const flipped = closedTetrahedron()
      // 斜面の巻きを反転する。閉じてはいるが向きが一貫しない
      flipped[3] = [V1, V3, V2]
      const report = verifyStlBytes(craftBinaryStl(flipped))
      expect(report.ok).toBe(false)
      const winding = report.issues.filter(
        (i) => i.code === 'INCONSISTENT_WINDING',
      )
      expect(winding).toHaveLength(3)
      expect(winding[0].message).toMatch(/same direction/)
    })

    it('rejects a duplicated triangle (non-manifold edges)', () => {
      const tris = closedTetrahedron()
      tris.push(tris[3])
      const report = verifyStlBytes(craftBinaryStl(tris))
      expect(report.ok).toBe(false)
      const nonManifold = report.issues.filter(
        (i) => i.code === 'NON_MANIFOLD_EDGE',
      )
      expect(nonManifold).toHaveLength(3)
      expect(nonManifold[0].code === 'NON_MANIFOLD_EDGE' && nonManifold[0].count).toBe(3)
    })

    it('rejects non-finite vertex coordinates', () => {
      const bytes = craftBinaryStl(closedTetrahedron())
      // 三角形 0 の第 1 頂点の x を NaN に書き換える（84 + 法線 12 バイト）
      new DataView(bytes.buffer).setFloat32(96, NaN, true)
      const report = verifyStlBytes(bytes)
      expect(report.ok).toBe(false)
      const nonFinite = report.issues.filter(
        (i) => i.code === 'NON_FINITE_VERTEX',
      )
      expect(nonFinite).toHaveLength(1)
      expect(nonFinite[0].code === 'NON_FINITE_VERTEX' && nonFinite[0].triangle).toBe(0)

      const infinite = craftBinaryStl([
        [[Infinity, 0, 0], [1, 0, 0], [0, 1, 0]],
      ])
      expect(
        verifyStlBytes(infinite).issues.some(
          (i) => i.code === 'NON_FINITE_VERTEX',
        ),
      ).toBe(true)
    })

    it('rejects zero-area triangles (collinear and repeated vertices)', () => {
      const collinear = verifyStlBytes(
        craftBinaryStl([[[0, 0, 0], [1, 1, 1], [2, 2, 2]]]),
      )
      expect(collinear.ok).toBe(false)
      expect(
        collinear.issues.some((i) => i.code === 'ZERO_AREA_TRIANGLE'),
      ).toBe(true)

      // 頂点の重複（自己辺）でもクラッシュせず縮退面として報告する
      const repeated = verifyStlBytes(
        craftBinaryStl([[[0, 0, 0], [0, 0, 0], [1, 0, 0]]]),
      )
      expect(repeated.ok).toBe(false)
      expect(
        repeated.issues.some((i) => i.code === 'ZERO_AREA_TRIANGLE'),
      ).toBe(true)
    })

    it('reports a bbox that disagrees with the requested millimetre dimensions', () => {
      const report = verifyStlBytes(craftBinaryStl(closedTetrahedron()), {
        heightMm: 61,
      })
      expect(report.ok).toBe(false)
      const mismatch = report.issues.filter((i) => i.code === 'BBOX_MISMATCH')
      expect(mismatch).toHaveLength(1)
      const issue = mismatch[0]
      if (issue.code !== 'BBOX_MISMATCH') throw new Error('unreachable')
      expect(issue.axis).toBe('y')
      expect(issue.actualMm).toBeCloseTo(60, 6)
      expect(issue.expectedMm).toBe(61)

      // 高さは合っていても幅が違えば widthMm の照合で落ちる
      const wrongWidth = verifyStlBytes(craftBinaryStl(closedTetrahedron()), {
        heightMm: 60,
        widthMm: 50,
      })
      expect(
        wrongWidth.issues.some(
          (i) => i.code === 'BBOX_MISMATCH' && i.axis === 'x',
        ),
      ).toBe(true)
    })

    it('reports malformed bytes instead of throwing', () => {
      const truncated = craftBinaryStl(closedTetrahedron()).slice(0, 100)
      const report = verifyStlBytes(truncated)
      expect(report.ok).toBe(false)
      expect(report.bounds).toBeNull()
      expect(report.issues).toHaveLength(1)
      expect(report.issues[0].code).toBe('MALFORMED')
      expect(report.issues[0].message).toMatch(/declares 4 triangles/)
    })

    it('reports an empty (zero-triangle) file as invalid', () => {
      const report = verifyStlBytes(craftBinaryStl([]))
      expect(report.ok).toBe(false)
      expect(report.issues.some((i) => i.code === 'EMPTY')).toBe(true)
      expect(report.bounds).toBeNull()
    })
  })
})
