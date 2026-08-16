import { describe, expect, it } from 'vitest'
import type { PresetId } from '../geometry/types'
import { runPreflight } from '../geometry/preflight'
import { normalizeSilhouette } from '../geometry/normalize'
import { PRESET_IDS, presetToContours } from '../sources/presets'
import type { PuzzleAction, PuzzlePair, PuzzleQuestion, PuzzleSessionState } from './puzzle'
import {
  createInitialPuzzleSession,
  generatePuzzleQuestion,
  generatePuzzleSequence,
  listValidPairs,
  pairDifficulty,
  pairsProduceSameSolid,
  puzzleReducer,
} from './puzzle'

/** テスト側で独立に preflight を掛け直すためのヘルパ。モジュール内部の作業高さには依存しない。 */
function contoursFor(id: PresetId) {
  return normalizeSilhouette(presetToContours(id), 1).contours
}

function hasWarning(report: ReturnType<typeof runPreflight>, code: string): boolean {
  return report.warnings.some((w) => w.code === code)
}

const SEEDS = ['demo', 'daily-2026-08-16', 'アヒル', 'seed-2', ''] as const

describe('puzzle: 出題生成', () => {
  describe('正解ペアは常に生成可能（preflight を独立に再実行して検証）', () => {
    it('listValidPairs() の全要素が EMPTY_INTERSECTION を出さない', () => {
      expect(listValidPairs().length).toBeGreaterThan(0)
      for (const pair of listValidPairs()) {
        const report = runPreflight(contoursFor(pair.a), contoursFor(pair.b))
        expect(hasWarning(report, 'EMPTY_INTERSECTION'), `${pair.a}×${pair.b}`).toBe(false)
      }
    })

    it('実際に生成した多数の問題について、正解ペアが EMPTY_INTERSECTION を出さない', () => {
      for (const seed of SEEDS) {
        for (let index = 0; index < 12; index++) {
          const question = generatePuzzleQuestion(seed, index)
          const correct = question.options[question.correctOptionIndex]
          const report = runPreflight(contoursFor(correct.a), contoursFor(correct.b))
          expect(
            hasWarning(report, 'EMPTY_INTERSECTION'),
            `seed=${seed} index=${index} pair=${correct.a}×${correct.b}`,
          ).toBe(false)
        }
      }
    })

    it('LIKELY_DISCONNECTED（分裂しやすい組）もプールに残らない', () => {
      for (const pair of listValidPairs()) {
        const report = runPreflight(contoursFor(pair.a), contoursFor(pair.b))
        expect(hasWarning(report, 'LIKELY_DISCONNECTED'), `${pair.a}×${pair.b}`).toBe(false)
      }
    })
  })

  describe('同じ立体になる組の重複除去', () => {
    it('対称な図形どうし（円×正方形）は順序を入れ替えても「同じ立体」判定になる', () => {
      expect(
        pairsProduceSameSolid({ a: 'circle', b: 'square' }, { a: 'square', b: 'circle' }),
      ).toBe(true)
    })

    it('非対称な矢印が絡む組は順序を入れ替えると「別の立体」判定になる', () => {
      expect(pairsProduceSameSolid({ a: 'arrow', b: 'square' }, { a: 'square', b: 'arrow' })).toBe(
        false,
      )
    })

    it('全く違うペアは同じ立体と判定しない', () => {
      expect(pairsProduceSameSolid({ a: 'circle', b: 'square' }, { a: 'circle', b: 'star' })).toBe(
        false,
      )
    })

    it('出題プールに、同じ立体になる組が 2 つ以上残らない（対称ペアは片方の順序しか出てこない）', () => {
      const pairs = listValidPairs()
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          expect(
            pairsProduceSameSolid(pairs[i], pairs[j]),
            `${JSON.stringify(pairs[i])} vs ${JSON.stringify(pairs[j])}`,
          ).toBe(false)
        }
      }
    })

    it('1 問の中のどの 2 選択肢を取っても同じ立体にならない（多数の問題で検証）', () => {
      for (const seed of SEEDS) {
        for (let index = 0; index < 12; index++) {
          const { options } = generatePuzzleQuestion(seed, index)
          for (let i = 0; i < options.length; i++) {
            for (let j = i + 1; j < options.length; j++) {
              expect(
                pairsProduceSameSolid(options[i], options[j]),
                `seed=${seed} index=${index}: ${JSON.stringify(options[i])} vs ${JSON.stringify(options[j])}`,
              ).toBe(false)
            }
          }
        }
      }
    })
  })

  describe('決定性', () => {
    it('同じ seed・同じ index は常に同じ問題を返す', () => {
      const q1 = generatePuzzleQuestion('repro-seed', 3)
      const q2 = generatePuzzleQuestion('repro-seed', 3)
      expect(q2).toEqual(q1)
    })

    it('同じ seed の問題列は再現できる', () => {
      const seqA = generatePuzzleSequence('daily-2026-08-16', 10)
      const seqB = generatePuzzleSequence('daily-2026-08-16', 10)
      expect(seqB).toEqual(seqA)
    })

    it('異なる seed は問題列が分岐する', () => {
      const seqA = generatePuzzleSequence('seed-alpha', 10)
      const seqB = generatePuzzleSequence('seed-beta', 10)
      expect(seqB).not.toEqual(seqA)
    })

    it('同じ seed でも index が違えば別の問題になりうる（列の中に重複しかないわけではない）', () => {
      const seq = generatePuzzleSequence('variety-check', 10)
      const distinctCorrectPairs = new Set(
        seq.map((q) => {
          const c = q.options[q.correctOptionIndex]
          return [c.a, c.b].sort().join('|')
        }),
      )
      expect(distinctCorrectPairs.size).toBeGreaterThan(1)
    })
  })

  describe('選択肢の構造', () => {
    it('既定では選択肢が 4 つ、そのうち 1 つだけが正解', () => {
      const q = generatePuzzleQuestion('option-count-check', 0)
      expect(q.options).toHaveLength(4)
      expect(q.correctOptionIndex).toBeGreaterThanOrEqual(0)
      expect(q.correctOptionIndex).toBeLessThan(q.options.length)
    })

    it('optionCount を指定するとその数の選択肢になる', () => {
      const q = generatePuzzleQuestion('option-count-check', 1, { optionCount: 3 })
      expect(q.options).toHaveLength(3)
    })

    it('2 未満の optionCount は拒否する', () => {
      expect(() => generatePuzzleQuestion('bad-options', 0, { optionCount: 1 })).toThrow(
        /optionCount/,
      )
    })

    it('負の index は拒否する', () => {
      expect(() => generatePuzzleQuestion('bad-index', -1)).toThrow(/index/)
    })
  })
})

