/**
 * 「これは何と何からできている？」パズルパネル（副次要素。puzzle/puzzle.ts の UI）。
 *
 * 出題・採点のロジックは一切ここに持たない — `generatePuzzleQuestion` と
 * `puzzleReducer`（puzzle/puzzle.ts）をそのまま呼ぶだけ。このパネルの責務は 4 つ:
 *
 * 1. 出題された正解ペアを、既存のスタジオストアへ **同じ `applyInput` 経路**で
 *    流し込む（Gallery.tsx と同じ 1 トランザクション契約）。生成・描画は
 *    既存の生成パイプライン / Viewport がそのまま担う — パズル専用の
 *    レンダリング経路は作らない。
 * 2. 経過時間の計測。`puzzleReducer` は `elapsedMs` を**受け取るだけ**の
 *    純関数（タイマーを持たない）なので、「いつ出題され、いつ回答したか」の
 *    時計はここが持つ。
 * 3. シルエットピッカーを画面に出さないこと。App.tsx はパズルモード中
 *    `<Sidebar />`（`<SilhouettePicker />` を含む）をそもそもマウントしない
 *    — 出題ペアがそのままフォームの選択状態として見えてしまうと、
 *    見た瞬間に答えが分かってしまうため。ここでは何もしなくてよいが、
 *    「なぜこの画面に SilhouettePicker が無いのか」の理由はここに書いておく。
 * 4. **出題は必ず俯瞰（iso）から**。カメラ・ビューポートは全モード共通の
 *    単一インスタンスで、カメラの状態はモード切り替えを跨いで生き残る
 *    （scene/Viewport.tsx 冒頭）。自由モードで 正面 (A) / 側面 (B) 等の
 *    正射影スナップへ切り替えた**あとに**クイズタブへ移ると、その正射影が
 *    そのまま残り、答えのシルエットが最初から画面に出てしまう
 *    （adversarial review で確認された欠陥）。`<Sidebar />` はパズルモード中
 *    マウントされないためスナップボタンには到達できないが、直前のモードで
 *    押されたスナップの**残留状態**はここで能動的に打ち消す必要がある —
 *    出題（初回・「次の問題へ」の両方）のたびに `requestSnap('iso')` を呼ぶ。
 *    回答後は逆に、正面 / 側面へのスナップを**ご褒美として**このパネルから
 *    提供する（`REVEAL_BUTTONS`）— 正解を見る唯一の経路をここに限定する。
 * 5. **カメラの演出モードを解除すること**。「常に回転できるとすぐに
 *    ネタバラシになる」はカタログ向けの制約で、クイズは逆 — 立体を
 *    あらゆる角度から調べること自体がパズルなので、自由回転は必須。
 *    マウント時に `curatedMode` / `rotationLocked` を両方解除する
 *    （scene/CameraRig.tsx 冒頭のコメントを参照。App.tsx / Gallery.tsx を
 *    編集せずにモード連動を実現する唯一の観測点がこのマウント境界のため）。
 *    A / B スナップそのものを封鎖する（責務 4 の話）のとは別の軸の制約で、
 *    自由回転の可否は封鎖しない — 立体を眺め回すことと、正解シルエットへ
 *    正確にスナップすることは別の操作である。
 */
/* eslint-disable react-refresh/only-export-components --
 * `pairToInputSpec` / `optionLabel` を純関数として export し、Node の Vitest
 * から DOM なしで検証する（PuzzlePanel.test.ts）。VirtualMirror.tsx と同じ
 * 事情: 単体で完結する小さなロジックのためだけに 2 ファイルへ割らない。
 * 編集時の Fast Refresh がフルリロードになる小さな代償を許容する */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { PresetId } from '../geometry/types'
import {
  createInitialPuzzleSession,
  generatePuzzleQuestion,
  puzzleReducer,
  type DifficultyLevel,
  type PuzzlePair,
} from '../puzzle/puzzle'
import { useStudioStore, type StudioInputSpec } from '../store/useStudioStore'
import { useViewerStore, type SnapView } from '../scene/SweetSpot'

/**
 * プリセット id → 表示名。SilhouettePicker.tsx が同内容の `PRESET_LABELS` を
 * 持つが export されていない（あちらの所有物で、このタスクでは編集できない）ため
 * ここに複製する。`Record<PresetId, string>` で全 id を網羅させ、プリセットが
 * 増えたときにここが増えていなければコンパイルエラーになるようにしてある
 * （sources/presets.ts の BUILDERS と同じ防御）。
 */
