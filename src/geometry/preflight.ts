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
 * | 全走査線で両側同時の被覆がない | `EMPTY_INTERSECTION`（生成しない） | exact |
 * | 片側のみ被覆が空の帯 | `EMPTY_BAND` | exact |
 * | 両側被覆のある全走査線で島数の積が 2 以上 | `LIKELY_DISCONNECTED` | estimated |
 * | 最小区間幅が閾値未満 | `THIN_NECK` | estimated |
 *
 * bbox の重なりは被覆の重なりの必要条件にすぎない（例：外輪郭と同一の穴を持つ
 * シルエットは bbox が正常でも被覆が常に空）。そのため走査後にも判定し、
 * 両側同時の被覆を持つ走査線が 1 本もなければ `EMPTY_INTERSECTION` を報告する。
 *
 * `emptyBands` の from/to は **実際に空を観測した走査線の中点**（連続する空走査線の
 * 最初と最後）であり、観測した範囲だけを報告する。範囲そのものは実測に基づく。
 * ただし走査線 1 本分（(hi−lo)/N）より狭い隙間はどの走査線にも掛からず
 * **検出自体を取りこぼしうる**。これは検出分解能の限界であって、
 * 報告した範囲が誤っていることとは別種の制約である。
 *
 * `estimatedComponents` は「両側とも被覆がある走査線」で観測したスライス島数の
 * 直積 m×n の最小値（該当走査線がなければ 0）。**実際の 3D 連結成分数の
 * 推定値でも下限でもない** — ある高さで分かれた島は別の高さで合流しうる。
 * 確定値は生成後の `decompose()` のみを根拠とする（FR-014）。
 *
 * `ok` は警告ゼロを意味する。生成の可否そのものは `EMPTY_INTERSECTION` の
 * 有無で判断すること（EMPTY_BAND があっても生成は行う — US-001）。
 *
 * @throws `scanlineCount` が正の整数でない、または `thinNeckRatio` が負・非有限の場合
 */
export function runPreflight(
  a: Contour[],
  b: Contour[],
  options: PreflightOptions = {},
): PreflightReport {
  const scanlineCount = options.scanlineCount ?? SCANLINE_COUNT
  const thinNeckRatio = options.thinNeckRatio ?? THIN_NECK_RATIO

  if (!Number.isInteger(scanlineCount) || scanlineCount <= 0) {
    throw new Error(
      `scanlineCount は正の整数でなければなりません（指定値: ${scanlineCount}）`,
    )
  }
  if (!Number.isFinite(thinNeckRatio) || thinNeckRatio < 0) {
    throw new Error(
      `thinNeckRatio は 0 以上の有限数でなければなりません（指定値: ${thinNeckRatio}）`,
    )
  }

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
      // 実際に空を観測した走査線の中点だけを範囲とする（セル境界へ広げない）。
      // 広げると未観測の高さまで「空」と主張することになり exact でなくなる
      emptyBands.push({
        from: lo + (bandFirstK + 0.5) * step,
        to: lo + (bandLastK + 0.5) * step,
        side: bandSide,
      })
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

  if (minProduct === Infinity) {
    // 両側同時の被覆を持つ走査線が 1 本もなかった。スライス恒等式より、
    // サンプリングしたすべての高さで交差は空 — bbox が重なっていても
    // 被覆が重ならない組（例：外輪郭と同一の穴を持つ空シルエット）はここで捕捉する。
    // 立体そのものが存在しないため、個別の EMPTY_BAND は報告しない
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
            'サンプリングしたすべての高さで、両シルエットの被覆が同時には存在しないため、この組み合わせの交差は空です。生成される立体はありません。',
        },
      ],
    }
  }

  const estimatedComponents = minProduct
  const warnings: PreflightWarning[] = []

  for (const band of emptyBands) {
    warnings.push({
      code: 'EMPTY_BAND',
      certainty: 'exact',
      band: [band.from, band.to],
      message: `高さ y=${fmt(band.from)}〜${fmt(band.to)} の帯では、サンプリングしたすべての高さでシルエット ${band.side} に被覆がないため、立体はこの帯で途切れます。これはこの組み合わせの性質です。`,
    })
  }

  if (estimatedComponents >= 2) {
    warnings.push({
      code: 'LIKELY_DISCONNECTED',
      certainty: 'estimated',
      components: estimatedComponents,
      message: `両側に被覆があるサンプリング高さのすべてでスライスが ${estimatedComponents} 個以上の島に分かれているため、立体が複数のパーツに分離する可能性があります（確定した連結成分数は生成後の解析で求まります）。`,
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
