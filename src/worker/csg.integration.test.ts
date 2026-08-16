import { beforeAll, describe, expect, it } from 'vitest'
import createManifold from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import { boundsOf } from '../geometry/normalize'
import { coveredIntervalsAt } from '../geometry/preflight'
import { presetToContours } from '../sources/presets'
import {
  computeDepths,
  type CsgRequest,
  type SerializedContour,
  type SilhouetteExtent,
} from './protocol'
import {
  BASEPLATE_CONTACT_RATIO,
  BASEPLATE_FOOTPRINT_SCALE,
  DEPTH_MARGIN,
  getLiveWasmObjectCount,
  performCsg,
} from './csg.worker'

/**
 * CSG Worker の統合テスト（Task 3.1）。実物の manifold-3d Wasm を Node 上で
 * 初期化し、`performCsg`（Worker の onmessage シェルから切り出した純粋ロジック）
 * を直接呼ぶ。Worker / ブラウザは不要。
 *
 * 文字（フォント由来グリフ）を使う統合テストは Task 6.1 完了後（text.ts が
 * まだスタブのため）。ここでは手書きの輪郭とプリセット（矢印）のみを使う。
 */

/** Node では locateFile 不要 — Emscripten が manifold.js の隣の .wasm を見つける */
let wasm: ManifoldToplevel

/**
 * manifold-3d が使う WebAssembly.Memory。ヒープ高水位のリーク検出
 * （後述の plateau テスト）のために beforeAll で捕捉する。
 * 自前カウンタ（getLiveWasmObjectCount）は track/release の記録に対する
 * 検算でしかなく、**ライブラリ内部**のリーク（例：extrude の center: true が
 * 内部チェーンする translate の中間 Manifold）はカウンタに現れない。
 * 実メモリを見る判定はこの Memory の容量でのみ可能。
 */
let wasmMemory: WebAssembly.Memory | null = null

beforeAll(async () => {
  // Emscripten は Node 経路で WebAssembly.instantiate(binary, imports) を呼び、
  // Memory をインポートではなく**エクスポート**する（manifold.js の
  // assignWasmExports 参照）。モジュール生成の間だけ instantiate をラップして
  // exports から Memory を捕捉する。ラップは finally で必ず復元する
  const originalInstantiate = WebAssembly.instantiate
  const capturing = async (
    source: BufferSource | WebAssembly.Module,
    importObject?: WebAssembly.Imports,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> => {
    const result = await originalInstantiate(source as BufferSource, importObject)
    const instance = result instanceof WebAssembly.Instance ? result : result.instance
    for (const exported of Object.values(instance.exports)) {
      if (exported instanceof WebAssembly.Memory) {
        wasmMemory = exported
      }
    }
    return result
  }
  WebAssembly.instantiate = capturing as typeof WebAssembly.instantiate
  try {
    wasm = await createManifold()
    wasm.setup()
  } finally {
    WebAssembly.instantiate = originalInstantiate
  }
}, 30_000)

// ---------------------------------------------------------------------------
// 輪郭ヘルパー（すべて正規化済み前提の形：外輪郭 CCW / 穴 CW、原点中心）
// ---------------------------------------------------------------------------

/** 一辺 size の正方形（CCW）。中心 (cx, cy) */
function squareContour(size: number, cx = 0, cy = 0): SerializedContour {
  const h = size / 2
  return {
    points: new Float64Array([
      cx - h, cy - h,
      cx + h, cy - h,
      cx + h, cy + h,
      cx - h, cy + h,
    ]),
    isHole: false,
  }
}

/** 半径 radius の正多角形近似円。ccw=false で CW（穴用） */
function circleContour(radius: number, segments: number, ccw: boolean, isHole: boolean): SerializedContour {
  const pts = new Float64Array(segments * 2)
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments
    pts[2 * i] = radius * Math.cos(t)
    pts[2 * i + 1] = (ccw ? 1 : -1) * radius * Math.sin(t)
  }
  return { points: pts, isHole }
}

const CIRCLE_SEGMENTS = 64

/**
 * design.md「2. 押し出し深さ」の式でリクエストを組む：
 *
 *   depth_A = B.bbox.width × (1 + MARGIN)
 *   depth_B = A.bbox.width × (1 + MARGIN)
 *
 * 使う bbox 次元の根拠：A は XY 断面のまま +Z へ押し出されるので、A の角柱が
 * 覆うべきは「回転後の B が world Z 方向に占める範囲」。B は XY で作られ
 * Y 軸まわり +90° 回転（(x, y, z) → (z, y, −x)）されるため、B の局所 X
 * （= bbox.width）が world Z に写る。よって depth_A は **B の幅**。
 * 対称に、B の押し出し（回転後 world X）が覆うべきは A の world X 範囲
 * = **A の幅**なので depth_B は A の幅。高さ（Y）はどちらの押し出し軸にも
 * 写らないため式に現れない。
 */
function makeRequest(
  aContours: SerializedContour[],
  bContours: SerializedContour[],
  generation = 1,
): CsgRequest {
  const boundsA = boundsOf(aContours)
  const boundsB = boundsOf(bContours)
  const widthA = boundsA.maxX - boundsA.minX
  const widthB = boundsB.maxX - boundsB.minX
  return {
    generation,
    a: { contours: aContours, depth: widthB * (1 + DEPTH_MARGIN) },
    b: { contours: bContours, depth: widthA * (1 + DEPTH_MARGIN) },
    baseplate: null,
  }
}

/** 正三角形（頂点が真上）を共通高さ 2 へ正規化した形。幅は 4/√3 ≈ 2.309 で正方形より広い */
function triangleContour(): SerializedContour {
  const halfWidth = 2 / Math.sqrt(3)
  return {
    points: new Float64Array([0, 1, -halfWidth, -1, halfWidth, -1]),
    isHole: false,
  }
}

/** 輪郭を一様スケールする（巻き方向は変わらない） */
function scaleContours(contours: SerializedContour[], s: number): SerializedContour[] {
  return contours.map((c) => ({
    points: new Float64Array(Array.from(c.points, (v) => v * s)),
    isHole: c.isHole,
  }))
}

/** 輪郭を面内で +90°（CCW）回す：(x, y) → (−y, x)。巻き方向は保たれる */
function rotateContoursQuarterTurn(contours: SerializedContour[]): SerializedContour[] {
  return contours.map((c) => {
    const out = new Float64Array(c.points.length)
    for (let i = 0; i < c.points.length; i += 2) {
      out[i] = -c.points[i + 1]
      out[i + 1] = c.points[i]
    }
    return { points: out, isHole: c.isHole }
  })
}

