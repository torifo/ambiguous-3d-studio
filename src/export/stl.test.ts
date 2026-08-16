import { describe, expect, it, vi } from 'vitest'
import { BoxGeometry } from 'three'
import type { MeshGLLike } from '../geometry/meshgl'
import { meshGLToBufferGeometry } from '../geometry/meshgl'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'
import {
  DEFAULT_STL_FILE_NAME,
  downloadStl,
  generateStlBytes,
  multipleComponentsWarning,
} from './stl'
import { parseBinaryStl, verifyStlBytes } from './verifyStl'

/**
 * 作業座標系の閉四面体。Y 範囲がちょうど WORKING_HEIGHT (= 2) になるよう
 * meshgl.test.ts の既知四面体を 2 倍 + 平行移動したもの（正の相似変換なので
 * 外向き CCW の巻き方向は保存される）。生成パイプラインと同じ
 * `meshGLToBufferGeometry` を通して「実際に生成されるメッシュ」の形にする。
 */
function workingTetrahedron(): MeshGLLike {
  return {
    numProp: 3,
    vertProperties: new Float32Array([
      0, -1, 0, // v0
      2, -1, 0, // v1
      0, 1, 0, // v2
      0, -1, 2, // v3
    ]),
    triVerts: new Uint32Array([
      0, 2, 1, // 底面 (-z)
      0, 1, 3, // 側面 (-y)
      0, 3, 2, // 側面 (-x)
      1, 2, 3, // 斜面
    ]),
  }
}

/** 作業座標系の直方体（Y 範囲 = WORKING_HEIGHT）。原点中心・閉・一貫巻き */
function workingBox(): BoxGeometry {
  return new BoxGeometry(1.2, WORKING_HEIGHT, 0.8)
}

/** 末尾の三角形レコード 1 件を取り除き、ヘッダの三角形数も辻褄を合わせる */
function withoutLastTriangle(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice(0, bytes.byteLength - 50)
  const count = (bytes.byteLength - 84) / 50
  new DataView(out.buffer).setUint32(80, count - 1, true)
  return out
}

