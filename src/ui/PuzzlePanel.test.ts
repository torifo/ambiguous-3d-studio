import { describe, expect, it } from 'vitest'
import { PRESET_IDS } from '../sources/presets'
import { listValidPairs } from '../puzzle/puzzle'
import { optionLabel, pairToInputSpec } from './PuzzlePanel'

/**
 * PuzzlePanel のロジックのテスト（puzzle/puzzle.ts の UI 側の接合部）。DOM は使わない。
 *
 * 検証するのは 2 つの純粋関数だけ:
 * - `pairToInputSpec`: 出題ペア（PresetId の組）→ ストア入力への変換
 * - `optionLabel`: 選択肢の表示文字列
 * 出題・採点そのもの（puzzleReducer / generatePuzzleQuestion）は puzzle.test.ts が
 * 既に検証済みなので、ここで再検証しない。タイマー駆動の実際のプレイ操作は
 * ブラウザで確認する（タスク指示どおり）。
 */
describe('pairToInputSpec', () => {
  it('a / b をプリセット入力へ変換し、視点 C は使わない', () => {
    const spec = pairToInputSpec({ a: 'circle', b: 'square' })
    expect(spec).toEqual({
      a: { kind: 'preset', id: 'circle' },
      b: { kind: 'preset', id: 'square' },
    })
    expect(spec.c).toBeUndefined()
    expect(spec.axisAngleDeg).toBeUndefined()
  })

  it('出題プールの全ペアで欠けなく変換できる', () => {
    const pool = listValidPairs()
    expect(pool.length).toBeGreaterThan(0)
    for (const pair of pool) {
      const spec = pairToInputSpec(pair)
      expect(spec.a).toEqual({ kind: 'preset', id: pair.a })
      expect(spec.b).toEqual({ kind: 'preset', id: pair.b })
    }
  })
})

describe('optionLabel', () => {
  it('「A × B」の形で日本語ラベルを組み立てる', () => {
    expect(optionLabel({ a: 'circle', b: 'square' })).toBe('円 × 正方形')
  })

  it('全プリセット id にラベルがある（片方が欠けると選択肢が壊れて表示される）', () => {
    for (const id of PRESET_IDS) {
      const label = optionLabel({ a: id, b: id })
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toContain('undefined')
    }
  })
})
