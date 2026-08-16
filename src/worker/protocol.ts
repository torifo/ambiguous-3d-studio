/**
 * Worker 境界のプロトコル型（design.md「4. Worker 境界」）。
 *
 * 型に加えて、**リクエストの意味を決める純粋な幾何規約**（押し出し軸の向き・
 * カメラ規約・押し出し深さの算出式）をここに置く。深さは「メインスレッドが
 * 算出し、Worker が防御的に検証する」二重実装であり、式が 2 か所に分かれると
 * 必ず食い違う。依存ゼロのこのファイルに 1 本だけ置くことで、Worker
 * （Wasm 一式を引き込む）を import せずにメインスレッドから同じ式を使える。
 *
 * ## なぜ `generation` があるのか
 *
 * Wasm のブール演算は**途中キャンセルできない**。リクエストを発行した時点で、
 * その演算は最後まで走る。ユーザーの打鍵ごとにリクエストを積むと処理が詰まり、
 * さらに古い入力に対する結果が新しい入力の結果を上書きしうる。
 *
 * そこで発行元（client.ts）が単調増加する世代 ID を各リクエストに付与し、
 * レスポンス受信時に `generation === latestGeneration` のときだけ採用する。
 * つまり stale なレスポンスは**発生源で中断するのではなく、受信側で破棄する**。
 * これが Wasm 演算を安全に「キャンセル」できる唯一の方法である。
 */

/**
 * postMessage 越しに渡す輪郭表現。
 *
 * `Float64Array` + boolean のみで構成され structured clone 可能
 * （`points` は transferable でもある）。内部型 `Contour`（geometry/types.ts）と
 * 構造的に互換だが、Worker 境界を越える形をここで明示的に固定する：
 * クラスインスタンスや関数を含む型は postMessage で壊れるため、
 * 境界を越えてよい形はこの型が定義するものだけとする。
 */
export interface SerializedContour {
  /** [x0, y0, x1, y1, ...] のフラット配列。Y 上向き、正規化済み作業座標系 */
  points: Float64Array
  /** true = 穴（内輪郭）。外輪郭は CCW、穴は CW に正規化済み */
  isHole: boolean
}

/** 角柱 1 本分の入力。輪郭（断面）と押し出し深さ */
export interface CsgPrism {
  contours: SerializedContour[]
  depth: number
}

/** メインスレッド → Worker。1 回の CSG 生成のリクエスト */
export type CsgRequest = {
  /** 単調増加。古い世代のレスポンスは破棄する（ファイル冒頭の解説を参照） */
  generation: number
  /** シルエット A（XY 平面、+Z へ押し出し） */
  a: CsgPrism
  /** シルエット B（XY 平面 → 押し出し後に Y 軸まわり `axisAngleDeg` 回転） */
  b: CsgPrism
  /**
   * シルエット C（FR-101）。XY 平面 → 押し出し後に X 軸まわり **−90°** 回転で
   * 押し出し軸を world +Y へ向ける（{@link VIEWPOINT_AXES} の導出を参照）。
   *
   * **省略 / null = 2 視点**。このフィールドに触れない限り、演算経路も結果も
   * 従来と 1 ビットも変わらない（`M = M_A ∩ M_B`）。
   */
  c?: CsgPrism | null
  /**
   * 視点 B の押し出し軸角（度、XZ 平面内。FR-102）。
   * **省略 = {@link DEFAULT_AXIS_ANGLE_DEG}（90 = 直交）**で従来どおり。
   */
  axisAngleDeg?: number
  /** 台座（FR-015）。null = 無効。height は作業座標系の厚み */
  baseplate: { enabled: boolean; height: number } | null
}

/**
 * Worker → メインスレッド。成功時の typed array は Wasm 管理メモリからの
 * **新規コピー**であり、transferable として転送される（ADR-003）。
 */
export type CsgResponse =
  | {
      generation: number
      ok: true
      /** 頂点座標 [x, y, z, ...]。transferable */
      positions: Float32Array
      /** 三角形インデックス。transferable */
      indices: Uint32Array
      /** decompose() で確定した連結成分数。2 以上なら印刷時に分離する */
      componentCount: number
      volume: number
      elapsedMs: number
    }
  | { generation: number; ok: false; error: CsgError }

/**
 * CSG 生成が失敗しうる分類。
 *
 * `WORKER_CRASHED` は Worker 内で起きるのではなく、Worker が死んだことを
 * メインスレッド側が検出して発行する。それでもこの union に含めるのは、
 * **ストアの `generationFailed` が受け取れる型が 1 つでなければならない**ため。
 * クライアント専用の別 union を作ると、Wave 4 がクラッシュを無関係なエラーに
 * 読み替えるか、キャストで型を潰すしかなくなる。
 */
