import { BufferAttribute, BufferGeometry } from 'three'

/**
 * Manifold のメッシュ交換フォーマット（`getMesh()` が返す構造）の最小サブセット。
 * CSG 用途では位置のみを扱う（`numProp = 3`。design.md「5. MeshGL ⇄ BufferGeometry」）。
 * UV や法線を載せるとシーム頂点の分裂を `mergeFromVert` / `mergeToVert` で
 * 明示する必要が生じ、間違えると非マニホールド扱いになるため持ち込まない。
 */
export interface MeshGLLike {
  /** 頂点 1 個あたりのプロパティ数。本モジュールは 3（x, y, z のみ）だけを受理する */
  numProp: number
  /** [x0, y0, z0, x1, y1, z1, ...] のフラット配列 */
  vertProperties: Float32Array
  /** 三角形ごとの頂点インデックス 3 つ組 [a0, b0, c0, a1, b1, c1, ...] */
  triVerts: Uint32Array
}

/** `numProp !== 3` を弾く共通ガード。ストライドを誤ったまま処理するより明示的に失敗させる */
function assertNumProp3(fn: string, numProp: number): void {
  if (numProp !== 3) {
    throw new Error(
      `${fn}: numProp is ${numProp} — this module handles positions-only ` +
        'meshes (numProp = 3). Strip extra properties before converting',
    )
  }
}

/**
 * MeshGL の整合性検証。Manifold や three が黙って壊れた結果を返す前に、
 * この境界で具体的なメッセージ付きで弾く：
 *
 * - `numProp` が 3 であること（位置のみ）
 * - `vertProperties.length` が `numProp` の倍数であること
 * - `triVerts.length` が 3 の倍数であること
 * - 全インデックスが頂点数の範囲内であること
 * - 全座標が有限値であること（NaN / Infinity を含まない）
 * - 面積ゼロの三角形（重複頂点・共線）が存在しないこと
 *
 * @throws Error 上記のいずれかに違反した場合
 */
export function validateMeshGL(mesh: MeshGLLike): void {
  assertNumProp3('validateMeshGL', mesh.numProp)

  if (mesh.vertProperties.length % mesh.numProp !== 0) {
    throw new Error(
      `validateMeshGL: vertProperties.length (${mesh.vertProperties.length}) ` +
        `is not a multiple of numProp (${mesh.numProp})`,
    )
  }
  if (mesh.triVerts.length % 3 !== 0) {
    throw new Error(
      `validateMeshGL: triVerts.length (${mesh.triVerts.length}) is not a multiple of 3`,
    )
  }

  const verts = mesh.vertProperties
  for (let i = 0; i < verts.length; i++) {
    if (!Number.isFinite(verts[i])) {
      throw new Error(
        `validateMeshGL: vertProperties[${i}] is non-finite (${verts[i]}) — ` +
          `vertex ${Math.floor(i / mesh.numProp)}`,
      )
    }
  }

  const numVert = verts.length / mesh.numProp
  const tris = mesh.triVerts
  for (let i = 0; i < tris.length; i++) {
    if (tris[i] >= numVert) {
      throw new Error(
        `validateMeshGL: triVerts[${i}] = ${tris[i]} is out of range — ` +
          `mesh has only ${numVert} vertices`,
      )
    }
  }

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3
    const b = tris[t + 1] * 3
    const c = tris[t + 2] * 3
    // 面積 = |(B-A) × (C-A)| / 2。外積の各成分がすべて 0 なら退化三角形
    const abx = verts[b] - verts[a]
    const aby = verts[b + 1] - verts[a + 1]
    const abz = verts[b + 2] - verts[a + 2]
    const acx = verts[c] - verts[a]
    const acy = verts[c + 1] - verts[a + 1]
    const acz = verts[c + 2] - verts[a + 2]
    const cx = aby * acz - abz * acy
    const cy = abz * acx - abx * acz
    const cz = abx * acy - aby * acx
    if (cx * cx + cy * cy + cz * cz === 0) {
      throw new Error(
        `validateMeshGL: triangle ${t / 3} (indices ${tris[t]}, ${tris[t + 1]}, ` +
          `${tris[t + 2]}) has zero area — degenerate triangle`,
      )
    }
  }
}

/**
 * MeshGL → `THREE.BufferGeometry`。
 * 入力配列は Wasm 管理メモリを指しうるため、**新規 typed array にコピー**して保持する。
 * 法線は `computeVertexNormals()` で再計算する — ブーリアン演算は元の側面/キャップ法線を
 * 無効化するので、ソース側の法線は引き継がない（design.md「5. MeshGL ⇄ BufferGeometry」）。
 *
 * @throws Error `numProp !== 3` の場合
 */
export function meshGLToBufferGeometry(mesh: MeshGLLike): BufferGeometry {
  assertNumProp3('meshGLToBufferGeometry', mesh.numProp)

  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(mesh.vertProperties), 3),
  )
  geometry.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * `THREE.BufferGeometry` → MeshGL（逆変換）。インデックス付きジオメトリのみ受け付ける。
 * 位置属性は `getX/getY/getZ` 経由で読むため、インターリーブ属性でも正しく変換できる。
 *
 * @throws Error インデックスが無い場合、position 属性が無い場合、itemSize が 3 でない場合
 */
export function bufferGeometryToMeshGL(geometry: BufferGeometry): MeshGLLike {
  const index = geometry.getIndex()
  if (index === null) {
    throw new Error(
      'bufferGeometryToMeshGL: geometry has no index — an indexed geometry is required',
    )
  }
  const position = geometry.getAttribute('position')
  if (position === undefined) {
    throw new Error('bufferGeometryToMeshGL: geometry has no position attribute')
  }
  if (position.itemSize !== 3) {
    throw new Error(
      `bufferGeometryToMeshGL: position attribute has itemSize ${position.itemSize} — expected 3`,
    )
  }

  const vertProperties = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    vertProperties[i * 3] = position.getX(i)
    vertProperties[i * 3 + 1] = position.getY(i)
    vertProperties[i * 3 + 2] = position.getZ(i)
  }

  return {
    numProp: 3,
    vertProperties,
    triVerts: new Uint32Array(index.array),
  }
}
