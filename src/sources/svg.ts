import type { Contour } from '../geometry/types'
import { flipY } from '../geometry/normalize'

/**
 * SVG インポート（Task 6.2 / FR-003 / FR-005 / US-002 / NFR-030）。
 *
 * SVG 文字列を **FR-005 のサポート部分集合に限定して** `Contour[]` に変換する。
 *
 * ## セキュリティ設計 — 「取得しない」はコードの不在で保証する
 *
 * NFR-030（外部送信ゼロ）に対する最大の脅威は、パーサ自身が発行するリクエスト
 * ではなく、**参照を解決してしまう実行環境に SVG マークアップを渡すこと**にある。
 * `DOMParser` で live な document に紐付ける・`innerHTML` に流す・`<img>` の
 * src にする — どれも `<image href="https://…">` や外部 CSS / フォント参照を
 * ブラウザが**勝手に**取りに行き、こちらのコードが 1 行もリクエストを書かずに
 * NFR-030 が破れる。
 *
 * 本実装は **DOM を一切使わない自前の文字列トークナイザ**で SVG を読む。
 * このモジュールには fetch / XHR / DOM API の呼び出しが存在せず、パース結果を
 * document に挿入することもない。外部参照（`<image>` `<use>` `<script>`
 * 外部 CSS / 外部フォント）は「無効化する」のではなく、**解決する仕組みが
 * そもそも存在しない**。ついでに Node（Vitest）でもブラウザと同一コードが
 * そのまま動くため、テストに DOM の差し替えシームも不要になる。
 *
 * ## 変換パイプライン
 *
 * 1. XML トークナイズ（純文字列処理・エンティティは組み込み 5 種＋数値参照のみ。
 *    DTD で定義されたカスタムエンティティは**展開しない**）
 * 2. `<style>` から fill / fill-rule の最小 CSS を収集（外部 `@import` は取得せず破棄）
 * 3. ツリー走査：transform（matrix / translate / scale / rotate）を合成しながら
 *    `<path>` `<polygon>` `<rect>` `<circle>` `<ellipse>` の**閉じた**形状を採取。
 *    `fill="none"`・ストロークのみ・開いたサブパスは面を持たないため破棄
 * 4. 要素ごとに `fill-rule`（nonzero / evenodd）で外輪郭と穴を分類
 *    （複合サブパス = 1 つの `d` に複数の `M` は、ここで入れ子として解釈される）
 * 5. 頂点数が上限（{@link MAX_SVG_VERTICES}）を超えたら許容誤差付きで単純化し、
 *    {@link getLastSvgImportReport} に前後の頂点数を記録（UI の `SIMPLIFIED` 警告の元）
 * 6. **Y 下向き → Y 上向き変換**（`flipY`）。Y 反転は全輪郭の符号付き面積の符号を
 *    裏返すため、巻き方向の再判定は反転の後でなければならない（FR-003）。
 *    `flipY` は反転直後の `normalizeWinding` を内包しているので、この順序は
 *    実装上壊せない
 *
 * 閉じた塗り対象パスが 1 つもない SVG は理由付きで reject する（US-002）。
 *
 * ## このモジュールが持つ共有ユーティリティ
 *
 * ベジェのフラット化（{@link flattenQuadraticInto} / {@link flattenCubicInto}）と
 * 輪郭の穴分類（{@link classifyRings}）は sources/text.ts（Task 6.1）と共通の
 * 幾何処理なのでここから export する。Task 6.1/6.2 の所有ファイル外に共有
 * モジュールを新設しないための配置であり、依存方向は text → svg の一方向のみ。
 */

// ---------------------------------------------------------------------------
// 公開定数・レポート
// ---------------------------------------------------------------------------

/** SVG 由来シルエットの頂点数上限（FR-005 / US-002）。超過分は単純化する */
export const MAX_SVG_VERTICES = 10_000

/**
 * 直近の {@link svgToContours} 呼び出しの付帯情報。
 *
 * スタブ契約のシグネチャ（`Promise<Contour[]>`）には警告チャンネルがないため、
 * 「単純化した旨の表示」（US-002）と「適用しない旨の警告」（FR-005）は
 * このサイドチャネルで公開する。パース本体は完全に同期なので、
 * `await svgToContours(...)` の直後に読めば必ずその呼び出しのレポートが得られる。
 */
export interface SvgImportReport {
  /**
   * 頂点数上限（{@link MAX_SVG_VERTICES}）超過による単純化の前後の総頂点数。
   * 単純化しなかった場合は null。UI はこれを
   * `PreflightWarning { code: 'SIMPLIFIED', before, after }` として提示する。
   */
  simplified: { before: number; after: number } | null
  /**
   * 取得せずに破棄した外部参照・適用しなかった機能の説明（日本語・UI 表示用）。
   * 例: `<image>`・外部 `<use>`・`<script>`・`@import`・`clipPath`。
   */
  ignored: string[]
}

let lastReport: SvgImportReport | null = null

/** 直近の {@link svgToContours} 呼び出しのレポート（呼び出し前は null） */
export function getLastSvgImportReport(): SvgImportReport | null {
  return lastReport
}

// ---------------------------------------------------------------------------
// 共有ジオメトリ 1: ベジェ曲線のフラット化（text.ts と共用）
// ---------------------------------------------------------------------------

/** 再帰分割の深さ上限。tolerance が極端に小さくても停止を保証する */
const MAX_SUBDIVISION_DEPTH = 18

/** 点 (px, py) と線分 (ax, ay)–(bx, by) の距離（端点縮退時は点距離） */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * 2 次ベジェを許容誤差 `tolerance` でフラット化し、**終点を含む**折れ線頂点を
 * `out` に push する（始点は呼び出し側が既に持っている前提）。
 * 制御点の弦からの距離が許容内なら弦 1 本で代用し、超えるなら de Casteljau で
 * 半分割する。誤差は制御多角形からの上界なので許容誤差を超えない。
 */
export function flattenQuadraticInto(
  out: number[],
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tolerance: number,
  depth = 0,
): void {
  // 2 次ベジェの弦からの最大距離は制御点の弦距離の 1/2 以下
  if (depth >= MAX_SUBDIVISION_DEPTH || distanceToSegment(cx, cy, x0, y0, x1, y1) / 2 <= tolerance) {
    out.push(x1, y1)
    return
  }
  const ax = (x0 + cx) / 2
  const ay = (y0 + cy) / 2
  const bx = (cx + x1) / 2
  const by = (cy + y1) / 2
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  flattenQuadraticInto(out, x0, y0, ax, ay, mx, my, tolerance, depth + 1)
  flattenQuadraticInto(out, mx, my, bx, by, x1, y1, tolerance, depth + 1)
}

/**
 * 3 次ベジェを許容誤差 `tolerance` でフラット化し、**終点を含む**折れ線頂点を
 * `out` に push する（始点は含めない）。判定は両制御点の弦からの距離。
 */
