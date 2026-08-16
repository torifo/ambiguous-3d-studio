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
  'spade',
  'diamond',
  'club',
] as const satisfies readonly PresetId[]

/** トランプの 4 マーク（FR-100）。♥ は FR-001 から流用する */
const SUIT_IDS = ['spade', 'heart', 'diamond', 'club'] as const satisfies readonly PresetId[]

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

/** bbox */
function bbox(pts: ReadonlyArray<readonly [number, number]>): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
} {
  const xs = pts.map(([x]) => x)
  const ys = pts.map(([, y]) => y)
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ]
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * 高さ y の水平線が輪郭を横切る点の x 座標（昇順）。
 * 交点が 2 個なら断面は 1 本の区間、4 個なら 2 本に分かれている。
 * ♠ / ♣ の「ローブと茎が分かれている高さ帯」を、座標のマジックナンバーに頼らずに検出する。
 */
function crossingsAt(pts: ReadonlyArray<readonly [number, number]>, y: number): number[] {
  const xs: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    if (y1 === y2) continue
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
    }
  }
  return xs.sort((a, b) => a - b)
}

/** 3 点を通る円（外接円）。同一円弧上の 3 点から中心と半径を復元する */
function circleThrough(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): { cx: number; cy: number; r: number } {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  const sa = a[0] * a[0] + a[1] * a[1]
  const sb = b[0] * b[0] + b[1] * b[1]
  const sc = c[0] * c[0] + c[1] * c[1]
  const cx = (sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d
  const cy = (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) }
}

