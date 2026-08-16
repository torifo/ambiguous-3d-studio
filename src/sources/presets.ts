import type { Contour, PresetId } from '../geometry/types'

/**
 * プリセット図形の生成オプション（FR-001 / Task 2.2）。
 */
export interface PresetOptions {
  /**
   * 円の分割数（= 頂点数）。3 以上の整数。
   * 既定値は {@link DEFAULT_CIRCLE_SEGMENTS}。印刷スケールで円として見える分割数にしてある。
   */
  circleSegments?: number
}

/** `circleSegments` 省略時の既定分割数 */
export const DEFAULT_CIRCLE_SEGMENTS = 64

/**
 * 座標規約（types.ts の `Contour` に従う）:
 * - Y 上向き。単位ボックス近傍（±1 程度）の作業座標。絶対サイズは normalize.ts（Wave 2）が
 *   後段で再スケールするため意味を持たない。縦横比だけが本質
 * - 全プリセットは穴なしの単一外輪郭（`isHole: false`）
 * - 巻き方向は CCW（符号付き面積が正）
 * - 閉パスは**暗黙閉路**: 終点に始点を繰り返さない。`toPolygons.ts` / Manifold の
 *   `Polygons` 規約（Task 2.4）と同じ
 */
function outer(points: readonly number[]): Contour {
  return { points: new Float64Array(points), isHole: false }
}

/** 単位円。増加方向の角度で走査するので Y 上向き座標系では CCW になる */
function circle(segments: number): Contour {
  if (!Number.isInteger(segments) || segments < 3) {
    throw new RangeError(`circleSegments は 3 以上の整数が必要です: ${segments}`)
  }
  const pts: number[] = []
  for (let k = 0; k < segments; k++) {
    const t = (2 * Math.PI * k) / segments
    pts.push(Math.cos(t), Math.sin(t))
  }
  return outer(pts)
}

/** 正方形（一辺 2、中心原点）。CCW */
function square(): Contour {
  return outer([-1, -1, 1, -1, 1, 1, -1, 1])
}

/** 正三角形（外接円半径 1、頂点が真上）。角度増加方向 = CCW */
function triangle(): Contour {
  const pts: number[] = []
  for (let k = 0; k < 3; k++) {
    const t = Math.PI / 2 + (2 * Math.PI * k) / 3
    pts.push(Math.cos(t), Math.sin(t))
  }
  return outer(pts)
}

/**
 * ハート。有名なパラメトリックハート曲線
 *   x(t) = 16 sin^3 t,  y(t) = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t
 * を 1/16 に縮めて 128 点サンプリングする。上に丸い両ローブ・中央のくぼみ・下の尖りが
 * 制御点の手置きよりきれいに出る。
 * この曲線は t 増加方向だと CW（上中央 → 右ローブ → 下先端）なので、
 * **t を負方向に走査して CCW** にする（曲線は x について左右対称なので形は変わらない）。
 */
function heart(): Contour {
  const n = 128
  const pts: number[] = []
  for (let k = 0; k < n; k++) {
    const t = (-2 * Math.PI * k) / n
    const s = Math.sin(t)
    const x = s * s * s // = 16 sin^3 t / 16
    const y =
      (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16
    pts.push(x, y)
  }
  return outer(pts)
}

/**
 * 五芒星（★）。外側頂点は外接円半径 1、内側頂点は五芒星 {5/2} の対角線交点半径
 * cos 72° / cos 36° ≈ 0.382。この比だと辺が一直線につながる「本物の星形」になる
 * （0.5 などにすると腰の折れた星になる）。頂点が真上、角度増加方向 = CCW。
 */
function star(): Contour {
  const innerR = Math.cos((2 * Math.PI) / 5) / Math.cos(Math.PI / 5)
  const pts: number[] = []
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? 1 : innerR
    const t = Math.PI / 2 + (Math.PI * k) / 5
    pts.push(r * Math.cos(t), r * Math.sin(t))
  }
  return outer(pts)
}

/**
 * 矢印（**右向き** = 左右非対称）。軸（矩形シャフト）+ 三角形の鏃。
 *
 * 非対称性は装飾ではなく仕様: 鏡像回帰テスト（Task 5.4 / 8.2、design.md「軸の割り当てと
 * カメラ規約」）の入力になる。左右対称な図形では B 視点の鏡像バグが原理的に検出できない。
 * 下辺を左→右に走査（内部が上）するので CCW。上下には対称でよい。
 */
function arrow(): Contour {
  const tailX = -1
  const neckX = 0.25
  const tipX = 1
  const shaftHalf = 0.22
  const headHalf = 0.55
  return outer([
    tailX, -shaftHalf,
    neckX, -shaftHalf,
    neckX, -headHalf,
    tipX, 0,
    neckX, headHalf,
    neckX, shaftHalf,
    tailX, shaftHalf,
  ])
}

/** 十字（ギリシャ十字）。腕の半幅 1/3・半長 1。右腕の下から CCW に一周する 12 頂点 */
function cross(): Contour {
  const w = 1 / 3
  return outer([
    1, -w,
    1, w,
    w, w,
    w, 1,
    -w, 1,
    -w, w,
    -1, w,
    -1, -w,
    -w, -w,
    -w, -1,
    w, -1,
    w, -w,
  ])
}

/**
 * id → 輪郭ビルダーの対応表。`Record<PresetId, ...>` にしてあるので、
 * `PresetId` にメンバーを追加してここへデータを足し忘れると**コンパイルエラー**になる。
 * 実行時（型検査をすり抜けた場合）は {@link presetToContours} が例外を投げる。
 */
const BUILDERS: Record<PresetId, (options: Required<PresetOptions>) => Contour[]> = {
  circle: (options) => [circle(options.circleSegments)],
  square: () => [square()],
  triangle: () => [triangle()],
  heart: () => [heart()],
  star: () => [star()],
  arrow: () => [arrow()],
  cross: () => [cross()],
}

/** 実データを持つ全プリセット id（UI の一覧やテストの網羅チェック用） */
export const PRESET_IDS = Object.keys(BUILDERS) as readonly PresetId[]

/**
 * プリセット図形の閉輪郭を返す（FR-001）。
 *
 * 全プリセットは穴なしの単一外輪郭・CCW（符号付き面積が正）・暗黙閉路。
 * 座標は単位ボックス近傍の作業座標で、スケーリングは normalize.ts の責務。
 *
 * @param id プリセット図形の識別子
 * @param options 円の分割数など（円以外には影響しない）
 * @throws {RangeError} `circleSegments` が 3 未満または非整数のとき
 * @throws {Error} データを持たない未知の id が実行時に渡されたとき
 */
export function presetToContours(id: PresetId, options: PresetOptions = {}): Contour[] {
  const builder: ((options: Required<PresetOptions>) => Contour[]) | undefined = BUILDERS[id]
  if (builder === undefined) {
    throw new Error(`未知のプリセット id: ${JSON.stringify(id)}`)
  }
  return builder({ circleSegments: options.circleSegments ?? DEFAULT_CIRCLE_SEGMENTS })
}