export function flattenCubicInto(
  out: number[],
  x0: number,
  y0: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x1: number,
  y1: number,
  tolerance: number,
  depth = 0,
): void {
  const d1 = distanceToSegment(c1x, c1y, x0, y0, x1, y1)
  const d2 = distanceToSegment(c2x, c2y, x0, y0, x1, y1)
  // 3 次ベジェの弦からの最大距離は制御点の弦距離の 3/4 以下
  if (depth >= MAX_SUBDIVISION_DEPTH || (Math.max(d1, d2) * 3) / 4 <= tolerance) {
    out.push(x1, y1)
    return
  }
  const p01x = (x0 + c1x) / 2
  const p01y = (y0 + c1y) / 2
  const p12x = (c1x + c2x) / 2
  const p12y = (c1y + c2y) / 2
  const p23x = (c2x + x1) / 2
  const p23y = (c2y + y1) / 2
  const p012x = (p01x + p12x) / 2
  const p012y = (p01y + p12y) / 2
  const p123x = (p12x + p23x) / 2
  const p123y = (p12y + p23y) / 2
  const mx = (p012x + p123x) / 2
  const my = (p012y + p123y) / 2
  flattenCubicInto(out, x0, y0, p01x, p01y, p012x, p012y, mx, my, tolerance, depth + 1)
  flattenCubicInto(out, mx, my, p123x, p123y, p23x, p23y, x1, y1, tolerance, depth + 1)
}

// ---------------------------------------------------------------------------
// 共有ジオメトリ 2: fill-rule による外輪郭 / 穴の分類（text.ts と共用）
// ---------------------------------------------------------------------------

/** FR-005 がサポートする fill-rule（CSS / presentation attribute の両方から来る） */
export type FillRule = 'nonzero' | 'evenodd'

/**
 * 縮退リングの棄却しきい値（bbox 面積に対する相対値・無次元）。
 * normalize.ts の `REL_AREA_EPS`（1e-10）より 1 桁厳しくしてあるので、
 * ここを通ったリングが後段の `flipY` → `normalizeWinding` で例外になることはない。
 */
const DEGENERATE_REL_AREA = 1e-9

/** 連続する重複頂点と「終点 = 始点」の明示閉路を除去する（暗黙閉路規約へ揃える） */
function cleanRing(pts: readonly number[]): Float64Array | null {
  const out: number[] = []
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]
    const y = pts[i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const n = out.length
    if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue
    out.push(x, y)
  }
  // 終点が始点の繰り返しなら落とす（toPolygons / presets と同じ暗黙閉路）
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) {
    out.length -= 2
  }
  if (out.length < 6) return null
  return new Float64Array(out)
}

/**
 * 巻き判定用の頑健な符号付き面積測定（normalize.ts の `windingMeasure` と同じ
 * 考え方）。bbox 中心へ平行移動し長辺で割った単位座標で計算するため、
 * 入力のスケール・位置に依らず桁落ちしない。
 *
 * @returns unitArea 単位 bbox 座標での符号付き面積（符号 = 巻き方向）
 * @returns relArea  bbox 面積に対する |面積| 比（縮退判定用）
 */
function ringMeasure(pts: Float64Array): { unitArea: number; relArea: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i]
    if (pts[i] > maxX) maxX = pts[i]
    if (pts[i + 1] < minY) minY = pts[i + 1]
    if (pts[i + 1] > maxY) maxY = pts[i + 1]
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0) || !(h > 0)) return { unitArea: 0, relArea: 0 }
  const ext = Math.max(w, h)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const n = pts.length / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const xi = (pts[2 * i] - cx) / ext
    const yi = (pts[2 * i + 1] - cy) / ext
    const xj = (pts[2 * j] - cx) / ext
    const yj = (pts[2 * j + 1] - cy) / ext
    sum += xi * yj - xj * yi
  }
  const unitArea = sum / 2
  return { unitArea, relArea: Math.abs(unitArea) / ((w / ext) * (h / ext)) }
}

/** 水平走査線とリングの交差 1 件。`dir` は Y 増加方向へ跨いだら +1、逆なら −1 */
interface ScanlineCrossing {
  x: number
  dir: 1 | -1
}

/** リングと水平線 y = level の交差点（半開区間規則で頂点の二重カウントを防ぐ） */
function crossingsAt(pts: Float64Array, level: number, out: ScanlineCrossing[]): void {
  const n = pts.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const y0 = pts[2 * i + 1]
    const y1 = pts[2 * j + 1]
    if (y0 <= level && y1 > level) {
      out.push({ x: pts[2 * i] + ((level - y0) * (pts[2 * j] - pts[2 * i])) / (y1 - y0), dir: 1 })
    } else if (y1 <= level && y0 > level) {
      out.push({ x: pts[2 * i] + ((level - y0) * (pts[2 * j] - pts[2 * i])) / (y1 - y0), dir: -1 })
    }
  }
}

/** 点 (x, level) の巻き数：+X 方向レイを横切る交差の方向和 */
function windingRightOf(crossings: readonly ScanlineCrossing[], x: number): number {
  let wn = 0
  for (const c of crossings) {
    if (c.x > x) wn += c.dir
  }
  return wn
}

/** 点 (x, level) のレイキャスト交差数（evenodd の塗り判定に使う） */
function countRightOf(crossings: readonly ScanlineCrossing[], x: number): number {
  let count = 0
  for (const c of crossings) {
    if (c.x > x) count++
  }
  return count
}

/**
 * リング集合を fill-rule で解釈し、外輪郭 / 穴（`isHole`）へ分類する。
 *
 * 判定原理：各リング R について、R の bbox 中央高さ付近の水平走査線上で
 * **R 自身の最左交差点の内側と外側に隣接するサンプル点**を取り、全リングの
 * 交差配置（arrangement）に対する塗り状態を fill-rule で評価する。
 *
 * - サンプル点は「R の交差点と、配置全体で次/前の交差点との中点」なので、
 *   間に他のリングが挟まらない = R の境界の直傍の塗り状態が得られる。
 *   （リング内部の任意点だと、入れ子の穴を跨いで巻き数が変わり誤判定する）
 * - **evenodd**: レイキャスト交差数の偶奇。境界を跨げば必ず反転するので
 *   全リングが塗りの境界になり、内側が塗りなら外輪郭・外側が塗りなら穴
 * - **nonzero**: 交差方向の総和（巻き数）。リングの巻き方向は交差の
 *   方向（`dir`）として自然に効く。内外の塗りが変わらないリング
 *   （例: 同方向の入れ子の内側）は境界にならないので**破棄**する
 *
 * 走査線が頂点や水平エッジをかすめて配置が縮退する場合に備え、走査線の
 * 高さを無理数的な比率で数回ずらして再試行する。
 *
 * 座標系に依存しない（Y 下向きの SVG 座標でも Y 上向きのフォント座標でも、
 * 同一座標系内で一貫していれば正しく分類できる）。縮退リング
 * （3 頂点未満・bbox 比でほぼ面積ゼロ）はここで棄却するため、戻り値は常に
 * normalize.ts の検証（`flipY` / `normalizeWinding`）を例外なしで通過する。
 *
 * 頂点順（CCW / CW への正規化）はここでは行わない — `Contour.isHole` を
 * 真実の情報源として、後段の `normalizeWinding` が揃える。
 *
 * sources/text.ts（Task 6.1）と共用（ファイル冒頭の doc 参照）。
 */