/** 図形の「見え方」の指標。縦横比と bbox 充填率の 2 次元。マーク同士の識別に使う */
function shapeSignature(pts: ReadonlyArray<readonly [number, number]>): [number, number] {
  const { width, height } = bbox(pts)
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    sum += x1 * y2 - x2 * y1
  }
  return [width / height, sum / 2 / (width * height)]
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

  it('頂点数が図形として自然（正方形 4・三角形 3・星 10・十字 12・矢印 7・ダイヤ 4）', () => {
    const count = (id: PresetId) => presetToContours(id)[0].points.length / 2
    expect(count('square')).toBe(4)
    expect(count('triangle')).toBe(3)
    expect(count('star')).toBe(10)
    expect(count('cross')).toBe(12)
    expect(count('arrow')).toBe(7)
    expect(count('diamond')).toBe(4)
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
      for (const id of [
        'square',
        'triangle',
        'heart',
        'star',
        'cross',
        'spade',
        'diamond',
        'club',
      ] as const) {
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

    it('spade: 上が 1 点の尖り・下は幅を持つ平らな底（＝茎がある）', () => {
      const vs = vertices(presetToContours('spade')[0])
      const { minY, maxY, width } = bbox(vs)
      // 頂点は中央の尖り 1 点だけ（ハートのように 2 つのローブではない）
      const top = vs.filter(([, y]) => y > maxY - 1e-9)
      expect(top.length).toBe(1)
      expect(Math.abs(top[0][0])).toBeLessThan(1e-9)
      // 最下部は茎の底辺 = 2 点以上が同じ高さに並び、幅を持つ
      const bottom = vs.filter(([, y]) => y < minY + 1e-9)
      expect(bottom.length).toBeGreaterThanOrEqual(2)
      const baseWidth = Math.max(...bottom.map(([x]) => x)) - Math.min(...bottom.map(([x]) => x))
      expect(baseWidth).toBeGreaterThan(0.2 * width)
      expect(baseWidth).toBeLessThan(0.6 * width)
    })

    it('spade: 最大幅が中心より下（下ぶくれ）。ハートは逆に中心より上', () => {
      const widestY = (id: PresetId): number => {
        const vs = vertices(presetToContours(id)[0])
        const maxX = Math.max(...vs.map(([x]) => x))
        return vs.filter(([x]) => x > maxX - 1e-9)[0][1]
      }
      expect(widestY('spade')).toBeLessThan(0)
      expect(widestY('heart')).toBeGreaterThan(0)
    })

    it('diamond: 4 頂点の菱形で、正方形の 45° 回転ではない（縦長）', () => {
      const vs = vertices(presetToContours('diamond')[0])
      expect(vs.length).toBe(4)
      const { width, height, minX, maxX, minY, maxY } = bbox(vs)
      // 上下の頂点は x 中央、左右の頂点は y 中央 = 菱形
      const top = vs.find(([, y]) => y === maxY)!
      const bottomV = vs.find(([, y]) => y === minY)!
      const rightV = vs.find(([x]) => x === maxX)!
      const leftV = vs.find(([x]) => x === minX)!
      expect(Math.abs(top[0])).toBeLessThan(1e-12)
      expect(Math.abs(bottomV[0])).toBeLessThan(1e-12)
      expect(Math.abs(rightV[1])).toBeLessThan(1e-12)
      expect(Math.abs(leftV[1])).toBeLessThan(1e-12)
      // 縦長。1.0 だと 45° 回した正方形になってしまう（トランプの♦は 2:3 前後）
      expect(width / height).toBeLessThan(0.8)
      expect(width / height).toBeGreaterThan(0.5)
    })

    it('club: 半径の等しい 3 円でできている（形から円を復元して確認する）', () => {
      const vs = vertices(presetToContours('club')[0])
      const { minX, maxX, maxY } = bbox(vs)
      // 各ローブの最遠点はその円弧の内側にあるので、その前後の点との外接円が
      // ローブの円そのものになる
      const at = (i: number) => vs[(i + vs.length) % vs.length]
      const fitAround = (index: number) => circleThrough(at(index - 8), at(index), at(index + 8))
      const topLobe = fitAround(vs.findIndex(([, y]) => y === maxY))
      const rightLobe = fitAround(vs.findIndex(([x]) => x === maxX))
      const leftLobe = fitAround(vs.findIndex(([x]) => x === minX))
      const lobes = [topLobe, rightLobe, leftLobe]
      // 3 円は同じ半径
      expect(rightLobe.r).toBeCloseTo(topLobe.r, 9)
      expect(leftLobe.r).toBeCloseTo(topLobe.r, 9)
      // 中心は正三角形（＝ 3 ローブが対等に散っている）
      const dist = (a: (typeof lobes)[number], b: (typeof lobes)[number]) =>
        Math.hypot(a.cx - b.cx, a.cy - b.cy)
      const side = dist(topLobe, rightLobe)
      expect(dist(rightLobe, leftLobe)).toBeCloseTo(side, 9)
      expect(dist(leftLobe, topLobe)).toBeCloseTo(side, 9)
      // 円どうしは重なっているが（< 2r = 1 つの塊）、切れ込みは残る（> 1.2r = 団子にならない）
      expect(side).toBeLessThan(2 * topLobe.r)
      expect(side).toBeGreaterThan(1.2 * topLobe.r)
      // 輪郭の大半（茎を除く全部）が、この 3 円のどれかの上に厳密に乗っている
      const onLobe = vs.filter((p) =>
        lobes.some((l) => Math.abs(Math.hypot(p[0] - l.cx, p[1] - l.cy) - l.r) < 1e-9),
      )
      expect(onLobe.length).toBeGreaterThan(vs.length * 0.8)
    })

    it.each(['spade', 'club'] as const)(
      '%s: ローブと茎が分かれて見える高さ帯があり、その下は茎だけになる',
      (id) => {
        const vs = vertices(presetToContours(id)[0])
        const { minY, maxY } = bbox(vs)
        const counts = new Map<number, number[]>()
        const steps = 400
        for (let k = 1; k < steps; k++) {
          const y = minY + ((maxY - minY) * k) / steps
          const n = crossingsAt(vs, y).length
          const ys = counts.get(n) ?? []
          ys.push(y)
          counts.set(n, ys)
        }
        // 断面が 3 本（左ローブ・茎・右ローブ）になる高さが存在する
        const split = counts.get(6)
        expect(split, `${id}: 交点 6 個（＝断面 3 本）の高さ`).toBeDefined()
        // それは下半分で起きる（茎は下にある）
        expect(Math.max(...split!)).toBeLessThan(0)
        // さらに下、最下部の近くは茎だけ（断面 1 本）
        expect(crossingsAt(vs, minY + (maxY - minY) * 0.05).length).toBe(2)
        // 上半分はどこでも 1 本の塊（ローブが割れていない）
        for (let k = 1; k < 20; k++) {
          const y = ((maxY - 1e-6) * k) / 20
          expect(crossingsAt(vs, y).length, `${id}: y=${y}`).toBe(2)
        }
        // 断面が 4 本以上に散ることはない
        expect(Math.max(...counts.keys())).toBe(6)
      },
    )

    it('4 マーク（♠♥♦♣）は互いに区別が付く', () => {
      for (let i = 0; i < SUIT_IDS.length; i++) {
        for (let j = i + 1; j < SUIT_IDS.length; j++) {
          const a = vertices(presetToContours(SUIT_IDS[i])[0])
          const b = vertices(presetToContours(SUIT_IDS[j])[0])
          const label = `${SUIT_IDS[i]} vs ${SUIT_IDS[j]}`
          // 点集合として別物（同じデータを 2 つの id に割り当てていない）
          expect(samePointSet(a, b, 1e-6), label).toBe(false)
          // 見え方としても別物: 縦横比と充填率の 2 次元で有意に離れている
          const [aspectA, fillA] = shapeSignature(a)
          const [aspectB, fillB] = shapeSignature(b)
          expect(Math.hypot(aspectA - aspectB, fillA - fillB), label).toBeGreaterThan(0.05)
        }
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
