import type { Contour, PreflightWarning } from './types'

/**
 * プリフライト判定（FR-012 / FR-101 / design.md「3. プリフライト判定」）。
 *
 * ## 2 視点のスライス恒等式
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
 *
 * ## 視点 C を足すとスライスは三重直積に**ならない**（FR-101 の実装上の訂正）
 *
 * 仕様（illusion-catalogue.md）は「高さ y のスライスは `A_y × B_y × C_y` の
 * 三重直積」と書くが、**視点 C の押し出し軸は +Y**（protocol.ts
 * `VIEWPOINT_AXES`）であり、C の断面ローカル Y は world **−Z** に載る。
 * つまり C のシルエットは XZ 平面の図形で、**高さ y の関数ではない**。
 * `C_y` という量は存在しない。実際のスライスは
 *
 * ```
 * w = −z（B の断面ローカル X であり、同時に C の断面ローカル Y でもある）
 * slice(y) = { (x, w) : x ∈ A_y,  w ∈ B_y,  (x, w) ∈ S_C }
 *          = (A_y × B_y) ∩ S_C
 * ```
 *
 * すなわち「高さごとの直積 `A_y × B_y` を、**高さに依らない 2D 領域 S_C** で
 * さらに削る」形になる。三重直積として実装すると C の効き方を取り違え、
 * 「C に被覆がある高さ帯」という存在しない量を UI に出すことになる。
 *
 * この形でも**空判定は厳密のまま**である：
 * `slice(y) = ∅ ⟺ ¬∃w( w ∈ B_y ∧ C_w ∩ A_y ≠ ∅ )`（`C_w` は S_C の高さ w に
 * おける x 区間集合）。走査線サンプリングの分解能内で、この同値は厳密に判定できる。
 * したがって適格性（US-001）は 2 視点よりはるかに狭くなる — C は
 * **すべての高さに同じ制約を課す**ため、A / B の被覆が w 方向に動く形
 * （斜めのストローク・離れたパーツ）では容易に全滅する。
 *
 * ## 斜交軸（FR-102）とプリフライト
 *
 * 軸角 φ ≠ 90° では `(x, z) → (x, x cos φ − z sin φ)` という**可逆な線形写像**が
 * 挟まるだけで、空判定にも島の数にも影響しない（可逆線形写像は空集合を空集合に、
 * 連結成分を連結成分に写す）。**唯一 `THIN_NECK` だけが楽観側にずれる**：
 * せん断後の実際のくびれ幅は、ここで測る区間幅より `|sin φ|` 倍ぶん細くなりうる。
 * THIN_NECK はもともと 'estimated' なので分類は変えない。
 *
 * ## 計算量
 *
 * 2 視点は走査線 N 本の O(N)。視点 C があると各高さで w を最大 M 本走査する
 * ため最悪 O(N·M) になるが、live な高さでは最初に見つかった w で打ち切る。
 * 実測（N = M = 256、256 角形の円）：2 視点 0.69ms / 3 視点（成立する組）
 * 0.53ms / 3 視点の最悪ケース（w は重なるが x が一度も重ならない組）1.16ms。
 * NFR-001 の 300ms 予算に対しては無視できる。
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
  /**
   * 視点 C の正規化済み輪郭（FR-101）。省略 / null = **2 視点**で、
   * 判定も返り値も従来と 1 ビットも変わらない。
   *
   * 位置引数ではなくオプションに置いてあるのは、既存の呼び出し
   * `runPreflight(a, b)` / `runPreflight(a, b, { scanlineCount })` を
   * 一切書き換えずに 3 視点へ拡張するため。
   */
  c?: Contour[] | null
  /** 走査線の本数。既定は {@link SCANLINE_COUNT}。 */
  scanlineCount?: number
  /** THIN_NECK 判定の比率閾値。既定は {@link THIN_NECK_RATIO}。 */
  thinNeckRatio?: number
}

/**
 * 視点の識別子。`'C'` は FR-101 で足したメンバーで、`'A' | 'B'` の**拡張**
 * （改名ではない）。既存 UI は追加メンバーを知らなくても壊れない。
 */
export type ViewpointId = 'A' | 'B' | 'C'

/** 空帯 1 本。`PreflightReport['emptyBands']` の要素を C まで広げた形 */
export interface PreflightEmptyBand {
  from: number
  to: number
  side: ViewpointId
}