const PRESET_LABELS: Record<PresetId, string> = {
  circle: '円',
  square: '正方形',
  triangle: '正三角形',
  heart: 'ハート',
  star: '星',
  arrow: '矢印',
  cross: '十字',
  spade: 'スペード',
  diamond: 'ダイヤ',
  club: 'クラブ',
}

const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  easy: 'やさしい',
  medium: 'ふつう',
  hard: 'むずかしい',
}

/**
 * 出題ペア → ストア入力（テスト対象の純粋関数）。
 * 視点 C は使わず、軸角は省略して既定の直交 90° に落とす — パズルは
 * 現エンジンで今日作れる 2 軸交差の範囲だけを出題する（puzzle.ts の
 * `candidatePool` が `PRESET_IDS` の 2 軸プリセットしか組まないのと対応する）。
 */
export function pairToInputSpec(pair: PuzzlePair): StudioInputSpec {
  return {
    a: { kind: 'preset', id: pair.a },
    b: { kind: 'preset', id: pair.b },
  }
}

/** 選択肢 1 件の表示ラベル（例:「円 × 正方形」）。テスト対象の純粋関数 */
export function optionLabel(pair: PuzzlePair): string {
  return `${PRESET_LABELS[pair.a]} × ${PRESET_LABELS[pair.b]}`
}

