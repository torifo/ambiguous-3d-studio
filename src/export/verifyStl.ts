/**
 * バイナリ STL の読み戻し検証（Task 5.3 / NFR-010 / NFR-011）。
 *
 * ## このファイルが存在する理由
 *
 * 84 バイトのヘッダと三角形数の検査は「バイナリ STL として
 * シリアライズできた」ことしか示さない。STL は位相情報（頂点の共有・
 * 隣接関係）を捨てるフォーマットなので、**入力が Manifold だったことは
 * 出力ファイルの保証にならない**（design.md「Testing Strategy → STL 検証」）。
 * スライサーが受理するかを決めるのはファイルそのものの性質であり、
 * それは書き出したバイトを読み戻して初めて検証できる：
 *
 * 1. 全頂点座標が有限値（NFR-011）
 * 2. 全三角形の面積が正 — 面積ゼロの縮退面がない（NFR-011）
 * 3. **全ての無向辺がちょうど 2 回、逆向きに現れる** — 閉じていて
 *    巻き方向が一貫している（NFR-010 の 2-manifold 検証。スライサーが
 *    拒否する「穴あき」「裏返り面」を捕まえるのはこの検査）
 * 4. bbox が FR-029 の指定 mm 寸法と一致する
 *
 * 頂点の同一性は座標の**ビット厳密一致**で判定する。STL は頂点を三角形
 * ごとに複製するため、共有されていた頂点は同じ float32 値で複数回現れる。
 * 書き出し経路（float32 位置 × 同一行列 → float32 丸め）は決定的なので、
 * 閉じたメッシュなら厳密一致で辺が必ず対になる。
 *
 * ファセット法線の**値**は検証しない。スライサーは法線を頂点の巻き方向から
 * 再計算するのが通例で、権威は巻き方向（検査 3）にある。
 */

/** 3 次元座標のタプル */
export type Vec3 = [number, number, number]

/** バイナリ STL の 1 三角形レコード（法線 + 頂点 3 つ） */
export interface StlTriangle {
  normal: Vec3
  vertices: [Vec3, Vec3, Vec3]
}

/** {@link parseBinaryStl} の結果 */
export interface ParsedBinaryStl {
  /** ヘッダ直後の uint32 が宣言する三角形数。パース成功時は `triangles.length` と一致 */
  triangleCount: number
  triangles: StlTriangle[]
}

const HEADER_BYTES = 80
const COUNT_BYTES = 4
const TRIANGLE_RECORD_BYTES = 50 // float32 × 12 + uint16

/**
 * バイナリ STL のバイト列をパースする。
 *
 * 構造の検査（ヘッダ長・**宣言三角形数とバイト長の一致**）はここで行い、
 * 破れていれば例外を投げる。この一致は必要条件にすぎない —
 * 幾何・位相の検証は {@link verifyStlBytes} が行う。
 *
 * @throws Error 84 バイト未満、またはヘッダの三角形数とバイト長が食い違う場合
 */
