import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SilhouetteSource } from '../geometry/types'
import { PRESET_IDS } from '../sources/presets'
import {
  ILLUSION_CATEGORIES,
  ILLUSIONS,
  getIllusionById,
  isBuildableIllusion,
  isUnbuildableIllusion,
  type IllusionCategory,
  type IllusionEntry,
} from './illusions'

/**
 * カタログのテスト（FR-100）。
 *
 * このデータはギャラリー UI の**契約**である。だから見た目の検査ではなく、
 * 「UI が壊れたボタンを出さない」ことを機械的に保証する検査を並べる：
 * - `buildable: true` の項目が参照するプリセット id と入力種別は、実在するものだけか
 * - `buildable: false` の項目には、必ず具体的な理由が書いてあるか
 */

/** 仕様書（illusion-catalogue.md）が定める項目数 */
const EXPECTED_ENTRY_COUNT = 12
/** A（現エンジン）3 + B（拡張が要る）2 */
const EXPECTED_BUILDABLE_COUNT = 5
/** C（この方式では原理的に作れない）7 */
const EXPECTED_UNBUILDABLE_COUNT = 7

/** 文字入力の契約（FR-002 / US-002）。sources/text.ts の TEXT_PATTERN と同一 */
const TEXT_PATTERN = /^[0-9A-Za-z]{1,8}$/
/** 同梱フォントの id。sources/text.ts の FONT_FILES のキーと同一（CDN 不使用 — NFR-030） */
const KNOWN_FONT_IDS: readonly string[] = ['default']
/** SilhouetteSource の全種別。types.ts の union と同一 */
const SOURCE_KINDS: ReadonlyArray<SilhouetteSource['kind']> = ['preset', 'text', 'svg']

/**
 * カタログが依存してよいモジュール。
 * データはプレーンな Node でテストできる状態を保つ（ワーカー・ストア・UI・シーンに
 * 依存し始めると、ギャラリーの契約テストがブラウザ環境なしでは回らなくなる）。
 */
const ALLOWED_IMPORTS = ['../geometry/types']

/** ある入力が実在するものだけを参照しているか検査する */
function expectResolvableSource(source: SilhouetteSource, label: string): void {
  expect(SOURCE_KINDS, `${label}: 入力種別`).toContain(source.kind)
  switch (source.kind) {
    case 'preset':
      // これが落ちるとき、ギャラリーは「押すと必ず失敗するボタン」を出している
      expect(PRESET_IDS, `${label}: プリセット id`).toContain(source.id)
      break
    case 'text':
      expect(source.value, `${label}: 文字列`).toMatch(TEXT_PATTERN)
      expect(KNOWN_FONT_IDS, `${label}: フォント id`).toContain(source.fontId)
      break
    case 'svg':
      // カタログは同梱データだけで完結する。外部ファイル前提の項目は置けない
      expect(source.raw.length, `${label}: SVG 本文`).toBeGreaterThan(0)
      expect(source.fileName.length, `${label}: SVG ファイル名`).toBeGreaterThan(0)
      break
  }
}

