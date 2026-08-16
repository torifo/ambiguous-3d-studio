import { describe, expect, it } from 'vitest'
import type { Contour } from './types'
import { SCANLINE_COUNT, coveredIntervalsAt, runPreflight } from './preflight'

// フィクスチャはすべてインラインで構築する（presets / normalize は並行実装中のため
// import しない）。巻き方向は正規化後の契約どおり：外輪郭 CCW / 穴 CW。

/** CCW の矩形輪郭。 */
function rect(x0: number, y0: number, x1: number, y1: number): Contour {
  return {
    points: new Float64Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    isHole: false,
  }
}

/** CW の矩形穴。 */
function holeRect(x0: number, y0: number, x1: number, y1: number): Contour {
  return {
    points: new Float64Array([x0, y0, x0, y1, x1, y1, x1, y0]),
    isHole: true,
  }
}

/** 原点中心・半径 r の CCW 多角形円。頂点は上下の極（±r）を含む。 */
function circle(r: number, segments = 64): Contour {
  const pts: number[] = []
  for (let k = 0; k < segments; k++) {
    const t = (2 * Math.PI * k) / segments
    pts.push(r * Math.cos(t), r * Math.sin(t))
  }
  return { points: new Float64Array(pts), isHole: false }
}

function warningOf<C extends string>(
  report: ReturnType<typeof runPreflight>,
  code: C,
): Extract<ReturnType<typeof runPreflight>['warnings'][number], { code: C }> | undefined {
  return report.warnings.find(
    (w): w is Extract<typeof w, { code: C }> => w.code === code,
  )
}

