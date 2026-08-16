import type { Contour, PreflightReport, PreflightWarning } from './types'

/**
 * プリフライト判定（FR-012 / design.md「3. プリフライト判定」）。
 *
 * 高さ y における交差立体のスライスは直積 `slice(y) = A_y × B_y` になる。
 * この恒等式から導ける事実と導けない推測を **certainty で厳密に区別する**：
 *
 * - **厳密（'exact'）**: 片方の被覆が空なら、その高さの交差は空。
 *   サンプリングした走査線上では反例が存在しえないため、断定してよい。
 *   → `EMPTY_INTERSECTION` / `EMPTY_BAND`
 * - **推定（'estimated'）**: 走査線ごとの島の数は 3D の連結成分数を
 *   確定しない（ある高さで分かれた島は別の高さで合流しうるし、
 *   256 本のサンプリングは狭い帯・細い首を取りこぼす）。
 *   → `LIKELY_DISCONNECTED` / `THIN_NECK`
 *
 * 確定した連結成分数は生成後の `decompose()` のみを根拠とする（FR-014）。
 * ここで検出される空帯は実装の不具合ではなく組み合わせの数学的性質であり、
 * 警告文もエラーではなく「性質の提示」として書く。
 */

/** 走査線の本数（design.md の N = 256）。 */
export const SCANLINE_COUNT = 256

/**
 * THIN_NECK 閾値：共通 Y 範囲の高さに対する最小区間幅の比。
 * 既定 0.02 = 高さの 2%。実寸の既定 60mm（FR-029）では約 1.2mm に相当し、
 * FDM 印刷で折れやすくなる目安の壁厚に合わせている。
 */
export const THIN_NECK_RATIO = 0.02

/** 同一座標とみなす交点間の許容差／ゼロ幅区間の除去閾値。 */
const EPS = 1e-9

export interface PreflightOptions {
  /** 走査線の本数。既定は {@link SCANLINE_COUNT}。 */
  scanlineCount?: number
  /** THIN_NECK 判定の比率閾値。既定は {@link THIN_NECK_RATIO}。 */
  thinNeckRatio?: number
}

/**
 * 高さ y におけるシルエットの被覆 x 区間集合を返す。
 *
 * 全輪郭の辺と水平線 y の交点を集め、巻き数（winding）でスイープする。
 * 正規化済み輪郭は外輪郭 CCW / 穴 CW（Positive fill rule — ADR-005）なので、
 * **穴の交点は巻き数を打ち消し、被覆から自動的に差し引かれる**。
 * `isHole` フラグは参照しない：被覆は巻き方向だけで決まる。
 *
 * 辺の交差判定は半開区間（y1 <= y < y2）で数え、頂点を通る走査線でも
 * 交点が二重・欠落しないようにする。水平辺は両条件を満たさず自然に無視される。
 *
 * @returns x 昇順の閉区間 `[from, to][]`。被覆がなければ空配列
 */
export function coveredIntervalsAt(contours: Contour[], y: number): Array<[number, number]> {
  const xs: number[] = []
  const dirs: number[] = []

  for (const contour of contours) {
    const p = contour.points
    const n = p.length >> 1
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const x1 = p[i * 2]
      const y1 = p[i * 2 + 1]
      const x2 = p[j * 2]
      const y2 = p[j * 2 + 1]
      if (y1 <= y && y < y2) {
        // 上向きに横切る辺（CCW 外輪郭の右側）
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
        dirs.push(1)
      } else if (y2 <= y && y < y1) {
        // 下向きに横切る辺
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
        dirs.push(-1)
      }
    }
  }

  if (xs.length === 0) return []

  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])

  // 点 x における巻き数 = x より右にある交点の方向の総和。
  // 左から右へスイープし、通過した交点の方向を総和（閉輪郭なので 0）から引いていく。
  const intervals: Array<[number, number]> = []
  let winding = 0
  let openX = 0
  let i = 0
  while (i < order.length) {
    const x = xs[order[i]]
    // 同一 x の交点はまとめて処理し、ゼロ幅のスパイク／隙間を作らない
    let delta = 0
    while (i < order.length && Math.abs(xs[order[i]] - x) <= EPS) {
      delta += dirs[order[i]]
      i++
    }
    const wasCovered = winding > 0
    winding -= delta
    const nowCovered = winding > 0
    if (!wasCovered && nowCovered) {
      openX = x
    } else if (wasCovered && !nowCovered && x - openX > EPS) {
      intervals.push([openX, x])
    }
  }
  return intervals
}

/** 全輪郭の Y 範囲。頂点が 1 つもなければ null。 */
function yRangeOf(contours: Contour[]): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (const contour of contours) {
    const p = contour.points
    for (let i = 1; i < p.length; i += 2) {
      if (p[i] < min) min = p[i]
      if (p[i] > max) max = p[i]
    }
  }
  return min <= max ? [min, max] : null
}

const fmt = (v: number): string => v.toFixed(2)

