import type { Contour } from './types'

/**
 * 輪郭の正規化（Task 2.1 / design.md「Geometry Pipeline → 1. 正規化」）。
 *
 * - 縦横比を保った共通高さ H へのフィット（X/Y の独立スケーリングは禁止）
 * - bbox 中心の原点センタリング
 * - 符号付き面積（シューレース）による巻き方向判定：外輪郭 CCW / 穴 CW
 * - SVG（Y 下向き）向けの Y 反転ユーティリティ
 *
 * すべて純関数。DOM / Wasm には依存しない。
 */

/** bbox。`Silhouette.sourceBounds` と同形 */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 巻き方向判定の縮退しきい値（スケール相対・無次元）。
 *
 * 符号付き面積は座標絶対値の **2 乗**でスケールするため、絶対値での
 * しきい値（旧 `1e-12`）は「入力がどの単位系か」への暗黙の仮定になる：
 * 一辺 1e-7 の正方形（面積 1e-14）は完全に有効な形なのに拒否されていた。
 * FR-010 はスケール非依存（任意の入力を共通高さへフィット）なので、
 * 判定も無次元の比で行う。
 *
 * 判定は輪郭を自身の bbox 中心へ平行移動し、長辺 `ext = max(w, h)` で
 * 割った「単位 bbox 座標」上で行う（`windingMeasure` 参照）。この座標系では
 * - シューレース和の丸め誤差は約 n × ε（ε ≈ 2.2e-16）× O(1)。
 *   頂点数 n が 10^4 級の密なパスでも誤差は ~1e-11 に収まる。
 * - 意味のある塗り領域は（極端に細長い矩形でも）bbox 面積比でオーダー 1。
 *   これを大きく下回るのは「ほぼ完全に一直線」な点列だけで、その巻きは
 *   数値ノイズと区別できず、通すと CrossSection の fill を静かに壊す。
 *
 * よって丸め誤差の上限より 1 桁強の余裕を取った 1e-10 を採用する。
 * 緩めすぎると巻きが数値的に無意味なスリバーを通してしまうため、
 * これ以上は下げないこと。
 */
const REL_AREA_EPS = 1e-10

/**
 * 入力検証。縮退した輪郭は NaN を生む前にここで弾く。
 * - 輪郭ゼロ個
 * - 3 頂点未満（points.length < 6）
 * - フラット配列が奇数長（[x, y] ペアが壊れている）
 * - 非有限値（NaN / ±Infinity）
 */
function assertValidContours(contours: Contour[]): void {
  if (contours.length === 0) {
    throw new Error('normalize: 輪郭が 0 個です。少なくとも 1 つの閉パスが必要です')
  }
  for (let c = 0; c < contours.length; c++) {
    const pts = contours[c].points
    if (pts.length % 2 !== 0) {
      throw new Error(
        `normalize: contour[${c}] の points が奇数長（${pts.length}）です。[x0, y0, x1, y1, ...] のフラット配列が必要です`,
      )
    }
    if (pts.length < 6) {
      throw new Error(
        `normalize: contour[${c}] の頂点数が ${pts.length / 2} 個です。閉パスには 3 頂点以上が必要です`,
      )
    }
    for (let i = 0; i < pts.length; i++) {
      if (!Number.isFinite(pts[i])) {
        throw new Error(
          `normalize: contour[${c}].points[${i}] が有限値ではありません（${pts[i]}）`,
        )
      }
    }
  }
}

/**
 * 単一輪郭の符号付き面積（シューレース公式、生の座標のまま）。
 * Y 上向き座標系で CCW なら正、CW なら負。
 * 巻き方向の**判定**には、桁落ちに強い内部の `windingMeasure` を使う
 * （原点から遠い・極端なスケールの輪郭では生のシューレース和は桁落ちする）。
 */
export function signedArea(points: Float64Array): number {
  const n = points.length / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1]
  }
  return sum / 2
}

