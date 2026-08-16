import { describe, expect, it } from 'vitest'
import {
  INITIAL_MODE_STATE,
  MODE_LABELS,
  STUDIO_MODES,
  modeReducer,
  type ModeAction,
  type StudioMode,
} from './modeStore'

/**
 * モード切り替えリデューサーのテスト（FR-103）。
 *
 * ここが検証するのは「カタログが最初に見えるモードであること」そのもの —
 * これがこのタスクのピボットの本体なので、初期値を明示的に固定する。
 */
describe('modeStore', () => {
  it('既定モードは catalogue（FR-103: カタログが主たる入口）', () => {
    expect(INITIAL_MODE_STATE).toEqual({ mode: 'catalogue' })
  })

  it('モードの並びはカタログが先頭、自由・パズルが続く', () => {
    expect(STUDIO_MODES).toEqual(['catalogue', 'free', 'puzzle'])
  })

  it('全モードにラベルがある（タブの表示が欠けない）', () => {
    for (const mode of STUDIO_MODES) {
      expect(MODE_LABELS[mode].length).toBeGreaterThan(0)
    }
  })

  describe('modeReducer', () => {
    it('mode-selected で指定モードへ切り替わる', () => {
      const next = modeReducer(INITIAL_MODE_STATE, { type: 'mode-selected', mode: 'puzzle' })
      expect(next).toEqual({ mode: 'puzzle' })
    })

    it('全モードへの遷移を一通り確認する', () => {
      for (const mode of STUDIO_MODES) {
        expect(modeReducer(INITIAL_MODE_STATE, { type: 'mode-selected', mode })).toEqual({
          mode,
        })
      }
    })

    it('同じモードを選び直しても新しい参照は作らない（無駄な再レンダーを避ける）', () => {
      const state = { mode: 'free' as StudioMode }
      const next = modeReducer(state, { type: 'mode-selected', mode: 'free' })
      expect(next).toBe(state)
    })

    it('未知のアクションは例外にする（判別共用体の網羅漏れを実行時にも検出する）', () => {
      const bogus = { type: 'unknown-action' } as unknown as ModeAction
      expect(() => modeReducer(INITIAL_MODE_STATE, bogus)).toThrow()
    })
  })
})