describe('puzzle: 難易度', () => {
  it('easy / medium / hard のすべてに候補ペアが存在し、母集団が互いに異なる', () => {
    const easy = listValidPairs('easy')
    const medium = listValidPairs('medium')
    const hard = listValidPairs('hard')

    expect(easy.length).toBeGreaterThan(0)
    expect(medium.length).toBeGreaterThan(0)
    expect(hard.length).toBeGreaterThan(0)

    // 3 段階は全体プールを過不足なく分割する（同じペアが 2 段階にまたがらない）
    expect(easy.length + medium.length + hard.length).toBe(listValidPairs().length)
    const allLevelPairs = [...easy, ...medium, ...hard]
    for (let i = 0; i < allLevelPairs.length; i++) {
      for (let j = i + 1; j < allLevelPairs.length; j++) {
        expect(pairsProduceSameSolid(allLevelPairs[i], allLevelPairs[j])).toBe(false)
      }
    }

    // 分布そのものが異なることを個数で示す（全部同じ大きさ、は「違うレベル」の証拠にならない）
    const sizes = new Set([easy.length, medium.length, hard.length])
    expect(sizes.size).toBeGreaterThan(1)
  })

  it('非対称な矢印が絡むペアは必ず hard（対称な図形どうしより難しい）', () => {
    for (const pair of listValidPairs('hard')) {
      expect(pair.a === 'arrow' || pair.b === 'arrow', JSON.stringify(pair)).toBe(true)
    }
    for (const pair of [...listValidPairs('easy'), ...listValidPairs('medium')]) {
      expect(pair.a).not.toBe('arrow')
      expect(pair.b).not.toBe('arrow')
    }
  })

  it('矢印が絡むペアは順序を変えても hard のまま（順序が意味を持つので両方が候補になりうる）', () => {
    expect(pairDifficulty('arrow', 'square')).toBe('hard')
    expect(pairDifficulty('square', 'arrow')).toBe('hard')
  })

  it('見た目が大きく異なる対称ペアは easy、似ているペアは medium（具体例で固定する）', () => {
    // square は充填率 1（塗りつぶし矩形）、cross は充填率が低い（腕だけの十字）→ 大きく異なる
    expect(pairDifficulty('square', 'cross')).toBe('easy')
    // circle と square はどちらも「角が丸いか立つか」以外はほぼ同じ充填率・アスペクト比 → 似ている
    expect(pairDifficulty('circle', 'square')).toBe('medium')
  })

  it('対称ペアの難易度は引数の順序に依存しない', () => {
    expect(pairDifficulty('circle', 'square')).toBe(pairDifficulty('square', 'circle'))
    expect(pairDifficulty('square', 'cross')).toBe(pairDifficulty('cross', 'square'))
  })

  it('PRESET_IDS 由来のすべての id が difficulty 計算に参加できる（ハードコード漏れの検出）', () => {
    // listValidPairs() に出てくる id は PRESET_IDS の部分集合であるべきで、
    // 未知の id が紛れ込んでいたらプリセット側の変更にこのモジュールが追随できていない
    const idSet = new Set<PresetId>(PRESET_IDS)
    for (const pair of listValidPairs()) {
      expect(idSet.has(pair.a)).toBe(true)
      expect(idSet.has(pair.b)).toBe(true)
    }
  })
})

