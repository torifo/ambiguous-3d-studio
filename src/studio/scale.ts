/**
 * 実寸 mm ⇄ 作業座標系の換算（FR-029）。**アプリで唯一の単位換算点。**
 *
 * 作業座標系は無次元。実寸はただ 1 つの物理量
 * 「**共通シルエット高さ（正規化された Y 範囲）のミリメートル値**」で定義する。
 * 既定 60mm、範囲 10〜300mm、刻み 1mm。台座の厚みはこの高さに含めない。
 *
 * ## 1000 倍事故（このファイルが存在する理由）
 *
 * STL はミリメートル、glTF / USDZ は**メートル**が慣例。STL 用の倍率を
 * そのまま GLB / USDZ に流すと座標が 1000 倍になり、AR で机に置いたはずの
 * 立体が**建物サイズ**で出現する。この 0.001 は忘れやすいので、
 * 換算をこのファイルに閉じ込め、出力先ごとに**別名のエクスポート**にして
 * 取り違えを型と名前の両方で防ぐ：
 *
 * - STL → {@link stlMmPerUnit}（作業座標 → mm）
 * - GLB / USDZ → {@link glbUsdzMetersPerUnit}（作業座標 → m。mm 換算 × 0.001）
 *
 * 「共通の倍率を取ってきて自分で 0.001 を掛ける」コードを書いてはならない。
 */

/** 実寸高さの既定値（mm）。FR-029 */
export const DEFAULT_HEIGHT_MM = 60
/** 実寸高さの下限（mm）。FR-029 */
export const MIN_HEIGHT_MM = 10
/** 実寸高さの上限（mm）。FR-029 */
export const MAX_HEIGHT_MM = 300
/** 実寸高さの刻み（mm）。FR-029 */
export const HEIGHT_STEP_MM = 1

/** mm → m の係数。GLB / USDZ 出力にのみ現れる */
export const METERS_PER_MM = 0.001

/**
 * UI 入力値を FR-029 の範囲（10〜300mm、刻み 1mm）へ丸める。
 * 非有限値（NaN / Infinity）は既定値 60mm に落とす。
 * store の setHeightMm はこれを通してから状態を書く。
 */
export function clampHeightMm(mm: number): number {
  if (!Number.isFinite(mm)) return DEFAULT_HEIGHT_MM
  const stepped = Math.round(mm / HEIGHT_STEP_MM) * HEIGHT_STEP_MM
  return Math.min(MAX_HEIGHT_MM, Math.max(MIN_HEIGHT_MM, stepped))
}

/** 換算の前提が壊れている呼び出しを弾く（単位換算点なので黙って直さない） */
function assertScaleInputs(heightMm: number, workingHeight: number): void {
  if (!Number.isFinite(workingHeight) || workingHeight <= 0) {
    throw new RangeError(
      `workingHeight must be a finite positive number, got ${workingHeight}`,
    )
  }
  if (
    !Number.isFinite(heightMm) ||
    heightMm < MIN_HEIGHT_MM ||
    heightMm > MAX_HEIGHT_MM
  ) {
    throw new RangeError(
      `heightMm must be within [${MIN_HEIGHT_MM}, ${MAX_HEIGHT_MM}], got ${heightMm}`,
    )
  }
}

/**
 * **STL 出力専用**の倍率：作業座標 1 単位 → ミリメートル。
 *
 * ```
 * mmPerUnit = heightMm / workingHeight
 * ```
 *
 * @param heightMm 実寸の共通シルエット高さ（mm、10〜300）
 * @param workingHeight 正規化時の共通高さ H（無次元、normalize.ts が決める）
 */
export function stlMmPerUnit(heightMm: number, workingHeight: number): number {
  assertScaleInputs(heightMm, workingHeight)
  return heightMm / workingHeight
}

/**
 * **GLB / USDZ 出力専用**の倍率：作業座標 1 単位 → メートル。
 *
 * `stlMmPerUnit` のちょうど 1/1000。glTF / USDZ はメートルが慣例なので、
 * STL 用の mm 倍率を流用すると AR で 1000 倍サイズになる（FR-029 Rationale）。
 */
export function glbUsdzMetersPerUnit(
  heightMm: number,
  workingHeight: number,
): number {
  return stlMmPerUnit(heightMm, workingHeight) * METERS_PER_MM
}

/**
 * 3D バウンディングボックス。`THREE.Box3` と構造的に互換
 * （min / max が x, y, z を持てばよい）。three への依存は持たない。
 */
export interface Bounds3 {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/** UI 表示用の実寸（FR-029「指定値から導かれる X / Y / Z の実寸を表示」） */
export interface RealWorldSizeMm {
  x: number
  y: number
  z: number
}

/**
 * 作業座標系の bbox から実寸 X / Y / Z（mm）を導く。UI 表示用。
 * bbox が正規化済み（Y 範囲 = workingHeight）なら y は heightMm に一致する。
 */
export function realWorldSizeMm(
  bounds: Bounds3,
  heightMm: number,
  workingHeight: number,
): RealWorldSizeMm {
  const mmPerUnit = stlMmPerUnit(heightMm, workingHeight)
  return {
    x: (bounds.max.x - bounds.min.x) * mmPerUnit,
    y: (bounds.max.y - bounds.min.y) * mmPerUnit,
    z: (bounds.max.z - bounds.min.z) * mmPerUnit,
  }
}
