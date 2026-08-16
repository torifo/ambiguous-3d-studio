import type { Contour } from '../geometry/types'

/**
 * SVG 文字列をパースし、FR-005 のサポート部分集合に限定して `Contour[]` に変換する。
 * Y 下向き → Y 上向き変換の後に巻き方向を再判定する（FR-003）。
 * 外部参照（image / use / script / 外部 CSS・フォント）は **取得せずに** 破棄する（NFR-030）。
 *
 * Wave 1 のスタブ。Task 6.2 が **この関数の中身のみ** を実装で差し替える。
 * シグネチャは Wave 4 の呼び出し側（useGenerationPipeline）との契約なので変更しない。
 *
 * @param raw SVG ファイルの生テキスト
 * @param fileName 表示・エラーメッセージ用のファイル名
 */
export function svgToContours(raw: string, fileName: string): Promise<Contour[]> {
  return Promise.reject(
    new Error(
      `NotImplemented: svgToContours(${raw.length} chars, "${fileName}") — Task 6.2 (Wave 6) implements this stub`,
    ),
  )
}