export function classifyRings(rings: readonly (readonly number[])[], fillRule: FillRule): Contour[] {
  const cleaned: Float64Array[] = []
  for (const raw of rings) {
    const pts = cleanRing(raw)
    if (pts === null) continue
    const { relArea } = ringMeasure(pts)
    if (!(relArea > DEGENERATE_REL_AREA)) continue
    cleaned.push(pts)
  }

  const fractions = [0.5, 0.487, 0.529, 0.451, 0.573, 0.397, 0.631, 0.347, 0.683, 0.293]
  const out: Contour[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const pts = cleaned[i]
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let k = 0; k < pts.length; k += 2) {
      if (pts[k] < minX) minX = pts[k]
      if (pts[k] > maxX) maxX = pts[k]
      if (pts[k + 1] < minY) minY = pts[k + 1]
      if (pts[k + 1] > maxY) maxY = pts[k + 1]
    }
    const tinyGap = Math.max(maxX - minX, 1) * 1e-12

    let classified = false
    for (const f of fractions) {
      const level = minY + (maxY - minY) * f
      const own: ScanlineCrossing[] = []
      crossingsAt(pts, level, own)
      if (own.length < 2 || own.length % 2 !== 0) continue
      const all: ScanlineCrossing[] = []
      for (const ring of cleaned) crossingsAt(ring, level, all)

      // R 自身の最左交差点の左右直傍にサンプル点を置く
      let ownLeft = Infinity
      for (const c of own) {
        if (c.x < ownLeft) ownLeft = c.x
      }
      let next = Infinity
      let prev = -Infinity
      for (const c of all) {
        if (c.x > ownLeft && c.x < next) next = c.x
        if (c.x < ownLeft && c.x > prev) prev = c.x
      }
      if (next === Infinity || next - ownLeft <= tinyGap) continue // 接触・縮退 → 再試行
      if (prev !== -Infinity && ownLeft - prev <= tinyGap) continue
      const sampleIn = (ownLeft + next) / 2
      const sampleOut = prev === -Infinity ? ownLeft - Math.max(maxX - minX, 1) : (prev + ownLeft) / 2

      let filledInside: boolean
      let filledOutside: boolean
      if (fillRule === 'evenodd') {
        filledInside = countRightOf(all, sampleIn) % 2 === 1
        filledOutside = countRightOf(all, sampleOut) % 2 === 1
        // 単純リングの境界では偶奇は必ず反転する。しなければ走査線が縮退している
        if (filledInside === filledOutside) continue
      } else {
        filledInside = windingRightOf(all, sampleIn) !== 0
        filledOutside = windingRightOf(all, sampleOut) !== 0
      }
      if (filledInside !== filledOutside) {
        out.push({ points: pts, isHole: !filledInside })
      }
      // nonzero で内外の塗りが同じリングは境界にならない → 破棄（push しない）
      classified = true
      break
    }
    // 全走査線が縮退した場合は保守側（外輪郭扱い）に倒す。relArea を通った
    // リングでここへ来ることは実質なく、例外で入力全体を殺すよりも安全
    if (!classified) out.push({ points: pts, isHole: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// XML ミニパーサ（DOM 不使用 — ファイル冒頭のセキュリティ設計を参照）
// ---------------------------------------------------------------------------

interface XmlNode {
  /** 名前空間接頭辞を除いたローカル名（`svg:path` → `path`） */
  tag: string
  /** 属性。キーはローカル名（`xlink:href` → `href`）。`xmlns*` はそのまま */
  attrs: Map<string, string>
  children: XmlNode[]
  /** 直下のテキスト（CDATA 含む）。`<style>` の中身の取得に使う */
  text: string
}

/** 組み込みエンティティと数値文字参照のみ展開する。未知の実体参照は**展開しない** */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
    }
    const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole
  })
}

