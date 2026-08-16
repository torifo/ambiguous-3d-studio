import { beforeAll, describe, expect, it } from 'vitest'
import createManifold from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import { boundsOf, normalizeSilhouette } from './normalize'
import { presetToContours } from '../sources/presets'
import { computeDepths } from '../worker/protocol'
import type { CsgRequest, SerializedContour } from '../worker/protocol'
import { performCsg } from '../worker/csg.worker'
import type { Contour } from './types'
import { SCANLINE_COUNT, containsPoint, coveredIntervalsAt, runPreflight } from './preflight'

// フィクスチャの大半はインラインで構築する。巻き方向は正規化後の契約どおり：
// 外輪郭 CCW / 穴 CW。レビュー Finding 1〜3 の回帰テスト（このファイル末尾）だけは、
// 実プリセット・実 Wasm CSG（`../worker/csg.worker`）と突き合わせるために
// presets / normalize / manifold-3d を使う — `src/worker/csg.integration.test.ts` と
// 同じ手法（Node 上で実物の manifold-3d を初期化し、performCsg を直接呼ぶ）。

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

  /**
   * レビュー Finding 2（THIN_NECK の誤検出）の回帰テスト。
   *
   * 「とがった先端」と「本物のくびれ」を区別できることを、3 段階で検証する：
   * (1) 合成フィクスチャで先端が誤検出されないこと、(2) 実プリセット
   * （スペード × ハート）でバグ報告そのものが再現しないこと、
   * (3) 本物のダンベル形では引き続き発火すること。
   */
  it('両端がとがった図形（先端で幅 0 に収束するだけ）では THIN_NECK を誤検出しない', () => {
    // A: 上端 (y=10) がとがった二等辺三角形（頂点で幅 0 に収束）
    const a: Contour[] = [{ isHole: false, points: new Float64Array([-1, 0, 1, 0, 0, 10]) }]
    // B: 下端 (y=0) がとがった二等辺三角形（頂点で幅 0 に収束）
    const b: Contour[] = [{ isHole: false, points: new Float64Array([0, 0, 1, 10, -1, 10]) }]
    const report = runPreflight(a, b)

    // 組み合わせ幅（min(A,B)）は y=0 で B の先端により、y=10 で A の先端により
    // それぞれ 0 に収束する「両端がとがった」形状 — スペード×ハートと同じ構造。
    // 先端はくびれではないので、警告なしで通る
    expect(warningOf(report, 'THIN_NECK')).toBeUndefined()
    expect(report.ok).toBe(true)
  })

  it('スペード×ハート（両端がとがった実プリセット）では THIN_NECK を誤検出しない（バグ報告の実地再現）', () => {
    // トランプマークの変身立体（catalogue/illusions.ts の card-suits）そのもの。
    // スペードは上端が、ハートは下端が、それぞれ 1 点に収束する — 旧実装は
    // この組み合わせで常に「最も細い部分の幅は約 0.0mm」を報告していた
    const spade = normalizeSilhouette(presetToContours('spade'), 2).contours
    const heart = normalizeSilhouette(presetToContours('heart'), 2).contours
    const report = runPreflight(spade, heart)

    expect(warningOf(report, 'THIN_NECK')).toBeUndefined()
  })

  it('ダンベル形（2 つの太い部分に挟まれた本物のくびれ）では THIN_NECK が引き続き発火する', () => {
    // A: 上下 y∈[0,4]・[6,10] が幅 4 の太い塊、中央 y∈[4,6] だけ幅 0.1 に
    // くびれるダンベル形（構成は本ファイル内の「本物のくびれ」フィクスチャ
    // と同じ手法 — 太い部分へいったん外へ出てから細い首を通り、また外へ戻る）
    const waistHalfWidth = 0.05
    const a: Contour[] = [
      {
        isHole: false,
        points: new Float64Array([
          -2, 0, 2, 0, 2, 4, waistHalfWidth, 4, waistHalfWidth, 6, 2, 6, 2, 10, -2, 10, -2, 6,
          -waistHalfWidth, 6, -waistHalfWidth, 4, -2, 4,
        ]),
      },
    ]
    const b = [rect(-3, 0, 3, 10)] // B は全高で十分広く、くびれを作らない
    const report = runPreflight(a, b)

    const warning = warningOf(report, 'THIN_NECK')
    expect(warning).toBeDefined()
    expect(warning!.certainty).toBe('estimated')
    expect(warning!.minWidth).toBeCloseTo(2 * waistHalfWidth, 9)
    expect(report.ok).toBe(false)
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

describe('geometry/preflight — containsPoint は coveredIntervalsAt と同じ被覆規約を持つ', () => {
  it('区間の内側・外側で一致する（穴のあるドーナツで検証）', () => {
    const donut = [rect(-4, -4, 4, 4), rect(-2, -2, 2, 2)]
    // rect は CCW を返すので、穴側は明示的に CW へ反転する（正規化済み輪郭の契約）
    const hole = { points: donut[1].points.slice().reverse(), isHole: true }
    const shape = [donut[0], hole]

    for (const y of [-3, 0, 1.5, 3.9]) {
      const intervals = coveredIntervalsAt(shape, y)
      for (const x of [-4.5, -3, -1.9, 0, 1.9, 3, 4.5]) {
        const inInterval = intervals.some(([from, to]) => x > from && x < to)
        expect(containsPoint(shape, x, y)).toBe(inInterval)
      }
    }
  })
})

/**
 * レビュー Finding 1〜3 の回帰テスト。
 *
 * 実プリセット・実 Wasm（manifold-3d）を Node 上で使う点が、このファイルの他の
 * テストと違う（`src/worker/csg.integration.test.ts` と同じ手法）。3 つの発見は
 * いずれも「走査線サンプリングでは掴めない細さ・角度」で初めて表に出るため、
 * 既存の C 系テストが使ってきた広い軸平行矩形では再現できない
 * （このファイル冒頭の合成フィクスチャ群では踏めない領域）。
 */
describe('geometry/preflight — レビュー Finding 1〜3 の回帰', () => {
  let wasm: ManifoldToplevel
  beforeAll(async () => {
    wasm = await createManifold()
    wasm.setup()
  }, 30_000)

  function extentOf(contours: Contour[]): { width: number; height: number } {
    const b = boundsOf(contours)
    return { width: b.maxX - b.minX, height: b.maxY - b.minY }
  }

  /** `performCsg` に渡すリクエストを、パイプラインと同じ深さ規則で組み立てる */
  function buildRequest(parts: {
    a: Contour[]
    b: Contour[]
    c?: Contour[] | null
    axisAngleDeg?: number
  }): CsgRequest {
    const c = parts.c ?? null
    const depths = computeDepths({
      a: extentOf(parts.a),
      b: extentOf(parts.b),
      c: c === null ? null : extentOf(c),
      axisAngleDeg: parts.axisAngleDeg,
    })
    return {
      generation: 1,
      a: { contours: parts.a as SerializedContour[], depth: depths.a },
      b: { contours: parts.b as SerializedContour[], depth: depths.b },
      c:
        c === null || depths.c === null
          ? null
          : { contours: c as SerializedContour[], depth: depths.c },
      axisAngleDeg: parts.axisAngleDeg,
      baseplate: null,
    }
  }

  describe('Finding 1（BLOCKER）: C 併用時の斜交軸', () => {
    // レビューの失敗入力そのもの。A = 全面正方形、B = 細い縦帯、
    // C = 対角の 2 つの塊。90° では真に空だが、120° / 135° / 150° では
    // 非空な実体になる（レビュー記載の体積 0.00426 / 0.20627 / 0.00426 と一致）
    const rawA = (): Contour[] => [rect(-1, -1, 1, 1)]
    const rawB = (): Contour[] => [rect(-0.05, -1, 0.05, 1)]
    const rawC = (): Contour[] => [rect(0.6, 0.6, 1, 1), rect(-1, -1, -0.6, -0.6)]

    const a = (): Contour[] => normalizeSilhouette(rawA(), 2).contours
    const b = (): Contour[] => normalizeSilhouette(rawB(), 2).contours
    const c = (): Contour[] => normalizeSilhouette(rawC(), 2).contours

    it('90° は preflight と実 CSG の両方で真に空になる（誤検出ではない対照）', () => {
      const report = runPreflight(a(), b(), { c: c(), axisAngleDeg: 90 })
      expect(warningOf(report, 'EMPTY_INTERSECTION')).toBeDefined()

      const response = performCsg(wasm, buildRequest({ a: a(), b: b(), c: c(), axisAngleDeg: 90 }))
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.code).toBe('EMPTY_RESULT')
    })

    it.each([
      { angle: 120, volume: 0.00426 },
      { angle: 135, volume: 0.20627 },
      { angle: 150, volume: 0.00426 },
    ])(
      '$angle° は非空な実体になり、preflight はそれを EMPTY_INTERSECTION として拒否しない',
      ({ angle, volume }) => {
        // axisAngleDeg を無視して常に 90° 相当で判定する実装（修正前のバグ）なら、
        // ここでも EMPTY_INTERSECTION を断定してしまう — 90° だけが真に空なので
        const report = runPreflight(a(), b(), { c: c(), axisAngleDeg: angle })
        expect(warningOf(report, 'EMPTY_INTERSECTION')).toBeUndefined()
        expect(report.liveYRange).not.toBeNull()

        // 実 Wasm の結果と突き合わせる：preflight が「非空」と言うなら、
        // performCsg も非空な体積を返さなければならない
        const response = performCsg(
          wasm,
          buildRequest({ a: a(), b: b(), c: c(), axisAngleDeg: angle }),
        )
        expect(response.ok).toBe(true)
        if (!response.ok) return
        expect(response.volume).toBeGreaterThan(0)
        expect(response.volume).toBeCloseTo(volume, 4)
      },
    )

    it('axisAngleDeg を渡さない呼び出しは 90°（既定）として評価される', () => {
      const withDefault = runPreflight(a(), b(), { c: c() })
      const withExplicit90 = runPreflight(a(), b(), { c: c(), axisAngleDeg: 90 })
      expect(withDefault).toEqual(withExplicit90)
      expect(warningOf(withDefault, 'EMPTY_INTERSECTION')).toBeDefined()
    })
  })

  describe('Finding 2（MAJOR）: 視点 C の空判定はサンプリングではなく厳密でなければならない', () => {
    it('円 × 正三角形 × 円は、三角形の頂点付近を偽の EMPTY_BAND(C) にしない', () => {
      const a = normalizeSilhouette(presetToContours('circle'), 2).contours
      const b = normalizeSilhouette(presetToContours('triangle'), 2).contours
      const c = normalizeSilhouette(presetToContours('circle'), 2).contours

      const report = runPreflight(a, b, { c })

      // 修正前はここに y≈0.9961 で side:'C' の EMPTY_BAND が exact として立っていた
      // （B_y の走査線ごとの被覆幅が 256 分割の C の w サンプル間隔より狭く、
      // どのサンプルも命中しなかったため）。修正後は 1 本も出ない
      const cBands = report.warnings.filter((w) => w.code === 'EMPTY_BAND' && w.side === 'C')
      expect(cBands).toEqual([])

      // liveYRange が正しく bbox の端近くまで届く（誤った帯で切り詰められない）
      expect(report.liveYRange).not.toBeNull()
      const step = (report.sharedYRange![1] - report.sharedYRange![0]) / SCANLINE_COUNT
      expect(report.liveYRange![1]).toBeGreaterThan(1 - step)

      // 実 CSG と突き合わせる：EMPTY_BAND は生成をゲートしないので実 CSG は
      // もともと成功していたが、その解が liveYRange の上端付近まで実際に届いている
      // ことを確かめる（「誤って途切れると主張した高さに実際は材料がある」の直接証拠）
      const response = performCsg(wasm, buildRequest({ a, b, c }))
      expect(response.ok).toBe(true)
      if (!response.ok) return
      let maxY = -Infinity
      for (let i = 1; i < response.positions.length; i += 3) {
        if (response.positions[i] > maxY) maxY = response.positions[i]
      }
      expect(maxY).toBeGreaterThan(0.99)
    })

    it('厳密性の直接証明：256 分割の走査線幅より狭い B の帯でも、全面 C（何も削らない）を偽の空と判定しない', () => {
      // レビュー本文の「幅が分割幅より狭い B の帯」を、C 側を最も甘い条件
      // （全面正方形 = 何も削らない）にして最小構成で再現する。
      // A は常に全面被覆、B は高さ 10 の中央 1 点（y0）だけ幅 2e-7 まで
      // くびれる砂時計形、C は A・B の bbox を覆う全面正方形。
      // y0 は 256 本の走査線サンプルの中点そのものに一致させてあるので、
      // 「サンプルが 1 点も命中しない」ことを偶然ではなく確実にする
      const y0 = 128.5 * (10 / SCANLINE_COUNT)
      const waistHalfWidth = 1e-7
      const waistHalfHeight = 0.02

      const a: Contour[] = [rect(-2, 0, 2, 10)]
      const b: Contour[] = [
        {
          isHole: false,
          points: new Float64Array([
            -2, 0,
            2, 0,
            2, y0 - waistHalfHeight,
            waistHalfWidth, y0 - waistHalfHeight,
            waistHalfWidth, y0 + waistHalfHeight,
            2, y0 + waistHalfHeight,
            2, 10,
            -2, 10,
            -2, y0 + waistHalfHeight,
            -waistHalfWidth, y0 + waistHalfHeight,
            -waistHalfWidth, y0 - waistHalfHeight,
            -2, y0 - waistHalfHeight,
          ]),
        },
      ]
      const c: Contour[] = [rect(-2, -2, 2, 2)]

      const report = runPreflight(a, b, { c })

      // 全面正方形の C は「何も削らない」— A・B が噛み合っていれば、
      // どの高さでも空になりようがない。EMPTY_BAND(C) は 1 本も出てはならない
      expect(report.warnings.filter((w) => w.code === 'EMPTY_BAND' && w.side === 'C')).toEqual([])
      // くびれ自体は本物なので THIN_NECK（推定）は出てよいが、
      // それは exact な EMPTY_BAND とは別物
      expect(report.ok).toBe(false)
      expect(warningOf(report, 'THIN_NECK')).toBeDefined()
    })
  })

  describe('Finding 3（MODERATE）: THIN_NECK の C 寄与は live な高さだけを見る', () => {
    it('三方向変身立体（円 × 正方形 × 三角形）は、2 視点なら THIN_NECK を出さない', () => {
      const a = normalizeSilhouette(presetToContours('circle'), 2).contours
      const b = normalizeSilhouette(presetToContours('square'), 2).contours
      const c = normalizeSilhouette(presetToContours('triangle'), 2).contours

      const twoViewpoints = runPreflight(a, b)
      expect(warningOf(twoViewpoints, 'THIN_NECK')).toBeUndefined()

      // C を足すと、三角形の頂点近くの細さが THIN_NECK として出る。
      // この組み合わせでは B（正方形）がどの高さでも幅を狭めないため、
      // C のほぼ全域が実際に live な高さから到達可能で、この特定の三つ組では
      // 「live 制限」をかけても数値そのものは変わらない（後述のテストが
      // 「live 制限しないと変わる」ケースを別途, 数値が変わらないことは
      // バグではなく、この三つ組固有の事実であることをコメントで明示する）
      const withC = runPreflight(a, b, { c })
      const warning = warningOf(withC, 'THIN_NECK')
      expect(warning).toBeDefined()
      expect(warning!.minWidth).toBeCloseTo(0.0045105489780441176, 9)
    })

    it('C の到達不能な領域（B が到達しない w）は THIN_NECK の細さに数えない', () => {
      // A: 全高・全面の正方形（幅 10 の帯、y∈[0,10]）
      // B: 左右 2 本の帯（x∈[-5,-4] と [4,5]）。**高さによらず同じ形**なので
      //    走査線サンプリングが取りこぼす余地はない（Finding 2 とは無関係に
      //    Finding 3 だけを切り出すための構成）
      // C: 上下は B の帯とちょうど噛み合う幅の広い矩形（x∈[-5,5]）、
      //    中央（w∈(-4,4)）だけ幅 0.001 の細い腰。B は w∈(-4,4) を
      //    どの高さでも一度も許さないため、この腰は**理論上どの高さからも
      //    到達できない** — 旧実装はここを「全 w の最小」として拾ってしまう
      const a: Contour[] = [rect(-5, 0, 5, 10)]
      const b: Contour[] = [rect(-5, 0, -4, 10), rect(4, 0, 5, 10)]
      const c: Contour[] = [rect(-5, -5, 5, -4), rect(-0.0005, -4, 0.0005, 4), rect(-5, 4, 5, 5)]

      const twoViewpoints = runPreflight(a, b)
      const withC = runPreflight(a, b, { c })

      // 2 視点では B の帯幅（1）自体が THIN_NECK の閾値を超えるため警告なし。
      // C の腰（幅 0.001）を正しく「到達不能」として除外できていれば、
      // 3 視点でも THIN_NECK は出ない — 出た場合、その値は腰の幅
      // （0.001）に極端に近くなるはずなので、そちらでも検出できる
      const twoTN = warningOf(twoViewpoints, 'THIN_NECK')
      const threeTN = warningOf(withC, 'THIN_NECK')
      expect(twoTN).toBeUndefined()
      expect(threeTN).toBeUndefined()
    })
  })

  describe('斜交軸 × 2 視点は Finding 1 の対象外（1 バイトも変わらない）', () => {
    it('C なしなら axisAngleDeg を変えても preflight の結果は変わらない', () => {
      const square = normalizeSilhouette([rect(-1, -1, 1, 1)], 2).contours
      const star = normalizeSilhouette(presetToContours('star'), 2).contours

      const at90 = runPreflight(square, star, { axisAngleDeg: 90 })
      const at45 = runPreflight(square, star, { axisAngleDeg: 45 })
      const noAngle = runPreflight(square, star)

      expect(at45).toEqual(at90)
      expect(noAngle).toEqual(at90)
    })
  })

  describe('2 視点の基準挙動は不変（自己比較ではなく解析解と実 CSG に対して固定）', () => {
    it('正方形（一辺 2）× 円（半径 1）：警告なし・live 帯が bbox 全体・実体積が解析解 2π と一致', () => {
      const square = [rect(-1, -1, 1, 1)]
      const circleContour: Contour = (() => {
        const pts: number[] = []
        for (let k = 0; k < 64; k++) {
          const t = (2 * Math.PI * k) / 64
          pts.push(Math.cos(t), Math.sin(t))
        }
        return { points: new Float64Array(pts), isHole: false }
      })()

      const report = runPreflight(square, [circleContour])
      // ハードコードした期待値そのものに対する固定（他の runPreflight 呼び出しとの
      // 比較ではないので、2 視点の経路が丸ごと壊れても検出できる）
      expect(report.ok).toBe(true)
      expect(report.warnings).toEqual([])
      expect(report.sharedYRange).toEqual([-1, 1])
      // liveYRange は走査線セルの中点なので、両端はちょうど半セルぶん内側
      // （(hi-lo)/SCANLINE_COUNT/2 = 2/256/2 = 0.00390625）に収まる
      const step = 2 / SCANLINE_COUNT
      expect(report.liveYRange![0]).toBeCloseTo(-1 + step / 2, 9)
      expect(report.liveYRange![1]).toBeCloseTo(1 - step / 2, 9)
      expect(report.estimatedComponents).toBe(1)

      const response = performCsg(wasm, buildRequest({ a: square, b: [circleContour] }))
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.componentCount).toBe(1)
      // 解析解 V = π r² s = π・1²・2 = 2π（csg.integration.test.ts と同じ導出）
      expect(Math.abs(response.volume - 2 * Math.PI) / (2 * Math.PI)).toBeLessThan(0.02)
    })
  })
})
