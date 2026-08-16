/**
 * 「これは何と何からできている？」パズルパネル（副次要素。puzzle/puzzle.ts の UI）。
 *
 * 出題・採点のロジックは一切ここに持たない — `generatePuzzleQuestion` と
 * `puzzleReducer`（puzzle/puzzle.ts）をそのまま呼ぶだけ。このパネルの責務は 3 つ:
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

/** パズルパネル。App.tsx はこれを `<PuzzlePanel />` として置くだけでよい */
export function PuzzlePanel() {
  const applyInput = useStudioStore((s) => s.applyInput)
  const [seed] = useState(randomSeed)
  const indexRef = useRef(0)
  const startedAtRef = useRef(0)
  const [session, dispatch] = useReducer(puzzleReducer, createInitialPuzzleSession())

  /**
   * 出題 → ストア反映 → 時計スタート、を 1 セットで行う。
   * `applyInput` はレンダー中に呼んではいけない（外部ストアへの書き込みは
   * effect からのみ行う）ため、この関数自体も effect / イベントハンドラからだけ呼ぶ。
   */
  const loadQuestion = useCallback(
    (index: number): void => {
      const question = generatePuzzleQuestion(seed, index)
      indexRef.current = index
      dispatch({ type: 'question-loaded', question })
      startedAtRef.current = performance.now()
      const correct = question.options[question.correctOptionIndex]
      applyInput(pairToInputSpec(correct))
    },
    [seed, applyInput],
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