function localName(name: string): string {
  if (name.startsWith('xmlns')) return name
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

const WHITESPACE = /\s/

class XmlParser {
  private pos = 0

  constructor(private readonly src: string) {}

  parseDocument(): XmlNode {
    if (this.src.charCodeAt(0) === 0xfeff) this.pos = 1 // BOM
    let root: XmlNode | null = null
    while (this.pos < this.src.length) {
      this.skipWhitespace()
      if (this.pos >= this.src.length) break
      if (this.lookingAt('<?')) {
        this.skipUntil('?>')
      } else if (this.lookingAt('<!--')) {
        this.skipUntil('-->')
      } else if (this.lookingAt('<!DOCTYPE') || this.lookingAt('<!doctype')) {
        this.skipDoctype()
      } else if (this.src[this.pos] === '<') {
        if (root !== null) throw new Error('ルート要素が複数あります')
        root = this.parseElement()
      } else {
        throw new Error('ルート要素の外にテキストがあります')
      }
    }
    if (root === null) throw new Error('要素が見つかりません')
    return root
  }

  private lookingAt(token: string): boolean {
    return this.src.startsWith(token, this.pos)
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && WHITESPACE.test(this.src[this.pos])) this.pos++
  }

  private skipUntil(closer: string): void {
    const end = this.src.indexOf(closer, this.pos)
    if (end === -1) throw new Error(`「${closer}」が閉じられていません`)
    this.pos = end + closer.length
  }

  /**
   * DOCTYPE 宣言を読み飛ばす。内部サブセット `[ ... ]` ごとスキップし、
   * そこで宣言されたエンティティは**一切展開しない**（外部 DTD も取得しない）。
   */
  private skipDoctype(): void {
    this.pos += '<!DOCTYPE'.length
    let inSubset = false
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch === '[') inSubset = true
      else if (ch === ']') inSubset = false
      else if (ch === '>' && !inSubset) {
        this.pos++
        return
      }
      this.pos++
    }
    throw new Error('DOCTYPE 宣言が閉じられていません')
  }

  private readName(): string {
    const start = this.pos
    while (this.pos < this.src.length && !/[\s=/>]/.test(this.src[this.pos])) this.pos++
    if (this.pos === start) throw new Error('要素名 / 属性名が空です')
    return this.src.slice(start, this.pos)
  }

  private parseElement(): XmlNode {
    this.pos++ // '<'
    const rawName = this.readName()
    const node: XmlNode = { tag: localName(rawName), attrs: new Map(), children: [], text: '' }

    // 属性
    for (;;) {
      this.skipWhitespace()
      if (this.lookingAt('/>')) {
        this.pos += 2
        return node
      }
      if (this.src[this.pos] === '>') {
        this.pos++
        break
      }
      if (this.pos >= this.src.length) throw new Error(`<${rawName}> が閉じられていません`)
      const attrName = this.readName()
      this.skipWhitespace()
      if (this.src[this.pos] !== '=') {
        throw new Error(`属性 ${attrName} に値がありません（整形式 XML が必要です）`)
      }
      this.pos++
      this.skipWhitespace()
      const quote = this.src[this.pos]
      if (quote !== '"' && quote !== "'") {
        throw new Error(`属性 ${attrName} の値が引用符で囲まれていません`)
      }
      this.pos++
      const end = this.src.indexOf(quote, this.pos)
      if (end === -1) throw new Error(`属性 ${attrName} の引用符が閉じられていません`)
      node.attrs.set(localName(attrName), decodeEntities(this.src.slice(this.pos, end)))
      this.pos = end + 1
    }

    // 中身
    for (;;) {
      if (this.pos >= this.src.length) throw new Error(`</${rawName}> がありません`)
      if (this.lookingAt('</')) {
        this.pos += 2
        const closeName = this.readName()
        this.skipWhitespace()
        if (this.src[this.pos] !== '>') throw new Error(`</${closeName} が閉じられていません`)
        this.pos++
        if (closeName !== rawName) {
          throw new Error(`タグの対応が取れていません（<${rawName}> ↔ </${closeName}>）`)
        }
        return node
      }
      if (this.lookingAt('<!--')) {
        this.skipUntil('-->')
      } else if (this.lookingAt('<![CDATA[')) {
        this.pos += '<![CDATA['.length
        const end = this.src.indexOf(']]>', this.pos)
        if (end === -1) throw new Error('CDATA が閉じられていません')
        node.text += this.src.slice(this.pos, end)
        this.pos = end + 3
      } else if (this.lookingAt('<?')) {
        this.skipUntil('?>')
      } else if (this.src[this.pos] === '<') {
        node.children.push(this.parseElement())
      } else {
        const next = this.src.indexOf('<', this.pos)
        const end = next === -1 ? this.src.length : next
        node.text += decodeEntities(this.src.slice(this.pos, end))
        this.pos = end
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CSS ミニパーサ（fill / fill-rule のみ。外部参照は取得せず破棄）
// ---------------------------------------------------------------------------

interface CssDecls {
  fill?: string
  fillRule?: FillRule
}

interface CssRule {
  kind: 'tag' | 'class' | 'id'
  name: string
  /** id(100) > class(10) > tag(1)。同点は出現順の後勝ち */
  specificity: number
  order: number
  decls: CssDecls
}

function parseDeclarations(body: string): CssDecls {
  const decls: CssDecls = {}
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim().toLowerCase()
    if (prop === 'fill') {
      decls.fill = value
    } else if (prop === 'fill-rule' || prop === 'clip-rule') {
      // clip-rule も受理する（FR-005）。clipPath 自体は部分集合外で警告付き無視
      // なので実質の効果は fill-rule のみだが、指定を落とさず同じ形で解釈する
      if (value === 'nonzero' || value === 'evenodd') {
        if (prop === 'fill-rule') decls.fillRule = value
      }
    }
  }
  return decls
}

/**
 * `<style>` の中身から fill / fill-rule 規則を収集する。
 * サポートは単純セレクタ（`tag` / `.class` / `#id`、カンマ列挙可）のみ。
 * `@import` と `@font-face` は**取得せず**破棄し、report に記録する。
 */
function parseCssText(css: string, startOrder: number, report: SvgImportReport): CssRule[] {
  const rules: CssRule[] = []
  const src = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  let pos = 0
  let order = startOrder
  while (pos < src.length) {
    while (pos < src.length && WHITESPACE.test(src[pos])) pos++
    if (pos >= src.length) break
    if (src[pos] === '@') {
      // @規則：@import は宣言終端まで、ブロック型はブレースの釣り合いまでスキップ
      const semicolon = src.indexOf(';', pos)
      const brace = src.indexOf('{', pos)
      const atText = src.slice(pos, Math.min(...[semicolon, brace, src.length].filter((i) => i >= 0)))
      if (atText.includes('import')) {
        report.ignored.push('外部 CSS（@import）は取得せず破棄しました')
      } else if (atText.includes('font-face')) {
        report.ignored.push('フォント参照（@font-face）は取得せず破棄しました')
      }
      if (brace !== -1 && (semicolon === -1 || brace < semicolon)) {
        let depth = 0
        while (pos < src.length) {
          if (src[pos] === '{') depth++
          else if (src[pos] === '}') {
            depth--
            if (depth === 0) {
              pos++
              break
            }
          }
          pos++
        }
      } else {
        pos = semicolon === -1 ? src.length : semicolon + 1
      }
      continue
    }
    const open = src.indexOf('{', pos)
    if (open === -1) break
    const close = src.indexOf('}', open)
    if (close === -1) break
    const selectors = src.slice(pos, open)
    const decls = parseDeclarations(src.slice(open + 1, close))
    pos = close + 1
    if (decls.fill === undefined && decls.fillRule === undefined) continue
    for (const raw of selectors.split(',')) {
      const sel = raw.trim()
      let match: RegExpExecArray | null
      if ((match = /^\.([\w-]+)$/.exec(sel)) !== null) {
        rules.push({ kind: 'class', name: match[1], specificity: 10, order: order++, decls })
      } else if ((match = /^#([\w-]+)$/.exec(sel)) !== null) {
        rules.push({ kind: 'id', name: match[1], specificity: 100, order: order++, decls })
      } else if ((match = /^([a-zA-Z][\w-]*)$/.exec(sel)) !== null) {
        rules.push({ kind: 'tag', name: match[1], specificity: 1, order: order++, decls })
      }
      // 複合セレクタ等は部分集合外 — 適用しない（取得を伴わないので黙って無視）
    }
  }
  return rules
}

/** ツリー全体から `<style>` を文書順に収集して CSS 規則にする */
function collectCssRules(root: XmlNode, report: SvgImportReport): CssRule[] {
  const rules: CssRule[] = []
  const visit = (node: XmlNode): void => {
    if (node.tag === 'style') {
      rules.push(...parseCssText(node.text, rules.length, report))
      return
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return rules
}

/** 要素にマッチする CSS 宣言から prop を解決（詳細度 → 出現順の後勝ち） */
function cssValueFor(
  node: XmlNode,
  rules: readonly CssRule[],
  prop: keyof CssDecls,
): string | undefined {
  const id = node.attrs.get('id')
  const classes = (node.attrs.get('class') ?? '').split(/\s+/).filter((c) => c.length > 0)
  let best: { specificity: number; order: number; value: string } | null = null
  for (const rule of rules) {
    const value = rule.decls[prop]
    if (value === undefined) continue
    const matches =
      (rule.kind === 'tag' && rule.name === node.tag) ||
      (rule.kind === 'class' && classes.includes(rule.name)) ||
      (rule.kind === 'id' && rule.name === id)
    if (!matches) continue
    if (
      best === null ||
      rule.specificity > best.specificity ||
      (rule.specificity === best.specificity && rule.order > best.order)
    ) {
      best = { specificity: rule.specificity, order: rule.order, value }
    }
  }
  return best?.value
}

// ---------------------------------------------------------------------------
// transform（FR-005: matrix / translate / scale / rotate）
// ---------------------------------------------------------------------------

/** SVG の 2D アフィン行列 [a, b, c, d, e, f]: x' = ax + cy + e, y' = bx + dy + f */
type Mat = readonly [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** 合成 m1 ∘ m2（m2 を先に適用）。`transform="t1 t2"` は t2 が内側 */
function matMultiply(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function matApply(m: Mat, x: number, y: number): readonly [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * transform 属性のパース。FR-005 の部分集合（matrix / translate / scale / rotate）
 * のみ適用し、範囲外（skewX / skewY）は無視して report に記録する。
 */
function parseTransform(value: string, report: SvgImportReport): Mat {
  let mat = IDENTITY
  const opPattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = opPattern.exec(value)) !== null) {
    const op = match[1]
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number)
    if (args.some((a) => !Number.isFinite(a))) continue
    switch (op) {
      case 'matrix':
        if (args.length === 6) {
          mat = matMultiply(mat, [args[0], args[1], args[2], args[3], args[4], args[5]])
        }
        break
      case 'translate':
        if (args.length === 1 || args.length === 2) {
          mat = matMultiply(mat, [1, 0, 0, 1, args[0], args[1] ?? 0])
        }
        break
      case 'scale':
        if (args.length === 1 || args.length === 2) {
          mat = matMultiply(mat, [args[0], 0, 0, args[1] ?? args[0], 0, 0])
        }
        break
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) break
        const rad = (args[0] * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const rot: Mat = [cos, sin, -sin, cos, 0, 0]
        if (args.length === 3) {
          mat = matMultiply(mat, [1, 0, 0, 1, args[1], args[2]])
          mat = matMultiply(mat, rot)
          mat = matMultiply(mat, [1, 0, 0, 1, -args[1], -args[2]])
        } else {
          mat = matMultiply(mat, rot)
        }
        break
      }
      default:
        report.ignored.push(`transform の「${op}」は部分集合外のため適用しません`)
    }
  }
  return mat
}

// ---------------------------------------------------------------------------
// path データ（d 属性）のパースとフラット化
// ---------------------------------------------------------------------------

/** 形状の最大辺長に対するフラット化許容誤差の比。円 1 周がおよそ 50 頂点になる */
const FLATTEN_REL_TOL = 1 / 1024

type Seg =
  | { k: 'L'; x: number; y: number }
  | { k: 'Q'; cx: number; cy: number; x: number; y: number }
  | { k: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | {
      k: 'A'
      rx: number
      ry: number
      rotDeg: number
      largeArc: boolean
      sweep: boolean
      x: number
      y: number
    }

interface SubpathIR {
  x0: number
  y0: number
  segs: Seg[]
  /** 明示的な Z による閉路 */
  closedByZ: boolean
}

const NUMBER_PATTERN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

/** d 属性の字句読み取り。arc のフラグは数字が連結されうるため専用に 1 文字読む */
class PathScanner {
  pos = 0

  constructor(private readonly d: string) {}

  skipSeparators(): void {
    while (this.pos < this.d.length && /[\s,]/.test(this.d[this.pos])) this.pos++
  }

  atEnd(): boolean {
    this.skipSeparators()
    return this.pos >= this.d.length
  }

  peekIsNumberStart(): boolean {
    this.skipSeparators()
    return this.pos < this.d.length && /[0-9+\-.]/.test(this.d[this.pos])
  }

  readCommand(): string {
    this.skipSeparators()
    const ch = this.d[this.pos]
    if (!/[a-zA-Z]/.test(ch)) throw new Error(`path データの位置 ${this.pos} にコマンドがありません`)
    this.pos++
    return ch
  }

  readNumber(): number {
    this.skipSeparators()
    NUMBER_PATTERN.lastIndex = this.pos
    const match = NUMBER_PATTERN.exec(this.d)
    if (match === null) throw new Error(`path データの位置 ${this.pos} を数値として読めません`)
    this.pos = NUMBER_PATTERN.lastIndex
    return Number(match[0])
  }

  readFlag(): boolean {
    this.skipSeparators()
    const ch = this.d[this.pos]
    if (ch !== '0' && ch !== '1') {
      throw new Error(`path データの位置 ${this.pos} を arc フラグとして読めません`)
    }
    this.pos++
    return ch === '1'
  }
}

/** d 属性 → 絶対座標のサブパス IR 列。SVG 2 の path 文法（A-Z 全コマンド）対応 */
function parsePathData(d: string): SubpathIR[] {
  const scanner = new PathScanner(d)
  const subpaths: SubpathIR[] = []
  let current: SubpathIR | null = null
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let prevQx: number | null = null
  let prevQy: number | null = null
  let prevCx: number | null = null
  let prevCy: number | null = null

  const beginSubpath = (x: number, y: number): void => {
    current = { x0: x, y0: y, segs: [], closedByZ: false }
    subpaths.push(current)
    sx = x
    sy = y
    cx = x
    cy = y
  }
  const ensureCurrent = (): SubpathIR => {
    // Z の後にコマンドが続く場合はサブパス開始点から新しいサブパスが始まる（SVG 仕様）
    if (current === null || current.closedByZ) beginSubpath(cx, cy)
    return current as unknown as SubpathIR
  }

  while (!scanner.atEnd()) {
    const cmd = scanner.readCommand()
    const rel = cmd === cmd.toLowerCase()
    const kind = cmd.toUpperCase()
    let clearQ = true
    let clearC = true
    switch (kind) {
      case 'M': {
        let first = true
        do {
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          if (first) {
            beginSubpath(x, y)
            first = false
          } else {
            // M の追加座標は暗黙の LineTo
            ensureCurrent().segs.push({ k: 'L', x, y })
            cx = x
            cy = y
          }
        } while (scanner.peekIsNumberStart())
        break
      }
      case 'L':
        do {
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'L', x, y })
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        break
      case 'H':
        do {
          const x = scanner.readNumber() + (rel ? cx : 0)
          ensureCurrent().segs.push({ k: 'L', x, y: cy })
          cx = x
        } while (scanner.peekIsNumberStart())
        break
      case 'V':
        do {
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'L', x: cx, y })
          cy = y
        } while (scanner.peekIsNumberStart())
        break
      case 'C':
        do {
          const c1x = scanner.readNumber() + (rel ? cx : 0)
          const c1y = scanner.readNumber() + (rel ? cy : 0)
          const c2x = scanner.readNumber() + (rel ? cx : 0)
          const c2y = scanner.readNumber() + (rel ? cy : 0)
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'C', c1x, c1y, c2x, c2y, x, y })
          prevCx = c2x
          prevCy = c2y
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        clearC = false
        break
      case 'S':
        do {
          const c1x = prevCx !== null ? 2 * cx - prevCx : cx
          const c1y = prevCy !== null ? 2 * cy - prevCy : cy
          const c2x = scanner.readNumber() + (rel ? cx : 0)
          const c2y = scanner.readNumber() + (rel ? cy : 0)
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'C', c1x, c1y, c2x, c2y, x, y })
          prevCx = c2x
          prevCy = c2y
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        clearC = false
        break
      case 'Q':
        do {
          const qx = scanner.readNumber() + (rel ? cx : 0)
          const qy = scanner.readNumber() + (rel ? cy : 0)
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'Q', cx: qx, cy: qy, x, y })
          prevQx = qx
          prevQy = qy
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        clearQ = false
        break
      case 'T':
        do {
          // 明示注釈: ループ背辺の prevQx = qx が自己参照の型推論になるのを断つ
          const qx: number = prevQx !== null ? 2 * cx - prevQx : cx
          const qy: number = prevQy !== null ? 2 * cy - prevQy : cy
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'Q', cx: qx, cy: qy, x, y })
          prevQx = qx
          prevQy = qy
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        clearQ = false
        break
      case 'A':
        do {
          const rx = scanner.readNumber()
          const ry = scanner.readNumber()
          const rotDeg = scanner.readNumber()
          const largeArc = scanner.readFlag()
          const sweep = scanner.readFlag()
          const x = scanner.readNumber() + (rel ? cx : 0)
          const y = scanner.readNumber() + (rel ? cy : 0)
          ensureCurrent().segs.push({ k: 'A', rx, ry, rotDeg, largeArc, sweep, x, y })
          cx = x
          cy = y
        } while (scanner.peekIsNumberStart())
        break
      case 'Z':
        if (current !== null) {
          ;(current as SubpathIR).closedByZ = true
        }
        cx = sx
        cy = sy
        break
      default:
        throw new Error(`path コマンド「${cmd}」は解釈できません`)
    }
    if (clearQ) {
      prevQx = null
      prevQy = null
    }
    if (clearC) {
      prevCx = null
      prevCy = null
    }
  }
  return subpaths
}