describe('geometry/preflight', () => {
  it('Y 範囲が重ならない組は EMPTY_INTERSECTION を断定し、生成不可を報告する', () => {
    const a = [rect(-1, 0, 1, 10)]
    const b = [rect(-1, 20, 1, 30)]
    const report = runPreflight(a, b)

    expect(report.ok).toBe(false)
    expect(report.sharedYRange).toBeNull()
    expect(report.emptyBands).toHaveLength(0)
    expect(report.estimatedComponents).toBe(0)
    expect(report.warnings).toHaveLength(1)

    const warning = warningOf(report, 'EMPTY_INTERSECTION')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    // 断定の文体（〜です）であり、推定の文体（〜の可能性）ではない
    expect(warning!.message).toContain('です')
    expect(warning!.message).not.toContain('可能性')
  })

  it('i 型（棒＋離れた点）× 全高矩形は EMPTY_BAND を断定し、帯は実際の隙間の内側にある', () => {
    // A: 棒 y∈[0,6] と点 y∈[8,10]。y∈(6,8) は真に空
    const a = [rect(-1, 0, 1, 6), rect(-1, 8, 1, 10)]
    // B: 全高の矩形 y∈[0,10]
    const b = [rect(-2, 0, 2, 10)]
    const report = runPreflight(a, b)

    expect(report.ok).toBe(false)
    expect(report.sharedYRange).toEqual([0, 10])
    expect(report.emptyBands).toHaveLength(1)

    const band = report.emptyBands[0]
    expect(band.side).toBe('A') // 空なのは A 側
    // 帯の端は走査線 1 本分（10/256 ≈ 0.039）の分解能で実際の隙間 [6, 8] を捉える
    const step = 10 / SCANLINE_COUNT
    expect(Math.abs(band.from - 6)).toBeLessThanOrEqual(step)
    expect(Math.abs(band.to - 8)).toBeLessThanOrEqual(step)
    // 帯は実測した空の走査線のみからなるため、真の隙間の内側に完全に収まる
    expect(band.from).toBeGreaterThanOrEqual(6)
    expect(band.to).toBeLessThanOrEqual(8)

    const warning = warningOf(report, 'EMPTY_BAND')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    expect(warning!.band).toEqual([band.from, band.to])
    expect(warning!.message).not.toContain('可能性')

    // 空帯は分離の証明にはならない：LIKELY_DISCONNECTED は出さない
    expect(warningOf(report, 'LIKELY_DISCONNECTED')).toBeUndefined()
  })

  it('外輪郭と同一の穴で被覆が空のシルエットは EMPTY_INTERSECTION を断定する', () => {
    // A: CCW 矩形 ＋ 同一形状の CW 穴。bbox は正常だが Positive fill の被覆は
    // すべての高さで空。bbox の重なりだけでは検出できない組
    const a = [rect(-1, 0, 1, 10), holeRect(-1, 0, 1, 10)]
    const b = [rect(-2, 0, 2, 10)]
    const report = runPreflight(a, b)

    expect(report.ok).toBe(false)
    expect(report.sharedYRange).toBeNull()
    expect(report.emptyBands).toHaveLength(0)
    expect(report.estimatedComponents).toBe(0)
    expect(report.warnings).toHaveLength(1)

    const warning = warningOf(report, 'EMPTY_INTERSECTION')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    // 断定の文体（〜です）であり、推定の文体（〜の可能性）ではない
    expect(warning!.message).toContain('です')
    expect(warning!.message).not.toContain('可能性')
  })

  it('EMPTY_BAND の範囲は実測した空の走査線に限定され、真の隙間の内側に収まる', () => {
    // 真の隙間は y∈[0.50185, 0.50205]（幅 0.0002）。走査線間隔 1/256 ≈ 0.0039 より
    // 狭いが、中点 y=128.5/256=0.501953125 がちょうど隙間に掛かり検出される。
    // 旧実装はこの 1 点をセル 1 個分 [0.5, 0.50390625] へ広げて exact と主張していた
    const a = [rect(-1, 0, 1, 0.50185), rect(-1, 0.50205, 1, 1)]
    const b = [rect(-2, 0, 2, 1)]
    const report = runPreflight(a, b)

    expect(report.emptyBands).toHaveLength(1)
    const band = report.emptyBands[0]
    expect(band.side).toBe('A')
    // overlap ではなく inside：報告範囲全体が真の隙間の中にある
    expect(band.from).toBeGreaterThanOrEqual(0.50185)
    expect(band.to).toBeLessThanOrEqual(0.50205)
    expect(band.from).toBeLessThanOrEqual(band.to)

    const warning = warningOf(report, 'EMPTY_BAND')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    expect(warning!.band).toEqual([band.from, band.to])
  })

  it('不正な scanlineCount は明確なエラーで拒否する', () => {
    const a = [rect(-1, 0, 1, 1)]
    const b = [rect(-1, 0, 1, 1)]
    expect(() => runPreflight(a, b, { scanlineCount: 0 })).toThrow(/scanlineCount/)
    expect(() => runPreflight(a, b, { scanlineCount: -8 })).toThrow(/scanlineCount/)
    expect(() => runPreflight(a, b, { scanlineCount: 12.5 })).toThrow(/scanlineCount/)
    expect(() => runPreflight(a, b, { scanlineCount: Number.NaN })).toThrow(/scanlineCount/)
    expect(() => runPreflight(a, b, { scanlineCount: Infinity })).toThrow(/scanlineCount/)
  })

  it('不正な thinNeckRatio は明確なエラーで拒否する', () => {
    const a = [rect(-1, 0, 1, 1)]
    const b = [rect(-1, 0, 1, 1)]
    expect(() => runPreflight(a, b, { thinNeckRatio: -0.01 })).toThrow(/thinNeckRatio/)
    expect(() => runPreflight(a, b, { thinNeckRatio: Number.NaN })).toThrow(/thinNeckRatio/)
    expect(() => runPreflight(a, b, { thinNeckRatio: Infinity })).toThrow(/thinNeckRatio/)
    // 0 は「THIN_NECK 判定を無効化する」正当な指定として許容される
    expect(() => runPreflight(a, b, { thinNeckRatio: 0 })).not.toThrow()
  })

  it('左右に離れた 2 パーツ × 矩形は LIKELY_DISCONNECTED を推定として報告する', () => {
    // A: x 方向に離れた 2 つの正方形（全高）
    const a = [rect(-3, 0, -1, 10), rect(1, 0, 3, 10)]
    const b = [rect(-1, 0, 1, 10)]
    const report = runPreflight(a, b)

    expect(report.estimatedComponents).toBe(2)
    expect(report.emptyBands).toHaveLength(0)

    const warning = warningOf(report, 'LIKELY_DISCONNECTED')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('estimated')
    expect(warning!.components).toBe(2)
    // 推定の文体（〜の可能性があります）
    expect(warning!.message).toContain('可能性があります')

    expect(warningOf(report, 'EMPTY_BAND')).toBeUndefined()
    expect(warningOf(report, 'EMPTY_INTERSECTION')).toBeUndefined()
  })

  it('正方形 × 円は警告なしで ok になる', () => {
    const a = [rect(-5, -5, 5, 5)]
    const b = [circle(5)]
    const report = runPreflight(a, b)

    expect(report.ok).toBe(true)
    expect(report.warnings).toHaveLength(0)
    expect(report.emptyBands).toHaveLength(0)
    expect(report.sharedYRange).toEqual([-5, 5])
    expect(report.estimatedComponents).toBe(1)
  })

  it('穴（ドーナツ）は被覆を差し引き、穴を横切る高さで x 区間が 2 本になる', () => {
    const donut = [rect(-4, -4, 4, 4), holeRect(-2, -2, 2, 2)]

    // 穴を横切る高さ：外輪郭の被覆から穴が差し引かれ、区間は 2 本
    const atHole = coveredIntervalsAt(donut, 0)
    expect(atHole).toHaveLength(2)
    expect(atHole[0][0]).toBeCloseTo(-4, 9)
    expect(atHole[0][1]).toBeCloseTo(-2, 9)
    expect(atHole[1][0]).toBeCloseTo(2, 9)
    expect(atHole[1][1]).toBeCloseTo(4, 9)

    // 穴より上：1 本に戻る
    const aboveHole = coveredIntervalsAt(donut, 3)
    expect(aboveHole).toHaveLength(1)
    expect(aboveHole[0][0]).toBeCloseTo(-4, 9)
    expect(aboveHole[0][1]).toBeCloseTo(4, 9)

    // ドーナツ × 矩形：穴の高さ帯だけ島が 2 つでも、全走査線で 2 以上ではないので
    // LIKELY_DISCONNECTED にはならない（推定は最小値ベース）
    const report = runPreflight(donut, [rect(-4, -4, 4, 4)])
    expect(report.ok).toBe(true)
    expect(report.estimatedComponents).toBe(1)
    expect(warningOf(report, 'LIKELY_DISCONNECTED')).toBeUndefined()
  })

  it('THIN_NECK の閾値は共通高さ基準で、2 視点の判定は視点 C を足す前と同じ', () => {
    // 「視点を足しても 2 視点の結果は変わらない」を仮定ではなく検証する。
    // c を渡さない呼び出しは、レポートのすべてのフィールドが従来どおり
    const a = [rect(-1, 0, 1, 6), rect(-1, 8, 1, 10)]
    const b = [rect(-2, 0, 2, 10)]
    const withoutC = runPreflight(a, b)
    const explicitNull = runPreflight(a, b, { c: null })
    expect(explicitNull).toEqual(withoutC)
  })

  it('細すぎる首は THIN_NECK を推定として報告する', () => {
    // A: 幅 0.1 の縦棒。共通高さ 10 の 2%（= 0.2）を下回る
    const a = [rect(-0.05, 0, 0.05, 10)]
    const b = [rect(-1, 0, 1, 10)]
    const report = runPreflight(a, b)

    const warning = warningOf(report, 'THIN_NECK')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('estimated')
    expect(warning!.minWidth).toBeCloseTo(0.1, 9)
    expect(warning!.message).toContain('可能性があります')

    expect(report.ok).toBe(false)
    expect(report.emptyBands).toHaveLength(0)
  })
})

