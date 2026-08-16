/**
 * 視点 1 つ分の入力 UI（Task 5.2 / FR-001〜FR-006 / US-002）。
 *
 * プリセット / 文字 / SVG の **3 タブすべて**をここで完結させる。Wave 6 は
 * 解析ロジック（sources/text.ts・sources/svg.ts のスタブ中身）だけを実装し、
 * この UI には触れない（tasks.md Task 5.2 Note）。スタブが reject する間も
 * UI の動作は同じ — コミット → パイプラインが拒否 → 直前の有効入力へ復帰。
 *
 * ## タブはローカル UI 状態（ストアと同期しない）
 *
 * タブ選択は「どの入力方法で作業しているか」であり、ストアの入力状態とは
 * 別物として扱う。SVG が拒否されストアが直前の有効入力（例: プリセット）へ
 * 復帰しても（FR-006）、ユーザーは SVG タブに留まり、拒否の理由を見ながら
 * 次のファイルを試せる。ストア変更にタブを追従させると、拒否のたびに
 * タブが切り替わって理由の表示ごと消えてしまう。
 *
 * ## 拒否の検出（US-002「アップロードを拒否し理由を表示」）
 *
 * パイプラインは拒否理由をストアへ書かない（`restoreLastValidInput` を呼ぶ
 * だけ）。そこで自分がコミットした入力を `pendingRef` に控え、**受理
 * （`lastValidInput` への昇格）を確認する前にストアから消えたら**拒否による
 * 復帰とみなして通知を表示する。受理を確認したら pending を破棄する。
 * ストアの epoch 検査（useStudioStore.ts）により、再編集後に届いた古い拒否は
 * store 側で無視されるため、ここで見える「消えた」はほぼ拒否復帰に対応する。
 *
 * ## アクセシビリティ（FR-027）
 * - タブは WAI-ARIA tabs パターン（roving tabindex + 矢印キー / Home / End）
 * - プリセットはネイティブ radio（sr-only）+ ラベル。選択状態は radio の
 *   checked に加えテキストの「✓」でも提示し、色だけに依存しない
 * - 非表示パネルは `hidden` 属性で DOM に残す（入力途中の状態を保持しつつ、
 *   タブ順序と支援技術ツリーからは除外される）
 * - 拒否・ファイルエラーの通知は常設の aria-live リージョンに流す
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { PresetId, SilhouetteSource } from '../geometry/types'
import { PRESET_IDS } from '../sources/presets'
import { useStudioStore } from '../store/useStudioStore'
import { SvgDropzone } from './SvgDropzone'

/** 文字入力の契約（FR-002 / US-002）: 英数字 1〜8 文字 */
const TEXT_PATTERN = /^[0-9A-Za-z]{1,8}$/

/**
 * 同梱フォントの既定 id。Task 6.1（sources/text.ts の実装）は
 * この id で参照できるフォントを同梱する契約 — UI 側は編集不要。
 */
export const DEFAULT_FONT_ID = 'default'

/**
 * SVG の生テキストとして受け付ける上限バイト数。
 * 実体の頂点数上限（10,000。FR-005）はパーサ側が守る — ここは巨大ファイルを
 * 文字列として読み込んで UI が固まるのを防ぐだけの入り口ガード。
 */
const MAX_SVG_BYTES = 10 * 1024 * 1024

type InputKind = SilhouetteSource['kind']

/** タブの表示順。全 3 種を常に提示する（Task 5.2: 3 つとも） */
const KINDS: readonly InputKind[] = ['preset', 'text', 'svg']

const KIND_LABELS: Record<InputKind, string> = {
  preset: 'プリセット',
  text: '文字',
  svg: 'SVG',
}

/** FR-001 の 7 図形の表示名。id は sources/presets.ts の PRESET_IDS と対応 */
const PRESET_LABELS: Record<PresetId, string> = {
  circle: '円',
  square: '正方形',
  triangle: '正三角形',
  heart: 'ハート',
  star: '星',
  arrow: '矢印',
  cross: '十字',
}

const VIEWPOINT_LABELS = {
  a: '視点 A（正面から見える形）',
  b: '視点 B（側面から見える形）',
} as const