/**
 * **上向き**の矢印（高さ 2 へ正規化）。arrow プリセットを面内で +90° 回した形。
 *
 * 視点 C の鏡像回帰にはこれが要る：C の回転符号を誤ると C のシルエットは
 * **上下**が反転する（B の左右反転とは軸が違う）。arrow プリセットは上下対称
 * なので、そのまま C に入れても符号の誤りを原理的に検出できない。
 */
function upArrowContours(): SerializedContour[] {
  const arrow = presetToContours('arrow') as SerializedContour[]
  // arrow の bbox は x∈[−1,1] / y∈[−0.55,0.55]。回すと y∈[−1,1]（高さ 2）になる
  return rotateContoursQuarterTurn(arrow)
}

/** 断面ローカルの bbox 寸法（computeDepths の入力） */
function extentOf(contours: SerializedContour[]): SilhouetteExtent {
  const b = boundsOf(contours)
  return { width: b.maxX - b.minX, height: b.maxY - b.minY }
}

/**
 * 3 視点・斜交にも対応したリクエスト組み立て。深さは `protocol.ts` の
 * {@link computeDepths} に委ねる — テストが自前の式を持つと、Worker の
 * 防御的検証と「たまたま同じ間違い」で通ってしまう。
 */
function buildRequest(
  parts: {
    a: SerializedContour[]
    b: SerializedContour[]
    c?: SerializedContour[] | null
    axisAngleDeg?: number
  },
  generation = 1,
): CsgRequest {
  const c = parts.c ?? null
  const depths = computeDepths({
    a: extentOf(parts.a),
    b: extentOf(parts.b),
    c: c === null ? null : extentOf(c),
    axisAngleDeg: parts.axisAngleDeg,
  })
  return {
    generation,
    a: { contours: parts.a, depth: depths.a },
    b: { contours: parts.b, depth: depths.b },
    c: c === null || depths.c === null ? null : { contours: c, depth: depths.c },
    axisAngleDeg: parts.axisAngleDeg,
    baseplate: null,
  }
}

/** 頂点配列を [x, y, z] の組に展開する */
function verticesOf(positions: Float32Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < positions.length; i += 3) {
    out.push([positions[i], positions[i + 1], positions[i + 2]])
  }
  return out
}

/**
 * 視点ごとの正射影の画面座標（protocol.ts のカメラ規約）。
 *
 * - A: right = +X, up = +Y → `(x, y)`
 * - B: right = `(cos φ, 0, −sin φ)`, up = +Y → `(x cos φ − z sin φ, y)`
 * - C: right = +X, up = −Z → `(x, −z)`
 *
 * 断面ローカル座標とこの画面座標が一致することが「鏡像でない」の定義。
 */
function projectTo(
  side: 'A' | 'B' | 'C',
  vertex: readonly [number, number, number],
  axisAngleDeg = 90,
): [number, number] {
  const [x, y, z] = vertex
  switch (side) {
    case 'A':
      return [x, y]
    case 'B': {
      const phi = (axisAngleDeg * Math.PI) / 180
      const sin = axisAngleDeg === 90 ? 1 : Math.sin(phi)
      const cos = axisAngleDeg === 90 ? 0 : Math.cos(phi)
      return [x * cos - z * sin, y]
    }
    case 'C':
      return [x, -z]
  }
}

/**
 * 点が輪郭集合の内側にあるか。被覆判定は preflight の走査線
 * （Positive fill / 巻き数）を再利用する — 独立実装を書くと、そちらの
 * バグで通ってしまう。
 *
 * 走査線は半開区間（y1 ≤ y < y2）で数えるため、bbox の上端・下端ちょうどの
 * 高さでは交点が出ない。頂点がシルエットの極値に乗るのは正常なので、
 * 真上・真下へ許容差ぶん寄せた高さも試す。
 */
function insideSilhouette(
  contours: SerializedContour[],
  point: readonly [number, number],
  tolerance: number,
): boolean {
  const [px, py] = point
  for (const dy of [0, -tolerance, tolerance]) {
    const intervals = coveredIntervalsAt(contours, py + dy)
    for (const [from, to] of intervals) {
      if (px >= from - tolerance && px <= to + tolerance) return true
    }
  }
  return false
}

/** 投影点の bbox（[minX, minY] / [maxX, maxY]） */
function boundsOfProjection(points: Array<[number, number]>): {
  min: [number, number]
  max: [number, number]
} {
  const min: [number, number] = [Infinity, Infinity]
  const max: [number, number] = [-Infinity, -Infinity]
  for (const p of points) {
    for (let axis = 0; axis < 2; axis++) {
      min[axis] = Math.min(min[axis], p[axis])
      max[axis] = Math.max(max[axis], p[axis])
    }
  }
  return { min, max }
}

/**
 * 「立体の側面 `side` からの正射影シルエットが、入力シルエットの内側に
 * 完全に収まっている」ことを検証する。軸の割り当て・回転符号・深さのどれを
 * 間違えても、はみ出した頂点が出てここで落ちる。
 */
function expectSilhouetteWithin(
  positions: Float32Array,
  side: 'A' | 'B' | 'C',
  contours: SerializedContour[],
  axisAngleDeg = 90,
  tolerance = 2e-3,
): Array<[number, number]> {
  const projected = verticesOf(positions).map((v) => projectTo(side, v, axisAngleDeg))
  const outside = projected.filter((p) => !insideSilhouette(contours, p, tolerance))
  expect(
    outside.slice(0, 5),
    `視点 ${side} の投影が入力シルエットの外へ出た（${outside.length} 点）`,
  ).toEqual([])
  return projected
}

/** 頂点配列の bbox（[minX, minY, minZ] / [maxX, maxY, maxZ]）。台座の実体検証用 */
function boundsOfPositions(positions: Float32Array): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis])
      max[axis] = Math.max(max[axis], positions[i + axis])
    }
  }
  return { min, max }
}

/** 成功レスポンスの共通妥当性（配列形状とインデックス範囲） */
function assertMeshShape(positions: Float32Array, indices: Uint32Array): void {
  expect(positions.length % 3).toBe(0)
  expect(indices.length % 3).toBe(0)
  expect(positions.length).toBeGreaterThan(0)
  expect(indices.length).toBeGreaterThan(0)
  const vertexCount = positions.length / 3
  for (const index of indices) {
    expect(index).toBeLessThan(vertexCount)
  }
}

