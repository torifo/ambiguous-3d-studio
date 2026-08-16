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

/** 面積・高さの縮退判定に使う許容誤差 */
const EPS = 1e-12

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
 * 単一輪郭の符号付き面積（シューレース公式）。
 * Y 上向き座標系で CCW なら正、CW なら負。巻き方向判定の基礎。
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
 * 巻き方向の正規化：外輪郭 CCW（符号付き面積が正）/ 穴 CW（負）。
 * どちらが穴かは `Contour.isHole` が真実の情報源で、実際の巻きが
 * `isHole` と食い違う輪郭だけ頂点順を反転する。
 *
 * 面積がほぼゼロの輪郭は巻き方向を判定できないため縮退として弾く。
 */
export function normalizeWinding(contours: Contour[]): Contour[] {
  assertValidContours(contours)
  return contours.map((contour, c) => {
    const area = signedArea(contour.points)
    if (Math.abs(area) < EPS) {
      throw new Error(
        `normalize: contour[${c}] の符号付き面積がほぼゼロ（${area}）で、巻き方向を判定できません`,
      )
    }
    // 外輪郭は正（CCW）、穴は負（CW）であるべき
    const wantPositive = !contour.isHole
    const isPositive = area > 0
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
  if (!(height > EPS)) {
    throw new Error(
      `normalize: bbox の高さがゼロ（${height}）です。高さのない輪郭はフィットできません`,
    )
  }
  const scale = targetHeight / height
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
