/**
 * カタログ 1 項目のカード（FR-100）。
 *
 * `entry.buildable` で見た目を大きく分ける。ここが `illusion-catalogue.md` の
 * 一番言いたいこと（「生成できないもの」も敗北ではなく、この方式の境界を
 * 示す読み物として掲載する）を UI で体現する場所:
 *
 * - **生成できる**: 現象・機構を示したうえで「この立体を作る」ボタンを出す。
 * - **生成できない**: ボタンを出さない代わりに `notBuildableReason` を
 *   最も広いスペースで、最も目立つ書体で見せる。エラー然とした赤/黄の警告色は
 *   使わない — これは失敗の報告ではなく、カタログが持つ知識そのものだから。
 *
 * `isBuildableIllusion` / `isUnbuildableIllusion`（catalogue/illusions.ts）で
 * 分岐する。`entry.preset!` は一度も書かない — 型ガードが型のレベルで
 * 存在を保証する。
 *
 * ## 見え方の改修（見た目のみ・構成とテキストは変えない）
 *
 * 生成できる/できないの区別を、左端の縦マーカーの**形**（実線 = 作れる、
 * 破線 = 作れない）でも重ねて示す。色（accent 緑 / sky 青）だけに頼らせない
 * ためで、`SweetSpotIndicator.tsx` が合致状態を色・形状・テキストの 3 経路で
 * 示しているのと同じ考え方をここにも適用した。
 *
 * ボタン文字列の周りに置く `[` `]` は `aria-hidden` にした別要素で、
 * アクセシブルネームの計算（content から名前を作るとき aria-hidden な
 * 子孫は無視される）には入らない。したがって
 * `getByRole('button', { name: 'この立体を作る' })`（catalogue.spec.ts）の
 * 文字列は一切変えていない — 視覚的な化粧だけを足した。
 */
import { isBuildableIllusion, isUnbuildableIllusion, type IllusionEntry } from '../catalogue/illusions'

const CATEGORY_LABELS: Record<IllusionEntry['category'], string> = {
  ambiguous: '両義立体',
  impossible: '不可能図形',
  gravity: '重力錯視',
  parallax: '視差錯視',
}

export interface IllusionCardProps {
  entry: IllusionEntry
  /** 現在ビューポートに表示中の項目かどうか（枠のハイライトのみに使う） */
  selected?: boolean
  /** 生成できる項目でボタンが押されたときの通知。生成できない項目では呼ばれない */
  onSelect: () => void
  /**
   * カタログ内の通し番号（1 始まり）。台帳の見出し番号のような装飾にのみ使う。
   * 省略時は番号を出さない — 単体でも壊れずに描画できる（既定 props のまま）
   */
  index?: number
}

/** カタログ 1 項目。生成できる/できないで CTA の有無と強調点が変わる */
export function IllusionCard({ entry, selected = false, onSelect, index }: IllusionCardProps) {
  const buildable = isBuildableIllusion(entry)
  const references = entry.references

  return (
    <article
      className={`group relative flex flex-col gap-3 overflow-hidden border p-4 pl-5 transition-colors ${
        selected
          ? 'border-sky-400 bg-sky-400/10'
          : 'border-line bg-ink-card hover:border-neutral-600'
      }`}
    >
      {/* 生成できる/できないの縦マーカー。実線=作れる（accent）、破線=作れない（sky）。
          色だけでなく形でも区別する（コメント冒頭参照）。装飾のみ: aria-hidden */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${
          buildable ? 'bg-accent/70' : 'border-l-2 border-dashed border-sky-400/40'
        }`}
      />

      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            {index !== undefined && (
              <span aria-hidden="true" className="shrink-0 font-mono text-[10px] text-muted">
                {String(index).padStart(2, '0')}
              </span>
            )}
            <h3 className="text-[15px] leading-snug font-semibold tracking-tight text-paper">
              {entry.name}
            </h3>
          </div>
          {/* 原題はラテン文字のみなので等幅で問題ない（index.css 冒頭のコメント参照:
              和文混じりの文には font-mono を使わない） */}
          <p className="mt-0.5 truncate font-mono text-[10px] tracking-[0.06em] text-muted uppercase">
            {entry.originalName}
          </p>
        </div>
        <span
          className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] tracking-wide whitespace-nowrap ${
            buildable ? 'border-accent/40 text-accent' : 'border-sky-400/40 text-sky-300'
          }`}
        >
          {CATEGORY_LABELS[entry.category]}
        </span>
      </header>

      <dl className="flex flex-col gap-2.5 text-xs">
        <div>
          <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">現象</dt>
          <dd className="mt-1 leading-relaxed text-neutral-300">{entry.phenomenon}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">機構</dt>
          <dd className="mt-1 text-[11px] leading-relaxed text-neutral-400">{entry.mechanism}</dd>
        </div>
      </dl>

      {/* 生成できない項目の主役はここ。エラー色ではなく sky（このアプリで
          「確定した性質」に使っている色。StatusBanner.tsx の「確定」バッジと同じ語彙）で、
          本文サイズも他の説明文より大きく取る */}
      {isUnbuildableIllusion(entry) && (
        <div className="border border-sky-400/30 bg-sky-400/5 p-2.5">
          <p className="text-[10px] font-semibold tracking-wide text-sky-300">
            この方式では作れない理由
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-neutral-100">
            {entry.notBuildableReason}
          </p>
        </div>
      )}

      {entry.credit !== undefined && (
        <p className="text-[10px] leading-relaxed text-neutral-600">出典: {entry.credit}</p>
      )}

      {/* 外部参照（別エージェントが catalogue/illusions.ts に追加中のフィールド）。
          出典を辿れることがカタログをカタログたらしめる、という owner の指示どおり
          描画する。矢印は ↗ に統一（FEEDBACK.md: 矢印グリフの不統一が指摘されていた） */}
      {references !== undefined && references.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line-soft pt-2.5">
          {references.map((ref) => (
            <li key={ref.url} className="text-[11px] leading-relaxed">
              <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline text-sky-300 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-200 hover:decoration-sky-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                {ref.label}
                <span aria-hidden="true" className="ml-0.5">
                  ↗
                </span>
              </a>
              {ref.note !== undefined && <span className="text-neutral-600">（{ref.note}）</span>}
            </li>
          ))}
        </ul>
      )}

      {isBuildableIllusion(entry) ? (
        <button
          type="button"
          onClick={onSelect}
          className="mt-1 inline-flex min-h-11 w-fit items-center gap-1.5 self-start border border-accent/50 px-3 font-mono text-xs tracking-wide text-accent transition-colors hover:border-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          <span aria-hidden="true" className="text-accent/50">
            [
          </span>
          この立体を作る
          <span aria-hidden="true" className="text-accent/50">
            ]
          </span>
        </button>
      ) : (
        <p className="mt-1 text-[10px] text-neutral-600">
          この方式では生成しません。理由は上記のとおりです。
        </p>
      )}
    </article>
  )
}
