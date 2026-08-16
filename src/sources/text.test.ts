/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { boundsOf, signedArea } from '../geometry/normalize'
import type { Contour } from '../geometry/types'
import { DEFAULT_FONT_ID } from '../ui/SilhouettePicker'
import { textToContours } from './text'

/**
 * テキスト入力のユニットテスト（Task 6.1 / FR-002 / US-002 / NFR-030）。
 *
 * Node には DOM も HTTP サーバもないため、`fetch` をスタブして同梱フォント
 * （public/fonts/Inter-Regular.otf）をファイルシステムから供給する。
 * これは text.ts の唯一の I/O シームであり、スタブの呼び出し記録が
 * 「フォントはバンドル相対 URL から 1 回だけ取得され、外部 URL には
 * 決して触れない」ことの検証（NFR-030）を兼ねる。
 */

const FONT_PATH = new URL('../../public/fonts/Inter-Regular.otf', import.meta.url)

/** fetch スタブに届いた URL の全記録（外部参照ゼロの検証に使う） */
const fetchedUrls: string[] = []

beforeAll(() => {
  const fontFile = readFileSync(FONT_PATH)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      fetchedUrls.push(url)
      if (!url.endsWith('fonts/Inter-Regular.otf')) {
        return Promise.reject(new Error(`テストが想定しない fetch: ${url}`))
      }
      // Node の Buffer ビューから独立した ArrayBuffer を切り出して返す
      const buffer = fontFile.buffer.slice(
        fontFile.byteOffset,
        fontFile.byteOffset + fontFile.byteLength,
      )
      return Promise.resolve(new Response(buffer))
    }),
  )
})

afterAll(() => {
  vi.unstubAllGlobals()
})

const holesOf = (contours: Contour[]): Contour[] => contours.filter((c) => c.isHole)
const outersOf = (contours: Contour[]): Contour[] => contours.filter((c) => !c.isHole)

/** 穴の bbox がいずれかの外輪郭の bbox に完全に含まれること（入れ子の検証） */
function expectHolesNested(contours: Contour[]): void {
  const outerBounds = outersOf(contours).map((c) => boundsOf([c]))
  for (const hole of holesOf(contours)) {
    const hb = boundsOf([hole])
    const nested = outerBounds.some(
      (ob) => hb.minX >= ob.minX && hb.maxX <= ob.maxX && hb.minY >= ob.minY && hb.maxY <= ob.maxY,
    )
    expect(nested, '穴はいずれかの外輪郭の bbox 内に入れ子でなければならない').toBe(true)
  }
}

describe('sources/text (Task 6.1)', () => {
  it.each([
    // [文字, 期待するカウンター（穴）数] — Inter Regular の実グリフ構造
    ['A', 1],
    ['B', 2],
    ['8', 2],
    ['O', 1],
    ['P', 1],
    ['R', 1],
    ['4', 1],
    ['6', 1],
    ['9', 1],
    ['0', 1],
  ])('counter of %s survives as %i isHole contour(s) (FR-002)', async (ch, holeCount) => {
    const contours = await textToContours(ch, DEFAULT_FONT_ID)
    expect(holesOf(contours)).toHaveLength(holeCount)
    expect(outersOf(contours).length).toBeGreaterThanOrEqual(1)
    expectHolesNested(contours)
  })

  it.each([['I'], ['L']])('%s has no counter — no isHole contour', async (ch) => {
    const contours = await textToContours(ch, DEFAULT_FONT_ID)
    expect(holesOf(contours)).toHaveLength(0)
    expect(outersOf(contours).length).toBeGreaterThanOrEqual(1)
  })

  it('winding follows the project convention: outer CCW (+area), hole CW (−area)', async () => {
    const contours = await textToContours('8', DEFAULT_FONT_ID)
    for (const contour of contours) {
      const area = signedArea(contour.points)
      if (contour.isHole) expect(area).toBeLessThan(0)
      else expect(area).toBeGreaterThan(0)
    }
  })

  it('output is Y-up: ascender above the baseline has positive Y', async () => {
    // opentype.js のキャンバス系（Y 下向き）では大文字はベースライン(0)より
    // **負**の Y に伸びる。Y 上向き変換後は正の Y に立ち上がるはず
    const bounds = boundsOf(await textToContours('A', DEFAULT_FONT_ID))
    expect(bounds.maxY).toBeGreaterThan(0)
    // ベースライン接地（オーバーシュートの分だけ僅かな負を許容）
    expect(bounds.minY).toBeGreaterThan(-2)
    expect(bounds.maxY).toBeGreaterThan(Math.abs(bounds.minY) * 10)
  })

  it('multi-character string: glyphs advance to the right, counters per glyph survive', async () => {
    const ab = await textToContours('AB', DEFAULT_FONT_ID)
    // A: 外 1 + 穴 1、B: 外 1 + 穴 2
    expect(ab).toHaveLength(5)
    expect(holesOf(ab)).toHaveLength(3)
    expectHolesNested(ab)
    const widthAB = boundsOf(ab)
    const widthA = boundsOf(await textToContours('A', DEFAULT_FONT_ID))
    expect(widthAB.maxX - widthAB.minX).toBeGreaterThan(widthA.maxX - widthA.minX)
  })

  it('disconnected glyph parts (dot of "i") come back as separate outers, not holes', async () => {
    const contours = await textToContours('i', DEFAULT_FONT_ID)
    expect(contours).toHaveLength(2)
    expect(holesOf(contours)).toHaveLength(0)
  })

  it('accepts the full 8-character limit', async () => {
    const contours = await textToContours('ABCDEFGH', DEFAULT_FONT_ID)
    expect(outersOf(contours).length).toBeGreaterThanOrEqual(8)
  })

  it.each([
    ['', '空文字列'],
    ['ABCDEFGHI', '9 文字'],
    ['A B', '空白入り'],
    ['あ', '非英数字'],
    ['A-1', '記号入り'],
  ])('rejects invalid input %j (%s) with a reason', async (value) => {
    await expect(textToContours(value, DEFAULT_FONT_ID)).rejects.toThrow(/英数字/)
  })

  it('rejects an unknown fontId with a reason', async () => {
    await expect(textToContours('A', 'no-such-font')).rejects.toThrow(/未知のフォント id/)
  })

  it('bundled font: fetched exactly once, only via a bundle-relative URL (NFR-030)', async () => {
    // ここまでのテストで textToContours は多数回呼ばれているが、
    // フォントの取得はキャッシュにより 1 回だけであるべき
    await textToContours('Z', DEFAULT_FONT_ID)
    expect(fetchedUrls).toHaveLength(1)
    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/^https?:/i)
      expect(url).toMatch(/fonts\/Inter-Regular\.otf$/)
    }
  })
})
