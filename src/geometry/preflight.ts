import type { Contour, PreflightWarning } from './types'

/**
 * プリフライト判定（FR-012 / FR-101 / FR-102 / design.md「3. プリフライト判定」）。
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
 * w = −z（C の断面ローカル Y。軸角 φ によらず常にこの座標）
 * s = x cos φ + w sin φ（B の断面ローカル X。φ = 90° では s = w）
 * slice(y) = { (x, w) : x ∈ A_y,  s(x, w) ∈ B_y,  (x, w) ∈ S_C }
 * ```
 *
 * すなわち「高さごとの直積 `A_y × B_y` を、**高さに依らない 2D 領域 S_C** で
 * さらに削る」形になる。三重直積として実装すると C の効き方を取り違え、
 * 「C に被覆がある高さ帯」という存在しない量を UI に出すことになる。
 *
 * ### 視点 C の厳密判定（レビュー Finding 1 / Finding 2 の修正）
 *
 * `slice(y) = ∅ ⟺ ¬∃(x, w)( x ∈ A_y ∧ s(x, w) ∈ B_y ∧ (x, w) ∈ S_C )`。
 *
 * この存在判定は **w を離散サンプリングせずに厳密に判定できる**：
 * `A_y` と `B_y` はそれぞれ有限本の区間の和集合なので、区間の組
 * `([a0,a1], [b0,b1])` ごとに `(x, w)` 平面上の凸四角形
 *
 * ```
 * Q(a0,a1,b0,b1) = { (x, w) : a0 ≤ x ≤ a1,  b0 ≤ x cos φ + w sin φ ≤ b1 }
 * ```
 *
 * （φ = 90° では軸に平行な矩形 `[a0,a1] × [b0,b1]` に一致する）を作り、
 * **`S_C` がこの凸四角形と交わるか**を判定する。多角形（`S_C`。巻き数で穴を含む
 * 任意の輪郭集合）と凸四角形の交わりは、次の 3 条件のどれか 1 つで**厳密に**
 * 決まる（`regionIntersectsQuad`）：
 *
 * 1. 四角形の頂点のどれかが `S_C` の内部にある
 * 2. `S_C` の頂点のどれかが四角形の内部にある
 * 3. `S_C` の辺と四角形の辺が交差する
 *
 * いずれも成り立たなければ交わらない（一方が他方を完全に含む場合は必ず 1 か 2
 * で捕まる — 凸領域なので「含みつつどの頂点も内側にない」は起こらない）。
 * `A_y` の区間数を p、`B_y` の区間数を q とすると判定は `O(p·q·|S_C の頂点数|)`
 * で、**サンプリング分解能に一切依存しない**。旧実装は `w` を 256 分割して
 * 各点で `s(x,w) ∈ B_y` かを尋ねていたため、`B_y` の帯が分割幅より狭いと
 * サンプルが 1 点も命中せず「空」と誤断定しうる（レビュー Finding 2 の実体）うえ、
 * 軸角が加わると `s` が `x` にも依存するため `s = w` を仮定する旧判定は
 * せん断のある入力そのものをモデル化できていなかった（レビュー Finding 1 の実体）。
 * 新判定はどちらの欠陥も持たない厳密な幾何判定なので、φ ≠ 90° でも
 * `EMPTY_INTERSECTION` / `EMPTY_BAND` は引き続き `'exact'` を返してよい。
 *
 * ## 斜交軸（FR-102）とプリフライト
 *
 * **2 視点だけ**なら、軸角 φ ≠ 90° は `(x, z) → (x, x cos φ − z sin φ)` という
 * **可逆な線形写像**が挟まるだけで、空判定にも島の数にも影響しない（可逆線形写像は
 * 空集合を空集合に、連結成分を連結成分に写す）。唯一 `THIN_NECK` だけが楽観側に
 * ずれる：せん断後の実際のくびれ幅は、ここで測る区間幅より `|sin φ|` 倍ぶん
 * 細くなりうるが、THIN_NECK はもともと `'estimated'` なので分類は変えない。
 *
 * **視点 C が加わると、この「無関係」は崩れる**（レビュー Finding 1）。B の被覆
 * 判定はせん断後の座標 `s = x cos φ + w sin φ` で行う必要があるが、C の押し出し
 * 軸角は B の軸角 φ に連動しない固定 +Y であり、C の被覆判定は常にせん断**前**の
 * `(x, w)` 平面で行う。B は s 軸、C は (x, w) 平面という**2 つの異なる基準**が
 * 同時に働くため、φ ≠ 90° はもう「x と z の可逆写像だけ」には還元できない。
 * φ を無視して常に `s = w`（90° 相当）で判定すると、実際には非空な組み合わせを
 * 空だと誤って断定しうる — 旧実装のバグそのものだった。上の「視点 C の厳密判定」
 * が `s = x cos φ + w sin φ` を明示的に使うことで、この効き方を厳密に織り込む。
 *
 * ## 計算量
 *
 * 2 視点は走査線 N 本の O(N)。視点 C の厳密判定（上記）は各高さ
 * `O(p·q·|S_C の頂点数|)` で、実務上 p・q は小さいためほぼ `O(N·|S_C|)`。
 * `THIN_NECK`（推定）の C 寄与は live な高さでのみ `S_C` を粗くサンプリングする
 * ため最悪 `O(N·M)`（M はサンプル数）だが、live でない高さでは走らない。
 * NFR-001 の 300ms 予算に対しては無視できる規模（`preflight.test.ts` の
 * パフォーマンス系テストを参照）。
 */

