import { describe, expect, it, vi } from 'vitest'
import { BoxGeometry } from 'three'
import type { MeshGLLike } from '../geometry/meshgl'
import { meshGLToBufferGeometry } from '../geometry/meshgl'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'
import { glbUsdzMetersPerUnit, stlMmPerUnit } from '../studio/scale'
import {
  DEFAULT_GLB_FILE_NAME,
  downloadGlb,
  generateGlbBytes,
} from './glb'
import { generateStlBytes, multipleComponentsWarning } from './stl'
import { verifyStlBytes } from './verifyStl'

/**
 * GLB 出力のテスト（Task 6.4 / FR-029 / FR-031）。
 *
 * ## FileReader の最小ポリフィル
 *
 * `GLTFExporter` の GLB 組み立ては `FileReader.readAsArrayBuffer` を使うが、
 * Node には FileReader が無い（Blob はある）。ブラウザ実行では不要なので
 * glb.ts 本体には入れず、テスト側でだけ `Blob.arrayBuffer()` に委譲する
 * 最小実装を与える。exporter は `readAsArrayBuffer()` 呼び出しの**直後に**
 * 同期的に `onloadend` を代入するため、マイクロタスクで発火するこの実装で
 * 取りこぼしは起きない。
 */
class TestFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer
      this.onloadend?.()
    })
  }
}
const globalWithFileReader = globalThis as { FileReader?: unknown }
globalWithFileReader.FileReader ??= TestFileReader

// ---------------------------------------------------------------------------
// GLB コンテナの読み戻し（ヘッダ + JSON チャンク）
// ---------------------------------------------------------------------------

/** glb.test が読む範囲だけの glTF JSON 型（構造は glTF 2.0 仕様に従う） */
interface GlbJson {
  asset: { version: string }
  nodes?: { mesh?: number; scale?: number[]; matrix?: number[] }[]
  meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[]
  accessors?: { min?: number[]; max?: number[]; count: number; type: string }[]
  materials?: { pbrMetallicRoughness?: Record<string, unknown> }[]
}

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

/** GLB バイナリを読み戻し、ヘッダを検証して JSON チャンクを取り出す */
function parseGlb(bytes: Uint8Array): { json: GlbJson; hasBinChunk: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint32(0, true)).toBe(GLB_MAGIC)
  expect(view.getUint32(4, true)).toBe(2) // glTF 2.0
  expect(view.getUint32(8, true)).toBe(bytes.byteLength)

  const jsonLength = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(CHUNK_JSON)
  const jsonText = new TextDecoder().decode(
    bytes.subarray(20, 20 + jsonLength),
  )
  const json = JSON.parse(jsonText) as GlbJson

  let hasBinChunk = false
  const binOffset = 20 + jsonLength
  if (binOffset + 8 <= bytes.byteLength) {
    hasBinChunk = view.getUint32(binOffset + 4, true) === CHUNK_BIN
  }
  return { json, hasBinChunk }
}

/** POSITION アクセサの min / max（= GLB の bbox。AR ビューアが読む値そのもの） */
function glbPositionBounds(json: GlbJson): { min: number[]; max: number[] } {
  const primitive = json.meshes?.[0]?.primitives[0]
  expect(primitive).toBeDefined()
  const accessor = json.accessors?.[primitive!.attributes.POSITION]
  expect(accessor?.min).toBeDefined()
  expect(accessor?.max).toBeDefined()
  return { min: accessor!.min!, max: accessor!.max! }
}

// ---------------------------------------------------------------------------
// 入力ジオメトリ（stl.test.ts と同一 — 同じ形状で STL と GLB を突き合わせる）
// ---------------------------------------------------------------------------

/** 作業座標系の閉四面体（stl.test.ts と同じもの） */
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
      0, 2, 1,
      0, 1, 3,
      0, 3, 2,
      1, 2, 3,
    ]),
  }
}

/** 作業座標系の直方体（Y 範囲 = WORKING_HEIGHT）。原点中心・閉・一貫巻き */
function workingBox(): BoxGeometry {
  return new BoxGeometry(1.2, WORKING_HEIGHT, 0.8)
}