/** プリセットの形をそのまま示すピクトグラム（装飾。ラベルテキストが実体） */
const ICON_SHAPES: Record<PresetId, ReactElement> = {
  circle: <circle cx="12" cy="12" r="9" fill="currentColor" />,
  square: <rect x="4" y="4" width="16" height="16" fill="currentColor" />,
  triangle: <polygon points="12,4 21,19.6 3,19.6" fill="currentColor" />,
  heart: (
    <path
      d="M12 20 C 5 14 3 9 6.5 6.5 C 9 4.8 11.2 6 12 8 C 12.8 6 15 4.8 17.5 6.5 C 21 9 19 14 12 20 Z"
      fill="currentColor"
    />
  ),
  star: (
    <polygon
      points="12,2 14.25,8.91 21.51,8.91 15.63,13.18 17.88,20.09 12,15.82 6.12,20.09 8.37,13.18 2.49,8.91 9.75,8.91"
      fill="currentColor"
    />
  ),
  arrow: <polygon points="3,10 13,10 13,6 21,12 13,18 13,14 3,14" fill="currentColor" />,
  cross: (
    <polygon
      points="10,3 14,3 14,10 21,10 21,14 14,14 14,21 10,21 10,14 3,14 3,10 10,10"
      fill="currentColor"
    />
  ),
}

function PresetIcon(props: { id: PresetId }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" aria-hidden="true">
      {ICON_SHAPES[props.id]}
    </svg>
  )
}

/**
 * 拒否による復帰（FR-006）の通知文言。理由の詳細はパイプラインがストアへ
 * 書かないため、入力種別ごとの一般的な理由を添える。
 */
function rejectMessage(rejected: SilhouetteSource): string {
  switch (rejected.kind) {
    case 'svg':
      return `「${rejected.fileName}」は読み込めませんでした（閉じたパスがない・対応していない内容など）。直前の有効な入力に戻しました。`
    case 'text':
      return `文字「${rejected.value}」を立体化できませんでした。直前の有効な入力に戻しました。`
    case 'preset':
      return '入力を確定できませんでした。直前の有効な入力に戻しました。'
  }
}

export interface SilhouettePickerProps {
  /** どちらの視点の入力を編集するか。'a' = 正面、'b' = 側面 */
  viewpoint: 'a' | 'b'
}