/** 走査線の本数（design.md の N = 256）。 */
export const SCANLINE_COUNT = 256

/**
 * THIN_NECK 閾値：共通 Y 範囲の高さに対する**真のくびれ幅**（後述
 * {@link narrowestGenuineNeck}）の比。既定 0.02 = 高さの 2%。実寸の既定
 * 60mm（FR-029）では約 1.2mm に相当し、FDM 印刷で折れやすくなる目安の
 * 壁厚に合わせている。とがった先端（先には何もぶら下がっていない箇所）
 * の幅はこの判定に一切数えない — レビュー Finding 2「とがった形状は
 * 必ず先端で幅 0 に近づくため、この判定なしでは常に発火してしまう」の
 * 修正。
 */
export const THIN_NECK_RATIO = 0.02

/** 視点 B の軸角の既定値（度）。90 = 直交。protocol.ts の同名定数と同じ値 */
const DEFAULT_AXIS_ANGLE_DEG = 90

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
  /**
   * 視点 B の押し出し軸角（度、XZ 平面内。FR-102）。省略 = 90（直交）。
   *
   * `c` が null のときはこの値を一切参照しない（2 視点は軸角に依存しない —
   * ファイル冒頭「斜交軸とプリフライト」を参照）ので、既存の 2 視点呼び出しは
   * この引数を渡さなくても 1 ビットも変わらない。
   */
  axisAngleDeg?: number
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

/**
 * 点 `(x, y)` が輪郭集合の内部（巻き数 > 0）にあるか。
 *
 * {@link coveredIntervalsAt} と**同じ辺の走査規約**（半開区間 `y1 ≤ y < y2`）
 * ・**同じ巻き数の符号**を使う。独立した実装にすると、2 つの関数が同じ点について
 * 違う答えを返しうる（`preflight.test.ts` にこの一致を固定する回帰テストがある）。
 *
 * 判定は「点から +X 方向のレイと輪郭の交点」の符号総和：
 * `coveredIntervalsAt` が「x 未満の交点の総和を 0 から引いていく」ことで
 * 「x より右の交点の総和」を得ているのと同じ量を、直接その定義で計算する。
 */
export function containsPoint(contours: Contour[], x: number, y: number): boolean {
  let winding = 0
  for (const contour of contours) {
    const p = contour.points
    const n = p.length >> 1
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const x1 = p[i * 2]
      const y1 = p[i * 2 + 1]
      const x2 = p[j * 2]
      const y2 = p[j * 2 + 1]
      // 初期値を置かない：if/else if のどちらかで必ず代入され、else は
      // continue する。`= 0` を置くと「使われない代入」になる（no-useless-assignment）
      let dir: number
      let xCross: number
      if (y1 <= y && y < y2) {
        xCross = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)
        dir = 1
      } else if (y2 <= y && y < y1) {
        xCross = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)
        dir = -1
      } else {
        continue
      }
      if (xCross > x) winding += dir
    }
  }
  return winding > 0
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