/**
 * 視点 C（FR-101）。
 *
 * 座標の対応（protocol.ts `VIEWPOINT_AXES`）を毎回思い出さずに読めるよう、
 * ここで一度だけ書いておく。`w = −z` と置くと
 *
 * - A の被覆 `A_y` … world X（= u）の区間集合
 * - B の被覆 `B_y` … B の断面ローカル X = **world w** の区間集合
 * - C のシルエット `S_C` … **(u, w) 平面**の図形。高さ y には依存しない
 *
 * 高さ y が立体になるのは `∃w( w ∈ B_y ∧ C_w ∩ A_y ≠ ∅ )` のときだけ。
 * つまり C は「B が許す奥行きのどこかに、A と重なる材料を持つ」必要がある。
 */
describe('geometry/preflight — 視点 C（FR-101）', () => {
  /** A: 全高の縦棒（world X で ±1） */
  const fullA = (): Contour[] => [rect(-1, 0, 1, 10)]
  /** B: 全高の縦棒（world w で ±1） */
  const fullB = (): Contour[] => [rect(-1, 0, 1, 10)]

  it('3 つとも噛み合う組は警告なしで ok になり、live 帯が全高になる', () => {
    // C は (u, w) = ([-1,1], [-1,1]) を覆うので、B が許す w（±1）のどこでも
    // A（±1）と重なる
    const c = [rect(-1, -1, 1, 1)]
    const report = runPreflight(fullA(), fullB(), { c })

    expect(report.ok).toBe(true)
    expect(report.warnings).toHaveLength(0)
    expect(report.emptyBands).toHaveLength(0)
    expect(report.estimatedComponents).toBe(1)
    expect(report.liveYRange).not.toBeNull()
    expect(report.liveYRange![0]).toBeLessThan(0.1)
    expect(report.liveYRange![1]).toBeGreaterThan(9.9)
  })

  it('C が共通帯のどこにも材料を持たない三つ組は EMPTY_INTERSECTION で C を名指しする', () => {
    // C の材料は w ∈ [5, 7] にしかない。B が許す w は ±1 なので、どの高さでも
    // スライスは空 — 「失敗した」ではなく「C が空だ」と言えなければならない
    const c = [rect(-1, 5, 1, 7)]
    const report = runPreflight(fullA(), fullB(), { c })

    expect(report.ok).toBe(false)
    expect(report.sharedYRange).toBeNull()
    expect(report.liveYRange).toBeNull()
    expect(report.emptyBands).toHaveLength(0)
    expect(report.warnings).toHaveLength(1)

    const warning = warningOf(report, 'EMPTY_INTERSECTION')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    // 機械可読な名指し（UI が文言を組み立て直せる）
    expect(warning!.emptySides).toEqual(['C'])
    // 文面でも C を名指しし、断定の文体を保つ
    expect(warning!.message).toContain('シルエット C')
    expect(warning!.message).toContain('です')
    expect(warning!.message).not.toContain('可能性')
  })

  it('C の被覆が A・B と噛み合わない高さ帯は EMPTY_BAND を C として断定する', () => {
    // B は下半分では w ∈ [0,1]、上半分では w ∈ [2,3] に材料を持つ。
    // C は w ∈ [0,1] にしか材料がないので、上半分だけスライスが空になる
    const a = fullA()
    const b = [rect(0, 0, 1, 5), rect(2, 5, 3, 10)]
    const c = [rect(-1, 0, 1, 1)]

    // 同じ A・B は 2 視点なら空帯なしで成立する（＝ C が効いていることの対照）
    const twoViewpoints = runPreflight(a, b)
    expect(twoViewpoints.emptyBands).toHaveLength(0)
    expect(warningOf(twoViewpoints, 'EMPTY_INTERSECTION')).toBeUndefined()

    const report = runPreflight(a, b, { c })
    expect(report.emptyBands).toHaveLength(1)
    const band = report.emptyBands[0]
    expect(band.side).toBe('C')
    // 帯は上半分（y ∈ [5, 10]）。端は走査線 1 本分（10/256）の分解能で捉える
    const step = 10 / SCANLINE_COUNT
    expect(band.from).toBeGreaterThanOrEqual(5)
    expect(Math.abs(band.from - 5)).toBeLessThanOrEqual(step)
    expect(band.to).toBeLessThanOrEqual(10)
    expect(Math.abs(band.to - 10)).toBeLessThanOrEqual(step)

    const warning = warningOf(report, 'EMPTY_BAND')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('exact')
    expect(warning!.side).toBe('C')
    expect(warning!.message).toContain('シルエット C')
    expect(warning!.message).not.toContain('可能性')

    // 立体になるのは下半分だけ、という事実を liveYRange が持つ
    expect(report.liveYRange).not.toBeNull()
    expect(report.liveYRange![1]).toBeLessThanOrEqual(5)
  })

  it('C は x 方向の食い違いも見る（w は重なるが A と重ならない場合）', () => {
    // C の材料は u ∈ [5, 7]。w は B と完全に重なるが、A（u ∈ [-1,1]）とは
    // どの高さでも重ならない。w の重なりだけを見る実装はここで落ちる
    const c = [rect(5, -1, 7, 1)]
    const report = runPreflight(fullA(), fullB(), { c })

    expect(report.ok).toBe(false)
    const warning = warningOf(report, 'EMPTY_INTERSECTION')
    expect(warning).toBeDefined()
    expect(warning!.emptySides).toEqual(['C'])
  })

  it('A が空の高さでは C に責任を付け替えない', () => {
    // A に隙間（y ∈ (6,8)）がある。そこは A の空帯であって C の空帯ではない
    const a = [rect(-1, 0, 1, 6), rect(-1, 8, 1, 10)]
    const c = [rect(-1, -1, 1, 1)]
    const report = runPreflight(a, fullB(), { c })

    expect(report.emptyBands).toHaveLength(1)
    expect(report.emptyBands[0].side).toBe('A')
    const warning = warningOf(report, 'EMPTY_BAND')
    expect(warning!.side).toBe('A')
  })

  it('視点 C を足しても、C なしのレポートは 1 バイトも変わらない', () => {
    // 同じ a・b について「c を渡さない」呼び出しの結果が、C 対応の前と
    // 同じであること（上の 2 視点テスト群が無改変で通ることと合わせて二重に固定）
    const a = [rect(-3, 0, -1, 10), rect(1, 0, 3, 10)]
    const b = [rect(-1, 0, 1, 10)]
    const bare = runPreflight(a, b)
    expect(bare.estimatedComponents).toBe(2)
    expect(warningOf(bare, 'LIKELY_DISCONNECTED')).toBeDefined()

    // C を足すと、同じ組でも判定が変わりうる（適格性が狭まる）
    const withC = runPreflight(a, b, { c: [rect(-3, -1, 3, 1)] })
    expect(withC.estimatedComponents).toBe(2)
    // それでも c を渡さない呼び出しは元のまま
    expect(runPreflight(a, b)).toEqual(bare)
  })
})