export type CsgError =
  | { code: 'WASM_INIT_FAILED'; detail: string }
  | { code: 'NOT_MANIFOLD'; detail: string }
  | { code: 'EMPTY_RESULT' }
  | { code: 'INVALID_INPUT'; detail: string }
  | { code: 'WORKER_CRASHED'; detail: string }

/**
 * Worker → メインスレッド。生成結果とは別系統の、初期化ライフサイクル通知。
 *
 * これがないと、クライアントは「準備完了」を推測するしかない。実際に
 * ウォームアップ生成の**成否を問わず** ready と見なす実装になっていたため、
 * エンジン側の異常で `INVALID_INPUT` が返っても正常起動として扱われていた。
 * Worker が `setup()` 直後に明示的に通知することで、準備完了の判定が
 * 推測ではなく事実になる。
 */
export type WorkerLifecycleMessage =
  | { type: 'ready' }
  | { type: 'init-failed'; detail: string }

/** Worker から届きうるメッセージの全体 */
export type WorkerOutbound = CsgResponse | WorkerLifecycleMessage

/** ライフサイクル通知か生成レスポンスかを判別する */
export function isLifecycleMessage(message: WorkerOutbound): message is WorkerLifecycleMessage {
  return 'type' in message
}

// ---------------------------------------------------------------------------
// 幾何規約（design.md「2. 押し出し深さ」「2.1 軸の割り当てとカメラ規約」の一般化）
// ---------------------------------------------------------------------------

/** 押し出し深さのマージン（design.md「2. 押し出し深さ」の MARGIN） */
export const DEPTH_MARGIN = 0.02

/** 視点 B の押し出し軸角の既定値（度）。90 = 直交で、design.md の規約そのもの */
export const DEFAULT_AXIS_ANGLE_DEG = 90

/**
 * 軸角の許容範囲（度）。0° / 180° では A と B の押し出し軸が平行になり
 * 交差が角柱のまま退化する（深さの式も 1/sin で発散する）。
 * 15° で 1/sin ≈ 3.86 — 深さが相手幅の 4 倍弱に収まる実用上限として採る。
 */
export const MIN_AXIS_ANGLE_DEG = 15
export const MAX_AXIS_ANGLE_DEG = 165

/** 3 次元ベクトル（world 座標）。Wasm を跨がない純粋な数値組 */
export type Vec3 = readonly [number, number, number]

/**
 * 各視点の軸割り当て（design.md「2.1」の表を C と斜交まで広げたもの）。
 *
 * `CrossSection.extrude` は常に断面ローカルの **+Z** へ押し出す。回転は
 * 押し出し**後**に掛ける。manifold の `rotate` は右手系・X→Y→Z の順で、
 * Y 軸まわり θ は `(x, y, z) → (x cosθ + z sinθ, y, −x sinθ + z cosθ)`、
 * X 軸まわり θ は `(x, y, z) → (x, y cosθ − z sinθ, y sinθ + z cosθ)`。
 *
 * | | 回転 | ローカル +X → | ローカル +Y → | 押し出し軸 +Z → |
 * |---|---|---|---|---|
 * | A | なし | +X | +Y | **+Z** |
 * | B | `[0, φ, 0]` | `(cos φ, 0, −sin φ)` | +Y | **`(sin φ, 0, cos φ)`** |
 * | C | `[-90, 0, 0]` | +X | **−Z** | **+Y** |
 *
 * **C の回転の導出**：X 軸まわり −90° は
 * `(x, y, z) → (x, y cos(−90°) − z sin(−90°), y sin(−90°) + z cos(−90°)) = (x, z, −y)`。
 * よってローカル +Z（押し出し軸）→ world **+Y** ✓、ローカル +X → world +X、
 * ローカル +Y → world **−Z**。`[+90, 0, 0]` にすると押し出しが −Y を向き、
 * +Y カメラから見た C のシルエットが**上下反転**する（B の左右反転と同じ事故で、
 * 上下対称な図形では原理的に検出できない）。
 *
 * **C は Y 軸を共有しない**：C の断面ローカル Y は world −Z に載る。つまり
 * C のシルエットは XZ 平面の図形であり、高さ y の関数ではない。プリフライトの
 * スライス式が A / B と同じ形にならないのはこのため（preflight.ts を参照）。
 */
export const VIEWPOINT_AXES = {
  /** A は回転しない */
  A: { rotationDeg: [0, 0, 0] as Vec3 },
  /** B は Y 軸まわり axisAngleDeg（既定 90°） */
  B: { rotationDeg: [0, DEFAULT_AXIS_ANGLE_DEG, 0] as Vec3 },
  /** C は X 軸まわり −90°（上の導出を参照） */
  C: { rotationDeg: [-90, 0, 0] as Vec3 },
} as const

