/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import createManifold from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import { boundsOf, normalizeSilhouette, normalizeWinding } from '../geometry/normalize'
import { presetToContours } from '../sources/presets'
import { textToContours } from '../sources/text'
import type { Contour } from '../geometry/types'
import type { CsgRequest, SerializedContour } from './protocol'
import { DEPTH_MARGIN, getLiveWasmObjectCount, performCsg } from './csg.worker'

/**
 * 文字入力 × CSG の統合テスト（Task 6.1 / FR-002）。
 *
 * csg.integration.test.ts と同じ構成で実物の manifold-3d Wasm を Node 上で
 * 初期化し、実フォント（public/fonts/Inter-Regular.otf）から抽出した文字
 * 輪郭を `performCsg` に通す。検証したいのは「カウンター（穴）が最終的な
 * 立体で**本物の貫通穴**になること」であり、見た目ではなく位相（種数）と
 * 体積恒等式で判定する：
 *
 * - 種数 g = (2 − χ) / 2, χ = V − E + F。閉じた向き付け可能 2-多様体では
 *   E = 3F/2 なので、メッシュの頂点数と三角形数だけで厳密に計算できる。
 *   貫通トンネルが 1 本あれば（連結・成分数 1 のとき）g = 1
 * - 体積恒等式: 穴 ⊂ 外輪郭なので
 *   V(文字 ∩ 円柱) = V(外輪郭のみ ∩ 円柱) − V(穴を実体化 ∩ 円柱)
 *   カウンターを潰した実装（穴が isHole で来ない・巻きが壊れている等）では
 *   左辺が外輪郭のみの体積と一致してしまい、恒等式が破れる
 *
 * どちらの証拠もメッシュが「まだ有効な 2-多様体」のまま穴だけ潰れている
 * 退行 — 下流の検証では検出できない — を捕まえる。
 */

const FONT_PATH = new URL('../../public/fonts/Inter-Regular.otf', import.meta.url)

/** 正規化の共通高さ。値は任意（比率だけが本質）— パイプラインと同じく一様スケール */
const H = 2

let wasm: ManifoldToplevel

beforeAll(async () => {
  // 同梱フォントをファイルシステムから供給する（Node に HTTP サーバはない）。
  // text.ts の I/O は fetch 1 箇所だけなので、このスタブで完全に閉じる
  const fontFile = readFileSync(FONT_PATH)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (!url.endsWith('fonts/Inter-Regular.otf')) {
        return Promise.reject(new Error(`テストが想定しない fetch: ${url}`))
      }
      const buffer = fontFile.buffer.slice(
        fontFile.byteOffset,
        fontFile.byteOffset + fontFile.byteLength,
      )
      return Promise.resolve(new Response(buffer))
    }),
  )
  // Node では locateFile 不要 — Emscripten が manifold.js の隣の .wasm を見つける
  wasm = await createManifold()
  wasm.setup()
}, 30_000)

afterAll(() => {
  vi.unstubAllGlobals()
})

/** design.md「2. 押し出し深さ」の式（csg.integration.test.ts と同一） */
function makeRequest(
  aContours: SerializedContour[],
  bContours: SerializedContour[],
  generation = 1,
): CsgRequest {
  const aBounds = boundsOf(aContours)
  const bBounds = boundsOf(bContours)
  return {
    generation,
    a: { contours: aContours, depth: (bBounds.maxX - bBounds.minX) * (1 + DEPTH_MARGIN) },
    b: { contours: bContours, depth: (aBounds.maxX - aBounds.minX) * (1 + DEPTH_MARGIN) },
    baseplate: null,
  }
}

/**
 * 閉じた向き付け可能 2-多様体の種数（csg.integration.test.ts と同一の導出）。
 * 前提（成分数 1・2-多様体）はテスト側で componentCount と ok で確認する。
 */
function genusOf(positions: Float32Array, indices: Uint32Array): number {
  const v = positions.length / 3
  const f = indices.length / 3
  const chi = v - f / 2
  return (2 - chi) / 2
}

/** 文字を取り出して共通高さへ正規化する（パイプラインの normalize 相当） */
async function letterContours(letter: string): Promise<Contour[]> {
  const raw = await textToContours(letter, 'default')
  return normalizeSilhouette(raw, H).contours
}

/** B 側の円柱（プリセットの円）。文字と同じ高さへ正規化する */
function circleContours(): Contour[] {
  return normalizeSilhouette(presetToContours('circle'), H).contours
}

describe('worker/text integration — counters become genuine through-holes', () => {
  it('letter A × circle → 1 component of genus 1 (the counter is a tunnel)', async () => {
    const a = await letterContours('A')
    expect(a.some((c) => c.isHole)).toBe(true)

    const response = performCsg(wasm, makeRequest(a, circleContours()))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    // performCsg は status() === 'NoError' のときだけ ok: true を返す（2-多様体保証）
    expect(response.componentCount).toBe(1)
    // 貫通トンネルがちょうど 1 本。カウンターが潰れていれば 0 になる
    expect(genusOf(response.positions, response.indices)).toBe(1)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('volume identity: V(A ∩ cyl) = V(outer-only ∩ cyl) − V(counter-as-solid ∩ cyl)', async () => {
    const a = await letterContours('A')
    const cylinder = circleContours()

    // 同一の正規化済み輪郭から派生させる（スケールを共有しないと体積が比べられない）
    const outerOnly = a.filter((c) => !c.isHole)
    // 穴を「実体」として単独で押し出すため、isHole を外して巻きを外輪郭向きに直す
    const counterAsSolid = normalizeWinding(
      a.filter((c) => c.isHole).map((c) => ({ points: c.points, isHole: false })),
    )
    expect(counterAsSolid.length).toBeGreaterThan(0)

    const whole = performCsg(wasm, makeRequest(a, cylinder))
    const outer = performCsg(wasm, makeRequest(outerOnly, cylinder))
    const counter = performCsg(wasm, makeRequest(counterAsSolid, cylinder))
    expect(whole.ok).toBe(true)
    expect(outer.ok).toBe(true)
    expect(counter.ok).toBe(true)
    if (!whole.ok || !outer.ok || !counter.ok) return

    // カウンターは実際に材料を取り除いている
    expect(counter.volume).toBeGreaterThan(0)
    expect(whole.volume).toBeLessThan(outer.volume)
    // 恒等式（同一テッセレーションの厳密ブール演算なので高精度で成立する）
    const expected = outer.volume - counter.volume
    expect(Math.abs(whole.volume - expected) / expected).toBeLessThan(1e-3)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('letter without a counter (L) × circle → genus 0 (no phantom tunnels)', async () => {
    const l = await letterContours('L')
    expect(l.some((c) => c.isHole)).toBe(false)

    const response = performCsg(wasm, makeRequest(l, circleContours()))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.componentCount).toBe(1)
    expect(genusOf(response.positions, response.indices)).toBe(0)
    expect(getLiveWasmObjectCount()).toBe(0)
  })

  it('letter with two counters (8) × circle → genus 2', async () => {
    const eight = await letterContours('8')
    expect(eight.filter((c) => c.isHole)).toHaveLength(2)

    const response = performCsg(wasm, makeRequest(eight, circleContours()))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.componentCount).toBe(1)
    expect(genusOf(response.positions, response.indices)).toBe(2)
    expect(getLiveWasmObjectCount()).toBe(0)
  })
})