describe('puzzle: セッションのリデューサー', () => {
  const question: PuzzleQuestion = {
    id: 'fixture::0',
    seed: 'fixture',
    index: 0,
    difficulty: 'medium',
    options: [
      { a: 'circle', b: 'square' },
      { a: 'triangle', b: 'star' },
      { a: 'heart', b: 'cross' },
    ],
    correctOptionIndex: 1,
  }
  const otherQuestion: PuzzleQuestion = { ...question, id: 'fixture::1', index: 1 }

  const load = (state: PuzzleSessionState, q: PuzzleQuestion): PuzzleSessionState =>
    puzzleReducer(state, { type: 'question-loaded', question: q })

  const answer = (
    state: PuzzleSessionState,
    optionIndex: number,
    elapsedMs = 0,
  ): PuzzleSessionState =>
    puzzleReducer(state, { type: 'answer-submitted', optionIndex, elapsedMs })

  it('初期状態は未回答・スコア 0', () => {
    const state = createInitialPuzzleSession()
    expect(state.question).toBeNull()
    expect(state.selectedOptionIndex).toBeNull()
    expect(state.isCorrect).toBeNull()
    expect(state.streak).toBe(0)
    expect(state.score).toBe(0)
    expect(state.answeredCount).toBe(0)
    expect(state.correctCount).toBe(0)
  })

  it('question が未設定のまま answer-submitted を送っても何も起きない', () => {
    const state = createInitialPuzzleSession()
    const next = answer(state, 0)
    expect(next).toEqual(state)
  })

  it('正解: isCorrect=true・streak が伸び・difficulty 込みの得点が加算される', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)

    expect(state.selectedOptionIndex).toBe(1)
    expect(state.isCorrect).toBe(true)
    expect(state.streak).toBe(1)
    expect(state.bestStreak).toBe(1)
    expect(state.answeredCount).toBe(1)
    expect(state.correctCount).toBe(1)
    // medium 係数 1.25、elapsedMs=0 は速度ボーナス満額（基礎点 100 + ボーナス 50 = 150 → 187.5 → 188）
    expect(state.score).toBe(188)
  })

  it('不正解: streak が 0 に戻り、得点は増えない', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    const wrongIndex = (question.correctOptionIndex + 1) % question.options.length
    state = answer(state, wrongIndex, 500)

    expect(state.isCorrect).toBe(false)
    expect(state.streak).toBe(0)
    expect(state.score).toBe(0)
    expect(state.answeredCount).toBe(1)
    expect(state.correctCount).toBe(0)
  })

  it('streak の継続: 連続正解で streak が積み上がる', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)
    expect(state.streak).toBe(1)

    state = load(state, otherQuestion)
    state = answer(state, otherQuestion.correctOptionIndex, 0)
    expect(state.streak).toBe(2)
    expect(state.bestStreak).toBe(2)
    expect(state.correctCount).toBe(2)
    expect(state.answeredCount).toBe(2)
  })

  it('streak の途切れ: 正解の後に不正解を挟むと streak は 0 に戻るが、bestStreak と score は残る', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)
    const scoreAfterFirstCorrect = state.score
    expect(state.streak).toBe(1)

    state = load(state, otherQuestion)
    const wrongIndex = (otherQuestion.correctOptionIndex + 1) % otherQuestion.options.length
    state = answer(state, wrongIndex, 0)

    expect(state.streak).toBe(0)
    expect(state.bestStreak).toBe(1)
    expect(state.score).toBe(scoreAfterFirstCorrect) // 不正解は減点しない
    expect(state.correctCount).toBe(1)
    expect(state.answeredCount).toBe(2)
  })

  it('回答済みの問題に再度 answer-submitted しても二重カウントしない', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)
    const afterFirstAnswer = state

    // 同じ問題に別の選択肢で再回答を試みても状態は変化しない
    const afterSecondAttempt = answer(
      afterFirstAnswer,
      (question.correctOptionIndex + 1) % question.options.length,
      0,
    )

    expect(afterSecondAttempt).toEqual(afterFirstAnswer)
    expect(afterSecondAttempt.answeredCount).toBe(1)
    expect(afterSecondAttempt.correctCount).toBe(1)
  })

  it('question-loaded は selectedOptionIndex / isCorrect をリセットするが streak・score は引き継ぐ', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)
    const scoreBefore = state.score
    const streakBefore = state.streak

    state = load(state, otherQuestion)

    expect(state.selectedOptionIndex).toBeNull()
    expect(state.isCorrect).toBeNull()
    expect(state.question).toEqual(otherQuestion)
    expect(state.score).toBe(scoreBefore)
    expect(state.streak).toBe(streakBefore)
  })

  it('session-reset で初期状態に戻る', () => {
    let state = createInitialPuzzleSession()
    state = load(state, question)
    state = answer(state, question.correctOptionIndex, 0)
    expect(state.score).toBeGreaterThan(0)

    state = puzzleReducer(state, { type: 'session-reset' })
    expect(state).toEqual(createInitialPuzzleSession())
  })

  it('速度ボーナス: 即答ほど得点が高く、ウィンドウを超えると基礎点×難易度係数まで下がる', () => {
    let fast = createInitialPuzzleSession()
    fast = load(fast, question)
    fast = answer(fast, question.correctOptionIndex, 0)

    let slow = createInitialPuzzleSession()
    slow = load(slow, question)
    slow = answer(slow, question.correctOptionIndex, 999_999)

    expect(fast.score).toBeGreaterThan(slow.score)
    // medium 係数 1.25 × 基礎点 100 = 125（ボーナス 0）
    expect(slow.score).toBe(125)
  })

  it('型を無視して未知の action type を渡すと明確な例外になる（沈黙して不正状態を返さない）', () => {
    const state = createInitialPuzzleSession()
    // @ts-expect-error 型システムが判別共用体を網羅チェックしていることの確認（実行時は型を迂回して検証）
    const invalid: PuzzleAction = { type: 'not-a-real-action' }
    expect(() => puzzleReducer(state, invalid)).toThrow(/未知の PuzzleAction/)
  })
})

describe('puzzle: PuzzlePair の型ヘルパ健全性', () => {
  it('pairsProduceSameSolid は入れ替えても同じ結果になる（対称関数）', () => {
    const p: PuzzlePair = { a: 'triangle', b: 'star' }
    const q: PuzzlePair = { a: 'star', b: 'triangle' }
    expect(pairsProduceSameSolid(p, q)).toBe(pairsProduceSameSolid(q, p))
  })
})