/** 正射影で「そのシルエットが正しい向きに見える」カメラ基底 */
export interface ViewpointCamera {
  /** 原点から見たカメラ位置の単位方向。カメラはこの位置から原点を見る */
  direction: Vec3
  /** up ベクトル */
  up: Vec3
}

/**
 * 視点ごとのカメラ規約（design.md「2.1」の一般化）。
 *
 * カメラ基底は `right = up × backward`（backward = 原点 → カメラ）。
 * 画面右が断面ローカル +X と一致する組み合わせだけが鏡像にならない：
 *
 * - **A**: backward `(0,0,1)`, up `(0,1,0)` → right `(1,0,0)` = ローカル +X ✓
 * - **B**: backward `(sin φ, 0, cos φ)`, up `(0,1,0)` →
 *   right `= (0,1,0) × (sin φ, 0, cos φ) = (cos φ, 0, −sin φ)` = ローカル +X ✓。
 *   φ=90° で従来の +X 側カメラに一致する。**斜交でもカメラは押し出し軸そのものの
 *   向きに置く**（原点から `(sin φ, 0, cos φ)` の側）。up は +Y のまま
 * - **C**: backward `(0,1,0)`（真上から見下ろす）, up **`(0,0,-1)`** →
 *   right `= (0,0,-1) × (0,1,0) = (1,0,0)` = ローカル +X ✓。
 *   up を `(0,0,1)` にすると画面右が −X になり、C だけ左右反転する
 *
 * シーン（視点スナップ・仮想ミラー・AR の初期姿勢）はこの表に従うこと。
 */
export function viewpointCamera(
  side: 'A' | 'B' | 'C',
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
): ViewpointCamera {
  switch (side) {
    case 'A':
      return { direction: [0, 0, 1], up: [0, 1, 0] }
    case 'B': {
      const phi = (axisAngleDeg * Math.PI) / 180
      // 既定の 90° は厳密値を使う（丸めで従来の [1, 0, 0] から動かさない）
      const orthogonal = axisAngleDeg === DEFAULT_AXIS_ANGLE_DEG
      const sin = orthogonal ? 1 : Math.sin(phi)
      const cos = orthogonal ? 0 : Math.cos(phi)
      return { direction: [sin, 0, cos], up: [0, 1, 0] }
    }
    case 'C':
      return { direction: [0, 1, 0], up: [0, 0, -1] }
  }
}

/** シルエット 1 枚の断面ローカル寸法（正規化後の作業座標系） */
export interface SilhouetteExtent {
  /** 断面ローカル X 方向の幅（bbox の幅） */
  width: number
  /** 断面ローカル Y 方向の高さ（bbox の高さ） */
  height: number
}

/** {@link computeDepths} の入力 */
export interface DepthRuleInput {
  a: SilhouetteExtent
  b: SilhouetteExtent
  /** 省略 / null = 視点 C なし（2 視点） */
  c?: SilhouetteExtent | null
  /** 省略 = {@link DEFAULT_AXIS_ANGLE_DEG} */
  axisAngleDeg?: number
}

/** 角柱ごとの押し出し深さ。`c` は視点 C がないとき null */
export interface PrismDepths {
  a: number
  b: number
  c: number | null
}