export function parseBinaryStl(bytes: Uint8Array): ParsedBinaryStl {
  const minLength = HEADER_BYTES + COUNT_BYTES
  if (bytes.byteLength < minLength) {
    throw new Error(
      `parseBinaryStl: ${bytes.byteLength} bytes is too short — ` +
        `a binary STL needs at least ${minLength} bytes (header + triangle count)`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triangleCount = view.getUint32(HEADER_BYTES, true)
  const expectedLength =
    HEADER_BYTES + COUNT_BYTES + TRIANGLE_RECORD_BYTES * triangleCount
  if (bytes.byteLength !== expectedLength) {
    throw new Error(
      `parseBinaryStl: header declares ${triangleCount} triangles ` +
        `(${expectedLength} bytes) but the file is ${bytes.byteLength} bytes`,
    )
  }

  const triangles: StlTriangle[] = []
  let offset = HEADER_BYTES + COUNT_BYTES
  for (let t = 0; t < triangleCount; t++) {
    const readVec3 = (at: number): Vec3 => [
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
    ]
    triangles.push({
      normal: readVec3(offset),
      vertices: [
        readVec3(offset + 12),
        readVec3(offset + 24),
        readVec3(offset + 36),
      ],
    })
    offset += TRIANGLE_RECORD_BYTES
  }
  return { triangleCount, triangles }
}

/** 検証で見つかった個別の問題。message は人間向けの根拠説明 */
export type StlVerificationIssue =
  | {
      /** バイナリ STL として構造が破れている（ヘッダ・バイト長の不一致など） */
      code: 'MALFORMED'
      message: string
    }
  | {
      /** 三角形が 0 個。閉じた立体は最低 4 面持つので空ファイルは常に不正 */
      code: 'EMPTY'
      message: string
    }
  | {
      /** NaN / Infinity を含む頂点座標（NFR-011 違反） */
      code: 'NON_FINITE_VERTEX'
      message: string
      triangle: number
    }
  | {
      /** 面積ゼロの縮退三角形（NFR-011 違反） */
      code: 'ZERO_AREA_TRIANGLE'
      message: string
      triangle: number
    }
  | {
      /** 辺が 1 回しか現れない = メッシュに穴が開いている（NFR-010 違反） */
      code: 'BOUNDARY_EDGE'
      message: string
      edge: [Vec3, Vec3]
    }
  | {
      /** 辺は 2 回現れるが同じ向き = 隣接面の巻き方向が食い違う（裏返り面） */
      code: 'INCONSISTENT_WINDING'
      message: string
      edge: [Vec3, Vec3]
    }
  | {
      /** 辺が 3 回以上現れる = 非マニホールド辺（NFR-010 違反） */
      code: 'NON_MANIFOLD_EDGE'
      message: string
      edge: [Vec3, Vec3]
      count: number
    }
  | {
      /** bbox の寸法が FR-029 の指定 mm と一致しない */
      code: 'BBOX_MISMATCH'
      message: string
      axis: 'x' | 'y' | 'z'
      actualMm: number
      expectedMm: number
    }

/** 読み戻した頂点群の mm 単位 bbox */
export interface StlBounds {
  min: Vec3
  max: Vec3
}

/** bbox 照合の既定許容差（mm）。float32 丸め誤差より十分大きく、印刷精度より十分小さい */
export const DEFAULT_TOLERANCE_MM = 0.01

/**
 * bbox に期待する実寸（FR-029）。`heightMm` は共通シルエット高さ = Y 範囲。
 * X / Z は形状に依存するため任意（分かっている場合のみ照合する）。
 */
export interface ExpectedDimensionsMm {
  /** Y 範囲の実寸 mm（FR-029 の唯一の物理量） */
  heightMm: number
  /** X 範囲の実寸 mm（任意） */
  widthMm?: number
  /** Z 範囲の実寸 mm（任意） */
  depthMm?: number
  /** 許容差 mm。既定 {@link DEFAULT_TOLERANCE_MM} */
  toleranceMm?: number
}

/** {@link verifyStlBytes} のレポート。`ok` は issues が空であることと同値 */
export interface StlVerificationReport {
  ok: boolean
  triangleCount: number
  /** パースできなかった場合は null */
  bounds: StlBounds | null
  issues: StlVerificationIssue[]
}

function formatVec3(v: Vec3): string {
  return `(${v[0]}, ${v[1]}, ${v[2]})`
}

/**
 * バイナリ STL のバイト列を読み戻し、冒頭に挙げた 4 性質を検証する。
 * 例外は投げず、問題を issues に列挙したレポートを返す
 * （E2E / デバッグでそのまま根拠として提示できる形にする）。
 *
 * @param bytes 書き出されたバイナリ STL
 * @param expected 指定すると bbox の寸法を FR-029 の実寸 mm と照合する
 */
export function verifyStlBytes(
  bytes: Uint8Array,
  expected?: ExpectedDimensionsMm,
): StlVerificationReport {
  let parsed: ParsedBinaryStl
  try {
    parsed = parseBinaryStl(bytes)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      triangleCount: 0,
      bounds: null,
      issues: [{ code: 'MALFORMED', message }],
    }
  }

  const issues: StlVerificationIssue[] = []
  const { triangles } = parsed

  if (triangles.length === 0) {
    issues.push({
      code: 'EMPTY',
      message:
        'the file contains no triangles — a closed solid has at least 4 faces',
    })
  }

  // ---- 1. 全頂点が有限値 / bbox の集計 ----
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  triangles.forEach((tri, t) => {
    for (const v of tri.vertices) {
      if (!v.every(Number.isFinite)) {
        issues.push({
          code: 'NON_FINITE_VERTEX',
          message: `triangle ${t} has a non-finite vertex ${formatVec3(v)}`,
          triangle: t,
        })
        continue
      }
      for (let axis = 0; axis < 3; axis++) {
        if (v[axis] < min[axis]) min[axis] = v[axis]
        if (v[axis] > max[axis]) max[axis] = v[axis]
      }
    }
  })
  const bounds: StlBounds | null =
    triangles.length > 0 && min.every(Number.isFinite) ? { min, max } : null

  // ---- 2. 全三角形の面積が正（縮退面がない） ----
  triangles.forEach((tri, t) => {
    const [a, b, c] = tri.vertices
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const abz = b[2] - a[2]
    const acx = c[0] - a[0]
    const acy = c[1] - a[1]
    const acz = c[2] - a[2]
    const cx = aby * acz - abz * acy
    const cy = abz * acx - abx * acz
    const cz = abx * acy - aby * acx
    const crossSq = cx * cx + cy * cy + cz * cz
    // NaN 頂点は検査 1 で報告済み。ここでは二重報告しない
    if (crossSq === 0) {
      issues.push({
        code: 'ZERO_AREA_TRIANGLE',
        message:
          `triangle ${t} has zero area — vertices ${formatVec3(a)}, ` +
          `${formatVec3(b)}, ${formatVec3(c)} are coincident or collinear`,
        triangle: t,
      })
    }
  })

  // ---- 3. 全無向辺がちょうど 2 回・逆向きに現れる（閉・一貫巻き） ----
  // 頂点はビット厳密一致で同一視する。float32 → 数値 → 文字列は可逆なので
  // キー衝突も取りこぼしも起きない
  const vertexIds = new Map<string, number>()
  const vertexById: Vec3[] = []
  const idOf = (v: Vec3): number => {
    const key = `${v[0]},${v[1]},${v[2]}`
    const known = vertexIds.get(key)
    if (known !== undefined) return known
    const id = vertexById.length
    vertexIds.set(key, id)
    vertexById.push(v)
    return id
  }

  /** 有向辺 `u>v` の出現回数 */
  const directedCounts = new Map<string, number>()
  for (const tri of triangles) {
    const ids = tri.vertices.map(idOf)
    for (let i = 0; i < 3; i++) {
      const u = ids[i]
      const v = ids[(i + 1) % 3]
      // 同一頂点への自己辺は面積ゼロ（検査 2）として報告済み。辺勘定からは除く
      if (u === v) continue
      const key = `${u}>${v}`
      directedCounts.set(key, (directedCounts.get(key) ?? 0) + 1)
    }
  }

  const seenUndirected = new Set<string>()
  for (const key of directedCounts.keys()) {
    const [u, v] = key.split('>').map(Number)
    const undirectedKey = u < v ? `${u}|${v}` : `${v}|${u}`
    if (seenUndirected.has(undirectedKey)) continue
    seenUndirected.add(undirectedKey)

    const forward = directedCounts.get(`${u}>${v}`) ?? 0
    const backward = directedCounts.get(`${v}>${u}`) ?? 0
    const total = forward + backward
    const edge: [Vec3, Vec3] = [vertexById[u], vertexById[v]]
    const edgeLabel = `${formatVec3(edge[0])}-${formatVec3(edge[1])}`

    if (total === 2 && forward === 1 && backward === 1) continue // 正常
    if (total === 1) {
      issues.push({
        code: 'BOUNDARY_EDGE',
        message:
          `edge ${edgeLabel} appears only once — the mesh has a hole ` +
          '(not watertight)',
        edge,
      })
    } else if (total === 2) {
      issues.push({
        code: 'INCONSISTENT_WINDING',
        message:
          `edge ${edgeLabel} appears twice in the same direction — ` +
          'adjacent triangles disagree on orientation (flipped face)',
        edge,
      })
    } else {
      issues.push({
        code: 'NON_MANIFOLD_EDGE',
        message: `edge ${edgeLabel} appears ${total} times — non-manifold edge`,
        edge,
        count: total,
      })
    }
  }

  // ---- 4. bbox が指定の実寸 mm と一致する（FR-029） ----
  if (expected !== undefined && bounds !== null) {
    const tolerance = expected.toleranceMm ?? DEFAULT_TOLERANCE_MM
    const checks: Array<{
      axis: 'x' | 'y' | 'z'
      index: number
      expectedMm: number | undefined
    }> = [
      { axis: 'x', index: 0, expectedMm: expected.widthMm },
      { axis: 'y', index: 1, expectedMm: expected.heightMm },
      { axis: 'z', index: 2, expectedMm: expected.depthMm },
    ]
    for (const { axis, index, expectedMm } of checks) {
      if (expectedMm === undefined) continue
      const actualMm = bounds.max[index] - bounds.min[index]
      if (Math.abs(actualMm - expectedMm) > tolerance) {
        issues.push({
          code: 'BBOX_MISMATCH',
          message:
            `bounding box ${axis} extent is ${actualMm}mm — ` +
            `expected ${expectedMm}mm (±${tolerance}mm)`,
          axis,
          actualMm,
          expectedMm,
        })
      }
    }
  }

  return {
    ok: issues.length === 0,
    triangleCount: parsed.triangleCount,
    bounds,
    issues,
  }
}