/** 出題シード。セッションを開くたびに 1 回だけ決める（決定的である必要はない）。 */
function randomSeed(): string {
  return `puzzle-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 回答後に「正解のシルエットを見る」ためのスナップボタン（ご褒美。ファイル
 * 冒頭コメントの責務 4）。視点 C はパズルが使わないため top は含めない
 * （`pairToInputSpec` の doc comment を参照）。
 */
const REVEAL_BUTTONS: ReadonlyArray<{ view: SnapView; label: string }> = [
  { view: 'front', label: '正面 (A)' },
  { view: 'side', label: '側面 (B)' },
]

/** パズルパネル。App.tsx はこれを `<PuzzlePanel />` として置くだけでよい */
export function PuzzlePanel() {
  const applyInput = useStudioStore((s) => s.applyInput)
  const requestSnap = useViewerStore((s) => s.requestSnap)
  const [seed] = useState(randomSeed)
  const indexRef = useRef(0)
  const startedAtRef = useRef(0)
  const [session, dispatch] = useReducer(puzzleReducer, createInitialPuzzleSession())

  // 責務 5（ファイル冒頭）：クイズは自由回転が必須（調べること自体がパズル）
  // なので、マウント中は curatedMode / rotationLocked を両方解除する。
  // 下の「初回出題」effect より先に実行される必要がある —
  // curatedMode が true のまま loadQuestion → applyInput が走ると、
  // scene/CameraRig.tsx の自動演出（視点 A への強制スナップ）が誤発火し、
  // 直後の requestSnap('iso') と競合する。宣言順で先に置くことで保証する
  useEffect(() => {
    const store = useViewerStore.getState()
    store.setCuratedMode(false)
    store.setRotationLocked(false)
    return () => {
      useViewerStore.getState().setCuratedMode(true)
    }
  }, [])

  /**
   * 出題 → ストア反映 → 時計スタート → 俯瞰へ強制、を 1 セットで行う。
   * `applyInput` はレンダー中に呼んではいけない（外部ストアへの書き込みは
   * effect からのみ行う）ため、この関数自体も effect / イベントハンドラからだけ呼ぶ。
   *
   * `requestSnap('iso')` が必須な理由（ファイル冒頭の責務 4）：ビューポートは
   * 全モード共通の単一インスタンスで、カメラの投影・向きはモード切り替えを
   * 跨いで保持される。自由モードで 正面 (A) 等の正射影スナップへ切り替えた
   * 状態のままクイズタブへ来ると、この呼び出しがない限り答えのシルエットが
   * 最初から画面に出てしまう。
   */
  const loadQuestion = useCallback(
    (index: number): void => {
      const question = generatePuzzleQuestion(seed, index)
      indexRef.current = index
      dispatch({ type: 'question-loaded', question })
      startedAtRef.current = performance.now()
      const correct = question.options[question.correctOptionIndex]
      applyInput(pairToInputSpec(correct))
      requestSnap('iso')
    },
    [seed, applyInput, requestSnap],
  )

  // 初回出題は 1 回だけ。以降は「次の問題へ」ボタン（handleNext）から呼ぶ
  useEffect(() => {
    loadQuestion(0)
  }, [loadQuestion])

  // useCallback で包む（handleAnswer 単体では「レンダー中に呼ばれない」ことが
  // 静的に判別できず、performance.now() の呼び出しが react-hooks/purity に
  // 引っかかる — loadQuestion と同じ扱いに揃える）
  const handleAnswer = useCallback((optionIndex: number): void => {
    const elapsedMs = performance.now() - startedAtRef.current
    dispatch({ type: 'answer-submitted', optionIndex, elapsedMs })
  }, [])

  const handleNext = useCallback((): void => {
    loadQuestion(indexRef.current + 1)
  }, [loadQuestion])

  const { question } = session
  const answered = session.selectedOptionIndex !== null

  return (
    <div className="pad-safe flex h-full flex-col gap-3 overflow-y-auto overscroll-contain pt-2">
      <div>
        <h1 className="text-sm font-semibold tracking-wide text-neutral-100">
          これは何と何からできている？
        </h1>
        <p className="mt-1 text-[11px] text-neutral-500">
          ビューポートの立体は、2 つのプリセット図形の交差からできています。元になった組み合わせを選んでください。
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-neutral-400">
        <div>
          <dt className="text-neutral-600">スコア</dt>
          <dd className="text-neutral-200">{session.score}</dd>
        </div>
        <div>
          <dt className="text-neutral-600">連続正解</dt>
          <dd className="text-neutral-200">
            {session.streak}（最高 {session.bestStreak}）
          </dd>
        </div>
        <div>
          <dt className="text-neutral-600">正解数</dt>
          <dd className="text-neutral-200">
            {session.correctCount} / {session.answeredCount}
          </dd>
        </div>
        {question !== null && (
          <div>
            <dt className="text-neutral-600">難易度</dt>
            <dd className="text-neutral-200">{DIFFICULTY_LABELS[question.difficulty]}</dd>
          </div>
        )}
      </dl>

      {question === null ? (
        <p role="status" className="text-xs text-neutral-400">
          出題を準備しています…
        </p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="sr-only">選択肢</legend>
            {question.options.map((option, index) => {
              const isCorrectOption = index === question.correctOptionIndex
              const isSelected = index === session.selectedOptionIndex
              const showResult = answered && (isSelected || isCorrectOption)
              return (
                <button
                  key={index}
                  type="button"
                  disabled={answered}
                  onClick={() => handleAnswer(index)}
                  aria-pressed={isSelected}
                  className={`min-h-11 rounded border px-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-80 ${
                    showResult
                      ? isCorrectOption
                        ? 'border-emerald-400 bg-emerald-400/10 text-emerald-200'
                        : 'border-red-400 bg-red-400/10 text-red-200'
                      : 'border-neutral-700 text-neutral-200 hover:bg-neutral-800'
                  }`}
                >
                  {optionLabel(option)}
                  {showResult && (
                    <span className="ml-2" aria-hidden="true">
                      {isCorrectOption ? '✓' : isSelected ? '✗' : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </fieldset>

          <p role="status" className="text-xs text-neutral-300">
            {!answered
              ? '組み合わせを選んでください。'
              : session.isCorrect
                ? '正解です。'
                : `不正解です。正解は「${optionLabel(question.options[question.correctOptionIndex])}」でした。`}
          </p>

          {/*
            回答後だけのご褒美（ファイル冒頭の責務 4）。正面 / 側面へのスナップを
            出題中は一切提供しない（`<Sidebar />` 自体がパズルモードでは
            マウントされないため到達できない）ことで「回答前にシルエットを
            見る手段がない」を構造的に保証し、回答後はここから素直に見せる。
          */}
          {answered && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] text-neutral-500">正解のシルエットを見る:</p>
              <div className="flex gap-1.5">
                {REVEAL_BUTTONS.map(({ view, label }) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => requestSnap(view)}
                    className="min-h-11 flex-1 rounded border border-neutral-600 px-3 text-xs text-neutral-200 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {answered && (
            <button
              type="button"
              onClick={handleNext}
              className="min-h-11 rounded border border-sky-400/60 px-3 text-xs text-sky-200 hover:bg-sky-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              次の問題へ
            </button>
          )}
        </>
      )}
    </div>
  )
}