/**
 * 押し出し深さの算出（FR-011 / FR-101 / FR-102）。**メインスレッドの算出と
 * Worker の防御的検証はこの 1 関数だけを根拠にする。**
 *
 * ## 一般化した規則
 *
 * 各角柱は、**自分の押し出し軸に沿って測った**他の角柱の広がりを覆わなければ
 * ならない。深さが足りないと Manifold は `'NoError'` の正常な 2-多様体を返す
 * ため、切り落とされた立体が成功として通ってしまう。
 *
 * 無限に長い角柱の交差を `M∞` とし、各角柱の押し出し軸 `u` に対して
 * `depth ≥ 2·max{|p·u| : p ∈ M∞}` を満たせば truncation は起きない。
 *
 * ### 斜交での導出（直交の式は成り立たない）
 *
 * 軸角 φ のとき A の軸は `u_A = (0,0,1)`、B の軸は `u_B = (sin φ, 0, cos φ)`、
 * B の断面ローカル X は `r_B = (cos φ, 0, −sin φ)`。点 `p ∈ M∞` は
 * `a = p_x ∈ [−wA/2, wA/2]`（A の断面）と `s = p·r_B ∈ [−wB/2, wB/2]`（B の断面）
 * を満たす。この 2 式を p_z / p·u_B について解くと
 *
 * ```
 * p_z      = (a cos φ − s) / sin φ
 * p·u_B    = (a − s cos φ) / sin φ
 * ```
 *
 * ゆえに
 *
 * ```
 * depth_A ≥ (wB + wA·|cos φ|) / |sin φ|
 * depth_B ≥ (wA + wB·|cos φ|) / |sin φ|
 * ```
 *
 * φ = 90° では `|cos φ| = 0, |sin φ| = 1` となり **`depth_A = wB`, `depth_B = wA`** —
 * design.md の直交式にちょうど戻る。直交式をそのまま斜交に流用すると、
 * せん断分（`wA·|cos φ|` の項と `1/|sin φ|` の伸び）が丸ごと抜けて切り落とされる。
 *
 * ### 視点 C（直交・+Y 軸）の寄与
 *
 * C の断面ローカル X は world +X（幅 `wC`）、ローカル Y は world −Z（高さ `hC`）、
 * 押し出し軸は world +Y。したがって C は他の軸に次の広がりしか許さない：
 *
 * ```
 * world Z 方向: hC                          → depth_A への寄与
 * u_B 方向:     wC·|sin φ| + hC·|cos φ|     → depth_B への寄与
 * world Y 方向: —（C は Y を拘束しない）
 * depth_C:      A と B が許す world Y の広がり = max(hA, hB)
 * ```
 *
 * ### なぜ max で、min ではないのか
 *
 * 実際に必要な深さは「各相手が許す広がりの **min**」（どれか 1 つでも狭ければ
 * そこで止まる）だが、本関数は **max** を返す。深さは大きすぎても結果を変えない
 * 一方、min を採ると「どの相手が効いているか」がシルエットの組み合わせごとに
 * 入れ替わり、算出側と検証側が別の相手を選んだ瞬間に破綻する。max は常に十分で、
 * 算出と検証が同じ値に一致する。
 *
 * @throws `axisAngleDeg` が範囲外・非有限のとき、または寸法が非有限・非正のとき
 */
export function computeDepths(input: DepthRuleInput): PrismDepths {
  const axisAngleDeg = input.axisAngleDeg ?? DEFAULT_AXIS_ANGLE_DEG
  const angleError = axisAngleError(axisAngleDeg)
  if (angleError !== null) throw new Error(angleError)

  const extents: Array<[string, SilhouetteExtent]> = [
    ['a', input.a],
    ['b', input.b],
  ]
  if (input.c != null) extents.push(['c', input.c])
  for (const [name, extent] of extents) {
    if (!Number.isFinite(extent.width) || extent.width <= 0) {
      throw new Error(`computeDepths: ${name}.width は正の有限値が必要です（${extent.width}）`)
    }
    if (!Number.isFinite(extent.height) || extent.height <= 0) {
      throw new Error(`computeDepths: ${name}.height は正の有限値が必要です（${extent.height}）`)
    }
  }

  // 既定の 90° は厳密値で計算する。Math.cos(π/2) は 6.1e-17 であって 0 ではなく、
  // 通すと 2 視点・直交の深さが従来値から 1 ULP 動く（byte-for-byte 互換を壊す）
  const orthogonal = axisAngleDeg === DEFAULT_AXIS_ANGLE_DEG
  const phi = (axisAngleDeg * Math.PI) / 180
  const cosAbs = orthogonal ? 0 : Math.abs(Math.cos(phi))
  const sinAbs = orthogonal ? 1 : Math.abs(Math.sin(phi))

  let spanA = (input.b.width + input.a.width * cosAbs) / sinAbs
  let spanB = (input.a.width + input.b.width * cosAbs) / sinAbs
  let spanC: number | null = null

  if (input.c != null) {
    spanA = Math.max(spanA, input.c.height)
    spanB = Math.max(spanB, input.c.width * sinAbs + input.c.height * cosAbs)
    spanC = Math.max(input.a.height, input.b.height)
  }

  return {
    a: spanA * (1 + DEPTH_MARGIN),
    b: spanB * (1 + DEPTH_MARGIN),
    c: spanC === null ? null : spanC * (1 + DEPTH_MARGIN),
  }
}

/**
 * 軸角の検証（FR-102）。問題なければ null、あれば人間が読めるメッセージを返す。
 * 例外にしないのは、Worker が `INVALID_INPUT.detail` にそのまま載せるため。
 */
export function axisAngleError(axisAngleDeg: number): string | null {
  if (!Number.isFinite(axisAngleDeg)) {
    return `axisAngleDeg must be a finite number (got ${axisAngleDeg})`
  }
  if (axisAngleDeg < MIN_AXIS_ANGLE_DEG || axisAngleDeg > MAX_AXIS_ANGLE_DEG) {
    return (
      `axisAngleDeg ${axisAngleDeg} is outside the supported range ` +
      `[${MIN_AXIS_ANGLE_DEG}, ${MAX_AXIS_ANGLE_DEG}] — the extrusion axes of A and B ` +
      'become near-parallel and the intersection degenerates'
    )
  }
  return null
}
