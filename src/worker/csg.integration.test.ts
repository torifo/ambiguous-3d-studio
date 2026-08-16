import { beforeAll, describe, expect, it } from 'vitest'
import createManifold from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import { boundsOf } from '../geometry/normalize'
import { presetToContours } from '../sources/presets'
import type { CsgRequest, SerializedContour } from './protocol'
import { DEPTH_MARGIN, getLiveWasmObjectCount, performCsg } from './csg.worker'

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

  it('baseplate-enabled request is rejected until Task 6.4', () => {
    const request: CsgRequest = {
      ...makeRequest([squareContour(2)], [squareContour(2)]),
      baseplate: { enabled: true, height: 0.2 },
    }
    const response = performCsg(wasm, request)
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('INVALID_INPUT')
    expect(getLiveWasmObjectCount()).toBe(0)
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

  it('sustained generations: live-object counter stays zero AND the wasm heap plateaus', () => {
    // リーク判定は 2 系統（NFR-012）：
    //
    // (a) 生存オブジェクト数 — ただしこれは track/release の**記帳に対する検算**
    //     でしかない。ライブラリ内部のリーク（例：extrude の center: true が内部で
    //     チェーンする translate の中間 Manifold）は記帳に現れず、カウンタ判定は
    //     原理的に失敗できない
    // (b) Wasm ヒープ容量の**高水位停滞（plateau）** — ウォームアップ 20 世代で
    //     アロケータを定常状態にして高水位を記録し、さらに 200 世代でそれ以上
    //     成長しないことを要求する。実測（本修正時）：修正後は 16.00 MB で完全に
    //     停滞、center: true に戻すと +100 MB 超成長する。
    //     Emscripten のヒープは delete() しても**縮まない**ため、容量の減少を
    //     要求する形は必ず偽陽性になる — 見るのは「増えないこと」だけ
    //
    // 成功パスと EMPTY_RESULT パスを混ぜて finally の破棄経路を両方通す。
    // 円の分割数を上げてリーク 1 件あたりのサイズを稼ぎ、もしリークが再発したら
    // ヒープ成長が許容値を確実に超えるようにする
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

    const runGeneration = (generation: number): void => {
      const request: CsgRequest = {
        ...(generation % 2 === 0 ? empty : success),
        generation,
      }
      const response = performCsg(wasm, request)
      expect(response.generation).toBe(generation)
      if (generation % 2 === 0) {
        expect(response.ok).toBe(false)
      } else {
        expect(response.ok).toBe(true)
      }
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