/**
 * 閉じた向き付け可能 2-多様体の種数。オイラー標数 χ = V − E + F、
 * 三角形メッシュでは各辺がちょうど 2 三角形に共有されるので E = 3F/2。
 * 連結（成分数 1）のとき genus = (2 − χ) / 2。
 */
function genusOf(positions: Float32Array, indices: Uint32Array): number {
  const v = positions.length / 3
  const f = indices.length / 3
  const chi = v - f / 2
  return (2 - chi) / 2
}

/**
 * 鏡像（handedness）感応の測度：「最大高さ |height| を取るサンプル点の
 * 軸座標 axis の平均」。軸反転でちょうど符号が反転する。
 *
 * 面積重心や頂点座標の単純平均は arrow プリセットでは**厳密に 0** になり
 * 使えない（シャフト面積 1.25×0.44 の重心 −0.375 と鏃面積 0.4125 の重心 +0.5 が
 * 正確に相殺する定数になっている）。最大高さは鏃の付け根 (0.25, ±0.55) でのみ
 * 達成されるため、この測度はソース輪郭で +0.25、鏡像で −0.25 になる。
 */
function widestPointMeanAxis(samples: ReadonlyArray<readonly [number, number]>): number {
  let maxAbs = 0
  for (const [, height] of samples) {
    maxAbs = Math.max(maxAbs, Math.abs(height))
  }
  // Float32 経由の丸め（相対 ~1e-7）を吸収しつつ、次に高い特徴点
  // （シャフトの ±0.22）は決して拾わない緩さ
  const tolerance = 1e-3
  let sum = 0
  let count = 0
  for (const [axis, height] of samples) {
    if (Math.abs(height) >= maxAbs - tolerance) {
      sum += axis
      count++
    }
  }
  return sum / count
}

