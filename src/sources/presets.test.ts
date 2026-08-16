import { describe, expect, it } from 'vitest'
import type { Contour, PresetId } from '../geometry/types'
import { DEFAULT_CIRCLE_SEGMENTS, PRESET_IDS, presetToContours } from './presets'

/**
 * テストが走査する全プリセット id。
 * `satisfies readonly PresetId[]` で union に無い id の混入を、
 * 下の網羅チェック（Exclude）で union 側の追加漏れを、それぞれ型エラーにする。
 */
const ALL_IDS = [
  'circle',
  'square',
  'triangle',
  'heart',
  'star',
  'arrow',
  'cross',
] as const satisfies readonly PresetId[]

/** シューレース公式による符号付き面積。CCW なら正（Y 上向き座標系） */
function signedArea(contour: Contour): number {
  const p = contour.points
  let sum = 0
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length
    sum += p[i] * p[j + 1] - p[j] * p[i + 1]
  }
  return sum / 2
}

/** フラット配列 → [x, y] の頂点リスト */
function vertices(contour: Contour): Array<[number, number]> {
  const p = contour.points
  const out: Array<[number, number]> = []
  for (let i = 0; i < p.length; i += 2) {
    out.push([p[i], p[i + 1]])
  }
  return out
}

/**
 * 点**集合**としての一致判定（全単射マッチング）。
 * 順序・開始インデックスの回転・巻き方向に依存せず、浮動小数点誤差 eps を許容する。
 */
function samePointSet(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
  eps: number,
): boolean {
  if (a.length !== b.length) return false
  const used = new Array<boolean>(b.length).fill(false)
  for (const [ax, ay] of a) {
    const idx = b.findIndex(
      ([bx, by], i) => !used[i] && Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps,
    )
    if (idx === -1) return false
    used[idx] = true
  }
  return true
}

/** bbox の縦中心線（x = cx）に対する鏡像 */
function mirrorAcrossBBoxCenter(
  pts: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const xs = pts.map(([x]) => x)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  return pts.map(([x, y]) => [2 * cx - x, y])
}

