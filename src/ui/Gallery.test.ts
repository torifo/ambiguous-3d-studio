import { describe, expect, it, vi } from 'vitest'
import { ILLUSIONS, isBuildableIllusion } from '../catalogue/illusions'
import { applyIllusionSelection } from './Gallery'

/**
 * Gallery のロジックのテスト（FR-100）。DOM は使わない — 検証するのは
 * 「カタログ項目を選んだら何がストアへ呼ばれるか」という、entry → store 呼び出しの
 * マッピングだけ。実際の描画（カード一覧・ボタン・強調表示）はブラウザで確認する
 * （タスク指示どおり）。
 */
describe('applyIllusionSelection', () => {
  const buildable = ILLUSIONS.find(isBuildableIllusion)
  const unbuildable = ILLUSIONS.find((entry) => !entry.buildable)

  it('生成できる項目を選ぶと applyInput が preset のまま 1 回だけ呼ばれる', () => {
    expect(buildable).toBeDefined()
    const applyInput = vi.fn()
    applyIllusionSelection(buildable!, applyInput)
    expect(applyInput).toHaveBeenCalledTimes(1)
    expect(applyInput).toHaveBeenCalledWith(buildable!.preset)
  })

  it('生成できない項目を選んでも applyInput は呼ばれない', () => {
    expect(unbuildable).toBeDefined()
    const applyInput = vi.fn()
    applyIllusionSelection(unbuildable!, applyInput)
    expect(applyInput).not.toHaveBeenCalled()
  })

  it('カタログ全項目について、buildable かどうかと applyInput 呼び出しの有無が一致する', () => {
    for (const entry of ILLUSIONS) {
      const applyInput = vi.fn()
      applyIllusionSelection(entry, applyInput)
      expect(applyInput.mock.calls.length, entry.id).toBe(isBuildableIllusion(entry) ? 1 : 0)
    }
  })
})