describe('export/stl', () => {
  describe('generateStlBytes', () => {
    it('writes 84 + 50 * n bytes with a header count matching the geometry (necessary, not sufficient)', () => {
      const bytes = generateStlBytes(workingBox(), 60)
      // BoxGeometry は 6 面 × 2 三角形 = 12
      expect(bytes.byteLength).toBe(84 + 50 * 12)
      expect(parseBinaryStl(bytes).triangleCount).toBe(12)
    })

    it('scales working coordinates to millimetres via stlMmPerUnit (heightMm = 60)', () => {
      // WORKING_HEIGHT = 2 の直方体 1.2 × 2 × 0.8 → 60mm 指定で 36 × 60 × 24 mm
      const bytes = generateStlBytes(workingBox(), 60)
      const report = verifyStlBytes(bytes, {
        heightMm: 60,
        widthMm: 36,
        depthMm: 24,
      })
      expect(report.issues).toEqual([])
      expect(report.ok).toBe(true)
      const { bounds } = report
      expect(bounds).not.toBeNull()
      expect(bounds!.max[1] - bounds!.min[1]).toBeCloseTo(60, 3)
    })

    it('a different height setting changes the written bbox accordingly (heightMm = 150)', () => {
      const bytes = generateStlBytes(workingBox(), 150)
      const report = verifyStlBytes(bytes, {
        heightMm: 150,
        widthMm: 90,
        depthMm: 60,
      })
      expect(report.issues).toEqual([])
      expect(report.ok).toBe(true)
      // 60mm 指定の bbox とはスケールが違うことも明示しておく
      const at60 = verifyStlBytes(generateStlBytes(workingBox(), 60))
      expect(report.bounds!.max[1] - report.bounds!.min[1]).toBeCloseTo(150, 3)
      expect(at60.bounds!.max[1] - at60.bounds!.min[1]).toBeCloseTo(60, 3)
    })

    it('round-trips a generated mesh through write -> parse -> verify (all four properties hold)', () => {
      // 生成パイプラインと同じ変換（meshGLToBufferGeometry）で作った閉四面体
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      const bytes = generateStlBytes(geometry, 60)
      const report = verifyStlBytes(bytes, { heightMm: 60 })
      // (a) 有限値 (b) 面積正 (c) 全無向辺が 2 回・逆向き (d) bbox 一致 —
      // どれかが破れていれば対応する issue が入り ok にならない
      expect(report.issues).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.triangleCount).toBe(4)

      // 頂点が mm 座標に載っていることを生値でも確認する（mmPerUnit = 30）
      const { triangles } = parseBinaryStl(bytes)
      const xs = triangles.flatMap((t) => t.vertices.map((v) => v[0]))
      expect(Math.max(...xs)).toBeCloseTo(60, 3) // 作業座標 2 × 30
    })

    it('the verifier rejects the same export once a triangle is removed (evidence it can fail)', () => {
      // 検証器が「通る」ことしか見ていないなら、この壊れ方も通ってしまう。
      // 閉じた出力から三角形を 1 枚抜くと、その 3 辺が対を失う
      const intact = generateStlBytes(workingBox(), 60)
      expect(verifyStlBytes(intact).ok).toBe(true)

      const broken = withoutLastTriangle(intact)
      const report = verifyStlBytes(broken)
      expect(report.ok).toBe(false)
      const boundaryEdges = report.issues.filter(
        (i) => i.code === 'BOUNDARY_EDGE',
      )
      expect(boundaryEdges).toHaveLength(3)
    })

    it('does not mutate the caller geometry (viewport keeps rendering the working coordinates)', () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      const before = Array.from(
        geometry.getAttribute('position').array as Float32Array,
      )
      generateStlBytes(geometry, 300)
      const after = Array.from(
        geometry.getAttribute('position').array as Float32Array,
      )
      expect(after).toEqual(before)
    })

    it('uses WORKING_HEIGHT as the default working height (agreement with the pipeline)', () => {
      // 既定引数と明示引数で同じバイト列になる = 既定がパイプラインの定数
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      const byDefault = generateStlBytes(geometry, 60)
      const byExplicit = generateStlBytes(geometry, 60, WORKING_HEIGHT)
      expect(Array.from(byDefault)).toEqual(Array.from(byExplicit))
    })

    it('rejects heightMm outside the FR-029 range (delegated to scale.ts)', () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      expect(() => generateStlBytes(geometry, 5)).toThrow(RangeError)
      expect(() => generateStlBytes(geometry, 301)).toThrow(
        /heightMm must be within \[10, 300\]/,
      )
    })

    it('rejects a geometry with no triangles', () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      geometry.setIndex([])
      expect(() => generateStlBytes(geometry, 60)).toThrow(
        /no triangles — nothing to export/,
      )
    })
  })

  describe('downloadStl', () => {
    it('generates bytes and hands them to the injected save seam (no DOM involved)', () => {
      const save = vi.fn()
      const confirm = vi.fn(() => true)
      const result = downloadStl(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 1,
        },
        { save, confirmMultipleComponents: confirm },
      )

      expect(result.status).toBe('saved')
      if (result.status !== 'saved') return
      expect(result.warning).toBeNull()
      expect(result.fileName).toBe(DEFAULT_STL_FILE_NAME)
      // 単一パーツでは確認ダイアログを出さない
      expect(confirm).not.toHaveBeenCalled()
      expect(save).toHaveBeenCalledTimes(1)
      const [bytes, fileName] = save.mock.calls[0]
      expect(fileName).toBe(DEFAULT_STL_FILE_NAME)
      expect(verifyStlBytes(bytes, { heightMm: 60 }).ok).toBe(true)
    })

    it('honours a custom file name', () => {
      const save = vi.fn()
      const result = downloadStl(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 1,
          fileName: 'my-solid.stl',
        },
        { save },
      )
      expect(result.status).toBe('saved')
      expect(save.mock.calls[0][1]).toBe('my-solid.stl')
    })

    it('warns before writing when componentCount > 1 and aborts on decline (US-005)', () => {
      const save = vi.fn()
      const confirm = vi.fn(() => false)
      const result = downloadStl(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 3,
        },
        { save, confirmMultipleComponents: confirm },
      )

      expect(result.status).toBe('cancelled')
      expect(result.warning).toBe(multipleComponentsWarning(3))
      expect(result.warning).toContain('3 個')
      // 中止したらダウンロードは発火しない
      expect(save).not.toHaveBeenCalled()
      expect(confirm).toHaveBeenCalledWith(multipleComponentsWarning(3), 3)
    })

    it('proceeds after confirmation but keeps the warning in the result for the UI', () => {
      const save = vi.fn()
      const confirm = vi.fn(() => true)
      const result = downloadStl(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 2,
        },
        { save, confirmMultipleComponents: confirm },
      )

      expect(result.status).toBe('saved')
      if (result.status !== 'saved') return
      expect(result.warning).toBe(multipleComponentsWarning(2))
      expect(save).toHaveBeenCalledTimes(1)
    })
  })
})