/**
 * arc（A コマンド）のフラット化。SVG 実装ノート F.6.5 / F.6.6 の
 * 端点パラメータ → 中心パラメータ変換に従い、許容誤差から求めた角度刻みで
 * サンプリングする。半径が退化していれば直線として扱う（仕様どおり）。
 */
function flattenArcInto(
  out: number[],
  x0: number,
  y0: number,
  seg: Extract<Seg, { k: 'A' }>,
  tolerance: number,
): void {
  let rx = Math.abs(seg.rx)
  let ry = Math.abs(seg.ry)
  const { x, y } = seg
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    out.push(x, y)
    return
  }
  const phi = (seg.rotDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx2 = (x0 - x) / 2
  const dy2 = (y0 - y) / 2
  const x1p = cosPhi * dx2 + sinPhi * dy2
  const y1p = -sinPhi * dx2 + cosPhi * dy2
  // 半径が足りなければ一様拡大（F.6.6.3）
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const rxSq = rx * rx
  const rySq = ry * ry
  let radicand =
    (rxSq * rySq - rxSq * y1p * y1p - rySq * x1p * x1p) / (rxSq * y1p * y1p + rySq * x1p * x1p)
  if (radicand < 0) radicand = 0
  const coef = (seg.largeArc !== seg.sweep ? 1 : -1) * Math.sqrt(radicand)
  const cxp = (coef * (rx * y1p)) / ry
  const cyp = (coef * (-ry * x1p)) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2
  const angleOf = (ux: number, uy: number): number => Math.atan2(uy, ux)
  const theta1 = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry)
  const theta2 = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry)
  let delta = theta2 - theta1
  if (seg.sweep && delta < 0) delta += 2 * Math.PI
  else if (!seg.sweep && delta > 0) delta -= 2 * Math.PI

  const maxR = Math.max(rx, ry)
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / maxR)))
  const steps = Math.max(1, Math.min(512, Math.ceil(Math.abs(delta) / (2 * halfAngle || 1e-3))))
  for (let i = 1; i <= steps; i++) {
    const theta = theta1 + (delta * i) / steps
    const px = rx * Math.cos(theta)
    const py = ry * Math.sin(theta)
    out.push(cosPhi * px - sinPhi * py + cx, sinPhi * px + cosPhi * py + cy)
  }
  // 終点を厳密値に揃える（角度サンプリングの丸めを閉路判定に持ち込まない）
  out[out.length - 2] = x
  out[out.length - 1] = y
}