/** 視点 1 つ分の入力タブ（プリセット / 文字 / SVG）。状態はストアから読む */
export function SilhouettePicker(props: SilhouettePickerProps) {
  const { viewpoint } = props
  const baseId = useId()
  const source = useStudioStore((s) => s.input[viewpoint])
  const lastValid = useStudioStore((s) => s.lastValidInput[viewpoint])
  const setSource = useStudioStore((s) =>
    viewpoint === 'a' ? s.setSilhouetteA : s.setSilhouetteB,
  )

  const [activeTab, setActiveTab] = useState<InputKind>(source.kind)
  const [text, setText] = useState(source.kind === 'text' ? source.value : '')
  const [fileError, setFileError] = useState<string | null>(null)
  const [rejectNotice, setRejectNotice] = useState<string | null>(null)
  /** 自分がコミットしたが、まだ受理（lastValidInput 昇格）を確認していない入力 */
  const pendingRef = useRef<SilhouetteSource | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  /** ストアへのコミット。pending に控えてから書く（拒否検出のため） */
  const commit = (next: SilhouetteSource): void => {
    pendingRef.current = next
    setRejectNotice(null)
    setSource(next)
  }

  // コミットした入力の行方を監視する：受理されたら pending を破棄、
  // 受理前にストアから消えたら「拒否による復帰」として通知する
  useEffect(() => {
    const pending = pendingRef.current
    if (pending === null) return
    if (source === pending) {
      if (lastValid === pending) pendingRef.current = null
      return
    }
    pendingRef.current = null
    setRejectNotice(rejectMessage(pending))
  }, [source, lastValid])

  const tabId = (kind: InputKind): string => `${baseId}-tab-${kind}`
  const panelId = (kind: InputKind): string => `${baseId}-panel-${kind}`
  const textId = `${baseId}-text`
  const textHintId = `${baseId}-text-hint`
  const svgInputId = `${baseId}-svg-file`
  const svgHintId = `${baseId}-svg-hint`

  /** WAI-ARIA tabs パターンのキーボード操作（矢印 / Home / End、自動活性化） */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (index + 1) % KINDS.length
    else if (event.key === 'ArrowLeft') next = (index + KINDS.length - 1) % KINDS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = KINDS.length - 1
    if (next === null) return
    event.preventDefault()
    setActiveTab(KINDS[next])
    tabRefs.current[next]?.focus()
  }

  const textInvalid = text.length > 0 && !TEXT_PATTERN.test(text)

  const handleTextChange = (value: string): void => {
    setText(value)
    // 有効な値だけコミットする。打鍵の合流・stale 破棄は下流
    // （client の 120ms デバウンス + 世代 ID。NFR-004）が担う
    if (TEXT_PATTERN.test(value)) {
      commit({ kind: 'text', value, fontId: DEFAULT_FONT_ID })
    }
  }

  /** ドロップ / ファイル選択の共通経路。読み取れたらストアへコミットする */
  const handleFile = (file: File): void => {
    setFileError(null)
    const looksSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml'
    if (!looksSvg) {
      setFileError('SVG ファイル（.svg）を選択してください。')
      return
    }
    if (file.size > MAX_SVG_BYTES) {
      setFileError('ファイルが大きすぎます（10MB 以下の SVG を選択してください）。')
      return
    }
    // 内容の検証（閉パスの有無・対応範囲）は sources/svg.ts の責務。
    // ここで読むのはテキストだけで、ネットワーク送信は発生しない（NFR-030）
    void file.text().then(
      (raw) => commit({ kind: 'svg', fileName: file.name, raw }),
      () => setFileError('ファイルを読み取れませんでした。'),
    )
  }

  const notice = fileError ?? rejectNotice

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex flex-col gap-2">
      <h2 id={`${baseId}-heading`} className="text-xs font-semibold text-neutral-200">
        {VIEWPOINT_LABELS[viewpoint]}
      </h2>

      <div
        role="tablist"
        aria-label={`${VIEWPOINT_LABELS[viewpoint]}の入力方法`}
        className="flex gap-1"
      >
        {KINDS.map((kind, index) => (
          <button
            key={kind}
            ref={(el) => {
              tabRefs.current[index] = el
            }}
            type="button"
            role="tab"
            id={tabId(kind)}
            aria-selected={activeTab === kind}
            aria-controls={panelId(kind)}
            tabIndex={activeTab === kind ? 0 : -1}
            onClick={() => setActiveTab(kind)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className="min-h-11 flex-1 rounded border border-neutral-700 px-2 text-xs text-neutral-400 aria-selected:border-sky-400 aria-selected:bg-sky-400/10 aria-selected:text-sky-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>

      {/* プリセット（FR-001）。ネイティブ radio による選択 — 矢印キーで移動できる */}
      <div
        role="tabpanel"
        id={panelId('preset')}
        aria-labelledby={tabId('preset')}
        hidden={activeTab !== 'preset'}
      >
        <fieldset>
          <legend className="sr-only">{VIEWPOINT_LABELS[viewpoint]}のプリセット図形</legend>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESET_IDS.map((id) => (
              <label
                key={id}
                className="group flex min-h-11 cursor-pointer items-center gap-2 rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 select-none has-[:checked]:border-sky-400 has-[:checked]:bg-sky-400/10 has-[:checked]:text-sky-200 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-400"
              >
                <input
                  type="radio"
                  name={`${baseId}-preset`}
                  value={id}
                  checked={source.kind === 'preset' && source.id === id}
                  onChange={() => commit({ kind: 'preset', id })}
                  className="sr-only"
                />
                <PresetIcon id={id} />
                <span>{PRESET_LABELS[id]}</span>
                {/* 選択の視覚提示は枠色 + ✓ の両方（色だけに依存しない） */}
                <span className="ml-auto hidden group-has-[:checked]:inline" aria-hidden="true">
                  ✓
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {/* 文字（FR-002）。英数字 1〜8 文字のみコミットする */}
      <div
        role="tabpanel"
        id={panelId('text')}
        aria-labelledby={tabId('text')}
        hidden={activeTab !== 'text'}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={textId} className="text-xs text-neutral-300">
            文字（英数字 1〜8 文字）
          </label>
          <input
            id={textId}
            type="text"
            value={text}
            maxLength={8}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={textInvalid}
            aria-describedby={textHintId}
            onChange={(event) => handleTextChange(event.target.value)}
            className="min-h-11 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-100 aria-[invalid=true]:border-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          />
          <p id={textHintId} className="text-[11px] text-neutral-500">
            {textInvalid
              ? '英数字（A–Z / a–z / 0–9）のみ、1〜8 文字で入力してください。'
              : '入力した文字のアウトライン（穴を含む）がシルエットになります。'}
          </p>
        </div>
      </div>

      {/* SVG（FR-003 / FR-005 / FR-027）。ドロップ領域 + 同等の file input */}
      <div
        role="tabpanel"
        id={panelId('svg')}
        aria-labelledby={tabId('svg')}
        hidden={activeTab !== 'svg'}
      >
        <div className="flex flex-col gap-1">
          <SvgDropzone
            inputId={svgInputId}
            describedById={svgHintId}
            currentFileName={source.kind === 'svg' ? source.fileName : null}
            onFile={handleFile}
          />
          <p id={svgHintId} className="text-[11px] text-neutral-500">
            閉じたパスを含む SVG（.svg）のみ。ファイルは端末内で処理され、外部へ送信されません。
          </p>
        </div>
      </div>

      {/* 拒否・ファイルエラーの通知（常設の live リージョン） */}
      <p aria-live="polite" className="text-[11px] text-amber-300">
        {notice ?? ''}
      </p>
    </section>
  )
}