describe('presetToContours', () => {
  it('PresetId の全メンバーを網羅している（union に追加してデータを足し忘れると失敗する）', () => {
    // 型レベル: ALL_IDS が union を覆っていなければこの行がコンパイルエラーになる
    // （[T] extends [never] で分配を止めるのが要点）
    const covered: [Exclude<PresetId, (typeof ALL_IDS)[number]>] extends [never] ? true : never =
      true
    expect(covered).toBe(true)
    // 実行時: 実装側の PRESET_IDS とテスト側のリストが集合として一致すること
    expect([...PRESET_IDS].sort()).toEqual([...ALL_IDS].sort())
    // 実行時: 全 id が空でない Contour[] を返すこと（空配列で沈黙しない）
    for (const id of ALL_IDS) {
      expect(presetToContours(id).length, id).toBeGreaterThanOrEqual(1)
    }
  })

  it('データを持たない id は沈黙せず例外を投げる', () => {
    expect(() => presetToContours('crescent' as PresetId)).toThrow(/プリセット/)
  })

  it.each(ALL_IDS)('%s: 閉じた CCW の外輪郭のみを返す（穴なし・退化なし）', (id) => {
    const contours = presetToContours(id)
    expect(contours.length).toBeGreaterThanOrEqual(1)
    for (const contour of contours) {
      // 穴ではない
      expect(contour.isHole).toBe(false)
      // フラット配列の健全性: 偶数長・3 頂点以上・全て有限値
      expect(contour.points).toBeInstanceOf(Float64Array)
      expect(contour.points.length % 2).toBe(0)
      expect(contour.points.length / 2).toBeGreaterThanOrEqual(3)
      for (const v of contour.points) {
        expect(Number.isFinite(v)).toBe(true)
      }
      // 閉パス規約: 暗黙閉路。隣接頂点（末尾→先頭の閉じ辺を含む）に重複がないこと
      // （終点に始点を繰り返すと長さゼロの閉じ辺ができ、ここで落ちる）
      const vs = vertices(contour)
      for (let i = 0; i < vs.length; i++) {
        const [x1, y1] = vs[i]
        const [x2, y2] = vs[(i + 1) % vs.length]
        expect(Math.hypot(x2 - x1, y2 - y1), `${id}: 頂点 ${i} → ${(i + 1) % vs.length}`)
          .toBeGreaterThan(1e-9)
      }
      // 巻き方向: 符号付き面積が正 = CCW
      expect(signedArea(contour), `${id} の符号付き面積`).toBeGreaterThan(0)
    }
  })

  it('頂点数が図形として自然（正方形 4・三角形 3・星 10・十字 12・矢印 7）', () => {
    const count = (id: PresetId) => presetToContours(id)[0].points.length / 2
    expect(count('square')).toBe(4)
    expect(count('triangle')).toBe(3)
    expect(count('star')).toBe(10)
    expect(count('cross')).toBe(12)
    expect(count('arrow')).toBe(7)
  })

  describe('circle', () => {
    it('分割数パラメータを尊重する（既定値と明示指定）', () => {
      expect(presetToContours('circle')[0].points.length).toBe(DEFAULT_CIRCLE_SEGMENTS * 2)
      expect(presetToContours('circle', { circleSegments: 12 })[0].points.length).toBe(24)
      expect(presetToContours('circle', { circleSegments: 96 })[0].points.length).toBe(192)
    })

    it('全頂点が中心から等距離（円として丸い）', () => {
      const vs = vertices(presetToContours('circle')[0])
      for (const [x, y] of vs) {
        expect(Math.hypot(x, y)).toBeCloseTo(1, 9)
      }
    })

    it('3 未満・非整数の分割数は RangeError', () => {
      expect(() => presetToContours('circle', { circleSegments: 2 })).toThrow(RangeError)
      expect(() => presetToContours('circle', { circleSegments: 6.5 })).toThrow(RangeError)
    })
  })

  describe('鏡像判定（Task 5.4 / 8.2 の回帰テスト入力保証）', () => {
    it('比較ヘルパの健全性: 左右対称なプリセットは鏡像と一致する', () => {
      // ここが通らないと「矢印が不一致」の主張が比較器バグで空虚に通る恐れがある
      for (const id of ['square', 'triangle', 'heart', 'star', 'cross'] as const) {
        const vs = vertices(presetToContours(id)[0])
        expect(samePointSet(mirrorAcrossBBoxCenter(vs), vs, 1e-9), id).toBe(true)
      }
    })

    it('arrow: bbox 縦中心線での鏡像が元の点集合を再現しない（左右非対称）', () => {
      const vs = vertices(presetToContours('arrow')[0])
      const mirrored = mirrorAcrossBBoxCenter(vs)
      expect(samePointSet(mirrored, vs, 1e-6)).toBe(false)
    })
  })

  describe('形の妥当性', () => {
    it('square: bbox が正方形（縦横比 1）', () => {
      const vs = vertices(presetToContours('square')[0])
      const xs = vs.map(([x]) => x)
      const ys = vs.map(([, y]) => y)
      const w = Math.max(...xs) - Math.min(...xs)
      const h = Math.max(...ys) - Math.min(...ys)
      expect(w / h).toBeCloseTo(1, 9)
    })

    it('triangle: 三辺の長さが等しい（正三角形）', () => {
      const vs = vertices(presetToContours('triangle')[0])
      const side = (i: number) => {
        const [x1, y1] = vs[i]
        const [x2, y2] = vs[(i + 1) % 3]
        return Math.hypot(x2 - x1, y2 - y1)
      }
      expect(side(1)).toBeCloseTo(side(0), 9)
      expect(side(2)).toBeCloseTo(side(0), 9)
    })

    it('heart: 最上部が左右のローブ（x ≠ 0）で、最下部が中央の尖り（x ≈ 0）', () => {
      const vs = vertices(presetToContours('heart')[0])
      const maxY = Math.max(...vs.map(([, y]) => y))
      const minY = Math.min(...vs.map(([, y]) => y))
      const topmost = vs.filter(([, y]) => y > maxY - 1e-9)
      const bottommost = vs.filter(([, y]) => y < minY + 1e-9)
      // 頂上は中央のくぼみではなく左右のローブにある = ハートらしい上部
      for (const [x] of topmost) {
        expect(Math.abs(x)).toBeGreaterThan(0.05)
      }
      // 最下点は中央の尖り
      for (const [x] of bottommost) {
        expect(Math.abs(x)).toBeLessThan(0.05)
      }
    })

    it('star: 外側頂点と内側頂点が交互に並び、比が五芒星（≈ 0.382）', () => {
      const vs = vertices(presetToContours('star')[0])
      const radii = vs.map(([x, y]) => Math.hypot(x, y))
      const outerR = Math.max(...radii)
      const innerR = Math.min(...radii)
      expect(innerR / outerR).toBeCloseTo(Math.cos((2 * Math.PI) / 5) / Math.cos(Math.PI / 5), 9)
      for (let i = 0; i < radii.length; i++) {
        expect(radii[i]).toBeCloseTo(i % 2 === 0 ? outerR : innerR, 9)
      }
    })
  })
})