describe('ILLUSIONS', () => {
  it('仕様書の 12 項目がすべてある', () => {
    expect(ILLUSIONS).toHaveLength(EXPECTED_ENTRY_COUNT)
  })

  it('id が一意（ギャラリーのパーマリンクが衝突しない）', () => {
    const ids = ILLUSIONS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id, 'id は空でない kebab-case').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('作れる 5 件 / 作れない 7 件に分かれる（仕様書の A + B と C）', () => {
    expect(ILLUSIONS.filter((entry) => entry.buildable)).toHaveLength(EXPECTED_BUILDABLE_COUNT)
    expect(ILLUSIONS.filter((entry) => !entry.buildable)).toHaveLength(EXPECTED_UNBUILDABLE_COUNT)
    // 型ガードが漏れなく 2 つに分ける（どちらでもない項目が無い）
    const guarded =
      ILLUSIONS.filter(isBuildableIllusion).length + ILLUSIONS.filter(isUnbuildableIllusion).length
    expect(guarded).toBe(ILLUSIONS.length)
  })

  it.each(ILLUSIONS.map((entry) => [entry.id, entry] as const))(
    '%s: 表示に必要なテキストがすべて埋まっている',
    (_id, entry: IllusionEntry) => {
      for (const [field, value] of [
        ['name', entry.name],
        ['originalName', entry.originalName],
        ['phenomenon', entry.phenomenon],
        ['mechanism', entry.mechanism],
      ] as const) {
        expect(value.trim().length, field).toBeGreaterThan(0)
      }
      // 分類は許可された集合から
      expect(ILLUSION_CATEGORIES as readonly IllusionCategory[]).toContain(entry.category)
      // credit は任意だが、置くなら空文字にしない
      if (entry.credit !== undefined) {
        expect(entry.credit.trim().length, `${entry.id}: credit`).toBeGreaterThan(0)
      }
    },
  )

  it('本文はプレーンテキスト（ギャラリーがそのまま出せる）', () => {
    // Markdown の強調が混ざっていると、素で描画する UI に `**` がそのまま出る。
    // 「そのまま出して読める文字列」であることをデータ側の契約にする
    for (const entry of ILLUSIONS) {
      const texts = [
        entry.name,
        entry.originalName,
        entry.phenomenon,
        entry.mechanism,
        entry.notBuildableReason ?? '',
        entry.credit ?? '',
      ]
      for (const text of texts) {
        expect(text, `${entry.id}: Markdown の強調が残っている`).not.toMatch(/\*\*|__/)
        expect(text, `${entry.id}: 前後の空白`).toBe(text.trim())
      }
    }
  })

  describe('buildable: true — 再現設定が実在するものだけを参照する', () => {
    const buildable = ILLUSIONS.filter((entry) => entry.buildable)

    it.each(buildable.map((entry) => [entry.id, entry] as const))(
      '%s: preset がある / 参照先がすべて実在する',
      (_id, entry: IllusionEntry) => {
        expect(entry.preset, `${entry.id}: preset`).toBeDefined()
        expect(entry.notBuildableReason, `${entry.id}: 作れるのに理由が付いている`).toBeUndefined()
        const preset = entry.preset!
        expectResolvableSource(preset.a, `${entry.id}.a`)
        expectResolvableSource(preset.b, `${entry.id}.b`)
        if (preset.c !== undefined) expectResolvableSource(preset.c, `${entry.id}.c`)
        // 軸角は任意。置くなら XZ 平面内の意味のある角
        if (preset.axisAngleDeg !== undefined) {
          expect(Number.isFinite(preset.axisAngleDeg), `${entry.id}: axisAngleDeg`).toBe(true)
          expect(preset.axisAngleDeg).toBeGreaterThan(0)
          expect(preset.axisAngleDeg).toBeLessThan(180)
        }
      },
    )

    it('型ガードが preset の存在を型で保証する', () => {
      for (const entry of ILLUSIONS.filter(isBuildableIllusion)) {
        // `!` を書かずに読める＝ギャラリー側も書かずに済む
        expect(entry.preset.a.kind).toBeTruthy()
      }
    })
  })

  describe('buildable: false — 作れない理由が具体的に書いてある', () => {
    const unbuildable = ILLUSIONS.filter((entry) => !entry.buildable)

    it.each(unbuildable.map((entry) => [entry.id, entry] as const))(
      '%s: 理由があり、再現設定は持たない',
      (_id, entry: IllusionEntry) => {
        expect(entry.preset, `${entry.id}: 作れないのに preset がある`).toBeUndefined()
        const reason = entry.notBuildableReason
        expect(reason, `${entry.id}: notBuildableReason`).toBeDefined()
        expect(reason!.trim().length, `${entry.id}: notBuildableReason が空`).toBeGreaterThan(0)
        // 「未対応です」で済ませない。どの機構が使われていて、なぜ交差では表せないかを書く
        expect(reason!.length, `${entry.id}: 理由が短すぎる`).toBeGreaterThan(80)
      },
    )
  })

  describe('仕様書が名指しした再現設定', () => {
    const byId = (id: string): IllusionEntry => {
      const entry = getIllusionById(id)
      expect(entry, `${id} が見つからない`).toBeDefined()
      return entry!
    }

    it('影の両義立体: 数字 1 × 数字 2 のテキストシルエット', () => {
      const preset = byId('shadow-ambiguous').preset!
      expect(preset.a).toEqual({ kind: 'text', value: '1', fontId: 'default' })
      expect(preset.b).toEqual({ kind: 'text', value: '2', fontId: 'default' })
    })

    it('トランプマークの変身立体: 追加した 4 マークのプリセットを使う', () => {
      const preset = byId('card-suits').preset!
      const suits = ['spade', 'heart', 'diamond', 'club']
      for (const source of [preset.a, preset.b]) {
        expect(source.kind).toBe('preset')
        expect(suits).toContain(source.kind === 'preset' ? source.id : '')
      }
      // 4 マークすべてがプリセットとして実在する（カタログが差し替えを謳う前提）
      for (const suit of suits) {
        expect(PRESET_IDS).toContain(suit)
      }
    })

    it('左右反転矢印: 非対称な矢印プリセットを両視点に置く', () => {
      const preset = byId('ambiguous-arrow').preset!
      expect(preset.a).toEqual({ kind: 'preset', id: 'arrow' })
      expect(preset.b).toEqual({ kind: 'preset', id: 'arrow' })
    })

    it('三方向変身立体: 視点 C を持つ唯一の項目', () => {
      const entry = byId('triply-ambiguous')
      expect(entry.preset!.c).toBeDefined()
      const withC = ILLUSIONS.filter((e) => e.preset?.c !== undefined).map((e) => e.id)
      expect(withC).toEqual(['triply-ambiguous'])
    })

    it('アンビギュアス・シリンダー: 斜交軸 45°、かつ中空でないことを本文で断ってある', () => {
      const entry = byId('ambiguous-cylinder')
      expect(entry.preset!.axisAngleDeg).toBe(45)
      // 「第 1 段階（中実）まで」を明示していないと、原典を期待した人とずれる
      expect(entry.mechanism).toContain('中実')
      expect(entry.mechanism).toContain('中空')
    })

    it('作れない 7 件は不可能図形 3・重力 2・視差 2 に分かれる', () => {
      const countOf = (category: IllusionCategory) =>
        ILLUSIONS.filter((entry) => !entry.buildable && entry.category === category).length
      expect(countOf('impossible')).toBe(3)
      expect(countOf('gravity')).toBe(2)
      expect(countOf('parallax')).toBe(2)
      // 作れるものはすべて両義立体（投影シルエット型）
      expect(
        ILLUSIONS.filter((entry) => entry.buildable).every((e) => e.category === 'ambiguous'),
      ).toBe(true)
    })
  })

  describe('getIllusionById', () => {
    it('全 id を引ける / 未知の id は undefined', () => {
      for (const entry of ILLUSIONS) {
        expect(getIllusionById(entry.id)).toBe(entry)
      }
      expect(getIllusionById('no-such-illusion')).toBeUndefined()
    })
  })

  it('カタログはデータのまま — ワーカー / ストア / UI / シーンに依存しない', () => {
    const source = readFileSync(new URL('./illusions.ts', import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(ALLOWED_IMPORTS, `許可されていない import: ${specifier}`).toContain(specifier)
    }
  })
})