/** path 要素 1 個 → 閉じたサブパスのリング列（要素ローカル座標） */
function pathToRings(d: string, report: SvgImportReport): number[][] {
  const subpaths = parsePathData(d)
  if (subpaths.length === 0) return []

  // フラット化許容誤差は制御点 bbox（曲線を包含する）に対する相対値で決める。
  // 入力座標系のスケールに依存しない（FR-010 と同じスケール非依存の原則）
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const include = (px: number, py: number): void => {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  for (const sub of subpaths) {
    include(sub.x0, sub.y0)
    for (const seg of sub.segs) {
      include(seg.x, seg.y)
      if (seg.k === 'Q') include(seg.cx, seg.cy)
      else if (seg.k === 'C') {
        include(seg.c1x, seg.c1y)
        include(seg.c2x, seg.c2y)
      } else if (seg.k === 'A') {
        include(seg.x - seg.rx, seg.y - seg.ry)
        include(seg.x + seg.rx, seg.y + seg.ry)
      }
    }
  }
  const maxDim = Math.max(maxX - minX, maxY - minY)
  if (!(maxDim > 0)) return []
  const tolerance = maxDim * FLATTEN_REL_TOL

  const rings: number[][] = []
  let openSkipped = false
  for (const sub of subpaths) {
    const pts: number[] = [sub.x0, sub.y0]
    for (const seg of sub.segs) {
      const lx = pts[pts.length - 2]
      const ly = pts[pts.length - 1]
      switch (seg.k) {
        case 'L':
          pts.push(seg.x, seg.y)
          break
        case 'Q':
          flattenQuadraticInto(pts, lx, ly, seg.cx, seg.cy, seg.x, seg.y, tolerance)
          break
        case 'C':
          flattenCubicInto(pts, lx, ly, seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y, tolerance)
          break
        case 'A':
          flattenArcInto(pts, lx, ly, seg, tolerance)
          break
      }
    }
    // 閉路判定：明示的な Z、または終点が始点に一致（bbox 相対の微小誤差まで許容）
    const endX = pts[pts.length - 2]
    const endY = pts[pts.length - 1]
    const closed =
      sub.closedByZ || Math.hypot(endX - sub.x0, endY - sub.y0) <= maxDim * 1e-6
    if (!closed) {
      openSkipped = true
      continue
    }
    rings.push(pts)
  }
  if (openSkipped) {
    report.ignored.push('閉じていないサブパスは面を持たないため無視しました')
  }
  return rings
}

// ---------------------------------------------------------------------------
// 基本図形（rect / circle / ellipse / polygon）
// ---------------------------------------------------------------------------

/** 属性の数値化。先頭の数値のみ採用（`px` などの単位は無視） */
function numAttr(node: XmlNode, name: string, fallback: number): number {
  const raw = node.attrs.get(name)
  if (raw === undefined) return fallback
  const value = parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

/** 楕円 1 周のリング（中心 cx, cy）。許容誤差から角度刻みを決める */
function ellipseRing(cx: number, cy: number, rx: number, ry: number): number[] {
  const maxR = Math.max(rx, ry)
  const tolerance = 2 * maxR * FLATTEN_REL_TOL
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / maxR)))
  const n = Math.max(12, Math.min(512, Math.ceil(Math.PI / (halfAngle || 1e-3))))
  const pts: number[] = []
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n
    pts.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
  }
  return pts
}