/**
 * 2 つの区間集合の交わりそのもの（部分区間の列として）を返す。
 * `intervalsOverlap` が真偽だけを返すのに対し、こちらは重なった範囲を持つ
 * （視点 C の厳密判定で、A の被覆と C の被覆の重なりを実際に使うために要る）。
 */
function intersectIntervals(
  left: ReadonlyArray<[number, number]>,
  right: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [l0, l1] of left) {
    for (const [r0, r1] of right) {
      const lo = Math.max(l0, r0)
      const hi = Math.min(l1, r1)
      if (hi - lo > EPS) out.push([lo, hi])
    }
  }
  return out
}

/** 区間集合の最小幅（空なら Infinity） */
function minIntervalWidth(intervals: ReadonlyArray<[number, number]>): number {
  let min = Infinity
  for (const [from, to] of intervals) {
    if (to - from < min) min = to - from
  }
  return min
}

/**
 * 走査順（Y 昇順）に並んだ live な高さごとの幅の列から、**真のくびれ**の
 * 最小幅を返す（レビュー Finding 2「とがった先端を全部 THIN_NECK として
 * 誤検出する」の修正）。
 *
 * ## ルール
 *
 * ある走査線 `i` を「真のくびれの候補」とみなすのは、**その走査線より
 * 手前側にも奥側にも、`widths[i]` 以上に幅がある走査線が少なくとも 1 本
 * ずつ存在する**ときだけ（走査範囲の両端から見て、途中で自分以上の幅に
 * 戻る箇所があるということ）。候補の中で最小の幅を返す。候補が 1 つも
 * なければ `Infinity`（くびれなし）。
 *
 * ## なぜこれで「先端」と「くびれ」を区別できるか
 *
 * スペードの上端・ハートの下端のような**先端**は、走査範囲の端に近づく
 * につれて幅が単調にゼロへ収束する — 定義上、先端側には「自分以上の幅」
 * を持つ走査線が 1 本も存在しない（そこから先には何もぶら下がっていない
 * ことの直接の言い換え）。したがってこのルールでは先端付近の走査線は
 * 一貫して候補から外れ、`THIN_NECK` は「とがった形状なら常に、無意味な
 * 0.0mm で」発火しなくなる。
 *
 * 一方、**両端まで太さの変わらない一様に細い形状**（例：`preflight.test.ts`
 * の「細すぎる首」フィクスチャ — 幅 0.1 の棒が範囲の端から端まで一定）は、
 * 内部のどの走査線から見ても「自分と同じ幅」の走査線が両側に存在する
 * （比較は `>=`、同値も「自分以上」に含める）ため、真のくびれとして
 * 正しく残る — 太さが一様であること自体は折れやすさを変えないので、
 * 除外する理由がない。**2 つの太い部分に挟まれた本物のくびれ**（バランス
 * ダンベル形。`preflight.test.ts` の「レビュー Finding」テストで構築）も、
 * 両側の太い部分がそのまま「自分以上の幅」の証人になるため同様に残る。
 *
 * `>=` の比較には浮動小数点誤差を吸収する {@link EPS} のスラックを持たせる
 * （実際の走査線間の幅の変化は EPS よりはるかに大きいため、真の先細りを
 * 誤って「一様」扱いすることはない）。
 */
function narrowestGenuineNeck(widths: readonly number[]): number {
  const n = widths.length
  if (n === 0) return Infinity

  const prefixMax = new Array<number>(n)
  let runningPrefix = -Infinity
  for (let i = 0; i < n; i++) {
    prefixMax[i] = runningPrefix
    if (widths[i] > runningPrefix) runningPrefix = widths[i]
  }

  const suffixMax = new Array<number>(n)
  let runningSuffix = -Infinity
  for (let i = n - 1; i >= 0; i--) {
    suffixMax[i] = runningSuffix
    if (widths[i] > runningSuffix) runningSuffix = widths[i]
  }

  let neck = Infinity
  for (let i = 0; i < n; i++) {
    const hasWiderBefore = prefixMax[i] >= widths[i] - EPS
    const hasWiderAfter = suffixMax[i] >= widths[i] - EPS
    if (hasWiderBefore && hasWiderAfter && widths[i] < neck) {
      neck = widths[i]
    }
  }
  return neck
}

