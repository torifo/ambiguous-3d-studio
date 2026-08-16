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
 * 有名なパラメトリックハート曲線
 *   x(t) = 16 sin^3 t,  y(t) = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t
 * を 1/16 に縮めたもの。ハートとスペードが共有する（スペードは上下反転したハートに
 * 茎を足した形 — 下記 {@link spade} 参照）。
 *
 * 特徴的な点の値は厳密に書ける:
 * - t = 0 で (0, 5/16) — 上中央のくぼみの底（尖点）
 * - t = π で (0, −17/16) — 下の尖り（尖点）
 * - t = ±π/2 で x = ±1 — 最大幅
 */
function heartPoint(t: number): [number, number] {
  const s = Math.sin(t)
  return [
    s * s * s, // = 16 sin^3 t / 16
    (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16,
  ]
}

/**
 * ハート。{@link heartPoint} を 128 点サンプリングする。上に丸い両ローブ・中央のくぼみ・
 * 下の尖りが、制御点の手置きよりきれいに出る。
 * この曲線は t 増加方向だと CW（上中央 → 右ローブ → 下先端）なので、
 * **t を負方向に走査して CCW** にする（曲線は x について左右対称なので形は変わらない）。
 */
function heart(): Contour {
  const n = 128
  const pts: number[] = []
  for (let k = 0; k < n; k++) {
    const [x, y] = heartPoint((-2 * Math.PI * k) / n)
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

/* ------------------------------------------------------------------------- *
 * トランプの 4 マーク（FR-100「トランプマークの変身立体」）
 *
 * ♥ は上（FR-001）で定義済み。♠♦♣ をここに足して 4 マークを揃える。
 * 4 つは並べて見られる（カタログでも UI でも）ので、単体で正しいだけでなく
 * **互いに区別が付くこと**が要件になる。縦横比を意図的に散らしてある:
 *   ♠ 幅/高さ ≈ 0.84 / ♥ ≈ 1.11 / ♦ ≈ 0.66 / ♣ ≈ 0.88
 * ------------------------------------------------------------------------- */

/**
 * 3 次ベジエの**内部点だけ**を out へ足す（両端は呼び出し側が置く）。
 * 閉パスは暗黙閉路で隣接頂点の重複が禁止なので、端点の二重登録を構造的に防ぐ。
 */
function cubicInteriorInto(
  out: number[],
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  steps: number,
): void {
  for (let k = 1; k < steps; k++) {
    const t = k / steps
    const u = 1 - t
    const w0 = u * u * u
    const w1 = 3 * u * u * t
    const w2 = 3 * u * t * t
    const w3 = t * t * t
    out.push(
      w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
      w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
    )
  }
}

/** 茎の辺 1 本あたりの分割数。R ≈ 0.5 の作業座標では 12 で折れが見えなくなる */
const STEM_SEGMENTS = 12

/**
 * ♠ / ♣ の茎（脚）。本体の輪郭が**左の付け根で終わっている**状態で呼び、
 * 左辺を下る → 底辺を左→右 → 右辺を上る、の順に足す。右の付け根は本体の輪郭の
 * 始点なので置かない（暗黙閉路）。底辺を左→右に走査するので内部が上 = CCW。
 *
 * 付け根でいったん内側へすぼめ、底で外へ開く「ラッパ形」にするため各辺は 3 次ベジエ。
 * 直線の台形にすると、下ローブの丸みに対して脚だけが硬く見える。
 * 左右対称なので、左辺は右辺の制御点を x 反転して逆順に辿るだけでよい。
 *
 * @param attach 右の付け根（本体の輪郭の始点と同じ位置）
 * @param neck   右辺の制御点 1（付け根側。x をわずかに内へ = くびれ）
 * @param flare  右辺の制御点 2（底側。x を外へ = 開き）
 * @param base   底辺の右端
 */
function stemInto(
  out: number[],
  attach: readonly [number, number],
  neck: readonly [number, number],
  flare: readonly [number, number],
  base: readonly [number, number],
): void {
  const mirror = (p: readonly [number, number]): [number, number] => [-p[0], p[1]]
  cubicInteriorInto(out, mirror(attach), mirror(neck), mirror(flare), mirror(base), STEM_SEGMENTS)
  out.push(-base[0], base[1], base[0], base[1])
  cubicInteriorInto(out, base, flare, neck, attach, STEM_SEGMENTS)
}

/** スペード本体の X 倍率 = 最大半幅。全高 2 に対して幅 1.68 の縦長（トランプのピップの比） */
const SPADE_HALF_WIDTH = 0.84
/** スペード本体の Y 倍率。反転ハートの尖端〜ローブ下端 1.797 が 1.60 になる */
const SPADE_Y_SCALE = 0.89
/** 尖端（反転後 17/16）を y = 1 に合わせる平行移動 */
const SPADE_Y_SHIFT = 1 - SPADE_Y_SCALE * (17 / 16)
/**
 * 本体を切り出す媒介変数の下限。sin^3(π/6) = 1/8 なので、付け根は x = ±0.84/8 = ±0.105
 * にちょうど来る。くぼみの底（t = 0 付近）はここで捨てて、茎に置き換える
 */
const SPADE_CUT_T = Math.PI / 6
/** 本体の分割数。**偶数**にすること — t = π（尖端）をサンプル点に含めるため */
const SPADE_BODY_SEGMENTS = 120

/**
 * スペード（♠）。**上下反転したハートに茎を足した形**。これは語呂合わせではなく
 * ♠ の実際の構成で、上の尖り・下の 2 つの丸いローブ・その間のくぼみが
 * ハートの尖り・両ローブ・くぼみとちょうど裏返しの対応になっている。
 * なので本体は {@link heartPoint} をそのまま使い、Y を反転して縦に潰す。
 *
 * ハートのくぼみ（t ≈ 0）は下向きの尖点として残ってしまうので、`t ∈ [π/6, 11π/6]` だけを
 * 使って捨て、切り口（±0.105, ≈ −0.461）から茎を生やす。茎はローブの下端（y ≈ −0.60）
 * より内側（|x| ≲ 0.13）を通るので、輪郭は自己交差しない。
 *
 * Y 反転により巻き方向も反転するため、**t を正方向に走査して CCW** になる
 * （ハート本体は負方向。{@link heart} のコメント参照）。
 */
function spade(): Contour {
  const pts: number[] = []
  const span = 2 * Math.PI - 2 * SPADE_CUT_T
  for (let k = 0; k <= SPADE_BODY_SEGMENTS; k++) {
    const t = SPADE_CUT_T + (span * k) / SPADE_BODY_SEGMENTS
    const [hx, hy] = heartPoint(t)
    pts.push(SPADE_HALF_WIDTH * hx, SPADE_Y_SHIFT - SPADE_Y_SCALE * hy)
  }
  const [cutX, cutY] = heartPoint(SPADE_CUT_T)
  stemInto(
    pts,
    [SPADE_HALF_WIDTH * cutX, SPADE_Y_SHIFT - SPADE_Y_SCALE * cutY],
    [0.085, -0.72],
    [0.27, -0.93],
    [0.36, -1],
  )
  return outer(pts)
}

/**
 * ダイヤ（♦）。**正方形を 45° 回したものではない**。トランプの♦は縦長の菱形で、
 * 幅:高さ ≈ 2:3。1:1 にすると♦ではなく「ひし形のタイル」に見え、他の 3 マークと
 * 並べたときだけ違和感が出る（単体では気付きにくい）ので、比率を明示的に持つ。
 * 辺は直線 — 印刷されたカードの♦も直線。下 → 右 → 上 → 左で CCW。
 */
function diamond(): Contour {
  const halfWidth = 0.66
  return outer([0, -1, halfWidth, 0, 0, 1, -halfWidth, 0])
}

/** クラブの 3 ローブの半径 */
const CLUB_R = 0.49
/**
 * ローブ中心間の距離 / 半径。3 中心は正三角形に置く。
 * 1.6 は「円どうしが重なって 1 つの塊になる」かつ「ローブ間の切れ込みが残る」帯の中央:
 * 2.0 を超えると円が離れて 3 つの島になり、1.3 を下回ると切れ込みが浅くなって団子になる。
 */
const CLUB_SPREAD = 1.6
/**
 * 底のカスプ手前で弧を止める角度。茎の付け根に幅（≈ 0.15）を与えるためで、
 * 0 にするとカスプ 1 点から茎が生えて輪郭がその点で自己接触してしまう。
 */
const CLUB_STEM_TRIM = (13 * Math.PI) / 180
/** 弧 1 本あたりの分割数。1 ステップ ≈ 4.7°、サジッタ ≈ 4e-4 で円として滑らか */
const CLUB_ARC_SEGMENTS = 48

/** 円弧を out へ足す。`includeStart: false` で始点を落とす（前の弧の終点と一致する場合） */
function arcInto(
  out: number[],
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  segments: number,
  includeStart: boolean,
): void {
  for (let k = includeStart ? 0 : 1; k <= segments; k++) {
    const a = a0 + ((a1 - a0) * k) / segments
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
}

/**
 * クラブ（♣）。**同じ半径の 3 円（上・左下・右下）の合併に茎を足した形**。
 * 「棒の上の 3 つの円」に見えることが要件なので、円を近似した閉曲線ではなく
 * 本物の円弧を 3 本つないで合併の輪郭をそのまま出す。
 *
 * 3 中心を一辺 1.6 R の正三角形に置くと、隣り合う円の交点は中心から見て
 * 3-4-5 の直角三角形（半弦 0.8 R・垂線 0.6 R）の位置に来る。したがって交点の角度は
 * すべて φ = asin(0.6) = 36.87° で書け、各円が合併の輪郭へ出す弧は
 * ちょうど 300° − 2φ ≈ 226.3° になる。3 本の弧の継ぎ目が、ローブ間の切れ込み（凹の角）。
 *
 * 右下 → 上 → 左下 の順に、各弧を角度が増える向きに辿ると合併の輪郭を CCW に一周する。
 * 最後に底のカスプを茎で置き換える。
 */
function club(): Contour {
  const r = CLUB_R
  const side = CLUB_SPREAD * r
  const dx = side / 2
  const cyTop = 1 - r // 上ローブの頂点が y = 1
  const cyBottom = cyTop - (side * Math.sqrt(3)) / 2
  const phi = Math.asin(0.6)
  const third = (2 * Math.PI) / 3
  const pts: number[] = []
  // 右下ローブ: 底のカスプ（π + φ）の少し先から、上ローブとの交点（2π + 2π/3 − φ）まで
  const startAngle = Math.PI + phi + CLUB_STEM_TRIM
  arcInto(pts, dx, cyBottom, r, startAngle, 2 * Math.PI + third - phi, CLUB_ARC_SEGMENTS, true)
  // 上ローブ: 右下との交点（φ − π/3）から左下との交点（2π/3 + π/3 − φ）まで
  arcInto(pts, 0, cyTop, r, phi - third / 2, 2 * third - phi, CLUB_ARC_SEGMENTS, false)
  // 左下ローブ: 上との交点（π/3 + φ）から、底のカスプ（2π − φ）の手前まで
  arcInto(
    pts,
    -dx,
    cyBottom,
    r,
    third / 2 + phi,
    2 * Math.PI - phi - CLUB_STEM_TRIM,
    CLUB_ARC_SEGMENTS,
    false,
  )
  stemInto(
    pts,
    [dx + r * Math.cos(startAngle), cyBottom + r * Math.sin(startAngle)],
    [0.062, -0.75],
    [0.23, -0.94],
    [0.3, -1],
  )
  return outer(pts)
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
  spade: () => [spade()],
  diamond: () => [diamond()],
  club: () => [club()],
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
