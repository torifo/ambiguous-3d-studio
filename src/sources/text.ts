import { parse } from 'opentype.js'
import type { Font, PathCommand } from 'opentype.js'
import type { Contour } from '../geometry/types'
import { flipY } from '../geometry/normalize'
import { classifyRings, flattenCubicInto, flattenQuadraticInto } from './svg'

/**
 * テキスト入力（Task 6.1 / FR-002 / US-002 / NFR-030）。
 *
 * 同梱フォントのグリフ輪郭から `Contour[]` を抽出する。
 *
 * ## フォントの同梱（NFR-030 / NFR-040）
 *
 * フォントは `public/fonts/Inter-Regular.otf`（Inter v3.019, SIL OFL 1.1 —
 * 同ディレクトリの OFL.txt がライセンス本文）として**アプリに同梱**する。
 * CDN・Google Fonts 等の外部取得は行わない。取得 URL は
 * `import.meta.env.BASE_URL` 起点の相対パスなので、GitHub Pages のサブパス
 * （`/ambiguous-3d-studio/`）配下でも解決される（NFR-040）。これは Wasm と
 * 同じ「自分自身の静的アセット」の読み込みであり、ユーザー入力が外部へ
 * 送信されることはない。パースは opentype.js の `parse(ArrayBuffer)` のみを
 * 使い、URL を渡す `load()` は使わない — ネットワークへ触れるのはこの
 * モジュール内の `fetch(自アセット)` の 1 箇所だけで、テストがこれを
 * スタブして検証する。
 *
 * ## カウンター（穴）の保存 — FR-002 の核心
 *
 * `A` `B` `8` のカウンターを潰すと文字として読めない。グリフの各輪郭を
 * フラット化した後、幾何的な包含関係と巻き数から外輪郭 / 穴を分類する
 * （svg.ts の {@link classifyRings} と共用。フォントの塗りは nonzero）。
 * フォント側の巻き方向規約（TrueType は外=CW / PostScript は外=CCW）に
 * 依存しないため、どちらの系統のフォントでも穴が穴として残る。
 *
 * ## 座標系
 *
 * opentype.js の `getPath` はキャンバス系（Y 下向き・ベースライン基準）で
 * 輪郭を返す。SVG と同様に **Y 反転 → 巻き方向再判定** の順で内部規約
 * （Y 上向き・外 CCW / 穴 CW）へ変換する。`flipY` が再判定を内包している。
 *
 * スタブ時代のシグネチャは Wave 4 の呼び出し側（useGenerationPipeline）との
 * 契約なので変更しない。スケール正規化（共通高さへのフィット）は呼び出し側の
 * normalize.ts が行うため、ここでは行わない。
 */

/** 受け付ける文字列（FR-002 / US-002）: 英数字 1〜8 文字。UI 側の検証と同一 */
const TEXT_PATTERN = /^[0-9A-Za-z]{1,8}$/

/**
 * fontId → 同梱フォントファイル（`public/fonts/` からの相対パス）。
 * キー `'default'` は UI（SilhouettePicker の `DEFAULT_FONT_ID`）との契約。
 */
const FONT_FILES: Readonly<Record<string, string>> = {
  default: 'fonts/Inter-Regular.otf',
}

/** グリフ描画サイズ（作業座標）。正規化は後段なので値自体に意味はなく、比率だけが本質 */
const FONT_RENDER_SIZE = 100

/**
 * 曲線フラット化の許容誤差（FR_RENDER_SIZE 相対）。1/512 em ≈ 0.2% で、
 * 8 文字入力でも総頂点数は数千に収まり、カウンターの形は視認上崩れない。
 */
const FLATTEN_TOLERANCE = FONT_RENDER_SIZE / 512

/**
 * パース済みフォントのキャッシュ。失敗した Promise は残さない
 * （残すと一時的なネットワーク断から永久に復帰できない — csg.worker.ts の
 * `ensureManifold` と同じ規律）。
 */
const fontCache = new Map<string, Promise<Font>>()

/** fontId → 取得 URL（`BASE_URL` 起点。先頭 `/` の重複だけ吸収する） */
function fontUrlOf(file: string): string {
  const base = import.meta.env.BASE_URL
  return base.endsWith('/') ? base + file : `${base}/${file}`
}