/** `Contour[]` 全体の bbox */
export function boundsOf(contours: Contour[]): Bounds {
  assertValidContours(contours)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const contour of contours) {
    const pts = contour.points
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]
      const y = pts[i + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

/** フラット配列の頂点順を逆にする（[p0, p1, ..., pn-1] → [pn-1, ..., p1, p0]） */
function reversePoints(points: Float64Array): Float64Array {
  const n = points.length / 2
  const out = new Float64Array(points.length)
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i
    out[2 * i] = points[2 * j]
    out[2 * i + 1] = points[2 * j + 1]
  }
  return out
}

/**
 * 巻き方向判定のための頑健な符号付き面積の測定。
 *
 * 生のシューレース和は座標絶対値の 2 乗オーダーの項の相殺で成り立つため、
 * 原点から遠い・極端に小さい／大きい輪郭では桁落ちして符号すら信用できない。
 * ここでは輪郭を自身の bbox 中心へ平行移動し、長辺 `ext = max(w, h)` で
 * 一様に割った「単位 bbox 座標」で面積を計算する。平行移動と正の一様スケールは
 * 符号付き面積の符号を変えないので、巻き方向判定にはこの値を使ってよい。
 * すべての量が O(1) になるため、アンダーフロー／オーバーフローも起きない。
 *
 * @returns unitArea — 単位 bbox 座標での符号付き面積（巻き判定用）
 * @returns relArea — 単位 bbox 面積に対する |面積| の比（縮退判定用・無次元）。
 *                    bbox の幅か高さがゼロ（一点・軸平行の一直線）なら 0
 */
function windingMeasure(points: Float64Array): { unitArea: number; relArea: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]
    const y = points[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const w = maxX - minX
  const h = maxY - minY
  // 幅か高さがゼロ → 面積は厳密にゼロ（一点、または軸平行の一直線）
  if (!(w > 0) || !(h > 0)) return { unitArea: 0, relArea: 0 }
  const ext = Math.max(w, h)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const n = points.length / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const xi = (points[2 * i] - cx) / ext
    const yi = (points[2 * i + 1] - cy) / ext
    const xj = (points[2 * j] - cx) / ext
    const yj = (points[2 * j + 1] - cy) / ext
    sum += xi * yj - xj * yi
  }
  const unitArea = sum / 2
  const relArea = Math.abs(unitArea) / ((w / ext) * (h / ext))
  return { unitArea, relArea }
}

/**
 * 巻き方向の正規化：外輪郭 CCW（符号付き面積が正）/ 穴 CW（負）。
 * どちらが穴かは `Contour.isHole` が真実の情報源で、実際の巻きが
 * `isHole` と食い違う輪郭だけ頂点順を反転する。
 *
 * 縮退判定は**スケール相対**：面積の絶対値ではなく、輪郭自身の bbox
 * 面積に対する比（`REL_AREA_EPS`）で行う。これにより一辺 1e-7 でも 1e7 でも
 * 有効な形は同じように通り（FR-010 のスケール非依存性）、厳密なゼロ面積・
 * 完全な一直線・bbox に対して面積が極小で巻きを浮動小数点で判定できない
 * スリバーは従来どおり拒否する。
 */
export function normalizeWinding(contours: Contour[]): Contour[] {
  assertValidContours(contours)
  return contours.map((contour, c) => {
    const { unitArea, relArea } = windingMeasure(contour.points)
    // `!(relArea > ...)` の形にして NaN も確実に拒否側へ倒す
    if (!(relArea > REL_AREA_EPS)) {
      throw new Error(
        `normalize: contour[${c}] の符号付き面積が bbox に対してほぼゼロ` +
          `（相対面積 ${relArea} ≤ しきい値 ${REL_AREA_EPS}）で、巻き方向を判定できません`,
      )
    }
    // 外輪郭は正（CCW）、穴は負（CW）であるべき
    const wantPositive = !contour.isHole
    const isPositive = unitArea > 0
    if (wantPositive === isPositive) return contour
    return { points: reversePoints(contour.points), isHole: contour.isHole }
  })
}

