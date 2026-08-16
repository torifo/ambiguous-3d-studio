import { describe, expect, it } from 'vitest'
import type { MeshGLLike } from './meshgl'
import {
  bufferGeometryToMeshGL,
  meshGLToBufferGeometry,
  validateMeshGL,
} from './meshgl'

/**
 * 既知の四面体。頂点 (0,0,0) (1,0,0) (0,1,0) (0,0,1)、
 * 4 面すべて外向き CCW（Manifold の出力と同じ向き規約）。
 */
function tetrahedron(): MeshGLLike {
  return {
    numProp: 3,
    vertProperties: new Float32Array([
      0, 0, 0, // v0
      1, 0, 0, // v1
      0, 1, 0, // v2
      0, 0, 1, // v3
    ]),
    triVerts: new Uint32Array([
      0, 2, 1, // 底面 (-z)
      0, 1, 3, // 側面 (-y)
      0, 3, 2, // 側面 (-x)
      1, 2, 3, // 斜面 (+x+y+z)
    ]),
  }
}

describe('geometry/meshgl', () => {
  describe('meshGLToBufferGeometry', () => {
    it('converts a tetrahedron with expected vertex/index counts', () => {
      const geom = meshGLToBufferGeometry(tetrahedron())

      const position = geom.getAttribute('position')
      expect(position.count).toBe(4)
      expect(position.itemSize).toBe(3)

      const index = geom.getIndex()
      expect(index).not.toBeNull()
      expect(index!.count).toBe(12)
      for (let i = 0; i < index!.count; i++) {
        const v = index!.getX(i)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(4)
      }
    })

    it('computes non-zero vertex normals (source normals are not carried over)', () => {
      const geom = meshGLToBufferGeometry(tetrahedron())
      const normal = geom.getAttribute('normal')
      expect(normal).toBeDefined()
      expect(normal.count).toBe(4)
      for (let i = 0; i < normal.count; i++) {
        const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))
        // computeVertexNormals は正規化するので、退化していなければ長さ ≈ 1
        expect(len).toBeGreaterThan(0.99)
        expect(len).toBeLessThan(1.01)
      }
    })

    it('copies the input arrays instead of aliasing them (Wasm heap safety)', () => {
      const mesh = tetrahedron()
      const geom = meshGLToBufferGeometry(mesh)
      mesh.vertProperties[0] = 999
      mesh.triVerts[0] = 999
      expect(geom.getAttribute('position').getX(0)).toBe(0)
      expect(geom.getIndex()!.getX(0)).toBe(0)
    })

    it('rejects numProp other than 3', () => {
      const mesh = { ...tetrahedron(), numProp: 6 }
      expect(() => meshGLToBufferGeometry(mesh)).toThrow(
        /numProp is 6.*positions-only/,
      )
    })
  })

  describe('bufferGeometryToMeshGL', () => {
    it('round-trips BufferGeometry -> MeshGL -> BufferGeometry preserving positions and indices', () => {
      const original = tetrahedron()
      const geom = meshGLToBufferGeometry(original)
      const back = bufferGeometryToMeshGL(geom)

      expect(back.numProp).toBe(3)
      expect(Array.from(back.vertProperties)).toEqual(
        Array.from(original.vertProperties),
      )
      expect(Array.from(back.triVerts)).toEqual(Array.from(original.triVerts))

      // もう一往復しても同じ
      const geom2 = meshGLToBufferGeometry(back)
      expect(Array.from(bufferGeometryToMeshGL(geom2).vertProperties)).toEqual(
        Array.from(original.vertProperties),
      )
    })

    it('rejects non-indexed geometry', () => {
      const geom = meshGLToBufferGeometry(tetrahedron())
      geom.setIndex(null)
      expect(() => bufferGeometryToMeshGL(geom)).toThrow(
        /no index.*indexed geometry is required/,
      )
    })
  })

  describe('validateMeshGL', () => {
    it('accepts a valid tetrahedron', () => {
      expect(() => validateMeshGL(tetrahedron())).not.toThrow()
    })

    it('catches an out-of-range index', () => {
      const mesh = tetrahedron()
      mesh.triVerts[5] = 4 // 頂点は 0..3 のみ
      expect(() => validateMeshGL(mesh)).toThrow(
        /triVerts\[5\] = 4 is out of range.*only 4 vertices/,
      )
    })

    it('catches a NaN coordinate', () => {
      const mesh = tetrahedron()
      mesh.vertProperties[7] = NaN
      expect(() => validateMeshGL(mesh)).toThrow(
        /vertProperties\[7\] is non-finite/,
      )
    })

    it('catches a triVerts length not divisible by 3', () => {
      const mesh = tetrahedron()
      mesh.triVerts = mesh.triVerts.slice(0, 11) // 12 -> 11
      expect(() => validateMeshGL(mesh)).toThrow(
        /triVerts\.length \(11\) is not a multiple of 3/,
      )
    })

    it('catches a vertProperties length not a multiple of numProp', () => {
      const mesh = tetrahedron()
      mesh.vertProperties = mesh.vertProperties.slice(0, 11) // 12 -> 11
      expect(() => validateMeshGL(mesh)).toThrow(
        /vertProperties\.length \(11\) is not a multiple of numProp/,
      )
    })

    it('catches a degenerate triangle with a repeated vertex', () => {
      const mesh = tetrahedron()
      mesh.triVerts = new Uint32Array([0, 0, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
      expect(() => validateMeshGL(mesh)).toThrow(/triangle 0.*zero area/)
    })

    it('catches a zero-area triangle from collinear vertices', () => {
      const mesh: MeshGLLike = {
        numProp: 3,
        vertProperties: new Float32Array([
          0, 0, 0,
          1, 0, 0,
          2, 0, 0, // v0-v1-v2 は一直線
          0, 0, 1,
        ]),
        triVerts: new Uint32Array([0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
      }
      expect(() => validateMeshGL(mesh)).toThrow(/triangle 0.*zero area/)
    })

    it('rejects numProp other than 3', () => {
      const mesh = { ...tetrahedron(), numProp: 7 }
      expect(() => validateMeshGL(mesh)).toThrow(/numProp is 7.*positions-only/)
    })
  })
})