function loadFont(fontId: string): Promise<Font> {
  const file = FONT_FILES[fontId]
  if (file === undefined) {
    return Promise.reject(
      new Error(`text: 未知のフォント id "${fontId}" です（同梱フォント: ${Object.keys(FONT_FILES).join(', ')}）`),
    )
  }
  const cached = fontCache.get(fontId)
  if (cached !== undefined) return cached
  const loading = (async () => {
    const url = fontUrlOf(file)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`text: 同梱フォント ${url} を読み込めません（HTTP ${response.status}）`)
    }
    const buffer = await response.arrayBuffer()
    return parse(buffer)
  })()
  // 失敗はキャッシュから除去して再試行可能にする（成功だけを恒久キャッシュ）
  loading.catch(() => {
    if (fontCache.get(fontId) === loading) fontCache.delete(fontId)
  })
  fontCache.set(fontId, loading)
  return loading
}

/**
 * opentype.js のパスコマンド列 → フラット化済みリング列。
 * M で輪郭を開始し、Z（または次の M / 終端）で確定する。曲線（Q / C）は
 * svg.ts と共用のフラット化で許容誤差付きの折れ線にする。
 */
function commandsToRings(commands: readonly PathCommand[]): number[][] {
  const rings: number[][] = []
  let current: number[] | null = null
  const closeCurrent = (): void => {
    if (current !== null && current.length >= 6) rings.push(current)
    current = null
  }
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        closeCurrent()
        current = [cmd.x, cmd.y]
        break
      case 'L':
        current?.push(cmd.x, cmd.y)
        break
      case 'Q':
        if (current !== null && current.length >= 2) {
          const lx = current[current.length - 2]
          const ly = current[current.length - 1]
          flattenQuadraticInto(current, lx, ly, cmd.x1, cmd.y1, cmd.x, cmd.y, FLATTEN_TOLERANCE)
        }
        break
      case 'C':
        if (current !== null && current.length >= 2) {
          const lx = current[current.length - 2]
          const ly = current[current.length - 1]
          flattenCubicInto(
            current,
            lx,
            ly,
            cmd.x1,
            cmd.y1,
            cmd.x2,
            cmd.y2,
            cmd.x,
            cmd.y,
            FLATTEN_TOLERANCE,
          )
        }
        break
      case 'Z':
        closeCurrent()
        break
    }
  }
  closeCurrent()
  return rings
}

/**
 * 文字列をフォントのグリフ輪郭（外輪郭 + 穴の入れ子）から `Contour[]` に変換する。
 *
 * カーニング適用済みの文字列全体を 1 つのパスとして取り出し、輪郭ごとに
 * フラット化 → nonzero 分類（カウンターは `isHole: true`）→ Y 反転＋巻き方向
 * 再判定、の順で内部規約の輪郭集合にする。
 *
 * @param value 英数字 1〜8 文字（FR-002 / US-002）。範囲外は reject
 * @param fontId 同梱フォントの識別子（CDN 不使用 — NFR-030）。既定は `'default'`
 * @returns Y 上向き・`isHole` 分類済みの輪郭集合（正規化前の生スケール）
 */
export async function textToContours(value: string, fontId: string): Promise<Contour[]> {
  if (!TEXT_PATTERN.test(value)) {
    throw new Error(
      `text: 英数字（A–Z / a–z / 0–9）1〜8 文字が必要です（入力: ${JSON.stringify(value)}）`,
    )
  }
  const font = await loadFont(fontId)
  // ベースライン原点・Y 下向き（キャンバス系）のパス。カーニングは既定で有効
  const path = font.getPath(value, 0, 0, FONT_RENDER_SIZE)
  const rings = commandsToRings(path.commands)
  const contours = classifyRings(rings, 'nonzero')
  if (contours.length === 0) {
    throw new Error(`text: "${value}" から輪郭を抽出できませんでした（グリフが空です）`)
  }
  // Y 下向き → Y 上向き。flipY は反転直後の巻き方向再判定を内包する（FR-003 と同じ規律）
  return flipY(contours)
}