/** rect（rx / ry の自動解決と半分クランプは SVG 仕様どおり）→ リング */
function rectRings(node: XmlNode): number[][] {
  const x = numAttr(node, 'x', 0)
  const y = numAttr(node, 'y', 0)
  const width = numAttr(node, 'width', NaN)
  const height = numAttr(node, 'height', NaN)
  if (!(width > 0) || !(height > 0)) return []
  let rx = numAttr(node, 'rx', NaN)
  let ry = numAttr(node, 'ry', NaN)
  if (!Number.isFinite(rx) && !Number.isFinite(ry)) {
    rx = 0
    ry = 0
  } else if (!Number.isFinite(rx)) {
    rx = ry
  } else if (!Number.isFinite(ry)) {
    ry = rx
  }
  rx = Math.max(0, Math.min(rx, width / 2))
  ry = Math.max(0, Math.min(ry, height / 2))
  if (rx === 0 || ry === 0) {
    return [[x, y, x + width, y, x + width, y + height, x, y + height]]
  }
  // 角丸：四隅を楕円 1/4 周で置き換える
  const tolerance = 2 * Math.max(rx, ry) * FLATTEN_REL_TOL
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / Math.max(rx, ry))))
  const per = Math.max(2, Math.min(128, Math.ceil(Math.PI / 2 / (2 * halfAngle || 1e-3))))
  const pts: number[] = []
  const corner = (ccx: number, ccy: number, from: number): void => {
    for (let i = 0; i <= per; i++) {
      const t = from + (Math.PI / 2) * (i / per)
      pts.push(ccx + rx * Math.cos(t), ccy + ry * Math.sin(t))
    }
  }
  // Y 下向き座標系での時計回り配置（向きは classifyRings が幾何で判定するので任意）
  corner(x + width - rx, y + ry, -Math.PI / 2)
  corner(x + width - rx, y + height - ry, 0)
  corner(x + rx, y + height - ry, Math.PI / 2)
  corner(x + rx, y + ry, Math.PI)
  return [pts]
}

function polygonRings(node: XmlNode): number[][] {
  const raw = node.attrs.get('points')
  if (raw === undefined) return []
  const nums = raw
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number)
  if (nums.length < 6 || nums.some((v) => !Number.isFinite(v))) return []
  return [nums.slice(0, nums.length - (nums.length % 2))]
}

// ---------------------------------------------------------------------------
// ツリー走査
// ---------------------------------------------------------------------------

/** 継承されるスタイル（fill と fill-rule は SVG で共に継承プロパティ） */
interface InheritedStyle {
  /** 塗り。null = 未指定（SVG 既定の black = 塗りあり） */
  fill: string | null
  fillRule: FillRule
}

/** 採取した 1 要素分の形状。リングは transform 適用済みの SVG（Y 下向き）座標 */
interface CollectedShape {
  rings: number[][]
  fillRule: FillRule
}

/** 部分集合外につき**中身ごと**読み飛ばす要素（FR-005 / NFR-030） */
const DISCARDED_TAGS: ReadonlyMap<string, string | null> = new Map([
  // 外部参照になりうるもの — 取得せず破棄し、その旨を報告する
  ['script', '<script> は取得・実行せず破棄しました'],
  ['image', '<image> の参照は取得せず破棄しました'],
  ['use', '<use> の参照は取得せず破棄しました'],
  ['foreignObject', '<foreignObject> は取得せず破棄しました'],
  // 適用しない旨を警告するもの（FR-005 の表）
  ['clipPath', 'clipPath は適用されません'],
  ['mask', 'mask は適用されません'],
  ['filter', 'filter は適用されません'],
  // 描画対象にならない定義・メタデータ（警告不要）
  ['defs', null],
  ['symbol', null],
  ['pattern', null],
  ['marker', null],
  ['linearGradient', null],
  ['radialGradient', null],
  ['metadata', null],
  ['title', null],
  ['desc', null],
  ['style', null], // 中身は collectCssRules が先に読んでいる
])

/** インライン style 属性 > CSS 規則 > presentation attribute > 継承、の順で解決 */
function resolveStyle(
  node: XmlNode,
  inherited: InheritedStyle,
  cssRules: readonly CssRule[],
): InheritedStyle {
  const inline = parseDeclarations(node.attrs.get('style') ?? '')

  let fill = inherited.fill
  const cssFill = cssValueFor(node, cssRules, 'fill')
  const attrFill = node.attrs.get('fill')?.trim().toLowerCase()
  if (attrFill !== undefined && attrFill !== 'inherit') fill = attrFill
  if (cssFill !== undefined && cssFill !== 'inherit') fill = cssFill
  if (inline.fill !== undefined && inline.fill !== 'inherit') fill = inline.fill

  let fillRule = inherited.fillRule
  const attrRule = node.attrs.get('fill-rule')?.trim().toLowerCase()
  if (attrRule === 'nonzero' || attrRule === 'evenodd') fillRule = attrRule
  const cssRule = cssValueFor(node, cssRules, 'fillRule')
  if (cssRule === 'nonzero' || cssRule === 'evenodd') fillRule = cssRule
  if (inline.fillRule !== undefined) fillRule = inline.fillRule

  return { fill, fillRule }
}

function walkSvgTree(
  node: XmlNode,
  ctm: Mat,
  inherited: InheritedStyle,
  cssRules: readonly CssRule[],
  report: SvgImportReport,
  sink: CollectedShape[],
): void {
  const discardNote = DISCARDED_TAGS.get(node.tag)
  if (discardNote !== undefined) {
    if (discardNote !== null && !report.ignored.includes(discardNote)) {
      report.ignored.push(discardNote)
    }
    return
  }

  // clip-path / mask / filter は属性としても現れる（FR-005: 適用しない旨を警告）
  for (const attrName of ['clip-path', 'mask', 'filter'] as const) {
    if (node.attrs.has(attrName)) {
      const note = `${attrName} 属性は適用されません`
      if (!report.ignored.includes(note)) report.ignored.push(note)
    }
  }

  const transform = node.attrs.get('transform')
  const localCtm = transform === undefined ? ctm : matMultiply(ctm, parseTransform(transform, report))
  const style = resolveStyle(node, inherited, cssRules)

  let localRings: number[][] | null = null
  switch (node.tag) {
    case 'path': {
      const d = node.attrs.get('d')
      localRings = d === undefined ? [] : pathToRings(d, report)
      break
    }
    case 'polygon':
      localRings = polygonRings(node)
      break
    case 'rect':
      localRings = rectRings(node)
      break
    case 'circle': {
      const r = numAttr(node, 'r', NaN)
      localRings =
        r > 0 ? [ellipseRing(numAttr(node, 'cx', 0), numAttr(node, 'cy', 0), r, r)] : []
      break
    }
    case 'ellipse': {
      const rx = numAttr(node, 'rx', NaN)
      const ry = numAttr(node, 'ry', NaN)
      localRings =
        rx > 0 && ry > 0
          ? [ellipseRing(numAttr(node, 'cx', 0), numAttr(node, 'cy', 0), rx, ry)]
          : []
      break
    }
    case 'line':
    case 'polyline':
      // ストロークのみの線 — 面がないため無視（FR-005）
      return
    default:
      break
  }

  if (localRings !== null) {
    // 塗りのない形状は面を成さない（fill="none" — FR-005）
    if (style.fill === 'none') return
    if (localRings.length === 0) return
    const transformed = localRings.map((ring) => {
      const out = new Array<number>(ring.length)
      for (let i = 0; i < ring.length; i += 2) {
        const [tx, ty] = matApply(localCtm, ring[i], ring[i + 1])
        out[i] = tx
        out[i + 1] = ty
      }
      return out
    })
    sink.push({ rings: transformed, fillRule: style.fillRule })
    return
  }

  // コンテナ（svg / g / a / switch / 未知要素）は透過的に子へ降りる
  for (const child of node.children) {
    walkSvgTree(child, localCtm, style, cssRules, report, sink)
  }
}