/**
 * 2 つの正規化済みシルエットの適合性を走査線サンプリングで解析する（FR-012）。
 *
 * 結合 Y 範囲を N 本の走査線で等分（セル中点サンプリング。範囲端の頂点に
 * 走査線が乗って交差判定が縮退するのを避ける）し、各高さで両側の被覆
 * x 区間集合を求めて判定する：
 *
 * | 条件 | 警告 | certainty |
 * |---|---|---|
 * | bbox の Y 範囲が重ならない | `EMPTY_INTERSECTION`（生成しない） | exact |
 * | 片側のみ被覆が空の帯 | `EMPTY_BAND` | exact |
 * | 全走査線で区間数の積が 2 以上 | `LIKELY_DISCONNECTED` | estimated |
 * | 最小区間幅が閾値未満 | `THIN_NECK` | estimated |
 *
 * `emptyBands` の from/to は「空だった走査線の並び」をセル境界まで広げた値で、
 * 実際の空帯の端とは走査線 1 本分（±(hi−lo)/N）の誤差を持ちうる。
 *
 * `estimatedComponents` は「両側とも被覆がある走査線」における区間数の積
 * m×n の最小値（該当走査線がなければ 0）。**3D 連結成分数の下限ではない。**
 *
 * `ok` は警告ゼロを意味する。生成の可否そのものは `EMPTY_INTERSECTION` の
 * 有無で判断すること（EMPTY_BAND があっても生成は行う — US-001）。
 */
export function runPreflight(
  a: Contour[],
  b: Contour[],
  options: PreflightOptions = {},
): PreflightReport {
  const scanlineCount = options.scanlineCount ?? SCANLINE_COUNT
  const thinNeckRatio = options.thinNeckRatio ?? THIN_NECK_RATIO

  const rangeA = yRangeOf(a)
  const rangeB = yRangeOf(b)
  const sharedLo = rangeA && rangeB ? Math.max(rangeA[0], rangeB[0]) : Infinity
  const sharedHi = rangeA && rangeB ? Math.min(rangeA[1], rangeB[1]) : -Infinity

  if (!rangeA || !rangeB || sharedHi - sharedLo <= EPS) {
    // Y 範囲に重なりがない。スライス恒等式より交差は空 — これは断定できる
    return {
      ok: false,
      sharedYRange: null,
      emptyBands: [],
      estimatedComponents: 0,
      warnings: [
        {
          code: 'EMPTY_INTERSECTION',
          certainty: 'exact',
          message:
            '2 つのシルエットの高さ範囲が重ならないため、この組み合わせの交差は空です。生成される立体はありません。',
        },
      ],
    }
  }

  // 結合（union）Y 範囲を走査する。片側しか届かない高さ帯は EMPTY_BAND になる
  const lo = Math.min(rangeA[0], rangeB[0])
  const hi = Math.max(rangeA[1], rangeB[1])
  const step = (hi - lo) / scanlineCount

  const emptyBands: PreflightReport['emptyBands'] = []
  let bandSide: 'A' | 'B' | null = null
  let bandFirstK = 0
  let bandLastK = 0
  const closeBand = (): void => {
    if (bandSide !== null) {
      // セル中点サンプリングなので、セル境界（±step/2）まで帯を広げる
      emptyBands.push({ from: lo + bandFirstK * step, to: lo + (bandLastK + 1) * step, side: bandSide })
      bandSide = null
    }
  }

  let minProduct = Infinity
  let minWidth = Infinity

  for (let k = 0; k < scanlineCount; k++) {
    const y = lo + (k + 0.5) * step
    const intervalsA = coveredIntervalsAt(a, y)
    const intervalsB = coveredIntervalsAt(b, y)
    const emptyA = intervalsA.length === 0
    const emptyB = intervalsB.length === 0

    if (emptyA !== emptyB) {
      const side: 'A' | 'B' = emptyA ? 'A' : 'B'
      if (bandSide === side) {
        bandLastK = k
      } else {
        closeBand()
        bandSide = side
        bandFirstK = k
        bandLastK = k
      }
    } else {
      closeBand()
      if (!emptyA) {
        // 両側とも被覆あり：島の数の直積と最小区間幅を記録
        if (intervalsA.length * intervalsB.length < minProduct) {
          minProduct = intervalsA.length * intervalsB.length
        }
        for (const [from, to] of intervalsA) if (to - from < minWidth) minWidth = to - from
        for (const [from, to] of intervalsB) if (to - from < minWidth) minWidth = to - from
      }
    }
  }
  closeBand()

  const estimatedComponents = minProduct === Infinity ? 0 : minProduct
  const warnings: PreflightWarning[] = []

  for (const band of emptyBands) {
    warnings.push({
      code: 'EMPTY_BAND',
      certainty: 'exact',
      band: [band.from, band.to],
      message: `高さ y=${fmt(band.from)}〜${fmt(band.to)} の帯ではシルエット ${band.side} に被覆がないため、立体はこの帯で途切れます。これはこの組み合わせの性質です。`,
    })
  }

  if (estimatedComponents >= 2) {
    warnings.push({
      code: 'LIKELY_DISCONNECTED',
      certainty: 'estimated',
      components: estimatedComponents,
      message: `どの高さでもスライスが ${estimatedComponents} 個以上の島に分かれているため、立体が複数のパーツに分離する可能性があります（確定した連結成分数は生成後の解析で求まります）。`,
    })
  }

  if (minWidth < thinNeckRatio * (sharedHi - sharedLo)) {
    warnings.push({
      code: 'THIN_NECK',
      certainty: 'estimated',
      minWidth,
      message: `幅が約 ${fmt(minWidth)} の細い箇所があるため、印刷時に破損する可能性があります。`,
    })
  }

  return {
    ok: warnings.length === 0,
    sharedYRange: [sharedLo, sharedHi],
    emptyBands,
    estimatedComponents,
    warnings,
  }
}