/**
 * Y 反転（SVG の Y 下向き座標系 → アプリ内部の Y 上向き）。
 *
 * **Y 反転はすべての符号付き面積の符号を裏返す**ため、巻き方向の判定は
 * 反転の**後**でなければならない（design.md「1. 正規化」）。順序ミスを
 * 型やドキュメントではなく実装で不可能にするため、この関数は反転直後に
 * `normalizeWinding` を内部で必ず実行してから返す。
 * 呼び出し側が再判定を忘れる余地はない。
 */
export function flipY(contours: Contour[]): Contour[] {
  assertValidContours(contours)
  const flipped = contours.map((contour) => {
    const pts = contour.points
    const out = new Float64Array(pts.length)
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = pts[i]
      out[i + 1] = -pts[i + 1]
    }
    return { points: out, isHole: contour.isHole }
  })
  // 反転で全輪郭の巻きが逆転しているので、ここで必ず再正規化する
  return normalizeWinding(flipped)
}

/**
 * 共通高さへのフィット：bbox 高さが `targetHeight` になるよう
 * **一様に**スケール（縦横比を保持。X/Y の独立スケーリングは禁止 —
 * design.md「1. 正規化」）し、bbox 中心を原点へ移す。
 *
 * 一様な正スケール＋平行移動は巻き方向を変えないため、
 * 入力の巻きはそのまま保たれる。
 */
export function fitToHeight(contours: Contour[], targetHeight: number): Contour[] {
  if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
    throw new Error(`normalize: targetHeight は正の有限値が必要です（${targetHeight}）`)
  }
  const bounds = boundsOf(contours)
  const height = bounds.maxY - bounds.minY
  // 高さの縮退判定もスケール絶対のしきい値を置かない（FR-010）：
  // 厳密にゼロの高さだけを拒否し、正の高さは大小を問わず受け付ける。
  if (!(height > 0)) {
    throw new Error(
      `normalize: bbox の高さがゼロ（${height}）です。高さのない輪郭はフィットできません`,
    )
  }
  const scale = targetHeight / height
  // 高さが非正規化数級に小さいと除算がオーバーフローし NaN 座標を生むため、
  // ここで明確に拒否する（「NaN を作らない」不変条件の維持）
  if (!Number.isFinite(scale)) {
    throw new Error(
      `normalize: スケール係数が非有限（${scale}）です。bbox の高さ（${height}）が` +
        ` targetHeight（${targetHeight}）に対して極端すぎるためフィットできません`,
    )
  }
  // スケール後の bbox 中心を原点へ
  const cx = ((bounds.minX + bounds.maxX) / 2) * scale
  const cy = ((bounds.minY + bounds.maxY) / 2) * scale
  return contours.map((contour) => {
    const pts = contour.points
    const out = new Float64Array(pts.length)
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = pts[i] * scale - cx
      out[i + 1] = pts[i + 1] * scale - cy
    }
    return { points: out, isHole: contour.isHole }
  })
}

/**
 * 正規化パイプラインの合成（入力ソース共通の入口）：
 * 検証 → 元 bbox の記録 → 巻き方向の正規化 → 共通高さ H へのフィット＋センタリング。
 *
 * SVG 由来の輪郭は **先に `flipY` を通してから** この関数に渡すこと
 * （flipY は反転後の巻き再判定を内包しているので順序事故は起きない）。
 *
 * @returns 正規化済み輪郭と、正規化前の元 bbox（`Silhouette.sourceBounds` 用）
 */
export function normalizeSilhouette(
  contours: Contour[],
  targetHeight: number,
): { contours: Contour[]; sourceBounds: Bounds } {
  const sourceBounds = boundsOf(contours)
  const wound = normalizeWinding(contours)
  const fitted = fitToHeight(wound, targetHeight)
  return { contours: fitted, sourceBounds }
}
