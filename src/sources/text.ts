import type { Contour } from '../geometry/types'

/**
 * 文字列をフォントのグリフ輪郭（外輪郭 + 穴の入れ子）から `Contour[]` に変換する。
 *
 * Wave 1 のスタブ。Task 6.1 が **この関数の中身のみ** を実装で差し替える。
 * シグネチャは Wave 4 の呼び出し側（useGenerationPipeline）との契約なので変更しない。
 *
 * @param value 英数字 1〜8 文字（FR-002 / US-002）
 * @param fontId 同梱フォントの識別子（CDN 不使用 — NFR-030）
 */
export function textToContours(value: string, fontId: string): Promise<Contour[]> {
  return Promise.reject(
    new Error(
      `NotImplemented: textToContours("${value}", "${fontId}") — Task 6.1 (Wave 6) implements this stub`,
    ),
  )
}