describe('worker/csg (integration with real manifold-3d)', () => {
  it('square × circle → 1 component, analytic volume within ±2%', () => {
    // A: 一辺 s = 2 の正方形（XY、+Z 押し出し）
    // B: 半径 r = s/2 = 1 の円（回転後、X 軸方向の円柱）
    //
    // 解析解の導出：交差 = {|x| ≤ s/2, |y| ≤ s/2, z は深さ内} ∩ {y² + z² ≤ r², x は深さ内}。
    // r = s/2 なので円柱の断面 y² + z² ≤ r² は角柱の |y| ≤ s/2 に内接し
    // （|y| ≤ r = s/2 が自動的に成り立つ）、z 方向は角柱の深さが円柱を覆う。
    // 残る制約は円柱本体と |x| ≤ s/2 のみ、つまり交差は
    // 「半径 r の円柱を長さ s に切ったもの」：
    //
    //   V = π r² s = π · 1² · 2 = 2π
    //
    // ±2% の許容は円の 64 角形近似（面積比 sin(2π/n)/(2π/n) ≈ 99.84%）を含む
    const s = 2
    const r = 1
    const response = performCsg(
      wasm,
      makeRequest([squareContour(s)], [circleContour(r, CIRCLE_SEGMENTS, true, false)]),
    )

    expect(response.ok).toBe(true)
    if (!response.ok) return // 型の絞り込み
    // performCsg は status() === 'NoError' のときだけ ok: true を返す
    expect(response.componentCount).toBe(1)
    const analytic = Math.PI * r * r * s
    expect(Math.abs(response.volume - analytic) / analytic).toBeLessThan(0.02)
    assertMeshShape(response.positions, response.indices)
    expect(response.elapsedMs).toBeGreaterThan(0)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('donut (outer CCW + hole CW) × circle → through-hole in the result', () => {
    // A: ドーナツ（外輪 r=1 CCW ＋ 内輪 r=0.4 CW の手書き輪郭）
    // B: 半径 1 の円 → X 軸方向の円柱
    //
    // A の穴（Z 軸まわり半径 0.4 の柱状領域）は結果を Z 方向に貫通するはず。
    // 目視ではなく 3 つの独立した証拠で判定する：
    //  (1) 連結成分数 1 かつ genus = 1（貫通トンネルがちょうど 1 本）
    //  (2) 体積の差分恒等式：hole ⊂ outer なので
    //      V(donut ∩ B) = V(outer ∩ B) − V(holeDisk ∩ B)
    //  (3) 結果の全頂点が穴の半径より外側（穴領域に材料が無い）
    const outerR = 1
    const holeR = 0.4
    const donut = [
      circleContour(outerR, CIRCLE_SEGMENTS, true, false),
      circleContour(holeR, CIRCLE_SEGMENTS, false, true),
    ]
    const cylinder = [circleContour(outerR, CIRCLE_SEGMENTS, true, false)]

    const donutResult = performCsg(wasm, makeRequest(donut, cylinder))
    expect(donutResult.ok).toBe(true)
    if (!donutResult.ok) return

    // (1) 位相：1 成分・種数 1
    expect(donutResult.componentCount).toBe(1)
    expect(genusOf(donutResult.positions, donutResult.indices)).toBe(1)

    // (2) 体積の差分恒等式（同一テッセレーションの厳密ブール演算なので高精度で成立）
    const outerOnly = performCsg(
      wasm,
      makeRequest([circleContour(outerR, CIRCLE_SEGMENTS, true, false)], cylinder),
    )
    const holeOnly = performCsg(
      wasm,
      makeRequest([circleContour(holeR, CIRCLE_SEGMENTS, true, false)], cylinder),
    )
    expect(outerOnly.ok).toBe(true)
    expect(holeOnly.ok).toBe(true)
    if (!outerOnly.ok || !holeOnly.ok) return
    const expected = outerOnly.volume - holeOnly.volume
    expect(Math.abs(donutResult.volume - expected) / expected).toBeLessThan(1e-3)

    // (3) 穴領域（Z 軸から内接円半径未満）に頂点が存在しない。
    // 64 角形の内接円半径は holeR·cos(π/64) ≈ 0.3995
    const apothem = holeR * Math.cos(Math.PI / CIRCLE_SEGMENTS)
    const positions = donutResult.positions
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]
      const y = positions[i + 1]
      expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(apothem - 1e-6)
    }

    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('disjoint silhouettes → EMPTY_RESULT, not a crash', () => {
    // A は原点中心、B は Y+10 に平行移動した正方形。共有する Y 帯が無いので
    // どの高さでもスライスは空 → 交差は空集合（design.md「3. プリフライト判定」の厳密ケース）
    const response = performCsg(
      wasm,
      makeRequest([squareContour(2)], [squareContour(2, 0, 10)]),
    )
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('EMPTY_RESULT')
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('invalid input (degenerate contour) → INVALID_INPUT with detail, no leak', () => {
    const degenerate: SerializedContour = {
      points: new Float64Array([0, 0, 1, 1]), // 2 頂点しかない
      isHole: false,
    }
    const request: CsgRequest = {
      generation: 1,
      a: { contours: [degenerate], depth: 1 },
      b: { contours: [squareContour(2)], depth: 1 },
      baseplate: null,
    }
    const response = performCsg(wasm, request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('INVALID_INPUT')
    if (response.error.code !== 'INVALID_INPUT') return
    expect(response.error.detail).toMatch(/at least 3/)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  describe('baseplate (FR-015 / Task 6.4)', () => {
    /** 作業座標系の台座厚（プロトコルは mm を運ばない — protocol.ts 参照） */
    const PLATE_HEIGHT = 0.2

    it('square × circle + baseplate → NoError, fused into a single component, plate present in the mesh', () => {
      // 正方形 × 円の交差（X 軸方向の円柱、半径 1・長さ 2）は最小 Y (= −1) に
      // 達する成分 1 個だけなので、台座と融合して単一パーツになる
      const request: CsgRequest = {
        ...makeRequest(
          [squareContour(2)],
          [circleContour(1, CIRCLE_SEGMENTS, true, false)],
        ),
        baseplate: { enabled: true, height: PLATE_HEIGHT },
      }
      const response = performCsg(wasm, request)
      // performCsg は status() === 'NoError'（結合後の再検証を含む）のときだけ ok: true
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)
      assertMeshShape(response.positions, response.indices)
      // 融合した箱＋円柱は穴のない単一立体（genus 0）
      expect(genusOf(response.positions, response.indices)).toBe(0)

      // 台座の実体を bbox で検証する：
      // - フットプリント = 立体の XZ bbox（±1）× 1.15 → ±1.15
      // - 厚みは下方向（FR-029: 実寸高さに台座厚は含めない）→ minY = −1 − 0.2
      const { min, max } = boundsOfPositions(response.positions)
      expect(min[0]).toBeCloseTo(-1 * BASEPLATE_FOOTPRINT_SCALE, 5)
      expect(max[0]).toBeCloseTo(1 * BASEPLATE_FOOTPRINT_SCALE, 5)
      expect(min[2]).toBeCloseTo(-1 * BASEPLATE_FOOTPRINT_SCALE, 5)
      expect(max[2]).toBeCloseTo(1 * BASEPLATE_FOOTPRINT_SCALE, 5)
      expect(min[1]).toBeCloseTo(-1 - PLATE_HEIGHT, 5)
      expect(max[1]).toBeCloseTo(1, 5)

      // 体積 ≈ 円柱 (2π) ＋ 台座 (2.3 × 2.3 × (厚み + 食い込み))。
      // 食い込み分の重複（円柱の最下帯 ≈ 0.004）は許容 1% に含まれる
      const plateVolume =
        2.3 * 2.3 * (PLATE_HEIGHT * (1 + BASEPLATE_CONTACT_RATIO))
      const expected = Math.PI * 1 * 1 * 2 + plateVolume
      expect(Math.abs(response.volume - expected) / expected).toBeLessThan(0.01)

      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('a component that never reaches the global minimum Y stays disconnected after the union', () => {
      // 意図的に分離する入力：A = 正方形、B = 上下に離れた 2 つの小正方形。
      // 交差は y ∈ [−1, −0.4] と y ∈ [0.4, 1] の 2 スラブになり、
      // 全体の最小 Y (= −1) に達するのは下スラブだけ。台座は下スラブとしか
      // 融合できず、上スラブは浮いたまま — 台座は 1 パーツを保証しない
      // （FR-015 / design.md「台座」）。componentCount はその事実を隠さない
      const twoBands = [
        squareContour(0.6, 0, -0.7),
        squareContour(0.6, 0, 0.7),
      ]

      const bare = performCsg(wasm, makeRequest([squareContour(2)], twoBands))
      expect(bare.ok).toBe(true)
      if (!bare.ok) return
      expect(bare.componentCount).toBe(2)

      const based = performCsg(wasm, {
        ...makeRequest([squareContour(2)], twoBands),
        baseplate: { enabled: true, height: PLATE_HEIGHT },
      })
      expect(based.ok).toBe(true)
      if (!based.ok) return
      // 結合後の再 decompose が正直に 2 を報告する（1 に「なったこと」に
      // されない）。台座 + 下スラブで 1 成分、浮いた上スラブで 1 成分
      expect(based.componentCount).toBe(2)

      // 台座は実在する（数え漏れで 2 なのではない）：bbox が下方向に厚み分
      // 伸び、体積が台座なしより増えている
      const { min } = boundsOfPositions(based.positions)
      expect(min[1]).toBeCloseTo(-1 - PLATE_HEIGHT, 5)
      expect(based.volume).toBeGreaterThan(bare.volume)

      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('baseplate with enabled: false behaves exactly as no baseplate', () => {
      const withNull = performCsg(
        wasm,
        makeRequest([squareContour(2)], [circleContour(1, CIRCLE_SEGMENTS, true, false)]),
      )
      const withDisabled = performCsg(wasm, {
        ...makeRequest(
          [squareContour(2)],
          [circleContour(1, CIRCLE_SEGMENTS, true, false)],
        ),
        baseplate: { enabled: false, height: PLATE_HEIGHT },
      })
      expect(withNull.ok).toBe(true)
      expect(withDisabled.ok).toBe(true)
      if (!withNull.ok || !withDisabled.ok) return
      expect(withDisabled.volume).toBe(withNull.volume)
      expect(withDisabled.componentCount).toBe(withNull.componentCount)
      expect(boundsOfPositions(withDisabled.positions).min[1]).toBeCloseTo(-1, 5)
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('non-finite or non-positive plate height → INVALID_INPUT, no leak', () => {
      for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const response = performCsg(wasm, {
          ...makeRequest([squareContour(2)], [squareContour(2)]),
          baseplate: { enabled: true, height },
        })
        expect(response.ok).toBe(false)
        if (response.ok) return
        expect(response.error.code).toBe('INVALID_INPUT')
        if (response.error.code !== 'INVALID_INPUT') return
        expect(response.error.detail).toMatch(/baseplate\.height/)
        expect(getLiveWasmObjectCount()).toBe(0)
      }
    })

    it('empty intersection with baseplate enabled still reports EMPTY_RESULT (no floating plate)', () => {
      // 空判定は台座結合より前 — 交差が空なのに台座だけの「立体」を
      // 成功として返してはならない
      const response = performCsg(wasm, {
        ...makeRequest([squareContour(2)], [squareContour(2, 0, 10)]),
        baseplate: { enabled: true, height: PLATE_HEIGHT },
      })
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.code).toBe('EMPTY_RESULT')
      expect(getLiveWasmObjectCount()).toBe(0)
    })
  })

  it('depth shorter than the opposing silhouette width → INVALID_INPUT, not a clipped solid', () => {
    // 幅 2 の正方形同士に深さ 0.1（レビュー Finding 2 の再現入力）。
    // Manifold はこの入力でも 'NoError' の非空 2-多様体を返すため、境界で
    // 拒否しない限り**両シルエットが切り落とされた立体が成功として通る**。
    // ステータス・体積・成分数のどれにも異常が出ず、下流では検出不能
    const response = performCsg(wasm, {
      generation: 1,
      a: { contours: [squareContour(2)], depth: 0.1 },
      b: { contours: [squareContour(2)], depth: 0.1 },
      baseplate: null,
    })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('INVALID_INPUT')
    if (response.error.code !== 'INVALID_INPUT') return
    // 不足量が明示されること：どの深さが、いくつ必要か
    expect(response.error.detail).toMatch(/a\.depth 0\.1/)
    expect(response.error.detail).toMatch(/2\.04/)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('asymmetric B (arrow) keeps its handedness — regression for the rotate([0, 90, 0]) sign', () => {
    // design.md「2.1 軸の割り当てとカメラ規約」：B の局所 +X（矢の先端方向）は
    // Y 軸まわり +90° 回転 (x, y, z) → (z, y, −x) で world −Z に写り、
    // +X カメラの画面右も world −Z。つまり +X 視点への投影
    // (sx, sy) = (−z, y) はソース輪郭 (x, y) と**同じ向き**で一致するはず。
    // 回転符号を −90° に変えると B だけ鏡像になるが、円・正方形・ドーナツは
    // すべて左右対称なので既存テストでは原理的に検出できない。仕様上の
    // 非対称プリセット arrow（presets.ts 参照）を B に使い、符号を検証する
    const arrow = presetToContours('arrow')
    const response = performCsg(wasm, makeRequest([squareContour(2)], arrow))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.componentCount).toBe(1)

    // ソース輪郭の測度（axis = 局所 x、height = 局所 y）
    const sourceSamples: [number, number][] = []
    for (const contour of arrow) {
      for (let i = 0; i < contour.points.length; i += 2) {
        sourceSamples.push([contour.points[i], contour.points[i + 1]])
      }
    }
    const sourceMeasure = widestPointMeanAxis(sourceSamples)
    // 測度自体が非退化であることを先に固定する（鏃の付け根 x = +0.25）
    expect(sourceMeasure).toBeGreaterThan(0.2)

    // 結果メッシュを +X カメラの画面座標へ投影（sx = −z, sy = y）
    const projected: [number, number][] = []
    const positions = response.positions
    for (let i = 0; i < positions.length; i += 3) {
      projected.push([-positions[i + 2], positions[i + 1]])
    }
    const resultMeasure = widestPointMeanAxis(projected)

    // **符号**を比較する — 絶対値の比較は鏡像でも通ってしまう
    expect(Math.sign(resultMeasure)).toBe(Math.sign(sourceMeasure))
    expect(resultMeasure).toBeGreaterThan(0.2)

    // 独立な二重確認：画面右端（先端側）は鏃がすぼまり |sy| ≈ 0、
    // 画面左端（尾側）はシャフト断面（|sy| = 0.22）が残る。鏡像だと左右が入れ替わる
    let maxAbsYTipSide = 0
    let maxAbsYTailSide = 0
    for (const [sx, sy] of projected) {
      if (sx > 0.8) maxAbsYTipSide = Math.max(maxAbsYTipSide, Math.abs(sy))
      if (sx < -0.8) maxAbsYTailSide = Math.max(maxAbsYTailSide, Math.abs(sy))
    }
    expect(maxAbsYTipSide).toBeLessThan(0.15)
    expect(maxAbsYTailSide).toBeGreaterThan(0.2)

    expect(getLiveWasmObjectCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 視点 C（FR-101）
  // -------------------------------------------------------------------------

  describe('third viewpoint (FR-101)', () => {
    it('adding the field without a silhouette changes nothing — c: null / omitted / 90° are bit-identical', () => {
      // 「視点を足しても 2 視点の結果は変わらない」を仮定ではなく検証する。
      // 深さ・回転・交差のどれかが C の追加で経路を変えていれば頂点が動く
      const shapes = {
        a: [squareContour(2)],
        b: [circleContour(1, CIRCLE_SEGMENTS, true, false)],
      }
      const legacy = performCsg(wasm, makeRequest(shapes.a, shapes.b))
      const explicitNull = performCsg(wasm, buildRequest(shapes))
      const explicitOrthogonal = performCsg(wasm, {
        ...buildRequest(shapes),
        axisAngleDeg: 90,
      })

      expect(legacy.ok).toBe(true)
      expect(explicitNull.ok).toBe(true)
      expect(explicitOrthogonal.ok).toBe(true)
      if (!legacy.ok || !explicitNull.ok || !explicitOrthogonal.ok) return

      // 深さの算出式（computeDepths）が従来の手書き式と厳密に同値であること
      expect(buildRequest(shapes).a.depth).toBe(makeRequest(shapes.a, shapes.b).a.depth)
      expect(buildRequest(shapes).b.depth).toBe(makeRequest(shapes.a, shapes.b).b.depth)
      expect(buildRequest(shapes).c).toBeNull()

      for (const other of [explicitNull, explicitOrthogonal]) {
        expect(other.volume).toBe(legacy.volume)
        expect(other.componentCount).toBe(legacy.componentCount)
        expect(Array.from(other.positions)).toEqual(Array.from(legacy.positions))
        expect(Array.from(other.indices)).toEqual(Array.from(legacy.indices))
      }
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('square × circle × triangle → 各視点の正射影が入力シルエットの内側に収まる', () => {
      // 3 視点の座標対応（protocol.ts `VIEWPOINT_AXES`）。w = −z と置くと
      //   A: (x, y) = (u, v)、B: (B ローカル x, y) = (w, v)、C: (x, −z) = (u, w)
      // で、M = { (u,v) ∈ S_A, (w,v) ∈ S_B, (u,w) ∈ S_C }。
      //
      // **3 つのシルエットが同時に完全再現されるとは限らない**：ここでは
      // 三角形の幅（4/√3 ≈ 2.309）が正方形の幅 2 を超えるため、視点 C の
      // シルエットは |u| ≤ 1 に切り落とされる。これは実装の不具合ではなく
      // FR-101 が言う「適格性の制約が急激に厳しくなる」ことそのもの。
      // 完全再現する適格な三つ組は次のテスト（tricylinder）で押さえる。
      const square = [squareContour(2)]
      const circle = [circleContour(1, CIRCLE_SEGMENTS, true, false)]
      const triangle = [triangleContour()]

      const response = performCsg(wasm, buildRequest({ a: square, b: circle, c: triangle }))
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)
      assertMeshShape(response.positions, response.indices)

      // 3 視点すべてで、投影が入力シルエットからはみ出さない
      const projA = expectSilhouetteWithin(response.positions, 'A', square)
      const projB = expectSilhouetteWithin(response.positions, 'B', circle)
      const projC = expectSilhouetteWithin(response.positions, 'C', triangle)

      // A / B は極値まで届く（＝深さ不足で切り落とされていない）
      const boundsA = boundsOfProjection(projA)
      expect(boundsA.min[0]).toBeCloseTo(-1, 4)
      expect(boundsA.max[0]).toBeCloseTo(1, 4)
      expect(boundsA.min[1]).toBeCloseTo(-1, 4)
      expect(boundsA.max[1]).toBeCloseTo(1, 4)
      const boundsB = boundsOfProjection(projB)
      expect(boundsB.min[0]).toBeCloseTo(-1, 4)
      expect(boundsB.max[0]).toBeCloseTo(1, 4)
      expect(boundsB.min[1]).toBeCloseTo(-1, 4)
      expect(boundsB.max[1]).toBeCloseTo(1, 4)

      // C は高さ（w）方向は届くが、幅（u）方向は正方形に削られる。
      // これを「届いている」ことにしてしまうと適格性の提示が嘘になる
      const boundsC = boundsOfProjection(projC)
      expect(boundsC.min[1]).toBeCloseTo(-1, 4)
      expect(boundsC.max[1]).toBeCloseTo(1, 4)
      expect(boundsC.max[0]).toBeCloseTo(1, 4)
      expect(boundsC.max[0]).toBeLessThan(2 / Math.sqrt(3) - 0.1)
      expect(boundsOf(triangle).maxX).toBeCloseTo(2 / Math.sqrt(3), 6)

      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('circle × circle × circle（適格な三つ組）→ 3 つの正射影が入力そのものに一致する', () => {
      // 適格性の十分条件：どの視点でも「相手 2 つの中心線（w = 0 など）」が
      // 常に材料の中にあるため、投影が入力から欠けない。円 3 枚はこれを満たす。
      //
      // 一致の証明は体積で行う：計算結果 M は必ず無限角柱の交差 M∞ の部分集合
      // なので、**体積が M∞ と一致すれば M = M∞**（測度ゼロを除く）。M∞ の
      // 3 投影が入力そのものになることは上の十分条件から従うので、
      // 体積一致 ⇒ シルエット一致。M∞ は Steinmetz の三円柱で
      //   V = 8(2 − √2) r³
      const segments = 128
      const disk = (): SerializedContour[] => [circleContour(1, segments, true, false)]
      const response = performCsg(wasm, buildRequest({ a: disk(), b: disk(), c: disk() }))
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)

      const analytic = 8 * (2 - Math.SQRT2)
      // 128 角形は内接（apothem = cos(π/128) = 0.99970）なので体積はごく僅かに
      // 小さい。1% は近似ぶんを十分に含み、切り落とし（数十 %）とは桁で分かれる
      expect(Math.abs(response.volume - analytic) / analytic).toBeLessThan(0.01)

      for (const side of ['A', 'B', 'C'] as const) {
        const projected = expectSilhouetteWithin(response.positions, side, disk())
        const bounds = boundsOfProjection(projected)
        expect(bounds.min[0]).toBeCloseTo(-1, 4)
        expect(bounds.max[0]).toBeCloseTo(1, 4)
        expect(bounds.min[1]).toBeCloseTo(-1, 4)
        expect(bounds.max[1]).toBeCloseTo(1, 4)
      }
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('asymmetric C (up arrow) keeps its handedness — regression for the rotate([-90, 0, 0]) sign', () => {
      // protocol.ts `VIEWPOINT_AXES`：C の押し出しは X 軸まわり **−90°** で
      // `(x, y, z) → (x, z, −y)`。ローカル +Y は world −Z に写り、+Y カメラの
      // 画面上 も world −Z。したがって +Y 視点への投影 (sx, sy) = (x, −z) は
      // ソース輪郭 (x, y) と**同じ向き**で一致するはず。
      // `[+90, 0, 0]` にすると押し出しが −Y を向き、+Y カメラから見た C は
      // **上下反転**する。arrow プリセットは上下対称でこれを検出できないので、
      // 面内で 90° 回した「上向き矢印」を使う（左右対称・上下非対称）。
      const upArrow = upArrowContours()
      const square = [squareContour(2)]
      const response = performCsg(
        wasm,
        buildRequest({ a: square, b: square, c: upArrow }),
      )
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)

      // 測度の軸を C の画面に合わせる：axis = 画面 Y（= −z）、height = 画面 X（= x）。
      // 上向き矢印は鏃の付け根 (±0.55, 0.25) でのみ |x| が最大になる
      const sourceSamples: Array<[number, number]> = []
      for (const contour of upArrow) {
        for (let i = 0; i < contour.points.length; i += 2) {
          sourceSamples.push([contour.points[i + 1], contour.points[i]])
        }
      }
      const sourceMeasure = widestPointMeanAxis(sourceSamples)
      expect(sourceMeasure).toBeCloseTo(0.25, 6)

      const projected = verticesOf(response.positions).map((v) => projectTo('C', v))
      const resultMeasure = widestPointMeanAxis(projected.map(([sx, sy]) => [sy, sx]))

      // **符号**を比較する — 絶対値の比較は上下反転でも通ってしまう
      expect(Math.sign(resultMeasure)).toBe(Math.sign(sourceMeasure))
      expect(resultMeasure).toBeGreaterThan(0.2)

      // 独立な二重確認：画面上端（鏃の先）は幅ゼロへすぼまり、下端（尾）には
      // シャフト断面（|sx| = 0.22）が残る。上下反転すると入れ替わる
      let maxAbsXTipSide = 0
      let maxAbsXTailSide = 0
      for (const [sx, sy] of projected) {
        if (sy > 0.85) maxAbsXTipSide = Math.max(maxAbsXTipSide, Math.abs(sx))
        if (sy < -0.85) maxAbsXTailSide = Math.max(maxAbsXTailSide, Math.abs(sx))
      }
      expect(maxAbsXTipSide).toBeLessThan(0.15)
      expect(maxAbsXTailSide).toBeGreaterThan(0.2)

      expectSilhouetteWithin(response.positions, 'C', upArrow)
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('c.depth shorter than the required span → INVALID_INPUT, not a clipped solid', () => {
      const request = buildRequest({
        a: [squareContour(2)],
        b: [squareContour(2)],
        c: [squareContour(2)],
      })
      expect(request.c).not.toBeNull()
      // 深さ規則どおりに組んだ要求値（= max(hA, hB) × 1.02 = 2.04）
      expect(request.c!.depth).toBeCloseTo(2 * (1 + DEPTH_MARGIN), 12)

      const response = performCsg(wasm, {
        ...request,
        c: { contours: request.c!.contours, depth: 0.1 },
      })
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.code).toBe('INVALID_INPUT')
      if (response.error.code !== 'INVALID_INPUT') return
      expect(response.error.detail).toMatch(/c\.depth 0\.1/)
      expect(response.error.detail).toMatch(/\+Y/)
      expect(response.error.detail).toMatch(/2\.04/)
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('non-finite or non-positive c.depth → INVALID_INPUT, no leak', () => {
      const request = buildRequest({
        a: [squareContour(2)],
        b: [squareContour(2)],
        c: [squareContour(2)],
      })
      for (const depth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const response = performCsg(wasm, {
          ...request,
          c: { contours: request.c!.contours, depth },
        })
        expect(response.ok).toBe(false)
        if (response.ok) return
        expect(response.error.code).toBe('INVALID_INPUT')
        if (response.error.code !== 'INVALID_INPUT') return
        expect(response.error.detail).toMatch(/c\.depth/)
        expect(getLiveWasmObjectCount()).toBe(0)
      }
    })

    it('a triple whose C never meets A and B → EMPTY_RESULT, not a crash', () => {
      // C を w 方向に外した位置に置く（B が許す w は |w| ≤ 1 だが、C の材料は
      // w ∈ [3, 5]）。どの高さでもスライスが空になる
      const offsetC: SerializedContour = squareContour(2, 0, 4)
      const response = performCsg(
        wasm,
        buildRequest({
          a: [squareContour(2)],
          b: [squareContour(2)],
          c: [offsetC],
        }),
      )
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.code).toBe('EMPTY_RESULT')
      expect(getLiveWasmObjectCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // 斜交軸（FR-102）
  // -------------------------------------------------------------------------

  describe('oblique axis (FR-102)', () => {
    /** 高さ 2 へ正規化した右向き矢印（左右非対称） */
    const tallArrow = (): SerializedContour[] =>
      scaleContours(presetToContours('arrow') as SerializedContour[], 2 / 1.1)

    it('45°: 立体が生成され、2 つの斜交方向から見たシルエットが正しい', () => {
      const square = [squareContour(2)]
      const arrow = tallArrow()
      const request = buildRequest({ a: square, b: arrow, axisAngleDeg: 45 })

      // 深さは直交式より確実に大きい（せん断ぶん）
      const widthArrow = boundsOf(arrow).maxX - boundsOf(arrow).minX
      expect(request.a.depth).toBeGreaterThan(widthArrow * (1 + DEPTH_MARGIN) * 1.3)

      const response = performCsg(wasm, request)
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)
      assertMeshShape(response.positions, response.indices)

      // 視点 A（+Z）と視点 B（(sin45°, 0, cos45°) 側）の 2 方向から検証する
      const projA = expectSilhouetteWithin(response.positions, 'A', square, 45)
      const projB = expectSilhouetteWithin(response.positions, 'B', arrow, 45)

      const boundsA = boundsOfProjection(projA)
      expect(boundsA.min[0]).toBeCloseTo(-1, 3)
      expect(boundsA.max[0]).toBeCloseTo(1, 3)
      expect(boundsA.min[1]).toBeCloseTo(-1, 3)
      expect(boundsA.max[1]).toBeCloseTo(1, 3)

      const arrowBounds = boundsOf(arrow)
      const boundsB = boundsOfProjection(projB)
      expect(boundsB.min[0]).toBeCloseTo(arrowBounds.minX, 3)
      expect(boundsB.max[0]).toBeCloseTo(arrowBounds.maxX, 3)
      expect(boundsB.min[1]).toBeCloseTo(-1, 3)
      expect(boundsB.max[1]).toBeCloseTo(1, 3)

      // 斜交でも B は鏡像にならない（画面右 = ローカル +X のまま）
      const sourceSamples: Array<[number, number]> = []
      for (const contour of arrow) {
        for (let i = 0; i < contour.points.length; i += 2) {
          sourceSamples.push([contour.points[i], contour.points[i + 1]])
        }
      }
      const sourceMeasure = widestPointMeanAxis(sourceSamples)
      const resultMeasure = widestPointMeanAxis(projB)
      expect(sourceMeasure).toBeGreaterThan(0.4)
      expect(Math.sign(resultMeasure)).toBe(Math.sign(sourceMeasure))
      expect(resultMeasure).toBeCloseTo(sourceMeasure, 2)

      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('直交式の深さを 45° に流用すると拒否される（斜交の導出が効いている証拠）', () => {
      const square = [squareContour(2)]
      const arrow = tallArrow()
      const orthogonal = buildRequest({ a: square, b: arrow })
      const oblique = buildRequest({ a: square, b: arrow, axisAngleDeg: 45 })
      expect(oblique.a.depth).toBeGreaterThan(orthogonal.a.depth)

      const response = performCsg(wasm, {
        ...oblique,
        a: { contours: square, depth: orthogonal.a.depth },
      })
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.code).toBe('INVALID_INPUT')
      if (response.error.code !== 'INVALID_INPUT') return
      expect(response.error.detail).toMatch(/a\.depth/)
      expect(getLiveWasmObjectCount()).toBe(0)
    })

    it('軸角が範囲外・非有限なら INVALID_INPUT（退化した交差を作らない）', () => {
      const base = buildRequest({ a: [squareContour(2)], b: [squareContour(2)] })
      for (const axisAngleDeg of [0, 180, 5, 170, Number.NaN, Number.POSITIVE_INFINITY]) {
        const response = performCsg(wasm, { ...base, axisAngleDeg })
        expect(response.ok).toBe(false)
        if (response.ok) return
        expect(response.error.code).toBe('INVALID_INPUT')
        if (response.error.code !== 'INVALID_INPUT') return
        expect(response.error.detail).toMatch(/axisAngleDeg/)
        expect(getLiveWasmObjectCount()).toBe(0)
      }
    })

    it('斜交でも視点 C を併用できる（3 視点 × 45°）', () => {
      const response = performCsg(
        wasm,
        buildRequest({
          a: [squareContour(2)],
          b: [circleContour(1, CIRCLE_SEGMENTS, true, false)],
          c: [squareContour(2)],
          axisAngleDeg: 45,
        }),
      )
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)
      expectSilhouetteWithin(response.positions, 'A', [squareContour(2)], 45)
      expectSilhouetteWithin(
        response.positions,
        'B',
        [circleContour(1, CIRCLE_SEGMENTS, true, false)],
        45,
      )
      expectSilhouetteWithin(response.positions, 'C', [squareContour(2)], 45)
      expect(getLiveWasmObjectCount()).toBe(0)
    })
  })

  it('sustained generations: live-object counter stays zero AND the wasm heap plateaus', () => {
    // リーク判定は 2 系統（NFR-012）：
    //
    // (a) 生存オブジェクト数 — ただしこれは track/release の**記帳に対する検算**
    //     でしかない。ライブラリ内部のリーク（例：extrude の center: true が内部で
    //     チェーンする translate の中間 Manifold）は記帳に現れず、カウンタ判定は
    //     原理的に失敗できない
    // (b) Wasm ヒープ容量の**高水位停滞（plateau）** — ウォームアップ 20 世代で
    //     アロケータを定常状態にして高水位を記録し、さらに 200 世代でそれ以上
    //     成長しないことを要求する。実測：修正後は 16.00 MB で完全に停滞し、
    //     **3 視点（FR-101）と斜交（FR-102）の経路を混ぜても成長は 0 バイト**
    //     （high-water = final = 16,777,216 B、生存オブジェクト 0）。
    //     center: true に戻すと +100 MB 超成長する。
    //     Emscripten のヒープは delete() しても**縮まない**ため、容量の減少を
    //     要求する形は必ず偽陽性になる — 見るのは「増えないこと」だけ
    //
    // 成功・EMPTY_RESULT・台座（Task 6.4）・**3 視点（FR-101）**・**斜交
    // （FR-102）**の 5 経路を混ぜて finally の破棄経路をすべて通す — 台座パスは
    // plateBox / plate / based の 3 個、3 視点パスは sectionC / rawC / centeredC /
    // prismC / solidABC の 5 個が追加で生成されるため、そこの解放漏れもこの
    // テストの監視対象。円の分割数を上げてリーク 1 件あたりのサイズを稼ぎ、
    // もしリークが再発したらヒープ成長が許容値を確実に超えるようにする
    const memory = wasmMemory
    if (memory === null) {
      throw new Error('WebAssembly.Memory を捕捉できていない（beforeAll のラップを確認）')
    }
    const LEAK_TEST_SEGMENTS = 512
    // 実測 0 バイト成長に対する余裕。断片化などプラットフォーム差を許す一方、
    // リーク時の +100 MB 超に対しては 25 倍以上の余裕で判定が分かれる
    const HEAP_PLATEAU_TOLERANCE_BYTES = 4 * 1024 * 1024

    const success = makeRequest(
      [squareContour(2)],
      [circleContour(1, LEAK_TEST_SEGMENTS, true, false)],
    )
    const empty = makeRequest([squareContour(2)], [squareContour(2, 0, 10)])
    const baseplated: CsgRequest = {
      ...makeRequest(
        [squareContour(2)],
        [circleContour(1, LEAK_TEST_SEGMENTS, true, false)],
      ),
      baseplate: { enabled: true, height: 0.2 },
    }

    // 3 視点（FR-101）と斜交（FR-102）。C も 512 角形の円にして、prismC 系の
    // 漏れが 1 件でもあればヒープ成長が許容値を超えるようにする
    const triple = buildRequest({
      a: [squareContour(2)],
      b: [circleContour(1, LEAK_TEST_SEGMENTS, true, false)],
      c: [circleContour(1, LEAK_TEST_SEGMENTS, true, false)],
    })
    const oblique = buildRequest({
      a: [squareContour(2)],
      b: [circleContour(1, LEAK_TEST_SEGMENTS, true, false)],
      axisAngleDeg: 45,
    })
    const variants: CsgRequest[] = [empty, success, baseplated, triple, oblique]

    const runGeneration = (generation: number): void => {
      const variant = generation % variants.length
      const request: CsgRequest = { ...variants[variant], generation }
      const response = performCsg(wasm, request)
      expect(response.generation).toBe(generation)
      // variant 0 = 空交差（失敗パス）、1 = 成功、2 = 台座付き成功、
      // 3 = 3 視点、4 = 斜交 45°
      expect(response.ok).toBe(variant !== 0)
      expect(getLiveWasmObjectCount()).toBe(0)
    }

    for (let generation = 1; generation <= 20; generation++) {
      runGeneration(generation)
    }
    const highWaterBytes = memory.buffer.byteLength

    for (let generation = 21; generation <= 220; generation++) {
      runGeneration(generation)
    }
    const finalBytes = memory.buffer.byteLength

    expect(getLiveWasmObjectCount()).toBe(0)
    expect(finalBytes - highWaterBytes).toBeLessThanOrEqual(HEAP_PLATEAU_TOLERANCE_BYTES)
  }, 60_000)
})