/**
 * 視点名を持つプリフライト警告。
 *
 * **コードの追加も改名もしていない** — `PreflightWarning`（geometry/types.ts）と
 * 同じ 5 コードのまま、`EMPTY_BAND` に `side`、`EMPTY_INTERSECTION` に
 * `emptySides` を**足しただけ**。よってこの型の値はそのまま
 * `PreflightWarning` として扱え、コードを網羅 switch している既存 UI
 * （ui/StatusBanner.tsx）はコンパイルも動作も変わらない。UI が視点名を
 * 出したくなったときだけ、この型を読めばよい。
 */
export type ViewpointPreflightWarning =
  | {
      code: 'EMPTY_INTERSECTION'
      certainty: 'exact'
      message: string
      /**
       * 交差が空になった責任を負う視点。「他の視点には被覆があるのに
       * この視点だけ被覆がない高さが存在した」ものを挙げる。
       * 高さ範囲そのものが重ならない場合は特定の視点に帰せないので空配列。
       */
      emptySides: ViewpointId[]
    }
  | {
      code: 'EMPTY_BAND'
      certainty: 'exact'
      message: string
      band: [number, number]
      /** この帯で被覆が空だった視点 */
      side: ViewpointId
    }
  | { code: 'LIKELY_DISCONNECTED'; certainty: 'estimated'; message: string; components: number }
  | { code: 'THIN_NECK'; certainty: 'estimated'; message: string; minWidth: number }
  | { code: 'SIMPLIFIED'; certainty: 'exact'; message: string; before: number; after: number }

/**
 * 3 視点まで扱えるプリフライトレポート。`PreflightReport` に
 * `liveYRange` を足し、`emptyBands[].side` と `warnings` を上の型へ広げたもの
 * （どのフィールドも削っていないので `PreflightReport` としても読める）。
 */
export interface ViewpointPreflightReport {
  ok: boolean
  /** 全シルエットの bbox が同時に存在する Y 範囲。空なら交差は空集合 */
  sharedYRange: [number, number] | null
  /**
   * **すべての視点が同時に材料を持つ高さ帯**（FR-101 が提示を求めるもの）。
   * `sharedYRange` は bbox の重なりでしかなく、必要条件にすぎない。
   * 立体になるのはこちらの範囲だけ。live な走査線が 1 本もなければ null。
   */
  liveYRange: [number, number] | null
  emptyBands: PreflightEmptyBand[]
  estimatedComponents: number
  warnings: ViewpointPreflightWarning[]
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

/** 全輪郭の X 範囲。頂点が 1 つもなければ null。 */
function xRangeOf(contours: Contour[]): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (const contour of contours) {
    const p = contour.points
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < min) min = p[i]
      if (p[i] > max) max = p[i]
    }
  }
  return min <= max ? [min, max] : null
}

/** 値が閉区間集合のどれかに入るか */
function containsValue(intervals: ReadonlyArray<[number, number]>, v: number): boolean {
  for (const [from, to] of intervals) {
    if (v >= from && v <= to) return true
  }
  return false
}

/** 2 つの区間集合が交わるか（どちらも x 昇順・互いに素） */
function intervalsOverlap(
  left: ReadonlyArray<[number, number]>,
  right: ReadonlyArray<[number, number]>,
): boolean {
  for (const [l0, l1] of left) {
    for (const [r0, r1] of right) {
      if (l0 < r1 - EPS && r0 < l1 - EPS) return true
    }
  }
  return false
}

/** 区間集合の最小幅（空なら Infinity） */
function minIntervalWidth(intervals: ReadonlyArray<[number, number]>): number {
  let min = Infinity
  for (const [from, to] of intervals) {
    if (to - from < min) min = to - from
  }
  return min
}

const fmt = (v: number): string => v.toFixed(2)

/** 視点 C の前処理結果（C の走査を高さ y のループの外で 1 回だけ行う） */
interface ViewpointCScan {
  /** サンプリングした w（= world −z）の座標。C のローカル Y かつ B のローカル X */
  wSamples: number[]
  /** `wSamples[j]` における S_C の x 区間集合 */
  intervalsAtW: Array<Array<[number, number]>>
  /** どこかの w で被覆を持ったか */
  anyCoverage: boolean
  /** 全 w にわたる最小区間幅（THIN_NECK 用の推定） */
  minWidth: number
}

/**
 * 視点 C を w 方向（= world −z）に走査する。
 *
 * C の制約が効くのは「B が高さ y で許す w」と重なる範囲だけなので、
 * サンプリング範囲は **C のローカル Y 範囲 ∩ B のローカル X 範囲**に絞る。
 * この重なりが無ければ C はどの高さでも A×B を全部削り落とす。
 *
 * @returns 重なりが無い（= どの高さでも交差が空）なら null
 */
