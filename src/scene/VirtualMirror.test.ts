import { describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import type { Material } from 'three'
import { createStudioStore } from '../store/useStudioStore'
import {
  MIRROR_CENTER_Y,
  MIRROR_HEIGHT,
  MIRROR_OFFSET,
  createMirrorMesh,
  disposeMirrorMesh,
  selectVirtualMirrorEnabled,
} from './VirtualMirror'

/**
 * 仮想ミラーのテスト（Task 6.3 / FR-024）。
 *
 * three の `Reflector` は WebGL に触れるまで純粋な JS オブジェクトなので、
 * 生成・配置・解放は Node でそのまま検証できる。React のマウント/
 * アンマウント自体は R3F の Canvas（実 WebGL コンテキスト）が必要で Node
 * では実行できないため、ここでは**ゲートの判定**（store → mount 可否）と
 * **クリーンアップが解放する資源の完全性**（renderTarget / material /
 * geometry の dispose）を検証し、実ブラウザでの結合は E2E（Task 8.2）が
 * 担保する。コンポーネントの effect クリーンアップは
 * `disposeMirrorMesh` そのもの（VirtualMirror.tsx）であり、テストは
 * その同一関数を直接駆動する。
 */
describe('scene/VirtualMirror', () => {
  it('stands on the +X side at 45°, reflecting the viewpoint-A gaze into the B view axis', () => {
    const mirror = createMirrorMesh()
    try {
      mirror.updateMatrixWorld(true)

      // 法線 (−1, 0, 1)/√2（PlaneGeometry の +Z 法線を Y 軸まわり −45° 回転）
      const normal = new Vector3(0, 0, 1).applyQuaternion(mirror.quaternion)
      expect(normal.x).toBeCloseTo(-Math.SQRT1_2, 10)
      expect(normal.y).toBeCloseTo(0, 10)
      expect(normal.z).toBeCloseTo(Math.SQRT1_2, 10)

      // 中心が平面 {x − z = MIRROR_OFFSET} 上にある（+X 側の対角）
      expect(mirror.position.x - mirror.position.z).toBeCloseTo(MIRROR_OFFSET, 10)
      expect(mirror.position.x).toBeGreaterThan(0)

      // 視点 A のカメラ前方 (0, 0, −1) が視点 B の視線 (−1, 0, 0) に反射する:
      // v' = v − 2(v·n)n（design.md 2.1 のカメラ規約と対になる配置の核心）
      const gaze = new Vector3(0, 0, -1)
      const reflected = gaze
        .clone()
        .sub(normal.clone().multiplyScalar(2 * gaze.dot(normal)))
      expect(reflected.x).toBeCloseTo(-1, 10)
      expect(reflected.y).toBeCloseTo(0, 10)
      expect(reflected.z).toBeCloseTo(0, 10)

      // 立体（プリセットで max(x − z) ≈ 2.1）と交差しないオフセット
      expect(MIRROR_OFFSET).toBeGreaterThan(2.2)

      // B の y 範囲 [−1, 1] を覆う（鏡の中で B が上下に欠けない）
      expect(MIRROR_CENTER_Y + MIRROR_HEIGHT / 2).toBeGreaterThanOrEqual(1)
      expect(MIRROR_CENTER_Y - MIRROR_HEIGHT / 2).toBeLessThanOrEqual(-1)
    } finally {
      disposeMirrorMesh(mirror)
    }
  })

  it('enabling then disabling the mirror disposes its render target (FR-024)', () => {
    const store = createStudioStore()

    // 既定で無効（オプション初期値）→ ゲートは閉じ、Reflector は存在しない
    expect(selectVirtualMirrorEnabled(store.getState())).toBe(false)

    // 有効化 → ゲートが開き、MirrorPlane のマウントで Reflector が生成される
    store.getState().setVirtualMirror(true)
    expect(selectVirtualMirrorEnabled(store.getState())).toBe(true)
    const mirror = createMirrorMesh()
    const target = mirror.getRenderTarget()
    const targetDispose = vi.spyOn(target, 'dispose')
    const materialDispose = vi.spyOn(mirror.material as Material, 'dispose')
    const geometryDispose = vi.spyOn(mirror.geometry, 'dispose')

    // 無効化 → ゲートが閉じて MirrorPlane がアンマウントされ、effect の
    // クリーンアップ（= disposeMirrorMesh。VirtualMirror.tsx 参照）が走る
    store.getState().setVirtualMirror(false)
    expect(selectVirtualMirrorEnabled(store.getState())).toBe(false)
    disposeMirrorMesh(mirror)

    // 反射レンダーターゲットが解放される（US-004: 描画コストの完全除去）。
    // material / geometry も道連れ — Reflector.dispose() は geometry を
    // 所有しないため、disposeMirrorMesh が補完していることの検証を兼ねる
    expect(targetDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(geometryDispose).toHaveBeenCalledTimes(1)
  })

  it('re-enabling creates a fresh reflector with a fresh render target (no reuse of disposed GPU state)', () => {
    const first = createMirrorMesh()
    const firstTarget = first.getRenderTarget()
    disposeMirrorMesh(first)

    const second = createMirrorMesh()
    try {
      // 再有効化は新しいマウント → 新しい Reflector / ターゲット
      expect(second).not.toBe(first)
      expect(second.getRenderTarget()).not.toBe(firstTarget)
    } finally {
      disposeMirrorMesh(second)
    }
  })
})