const fmt = (v: number): string => v.toFixed(2)

// ---------------------------------------------------------------------------
// 凸多角形との交差判定（視点 C の厳密判定を支える基本図形演算）
// ---------------------------------------------------------------------------

/** 符号付き面積の 2 倍（外積）。`(b−a) × (c−a)` */
function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** `p` が `a`–`b` を結ぶ軸に沿った bbox の内側にあるか（共線判定の補助） */
function onSegmentBounds(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): boolean {
  return (
    px >= Math.min(ax, bx) - EPS &&
    px <= Math.max(ax, bx) + EPS &&
    py >= Math.min(ay, by) - EPS &&
    py <= Math.max(ay, by) + EPS
  )
}

/** 線分 `a1–a2` と `b1–b2` が交わるか（端点での接触・共線接触を含む）。 */
function segmentsIntersect(
  a1x: number,
  a1y: number,
  a2x: number,
  a2y: number,
  b1x: number,
  b1y: number,
  b2x: number,
  b2y: number,
): boolean {
  const d1 = cross2(b1x, b1y, b2x, b2y, a1x, a1y)
  const d2 = cross2(b1x, b1y, b2x, b2y, a2x, a2y)
  const d3 = cross2(a1x, a1y, a2x, a2y, b1x, b1y)
  const d4 = cross2(a1x, a1y, a2x, a2y, b2x, b2y)
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true
  }
  if (Math.abs(d1) <= EPS && onSegmentBounds(b1x, b1y, b2x, b2y, a1x, a1y)) return true
  if (Math.abs(d2) <= EPS && onSegmentBounds(b1x, b1y, b2x, b2y, a2x, a2y)) return true
  if (Math.abs(d3) <= EPS && onSegmentBounds(a1x, a1y, a2x, a2y, b1x, b1y)) return true
  if (Math.abs(d4) <= EPS && onSegmentBounds(a1x, a1y, a2x, a2y, b2x, b2y)) return true
  return false
}

/**
 * 点が凸多角形（頂点は周を一周する順。CW/CCW どちらでもよい）の内部・境界上にあるか。
 */