function scanViewpointC(
  c: Contour[],
  b: Contour[],
  sampleCount: number,
): ViewpointCScan | null {
  const rangeC = yRangeOf(c)
  const rangeBx = xRangeOf(b)
  if (rangeC === null || rangeBx === null) return null
  const lo = Math.max(rangeC[0], rangeBx[0])
  const hi = Math.min(rangeC[1], rangeBx[1])
  if (hi - lo <= EPS) return null

  const step = (hi - lo) / sampleCount
  const wSamples: number[] = []
  const intervalsAtW: Array<Array<[number, number]>> = []
  let anyCoverage = false
  let minWidth = Infinity
  for (let j = 0; j < sampleCount; j++) {
    const w = lo + (j + 0.5) * step
    const intervals = coveredIntervalsAt(c, w)
    wSamples.push(w)
    intervalsAtW.push(intervals)
    if (intervals.length > 0) {
      anyCoverage = true
      const width = minIntervalWidth(intervals)
      if (width < minWidth) minWidth = width
    }
  }
  return { wSamples, intervalsAtW, anyCoverage, minWidth }
}

/**
 * 高さ y のスライス `(A_y × B_y) ∩ S_C` が空でないか（FR-101）。
 *
 * `∃w( w ∈ B_y ∧ C_w ∩ A_y ≠ ∅ )` をサンプリングした w について調べる。
 * 見つかった時点で打ち切るので、適格な組では数回の反復で終わる。
 */
function sliceSurvivesC(
  scan: ViewpointCScan,
  intervalsA: ReadonlyArray<[number, number]>,
  intervalsB: ReadonlyArray<[number, number]>,
): boolean {
  for (let j = 0; j < scan.wSamples.length; j++) {
    const cAtW = scan.intervalsAtW[j]
    if (cAtW.length === 0) continue
    if (!containsValue(intervalsB, scan.wSamples[j])) continue
    if (intervalsOverlap(cAtW, intervalsA)) return true
  }
  return false
}

/** 視点名の日本語表記（警告文用） */
function sideLabel(side: ViewpointId): string {
  return `シルエット ${side}`
}

