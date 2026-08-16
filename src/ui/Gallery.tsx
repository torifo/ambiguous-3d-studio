/**
 * 錯視立体カタログのギャラリー（FR-100 / FR-103）。
 *
 * アプリの**主たる入口**。`ILLUSIONS`（catalogue/illusions.ts）の全 12 項目を
 * 表示順そのままに一覧する。並び替え・フィルタは仕様書にない機能なので足さない
 * — カタログの先頭が #12 影の両義立体（このアプリの数理そのもの）であることに
 * 意味があり、UI が勝手に並びを変えるとその意図が壊れる。
 *
 * 生成できる項目を選ぶと {@link applyIllusionSelection} が
 * `useStudioStore.applyInput` を **1 回だけ** 呼ぶ。a / b / c を個別に
 * setSilhouetteX すると epoch が 3 回進み、中間状態（例: C だけ差し替わった
 * 不整合な組）にもプリフライトが走ってしまう（useStudioStore.ts の
 * `applyInput` の doc comment）。ここは新規ファイルだが、この禁を破らないための
 * ロジックだけを純粋関数として切り出し、DOM なしでテストする。
 *
 * ジオメトリの表示は「同じビューポート」（scene/Viewport.tsx）が担う。
 * Gallery 自身は Viewport に触れない — 入力を差し替えれば、App.tsx が
 * 1 度だけ起動した生成パイプライン（useGenerationPipeline）が購読で拾って
 * 生成し、Viewport はその結果を描くだけ、という既存の配線に乗るだけでよい。
 */
/* eslint-disable react-refresh/only-export-components --
 * `applyIllusionSelection` を純関数として export し、Node の Vitest から
 * DOM なしで検証する（Gallery.test.ts）。コンポーネントと別ファイルに
 * 分けない理由は VirtualMirror.tsx と同じ: 単体で完結する小さなロジックを
 * わざわざ 2 ファイルに割る理由がない。編集時の Fast Refresh がフル
 * リロードになる小さな代償を許容する */
import { useState } from 'react'
import { ILLUSIONS, isBuildableIllusion, type IllusionEntry } from '../catalogue/illusions'
import { useStudioStore, type StudioInputSpec } from '../store/useStudioStore'
import { IllusionCard } from './IllusionCard'

/**
 * カタログ項目の選択をストアへ反映する（この Gallery の中核ロジック。
 * DOM を必要としないのでテストは Node で行う）。
 *
 * 生成できる項目（`isBuildableIllusion` で判定）のときだけ `applyInput` を
 * ちょうど 1 回呼ぶ。生成できない項目は `preset` を持たないため何もしない
 * — 呼び出し側（IllusionCard）はそもそも生成できない項目にボタンを出さないが、
 * ここでも二重に安全側へ倒しておく。
 */
export function applyIllusionSelection(
  entry: IllusionEntry,
  applyInput: (spec: StudioInputSpec) => void,
): void {
  if (!isBuildableIllusion(entry)) return
  applyInput(entry.preset)
}

/** カタログ。App.tsx はこれを `<Gallery />` として置くだけでよい（必須 props なし） */
export function Gallery() {
  const applyInput = useStudioStore((s) => s.applyInput)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const handleSelect = (entry: IllusionEntry): void => {
    applyIllusionSelection(entry, applyInput)
    setSelectedId(entry.id)
  }

  return (
    <div className="pad-safe flex h-full flex-col gap-3 overflow-y-auto overscroll-contain pt-2">
      <div>
        <h1 className="text-sm font-semibold tracking-wide text-neutral-100">錯視立体カタログ</h1>
        <p className="mt-1 text-[11px] text-neutral-500">
          既知の錯視立体を選ぶと、その錯視を再現する入力が設定され、右のビューポートに立体が生成されます。
          この方式では作れないものも、境界を示すために掲載しています。
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {ILLUSIONS.map((entry) => (
          <li key={entry.id}>
            <IllusionCard
              entry={entry}
              selected={selectedId === entry.id}
              onSelect={() => handleSelect(entry)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
