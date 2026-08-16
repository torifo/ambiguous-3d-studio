import type { Contour } from './types'

/**
 * `Contour[]` → manifold-3d の `Polygons`（`Vec2[][]`）アダプタ。
 * **Manifold へ渡す唯一の入口**（ADR-005 / Task 2.4）。
 *
 * manifold-3d はフラットな `Float64Array` も `isHole` フラグも受け付けない。
 * 穴は API 上のフラグではなく、fill rule のもとでの**巻き方向**として表現される。
 * 巻き方向（外輪郭 CCW / 穴 CW）はこの関数に入る**前**に `normalize.ts` が保証する。
 * ここでは巻き直しは行わず、形式変換と不変条件の検証だけを行う：
 *
 * - 輪郭リストが空でないこと
 * - 各輪郭の点バッファが偶数長であること（[x0, y0, x1, y1, ...]）
 * - 各輪郭が 3 頂点以上（数値 6 個以上）であること
 * - 全座標が有限値であること（NaN / Infinity を含まない）
 *
 * これらは Manifold 側では Wasm バインディング境界の不透明なエラーになるため、
 * この境界で具体的なメッセージ付きで弾く。
 *
 * @throws Error 上記の不変条件のいずれかに違反した場合。メッセージに違反内容と輪郭番号を含む
 */
export function toPolygons(contours: Contour[]): [number, number][][] {
  if (contours.length === 0) {
    throw new Error('toPolygons: contour list is empty — nothing to convert')
  }

  return contours.map((contour, ci) => {
    const pts = contour.points

    if (pts.length % 2 !== 0) {
      throw new Error(
        `toPolygons: contour[${ci}] has an odd-length point buffer ` +
          `(${pts.length} numbers) — expected flat [x0, y0, x1, y1, ...] pairs`,
      )
    }
    if (pts.length < 6) {
      throw new Error(
        `toPolygons: contour[${ci}] has only ${pts.length / 2} vertices — ` +
          'a polygon needs at least 3',
      )
    }

    const poly: [number, number][] = []
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]
      const y = pts[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(
          `toPolygons: contour[${ci}] vertex ${i / 2} has a non-finite ` +
            `coordinate (x=${x}, y=${y})`,
        )
      }
      poly.push([x, y])
    }
    return poly
  })
}
