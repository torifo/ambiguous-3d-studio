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
 *
 * ## 選択ハイライトは「クリックした事実」ではなく「現在の入力」から導く
 *
 * かつてはクリック時に `setSelectedId(entry.id)` する `useState` で強調表示を
 * 持っていた。これは嘘をつく：SVG／文字ソースの解析が非同期で失敗すると
 * パイプラインは `restoreLastValidInput` で直前の有効入力へ戻す
 * （useGenerationPipeline.ts）が、その通知はストアの `input` にしか現れず、
 * Gallery はそれを購読していなかったため、失敗したカードが選択されたままに
 * 見えていた（カタログ先頭の #12 影の両義立体はテキストソースなので、同梱
 * フォントの読み込みに失敗するとこの経路を静かに踏む）。
 *
 * 修正は `selectedId` という独立した状態を持たないこと — 現在ハイライトすべき
 * 項目は `useStudioStore` の `input` から**毎回導出**する（{@link findAppliedEntryId}）。
 * `input` は成功時はクリックした項目のプリセットのまま、拒否・復帰時は
 * 直前の入力へ書き戻るので、どちらの場合も「実際に今適用されている入力」と
 * ハイライトが必ず一致する。副作用として、他のモードで手動編集した入力が
 * たまたまカタログ項目と一致していれば、カタログへ戻ったときに正しく
 * ハイライトされる（クリックした記憶に頼らないため）。
 */
/* eslint-disable react-refresh/only-export-components --
 * `applyIllusionSelection` / `findAppliedEntryId` を純関数として export し、
 * Node の Vitest から DOM なしで検証する（Gallery.test.ts）。コンポーネントと
 * 別ファイルに分けない理由は VirtualMirror.tsx と同じ: 単体で完結する小さな
 * ロジックをわざわざ 2 ファイルに割る理由がない。編集時の Fast Refresh が
 * フルリロードになる小さな代償を許容する */
import { useMemo } from 'react'
import type { SilhouetteSource } from '../geometry/types'
import { DEFAULT_AXIS_ANGLE_DEG } from '../worker/protocol'
import {
  ILLUSIONS,
  isBuildableIllusion,
  type IllusionEntry,
  type IllusionPreset,
} from '../catalogue/illusions'
import { useStudioStore, type StudioInput, type StudioInputSpec } from '../store/useStudioStore'
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

/** 2 つの `SilhouetteSource` が同じ入力を表すか（種別と中身の構造比較） */
function sourcesEqual(a: SilhouetteSource, b: SilhouetteSource): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'preset':
      return b.kind === 'preset' && a.id === b.id
    case 'text':
      return b.kind === 'text' && a.value === b.value && a.fontId === b.fontId
    case 'svg':
      return b.kind === 'svg' && a.fileName === b.fileName && a.raw === b.raw
  }
}

/**
 * ストアの現在の `input` が、あるカタログ項目の `preset` と一致するか。
 * `preset.c` / `preset.axisAngleDeg` の省略は store 側の既定
 * （`c: null` / `axisAngleDeg: 90`）と同じ意味なので、その既定に正規化してから比べる。
 */
function inputMatchesPreset(input: StudioInput, preset: IllusionPreset): boolean {
  if (!sourcesEqual(input.a, preset.a)) return false
  if (!sourcesEqual(input.b, preset.b)) return false
  const presetC = preset.c ?? null
  if (presetC === null) {
    if (input.c !== null) return false
  } else if (input.c === null || !sourcesEqual(input.c, presetC)) {
    return false
  }
  const presetAxis = preset.axisAngleDeg ?? DEFAULT_AXIS_ANGLE_DEG
  return input.axisAngleDeg === presetAxis
}

/**
 * 現在ストアに適用されている入力に一致するカタログ項目の id（なければ null）。
 * 「クリックした」ではなく「今この入力が実際に適用されている」を見るので、
 * 拒否によって入力が復帰した後は自動的に一致しなくなる。
 */
export function findAppliedEntryId(input: StudioInput): string | null {
  for (const entry of ILLUSIONS) {
    if (isBuildableIllusion(entry) && inputMatchesPreset(input, entry.preset)) return entry.id
  }
  return null
}

/** カタログ。App.tsx はこれを `<Gallery />` として置くだけでよい（必須 props なし） */
export function Gallery() {
  const applyInput = useStudioStore((s) => s.applyInput)
  const input = useStudioStore((s) => s.input)
  const selectedId = useMemo(() => findAppliedEntryId(input), [input])

  const handleSelect = (entry: IllusionEntry): void => {
    applyIllusionSelection(entry, applyInput)
  }

  return (
    <div className="pad-safe flex h-full flex-col gap-3 overflow-y-auto overscroll-contain pt-2">
      <div>
        {/* Ambiguous 3D Studio という製品名の <h1> は App.tsx のシェルへ集約した
            （3 モード共通の 1 つの見出しにするため）。ここは 2 段目の見出し */}
        <h2 className="text-sm font-semibold tracking-wide text-neutral-100">錯視立体カタログ</h2>
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