describe('export/glb', () => {
  describe('generateGlbBytes', () => {
    it('produces a structurally valid GLB (magic / glTF 2.0 / JSON + BIN chunks)', async () => {
      const bytes = await generateGlbBytes(workingBox(), 60)
      const { json, hasBinChunk } = parseGlb(bytes)
      expect(json.asset.version).toBe('2.0')
      expect(hasBinChunk).toBe(true)
    })

    it('GLB bbox is exactly 1/1000 of the STL bbox for the same geometry and height (FR-029)', async () => {
      // 倍率そのものの恒等式は**ビット単位で正確**：glbUsdzMetersPerUnit は
      // stlMmPerUnit × 0.001 と同一の式で定義されている（scale.ts が唯一の換算点）
      for (const heightMm of [60, 150]) {
        expect(glbUsdzMetersPerUnit(heightMm, WORKING_HEIGHT)).toBe(
          stlMmPerUnit(heightMm, WORKING_HEIGHT) * 0.001,
        )
      }

      // 書き出したバイト同士の突き合わせ。両者とも Float32 で格納されるため、
      // 軸ごとのサイズ比 ×1000 は 1 に対して相対 ~2^-23 内で一致する
      for (const heightMm of [60, 150]) {
        const stlBounds = verifyStlBytes(
          generateStlBytes(workingBox(), heightMm),
        ).bounds
        expect(stlBounds).not.toBeNull()

        const glb = parseGlb(await generateGlbBytes(workingBox(), heightMm))
        const glbBounds = glbPositionBounds(glb.json)

        for (const axis of [0, 1, 2]) {
          const stlSize = stlBounds!.max[axis] - stlBounds!.min[axis]
          const glbSize = glbBounds.max[axis] - glbBounds.min[axis]
          expect(stlSize).toBeGreaterThan(0)
          expect(Math.abs((glbSize * 1000) / stlSize - 1)).toBeLessThan(1e-6)
        }

        // スケールはアクセサへ焼き込まれている（ノード TRS に逃がしていない）。
        // ノードに scale / matrix が残っていると、アクセサの min/max（AR
        // ビューアが読むバウンディング）が作業座標のままになってしまう
        for (const node of glb.json.nodes ?? []) {
          expect(node.scale).toBeUndefined()
          expect(node.matrix).toBeUndefined()
        }
      }
    })

    it('stays desk-sized in metres — the 1000× AR accident guard (heightMm = 60 → 0.06 m)', async () => {
      const glb = parseGlb(await generateGlbBytes(workingBox(), 60))
      const { min, max } = glbPositionBounds(glb.json)
      // 高さ 60mm 指定 → Y サイズはちょうど 0.06 m。mm のまま流出していれば 60
      expect(max[1] - min[1]).toBeCloseTo(0.06, 6)
      const maxDimension = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
      expect(maxDimension).toBeLessThan(0.3)
    })

    it('embeds material information (FR-031: pbrMetallicRoughness present)', async () => {
      const glb = parseGlb(await generateGlbBytes(workingBox(), 60))
      expect(glb.json.materials?.length).toBeGreaterThanOrEqual(1)
      expect(glb.json.materials?.[0].pbrMetallicRoughness).toBeDefined()
      expect(glb.json.meshes?.[0]?.primitives[0].material).toBeDefined()
    })

    it('does not mutate the caller geometry (scale is baked into a clone only)', async () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      const before = Array.from(
        geometry.getAttribute('position').array as Float32Array,
      )
      await generateGlbBytes(geometry, 300)
      const after = Array.from(
        geometry.getAttribute('position').array as Float32Array,
      )
      expect(after).toEqual(before)
    })

    it('uses WORKING_HEIGHT as the default working height (agreement with the pipeline)', async () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      const byDefault = parseGlb(await generateGlbBytes(geometry, 60))
      const byExplicit = parseGlb(
        await generateGlbBytes(geometry, 60, WORKING_HEIGHT),
      )
      expect(glbPositionBounds(byDefault.json)).toEqual(
        glbPositionBounds(byExplicit.json),
      )
    })

    it('rejects heightMm outside the FR-029 range (delegated to scale.ts)', async () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      await expect(generateGlbBytes(geometry, 5)).rejects.toThrow(RangeError)
      await expect(generateGlbBytes(geometry, 301)).rejects.toThrow(
        /heightMm must be within \[10, 300\]/,
      )
    })

    it('rejects a geometry with no triangles', async () => {
      const geometry = meshGLToBufferGeometry(workingTetrahedron())
      geometry.setIndex([])
      await expect(generateGlbBytes(geometry, 60)).rejects.toThrow(
        /no triangles — nothing to export/,
      )
    })
  })

  describe('downloadGlb', () => {
    it('generates bytes and hands them to the injected save seam (no DOM involved)', async () => {
      const save = vi.fn()
      const confirm = vi.fn(() => true)
      const result = await downloadGlb(
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
      expect(result.fileName).toBe(DEFAULT_GLB_FILE_NAME)
      // 単一パーツでは確認ダイアログを出さない
      expect(confirm).not.toHaveBeenCalled()
      expect(save).toHaveBeenCalledTimes(1)
      const [bytes, fileName] = save.mock.calls[0] as [Uint8Array, string]
      expect(fileName).toBe(DEFAULT_GLB_FILE_NAME)
      expect(parseGlb(bytes).json.asset.version).toBe('2.0')
    })

    it('honours a custom file name', async () => {
      const save = vi.fn()
      const result = await downloadGlb(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 1,
          fileName: 'my-solid.glb',
        },
        { save },
      )
      expect(result.status).toBe('saved')
      expect(save.mock.calls[0][1]).toBe('my-solid.glb')
    })

    it('warns before writing when componentCount > 1 and aborts on decline', async () => {
      const save = vi.fn()
      const confirm = vi.fn(() => false)
      const result = await downloadGlb(
        {
          geometry: meshGLToBufferGeometry(workingTetrahedron()),
          heightMm: 60,
          componentCount: 3,
        },
        { save, confirmMultipleComponents: confirm },
      )

      expect(result.status).toBe('cancelled')
      // 警告文は stl.ts と共有（同じ事実に別の文言を作らない）
      expect(result.warning).toBe(multipleComponentsWarning(3))
      // 中止したらダウンロードは発火しない
      expect(save).not.toHaveBeenCalled()
      expect(confirm).toHaveBeenCalledWith(multipleComponentsWarning(3), 3)
    })

    it('proceeds after confirmation but keeps the warning in the result for the UI', async () => {
      const save = vi.fn()
      const confirm = vi.fn(() => true)
      const result = await downloadGlb(
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
