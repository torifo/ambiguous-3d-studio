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
}

/** カタログ 1 項目。生成できる/できないで CTA の有無と強調点が変わる */
export function IllusionCard({ entry, selected = false, onSelect }: IllusionCardProps) {
  return (
    <article
      className={`flex flex-col gap-2 rounded border p-3 ${
        selected ? 'border-sky-400 bg-sky-400/10' : 'border-neutral-700'
      }`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-neutral-100">{entry.name}</h3>
          <p className="text-[11px] text-neutral-500">{entry.originalName}</p>
        </div>
        <span className="shrink-0 rounded border border-neutral-600 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {CATEGORY_LABELS[entry.category]}
        </span>
      </header>

      <div>
        <p className="text-[10px] font-semibold text-neutral-500">現象</p>
        <p className="mt-0.5 text-xs text-neutral-300">{entry.phenomenon}</p>
      </div>
      <div>
        <p className="text-[10px] font-semibold text-neutral-500">機構</p>
        <p className="mt-0.5 text-[11px] text-neutral-400">{entry.mechanism}</p>
      </div>

      {/* 生成できない項目の主役はここ。エラー色ではなく sky（このアプリで
          「確定した性質」に使っている色。StatusBanner.tsx の「確定」バッジと同じ語彙）で、
          本文サイズも他の説明文より大きく取る */}
      {isUnbuildableIllusion(entry) && (
        <div className="rounded border border-sky-400/30 bg-sky-400/5 p-2.5">
          <p className="text-[10px] font-semibold tracking-wide text-sky-300">
            この方式では作れない理由
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-neutral-100">
            {entry.notBuildableReason}
          </p>
        </div>
      )}

      {entry.credit !== undefined && (
        <p className="text-[10px] text-neutral-600">出典: {entry.credit}</p>
      )}

      {isBuildableIllusion(entry) ? (
        <button
          type="button"
          onClick={onSelect}
          className="mt-1 min-h-11 rounded border border-sky-400/60 px-3 text-xs text-sky-200 hover:bg-sky-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          この立体を作る
        </button>
      ) : (
        <p className="mt-1 text-[10px] text-neutral-600">
          この方式では生成しません。理由は上記のとおりです。
        </p>
      )}
    </article>
  )
}