// ---------------------------------------------------------------------------
// 頂点数上限（Ramer–Douglas–Peucker による単純化）
// ---------------------------------------------------------------------------

function totalVertices(contours: readonly Contour[]): number {
  let n = 0
  for (const c of contours) n += c.points.length / 2
  return n
}

/** 閉リングの RDP 単純化。始点と最遠点をアンカーに 2 本の折れ線として処理する */
function simplifyRing(pts: Float64Array, epsilon: number): Float64Array | null {
  const n = pts.length / 2
  if (n <= 3) return pts
  let far = 1
  let bestDistSq = -1
  for (let i = 1; i < n; i++) {
    const dx = pts[2 * i] - pts[0]
    const dy = pts[2 * i + 1] - pts[1]
    const distSq = dx * dx + dy * dy
    if (distSq > bestDistSq) {
      bestDistSq = distSq
      far = i
    }
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[far] = 1
  // 明示スタックで再帰深度を回避。区間 (i0, i1) は i1 === n を 0 の別名として扱う
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ]
  while (stack.length > 0) {
    const [i0, i1] = stack.pop() as [number, number]
    if (i1 - i0 < 2) continue
    const ax = pts[2 * i0]
    const ay = pts[2 * i0 + 1]
    const bi = i1 % n
    const bx = pts[2 * bi]
    const by = pts[2 * bi + 1]
    let maxDist = -1
    let maxIdx = -1
    for (let i = i0 + 1; i < i1; i++) {
      const d = distanceToSegment(pts[2 * i], pts[2 * i + 1], ax, ay, bx, by)
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxDist > epsilon && maxIdx !== -1) {
      keep[maxIdx] = 1
      stack.push([i0, maxIdx], [maxIdx, i1])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1) out.push(pts[2 * i], pts[2 * i + 1])
  }
  if (out.length < 6) return null
  return new Float64Array(out)
}

/**
 * 総頂点数が {@link MAX_SVG_VERTICES} を超えたら、bbox 対角に相対的な許容誤差で
 * 単純化する（US-002）。許容誤差は上限内に収まるまで倍々で引き上げる。
 * 単純化で縮退したリングは棄却する（穴が消えるのは「その穴が許容誤差より
 * 小さかった」ことを意味し、位相の破壊ではない）。
 */
function enforceVertexBudget(contours: Contour[], report: SvgImportReport): Contour[] {
  const before = totalVertices(contours)
  if (before <= MAX_SVG_VERTICES) return contours

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours) {
    for (let i = 0; i < c.points.length; i += 2) {
      if (c.points[i] < minX) minX = c.points[i]
      if (c.points[i] > maxX) maxX = c.points[i]
      if (c.points[i + 1] < minY) minY = c.points[i + 1]
      if (c.points[i + 1] > maxY) maxY = c.points[i + 1]
    }
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY)
  let epsilon = diagonal * 1e-4
  let current = contours
  for (let iteration = 0; iteration < 24; iteration++) {
    const next: Contour[] = []
    for (const c of current) {
      const simplified = simplifyRing(c.points, epsilon)
      if (simplified === null) continue
      const { relArea } = ringMeasure(simplified)
      if (!(relArea > DEGENERATE_REL_AREA)) continue
      next.push({ points: simplified, isHole: c.isHole })
    }
    current = next
    if (totalVertices(current) <= MAX_SVG_VERTICES) break
    epsilon *= 2
  }
  report.simplified = { before, after: totalVertices(current) }
  return current
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * SVG 文字列をパースし、FR-005 のサポート部分集合に限定して `Contour[]` に変換する。
 * Y 下向き → Y 上向き変換の後に巻き方向を再判定する（FR-003）。
 * 外部参照（image / use / script / 外部 CSS・フォント）は **取得せずに** 破棄する
 * （NFR-030 — 保証の仕組みはファイル冒頭の「セキュリティ設計」を参照）。
 *
 * シグネチャは Wave 4 の呼び出し側（useGenerationPipeline）との契約なので変更しない。
 * 単純化（`SIMPLIFIED`）等の付帯情報は {@link getLastSvgImportReport} で公開する。
 *
 * @param raw SVG ファイルの生テキスト
 * @param fileName 表示・エラーメッセージ用のファイル名
 * @returns Y 上向き・`isHole` 分類済みの輪郭集合。スケール正規化は呼び出し側
 *          （normalize.ts）の責務
 */
export function svgToContours(raw: string, fileName: string): Promise<Contour[]> {
  const report: SvgImportReport = { simplified: null, ignored: [] }
  lastReport = report
  try {
    let root: XmlNode
    try {
      root = new XmlParser(raw).parseDocument()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`「${fileName}」を SVG として解釈できません: ${detail}`, { cause: err })
    }
    if (root.tag !== 'svg') {
      throw new Error(`「${fileName}」はルート要素が <svg> ではありません（<${root.tag}>）`)
    }

    const cssRules = collectCssRules(root, report)
    const shapes: CollectedShape[] = []
    walkSvgTree(
      root,
      IDENTITY,
      { fill: null, fillRule: 'nonzero' },
      cssRules,
      report,
      shapes,
    )

    // fill-rule は要素単位のプロパティなので、分類も要素単位で行う。
    // 複合サブパス（1 つの d に複数の M）はこの単位の中で入れ子として解釈される
    const contours: Contour[] = []
    for (const shape of shapes) {
      contours.push(...classifyRings(shape.rings, shape.fillRule))
    }
    if (contours.length === 0) {
      throw new Error(
        `「${fileName}」には閉じた塗りつぶし対象のパスがありません` +
          '（fill="none"・ストロークのみ・開いたパスはシルエットになりません）',
      )
    }

    const budgeted = enforceVertexBudget(contours, report)
    if (budgeted.length === 0) {
      throw new Error(`「${fileName}」の輪郭は単純化の結果すべて縮退しました`)
    }

    // Y 下向き（SVG）→ Y 上向き（内部規約）。flipY は反転直後の巻き方向
    // 再判定（normalizeWinding）を内包する — 反転前に巻きを確定してはならない
    return Promise.resolve(flipY(budgeted))
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
}