/**
 * 正規化済みシルエットの適合性を走査線サンプリングで解析する（FR-012 / FR-101）。
 *
 * 結合 Y 範囲を N 本の走査線で等分（セル中点サンプリング。範囲端の頂点に
 * 走査線が乗って交差判定が縮退するのを避ける）し、各高さで各視点の被覆を
 * 求めて判定する：
 *
 * | 条件 | 警告 | certainty |
 * |---|---|---|
 * | bbox の Y 範囲が重ならない | `EMPTY_INTERSECTION`（生成しない） | exact |
 * | 全走査線でスライスが空 | `EMPTY_INTERSECTION`（生成しない） | exact |
 * | 一部の視点だけ被覆が空の帯 | `EMPTY_BAND`（視点ごとに 1 件） | exact |
 * | live な全走査線で島数の積が 2 以上 | `LIKELY_DISCONNECTED` | estimated |
 * | 最小区間幅が閾値未満 | `THIN_NECK` | estimated |
 *
 * bbox の重なりは被覆の重なりの必要条件にすぎない（例：外輪郭と同一の穴を持つ
 * シルエットは bbox が正常でも被覆が常に空）。そのため走査後にも判定し、
 * live な走査線が 1 本もなければ `EMPTY_INTERSECTION` を報告する。
 *
 * ### 視点 C の効き方（ファイル冒頭「三重直積にならない」を参照）
 *
 * C は高さごとの被覆を持たない。高さ y が live であるのは
 * `∃w( w ∈ B_y ∧ C_w ∩ A_y ≠ ∅ )` のときで、これを満たさない高さを
 * 「C が空の帯」として報告する（A / B のどちらかが既に空の高さは、
 * 責任を C に付け替えないため C の空判定から除く）。
 *
 * ### 空帯の報告単位と「1 高さ 1 視点」の不変条件
 *
 * 帯は**視点ごとに 1 件**出す（`side` は単数のまま — 配列化は既存 UI の
 * 契約を壊す）。3 視点でも 1 つの高さで責任を負う視点は**高々 1 つ**になる：
 *
 * - A だけ空 → A のみ（C は評価しない）
 * - B だけ空 → B のみ（同上）
 * - A も B も空 → そこには何もない。帯として報告しない（2 視点と同じ扱い）
 * - A も B も被覆あり・スライスが空 → C のみ
 *
 * 高さごとに責任が入れ替わるので追跡は視点ごとに独立して行うが、
 * 2 視点では空になる視点が高々 1 つという性質が変わらないため、
 * 出力は従来と完全に一致する。
 *
 * `emptyBands` の from/to は **実際に空を観測した走査線の中点**（連続する空走査線の
 * 最初と最後）であり、観測した範囲だけを報告する。範囲そのものは実測に基づく。
 * ただし走査線 1 本分（(hi−lo)/N）より狭い隙間はどの走査線にも掛からず
 * **検出自体を取りこぼしうる**。これは検出分解能の限界であって、
 * 報告した範囲が誤っていることとは別種の制約である。
 *
 * `estimatedComponents` は「live な走査線」で観測した `|A_y| × |B_y|` の最小値
 * （該当走査線がなければ 0）。**実際の 3D 連結成分数の推定値でも下限でもない** —
 * ある高さで分かれた島は別の高さで合流しうる。視点 C は材料を削るだけなので
 * 島をさらに増やしうるが、その分は数えない（数えても下限にはならないため）。
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
): ViewpointPreflightReport {
  const scanlineCount = options.scanlineCount ?? SCANLINE_COUNT
  const thinNeckRatio = options.thinNeckRatio ?? THIN_NECK_RATIO
  const c = options.c ?? null

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

  const sides: ViewpointId[] = c === null ? ['A', 'B'] : ['A', 'B', 'C']
  const emptyIntersection = (
    message: string,
    emptySides: ViewpointId[],
  ): ViewpointPreflightReport => ({
    ok: false,
    sharedYRange: null,
    liveYRange: null,
    emptyBands: [],
    estimatedComponents: 0,
    warnings: [{ code: 'EMPTY_INTERSECTION', certainty: 'exact', message, emptySides }],
  })

  const rangeA = yRangeOf(a)
  const rangeB = yRangeOf(b)
  const sharedLo = rangeA && rangeB ? Math.max(rangeA[0], rangeB[0]) : Infinity
  const sharedHi = rangeA && rangeB ? Math.min(rangeA[1], rangeB[1]) : -Infinity

  if (!rangeA || !rangeB || sharedHi - sharedLo <= EPS) {
    // Y 範囲に重なりがない。スライス恒等式より交差は空 — これは断定できる。
    // 特定の視点に責任を帰せる状況ではない（どちらも「相手の高さにいない」）
    return emptyIntersection(
      `${sides.length} つのシルエットが同時に材料を持てる高さ範囲がないため、この組み合わせの交差は空です。生成される立体はありません。`,
      [],
    )
  }

  // 視点 C の走査は高さのループの外で 1 回だけ行う（C は y に依存しない）
  let scanC: ViewpointCScan | null = null
  if (c !== null) {
    scanC = scanViewpointC(c, b, scanlineCount)
    if (scanC === null || !scanC.anyCoverage) {
      return emptyIntersection(
        `${sideLabel('C')} が、シルエット B の許す奥行き範囲のどこにも材料を持たないため、この組み合わせの交差は空です。生成される立体はありません。`,
        ['C'],
      )
    }
  }

  // 結合（union）Y 範囲を走査する。片側しか届かない高さ帯は EMPTY_BAND になる
  const lo = Math.min(rangeA[0], rangeB[0])
  const hi = Math.max(rangeA[1], rangeB[1])
  const step = (hi - lo) / scanlineCount

  // 視点ごとの空帯を独立に追う。2 視点では同時に空になる視点が高々 1 つなので
  // 従来の「1 本の帯を側で切り替える」実装と出力が完全に一致する
  const emptyBands: PreflightEmptyBand[] = []
  const openFirstK: Partial<Record<ViewpointId, number>> = {}
  const openLastK: Partial<Record<ViewpointId, number>> = {}
  const closeBand = (side: ViewpointId): void => {
    const first = openFirstK[side]
    const last = openLastK[side]
    if (first === undefined || last === undefined) return
    // 実際に空を観測した走査線の中点だけを範囲とする（セル境界へ広げない）。
    // 広げると未観測の高さまで「空」と主張することになり exact でなくなる
    emptyBands.push({
      from: lo + (first + 0.5) * step,
      to: lo + (last + 0.5) * step,
      side,
    })
    delete openFirstK[side]
    delete openLastK[side]
  }
  const closeAllBands = (): void => {
    for (const side of sides) closeBand(side)
  }

  /** 「他に被覆のある視点がある高さで空だった」視点 = 責任を負う視点 */
  const blamed: Partial<Record<ViewpointId, boolean>> = {}
  let minProduct = Infinity
  let minWidth = Infinity
  let firstLiveK = -1
  let lastLiveK = -1

  for (let k = 0; k < scanlineCount; k++) {
    const y = lo + (k + 0.5) * step
    const intervalsA = coveredIntervalsAt(a, y)
    const intervalsB = coveredIntervalsAt(b, y)
    const emptyA = intervalsA.length === 0
    const emptyB = intervalsB.length === 0
    // C の空判定は A / B が両方とも被覆を持つ高さでのみ意味を持つ。
    // A が空の高さで「C も空」と数えると、A の責任を C に付け替えてしまう
    const emptyC =
      scanC !== null && !emptyA && !emptyB && !sliceSurvivesC(scanC, intervalsA, intervalsB)
    const live = !emptyA && !emptyB && !emptyC

    // A も B も材料を持たない高さは「途切れ」ではない（そこには何もない）。
    // 2 視点ではこれが従来の `emptyA !== emptyB` と厳密に同値になる
    const isGap = !live && !(emptyA && emptyB)
    if (!isGap) {
      closeAllBands()
    } else {
      const empty: Record<ViewpointId, boolean> = { A: emptyA, B: emptyB, C: emptyC }
      for (const side of sides) {
        if (empty[side]) {
          blamed[side] = true
          if (openFirstK[side] === undefined) openFirstK[side] = k
          openLastK[side] = k
        } else {
          closeBand(side)
        }
      }
    }

    if (live) {
      if (firstLiveK < 0) firstLiveK = k
      lastLiveK = k
      // 島の数の直積と最小区間幅を記録
      if (intervalsA.length * intervalsB.length < minProduct) {
        minProduct = intervalsA.length * intervalsB.length
      }
      const widthAB = Math.min(minIntervalWidth(intervalsA), minIntervalWidth(intervalsB))
      if (widthAB < minWidth) minWidth = widthAB
    }
  }
  closeAllBands()

  if (minProduct === Infinity) {
    // live な走査線が 1 本もなかった。スライス恒等式より、サンプリングした
    // すべての高さで交差は空 — bbox が重なっていても被覆が重ならない組
    // （例：外輪郭と同一の穴を持つ空シルエット、B の奥行きと噛み合わない C）は
    // ここで捕捉する。立体そのものが存在しないため、個別の EMPTY_BAND は報告しない
    const emptySides = sides.filter((side) => blamed[side] === true)
    const blame =
      emptySides.length > 0
        ? `被覆が空だったのは ${emptySides.map(sideLabel).join(' と ')} です。`
        : ''
    return emptyIntersection(
      `サンプリングしたすべての高さで、${sides.length} つのシルエットの被覆が同時には存在しないため、この組み合わせの交差は空です。${blame}生成される立体はありません。`,
      emptySides,
    )
  }

  // C の最小区間幅（w 方向）も細さの推定に加える。C は y に依存しないので
  // 全 w 一括で 1 回だけ折り込む
  if (scanC !== null && scanC.minWidth < minWidth) minWidth = scanC.minWidth

  const estimatedComponents = minProduct
  const warnings: ViewpointPreflightWarning[] = []

  for (const band of emptyBands) {
    warnings.push({
      code: 'EMPTY_BAND',
      certainty: 'exact',
      band: [band.from, band.to],
      side: band.side,
      message: `高さ y=${fmt(band.from)}〜${fmt(band.to)} の帯では、サンプリングしたすべての高さで${sideLabel(band.side)}に被覆がないため、立体はこの帯で途切れます。これはこの組み合わせの性質です。`,
    })
  }

  if (estimatedComponents >= 2) {
    warnings.push({
      code: 'LIKELY_DISCONNECTED',
      certainty: 'estimated',
      components: estimatedComponents,
      message: `すべての視点に被覆があるサンプリング高さのすべてでスライスが ${estimatedComponents} 個以上の島に分かれているため、立体が複数のパーツに分離する可能性があります（確定した連結成分数は生成後の解析で求まります）。`,
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
    liveYRange:
      firstLiveK < 0 ? null : [lo + (firstLiveK + 0.5) * step, lo + (lastLiveK + 0.5) * step],
    emptyBands,
    estimatedComponents,
    warnings,
  }
}

/**
 * 広げた警告型が、従来の `PreflightWarning`（geometry/types.ts）として
 * **そのまま**通ることを型で固定する回帰ガード。`side` / `emptySides` は
 * 追加フィールドにすぎず、コードの追加も改名もしていない — ここが
 * コンパイルエラーになったら、警告コードを網羅 switch している
 * ui/StatusBanner.tsx も同時に壊れている。
 */
export function asLegacyWarnings(
  warnings: readonly ViewpointPreflightWarning[],
): readonly PreflightWarning[] {
  return warnings
}