function pointInConvexPolygon(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const [ax, ay] = poly[i]
    const [bx, by] = poly[j]
    const c = cross2(ax, ay, bx, by, x, y)
    if (Math.abs(c) <= EPS) continue // 辺上は内側扱い
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * 輪郭集合（巻き数で穴を含む任意の領域）が凸多角形と交わるかを厳密に判定する。
 *
 * ファイル冒頭「視点 C の厳密判定」の 3 条件をそのまま実装したもの：
 * 凸多角形の頂点が領域の内部にある／領域の頂点が凸多角形の内部にある／
 * 辺同士が交差する、のいずれかが成り立てば交わる。凸多角形なので
 * この 3 条件で尽くされる（一方が他方を包含する場合も、包含される側の
 * 頂点が必ず内部に入るため 1 か 2 で捕まる）。
 */
function regionIntersectsQuad(
  contours: Contour[],
  quad: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [qx, qy] of quad) {
    if (containsPoint(contours, qx, qy)) return true
  }
  for (const contour of contours) {
    const p = contour.points
    const n = p.length >> 1
    for (let i = 0; i < n; i++) {
      if (pointInConvexPolygon(quad, p[i * 2], p[i * 2 + 1])) return true
    }
  }
  for (const contour of contours) {
    const p = contour.points
    const n = p.length >> 1
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ex1 = p[i * 2]
      const ey1 = p[i * 2 + 1]
      const ex2 = p[j * 2]
      const ey2 = p[j * 2 + 1]
      for (let k = 0; k < quad.length; k++) {
        const l = (k + 1) % quad.length
        if (
          segmentsIntersect(ex1, ey1, ex2, ey2, quad[k][0], quad[k][1], quad[l][0], quad[l][1])
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * `Q(a0,a1,b0,b1) = { (x, w) : a0 ≤ x ≤ a1,  b0 ≤ x cos φ + w sin φ ≤ b1 }`
 * を周に沿った頂点列として組み立てる（ファイル冒頭「視点 C の厳密判定」）。
 *
 * `sin` はここでは常に非ゼロ（呼び出し元 `runPreflight` が軸角の有限性を検証し、
 * 実運用では store 側が `[15°, 165°]` にクランプしているため `|sin φ| ≥ sin 15°`）。
 */
function shearQuad(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  cos: number,
  sin: number,
): Array<[number, number]> {
  const wAt = (x: number, s: number): number => (s - x * cos) / sin
  return [
    [a0, wAt(a0, b0)],
    [a1, wAt(a1, b0)],
    [a1, wAt(a1, b1)],
    [a0, wAt(a0, b1)],
  ]
}

/**
 * 高さ y のスライス `(A_y × B_y) ∩ S_C` が空でないかを厳密に判定する（FR-101 / FR-102）。
 *
 * `∃(x, w)( x ∈ A_y ∧ x cos φ + w sin φ ∈ B_y ∧ (x, w) ∈ S_C )` を、
 * `A_y` と `B_y` の区間の組ごとに作った凸四角形 `Q` と `S_C` の交差判定へ
 * 帰着させる（サンプリングなし。ファイル冒頭を参照）。
 */
function sliceSurvivesC(
  c: Contour[],
  intervalsA: ReadonlyArray<[number, number]>,
  intervalsB: ReadonlyArray<[number, number]>,
  cos: number,
  sin: number,
): boolean {
  for (const [a0, a1] of intervalsA) {
    for (const [b0, b1] of intervalsB) {
      const quad = shearQuad(a0, a1, b0, b1, cos, sin)
      if (regionIntersectsQuad(c, quad)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 視点 C の推定サンプリング（THIN_NECK のみが使う。存在判定には使わない）
// ---------------------------------------------------------------------------

/** 視点 C の推定用サンプリング結果（THIN_NECK 幅の見積りだけに使う） */
interface ViewpointCScan {
  /** C 自身の Y 範囲を等分した w（= world −z）のサンプル座標 */
  wSamples: number[]
  /** `wSamples[j]` における S_C の x 区間集合 */
  intervalsAtW: Array<Array<[number, number]>>
  /** どこかの w で被覆を持ったか（false なら C はそもそも材料を持たない） */
  anyCoverage: boolean
}

/**
 * 視点 C を、C 自身の Y 範囲全体にわたって w 方向（= world −z）に等分サンプリングする。
 *
 * 空判定（`sliceSurvivesC`）はこのサンプリングを一切使わない（厳密な幾何判定に
 * 置き換え済み）。ここで作るのは `THIN_NECK`（もともと `'estimated'`）の
 * C 側の幅見積りに使う下地だけ。旧実装はここを B の bbox 幅で絞り込んでいたが、
 * せん断があると「C の w 範囲」と「B が許す s 範囲」は同じ量ではないため
 * （ファイル冒頭「斜交軸とプリフライト」）、絞り込みは行わず C 自身の Y 範囲を
 * そのまま使う。
 *
 * @returns C に頂点が 1 つもなければ null
 */
function sampleViewpointC(c: Contour[], sampleCount: number): ViewpointCScan | null {
  const rangeC = yRangeOf(c)
  if (rangeC === null) return null

  const [lo, hi] = rangeC
  if (hi - lo <= EPS) {
    // 高さゼロの退化した輪郭。被覆はどこにもない
    return { wSamples: [], intervalsAtW: [], anyCoverage: false }
  }

  const step = (hi - lo) / sampleCount
  const wSamples: number[] = []
  const intervalsAtW: Array<Array<[number, number]>> = []
  let anyCoverage = false
  for (let j = 0; j < sampleCount; j++) {
    const w = lo + (j + 0.5) * step
    const intervals = coveredIntervalsAt(c, w)
    wSamples.push(w)
    intervalsAtW.push(intervals)
    if (intervals.length > 0) anyCoverage = true
  }
  return { wSamples, intervalsAtW, anyCoverage }
}

/**
 * live な高さ y における、視点 C 由来の最小幅（THIN_NECK の推定に使う）。
 *
 * レビュー Finding 3 の修正：C の寄与は**この高さで実際にスライスを生かしている
 * w のところだけ**を見る。A・B はもともとそう（`minIntervalWidth(intervalsA)` /
 * `minIntervalWidth(intervalsB)` は live な走査線でしか呼ばれない）ので、
 * C だけ「live かどうかに関係なく全 w の最小」を混ぜていたのが不整合だった
 * （三角形の頂点近くなど、どの高さからも到達しない w が最小値を持って行ってしまう）。
 *
 * 測る量は A・B とそろえて **C 自身の生の区間幅**（`minIntervalWidth(cAtW)`）にする
 * — A と重ねた重なり幅にはしない。重なり幅にすると「A・B と同じ規則」から外れた
 * 別の量になるうえ、`live` な w の集合は旧実装が見ていた全 w の集合の**部分集合**
 * でしかありえないので、この関数の返り値は理論上つねに旧実装の
 * `scanC.minWidth`（全 w の最小）以上になる（狭い候補集合の最小は広い候補集合の
 * 最小を下回れない）。旧実装が「届かない w のせいで誤って過度に警告していた」
 * ケースは、この不等式のとおり修正後は警告が緩む方向にしか動かない。
 *
 * ここでのサンプリングは推定にすぎない（`scan` の分解能を取りこぼしうる）が、
 * `THIN_NECK` はもともと `'estimated'` なので分類は変わらない。空判定
 * （`EMPTY_BAND` / `EMPTY_INTERSECTION`）はこの関数を経由しない。
 */
function liveWidthFromC(
  scan: ViewpointCScan,
  intervalsA: ReadonlyArray<[number, number]>,
  intervalsB: ReadonlyArray<[number, number]>,
  cos: number,
  sin: number,
): number {
  let min = Infinity
  for (let j = 0; j < scan.wSamples.length; j++) {
    const cAtW = scan.intervalsAtW[j]
    if (cAtW.length === 0) continue
    const w = scan.wSamples[j]
    const overlapX = intersectIntervals(cAtW, intervalsA)
    let reachable = false
    for (const [x0, x1] of overlapX) {
      const s0 = x0 * cos + w * sin
      const s1 = x1 * cos + w * sin
      const sLo = Math.min(s0, s1)
      const sHi = Math.max(s0, s1)
      if (intervalsOverlap([[sLo, sHi]], intervalsB)) {
        reachable = true
        break
      }
    }
    if (reachable) {
      const width = minIntervalWidth(cAtW)
      if (width < min) min = width
    }
  }
  return min
}

/** 視点名の日本語表記（警告文用） */
function sideLabel(side: ViewpointId): string {
  return `シルエット ${side}`
}

/**
 * 正規化済みシルエットの適合性を走査線サンプリングで解析する（FR-012 / FR-101 / FR-102）。
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
 * | 真のくびれ幅（{@link narrowestGenuineNeck}）が閾値未満 | `THIN_NECK` | estimated |
 *
 * bbox の重なりは被覆の重なりの必要条件にすぎない（例：外輪郭と同一の穴を持つ
 * シルエットは bbox が正常でも被覆が常に空）。そのため走査後にも判定し、
 * live な走査線が 1 本もなければ `EMPTY_INTERSECTION` を報告する。
 *
 * ### 視点 C の効き方（ファイル冒頭「三重直積にならない」「視点 C の厳密判定」を参照）
 *
 * C は高さごとの被覆を持たない。高さ y が live であるのは
 * `∃(x,w)( x ∈ A_y ∧ x cos φ + w sin φ ∈ B_y ∧ (x,w) ∈ S_C )` のときで、
 * これは走査線サンプリングなしに厳密に判定できる。満たさない高さを
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
 * 報告した範囲が誤っていることとは別種の制約である（A・B は元からこの限界を
 * 持っており、C はここで厳密判定に変えたことでこの限界を持たなくなった —
 * C が原因の空帯は、走査線が当たった高さでは常に正しい）。
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
 * @throws `scanlineCount` が正の整数でない、`thinNeckRatio` が負・非有限、
 *   または `axisAngleDeg` が非有限・正弦がほぼ 0（軸がほぼ平行）の場合
 */
export function runPreflight(
  a: Contour[],
  b: Contour[],
  options: PreflightOptions = {},
): ViewpointPreflightReport {
  const scanlineCount = options.scanlineCount ?? SCANLINE_COUNT
  const thinNeckRatio = options.thinNeckRatio ?? THIN_NECK_RATIO
  const c = options.c ?? null
  const axisAngleDeg = options.axisAngleDeg ?? DEFAULT_AXIS_ANGLE_DEG

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
  if (!Number.isFinite(axisAngleDeg)) {
    throw new Error(`axisAngleDeg は有限数でなければなりません（指定値: ${axisAngleDeg}）`)
  }

  // 既定の 90° は厳密値で計算する（cos=0, sin=1）。Math.cos(π/2) は 6.1e-17 であって
  // 0 ではなく、通すと丸めが混じって「c === null と axisAngleDeg 省略が厳密に同一」
  // という前提が壊れる（この値は c !== null のときしか使わないので実害はないが、
  // protocol.ts computeDepths と同じ流儀に揃えておく）
  const orthogonal = axisAngleDeg === DEFAULT_AXIS_ANGLE_DEG
  const phi = (axisAngleDeg * Math.PI) / 180
  const shearCos = orthogonal ? 0 : Math.cos(phi)
  const shearSin = orthogonal ? 1 : Math.sin(phi)
  if (c !== null && Math.abs(shearSin) < 1e-6) {
    throw new Error(
      `axisAngleDeg ${axisAngleDeg} では sin がほぼ 0 になり、視点 C の判定が発散します`,
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

  // 視点 C の推定サンプリング（THIN_NECK 用）は高さのループの外で 1 回だけ行う
  // （C は y に依存しない）。空判定そのものは sliceSurvivesC が厳密に行うため、
  // ここで作る scanC を経由しない
  let scanC: ViewpointCScan | null = null
  if (c !== null) {
    scanC = sampleViewpointC(c, scanlineCount)
    if (scanC === null || !scanC.anyCoverage) {
      return emptyIntersection(
        `${sideLabel('C')} が材料を持たないため、この組み合わせの交差は空です。生成される立体はありません。`,
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
  // live な走査線ごとの幅（Y 昇順）。THIN_NECK は走査後に
  // {@link narrowestGenuineNeck} でこの列から「真のくびれ」だけを拾う
  // （レビュー Finding 2。とがった先端を「幅 0 のくびれ」と誤検出しないため、
  // ここでは生の最小値をその場では確定しない）
  const liveWidths: number[] = []
  let firstLiveK = -1
  let lastLiveK = -1

  for (let k = 0; k < scanlineCount; k++) {
    const y = lo + (k + 0.5) * step
    const intervalsA = coveredIntervalsAt(a, y)
    const intervalsB = coveredIntervalsAt(b, y)
    const emptyA = intervalsA.length === 0
    const emptyB = intervalsB.length === 0
    // C の空判定は A / B が両方とも被覆を持つ高さでのみ意味を持つ。
    // A が空の高さで「C も空」と数えると、A の責任を C に付け替えてしまう。
    // 判定は sliceSurvivesC（サンプリングなしの厳密判定）に委ねる
    const emptyC =
      scanC !== null &&
      !emptyA &&
      !emptyB &&
      !sliceSurvivesC(c!, intervalsA, intervalsB, shearCos, shearSin)
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
      let widthAtY = Math.min(minIntervalWidth(intervalsA), minIntervalWidth(intervalsB))
      // 視点 C の幅寄与は、この live な高さで実際にスライスを生かしている
      // w のところだけを見る（レビュー Finding 3。ファイル冒頭 liveWidthFromC を参照）
      if (scanC !== null) {
        const widthC = liveWidthFromC(scanC, intervalsA, intervalsB, shearCos, shearSin)
        if (widthC < widthAtY) widthAtY = widthC
      }
      liveWidths.push(widthAtY)
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

  const minWidth = narrowestGenuineNeck(liveWidths)
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
