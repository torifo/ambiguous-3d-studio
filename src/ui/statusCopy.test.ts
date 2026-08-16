/**
 * プリフライト警告・live 帯の文言の単体テスト（FR-101 / FR-102）。
 *
 * 検証の主眼：
 * - EMPTY_BAND / EMPTY_INTERSECTION が視点名を具体的に名指しすること
 *   （旧文言「片方のシルエット」が三視点で偽になる問題の回帰防止）
 * - 視点 C の EMPTY_BAND は「C 自身に被覆がない」ではなく「A・B には
 *   材料があるが C がその位置を許さない」という別の事実を書くこと
 *   （illusion-catalogue.md の訂正 — 「3 つとも被覆」という誤った基準を
 *   文言に持ち込んでいないかの回帰防止）
 * - emptySides が空配列のときは特定の視点を名指ししないこと
 * - THIN_NECK は直交では斜交注記を付けず、斜交では |sin φ| の注記を足すこと
 * - certainty ↔ 文体（です / 可能性があります）の対応が保たれていること
 * - formatLiveYRange が EMPTY_BAND と同じ mm 換算・丸めで文字列を作ること
 */
import { describe, expect, it } from 'vitest'
import type { ViewpointPreflightWarning } from '../geometry/preflight'
import { formatLiveYRange, warningCopy, type WarningCopyContext } from './statusCopy'

const ORTHOGONAL_CTX: WarningCopyContext = {
  heightMm: 60,
  axisAngleDeg: 90,
  isOrthogonalAxes: true,
}

const OBLIQUE_45_CTX: WarningCopyContext = {
  heightMm: 60,
  axisAngleDeg: 45,
  isOrthogonalAxes: false,
}

describe('warningCopy / EMPTY_BAND', () => {
  it('side: A を具体的に名指しする（「片方の」ではない）', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: '',
      band: [-1, 0], // 正規化 Y。WORKING_HEIGHT=2 として下から 0〜30mm 相当
      side: 'A',
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.badge).toBe('確定')
    expect(copy.title).toContain('シルエット A')
    expect(copy.body).toContain('シルエット A')
    expect(copy.body).not.toContain('片方の')
    // exact ⇒ 断定の文体
    expect(copy.body).toContain('です')
    expect(copy.body).not.toContain('可能性があります')
  })

  it('side: B も同様に名指しする', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: '',
      band: [0, 1],
      side: 'B',
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.title).toContain('シルエット B')
    expect(copy.body).toContain('シルエット B')
  })

  it('side: C は「A・B に材料はあるが C が許さない」と書き、C自身の被覆欠落だとは書かない', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: '',
      band: [-0.5, 0.5],
      side: 'C',
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.title).toContain('視点 C')
    // A・B には材料がある、という事実を明示している
    expect(copy.body).toContain('A・B')
    expect(copy.body).toContain('材料があります')
    // 「3 つとも被覆がない/高さごとに被覆がない」という誤った基準を書いていない
    expect(copy.body).not.toContain('3 つとも')
    expect(copy.body).not.toContain('すべての高さ')
  })

  it('A/B と C とで本文が異なる（同じテンプレートの使い回しではない）', () => {
    const bandA: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: '',
      band: [0, 0.2],
      side: 'A',
    }
    const bandC: ViewpointPreflightWarning = {
      code: 'EMPTY_BAND',
      certainty: 'exact',
      message: '',
      band: [0, 0.2],
      side: 'C',
    }
    const copyA = warningCopy(bandA, ORTHOGONAL_CTX)
    const copyC = warningCopy(bandC, ORTHOGONAL_CTX)
    expect(copyA.body).not.toBe(copyC.body)
    expect(copyA.title).not.toBe(copyC.title)
  })
})

describe('warningCopy / EMPTY_INTERSECTION', () => {
  it('emptySides が非空なら、その視点を名指しする', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['C'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('視点 C')
  })

  it('複数視点が emptySides に入っていれば両方を名指しする', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['A', 'B'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('シルエット A')
    expect(copy.body).toContain('シルエット B')
  })

  it('emptySides が空配列なら、高さ範囲が重ならないという別の文で、特定の視点を名指ししない', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: [],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('重ならない')
    expect(copy.body).not.toContain('シルエット A')
    expect(copy.body).not.toContain('シルエット B')
    expect(copy.body).not.toContain('視点 C')
  })

  // Finding 3（アドバイザリレビュー）の回帰防止: emptySides に 'C' が含まれるのは
  // 「A・B が両方とも被覆を持つ高さで、C だけがその位置を許さなかった」ケース
  // （geometry/preflight.ts の blamed.C）。A/B と同じ「C に必要な被覆がなかった」
  // という文型を使い回すと、EMPTY_BAND の C 分岐が明示的に否定しているのと同じ
  // 誤ったモデル（C が「高さごとの被覆」を持つ）を書いてしまう。
  it('emptySides が [\'C\'] のとき、「C に必要な被覆」という誤ったモデルを書かない', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['C'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('視点 C')
    expect(copy.body).not.toContain('C に必要な被覆')
    expect(copy.body).not.toContain('視点 Cに必要な被覆')
  })

  it('emptySides が [\'C\'] のとき、A・B には材料があるという事実を明示する', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['C'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('A・B')
    expect(copy.body).toContain('材料がある')
  })

  it('emptySides が [\'C\'] のとき、C だけでなく A・B を変えても解決することを示す（C 限定の助言にしない）', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['C'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('シルエット A')
    expect(copy.body).toContain('シルエット B')
    expect(copy.body).toContain('視点 C')
  })

  it('emptySides が [\'A\', \'C\'] のような混在でも、A 自身の被覆欠落と C の位置制約を両方書く', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'EMPTY_INTERSECTION',
      certainty: 'exact',
      message: '',
      emptySides: ['A', 'C'],
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.body).toContain('シルエット A')
    expect(copy.body).toContain('視点 C')
    expect(copy.body).not.toContain('C に必要な被覆')
  })
})

describe('warningCopy / THIN_NECK', () => {
  const base = {
    code: 'THIN_NECK' as const,
    certainty: 'estimated' as const,
    message: '',
    minWidth: 0.03, // 作業座標。WORKING_HEIGHT=2, heightMm=60 → 0.9mm
  }

  it('直交軸では斜交の注記を付けない', () => {
    const copy = warningCopy(base, ORTHOGONAL_CTX)
    expect(copy.badge).toBe('推定')
    expect(copy.body).toContain('可能性があります')
    expect(copy.body).not.toContain('sin')
    expect(copy.body).not.toContain('斜交')
  })

  it('斜交軸（45°）では |sin φ| による細り注記を付ける', () => {
    const copy = warningCopy(base, OBLIQUE_45_CTX)
    expect(copy.body).toContain('斜交')
    expect(copy.body).toContain('45°')
    expect(copy.body).toContain('sin')
    // 0.9mm * sin(45°) ≈ 0.636mm → 「0.6mm」を含む
    expect(copy.body).toMatch(/0\.6mm/)
  })
})

describe('warningCopy / LIKELY_DISCONNECTED・SIMPLIFIED（既存の文言を維持）', () => {
  it('LIKELY_DISCONNECTED は推定の文体', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'LIKELY_DISCONNECTED',
      certainty: 'estimated',
      message: '',
      components: 3,
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.badge).toBe('推定')
    expect(copy.body).toContain('3')
    expect(copy.body).toContain('可能性があります')
  })

  it('SIMPLIFIED は断定の文体', () => {
    const warning: ViewpointPreflightWarning = {
      code: 'SIMPLIFIED',
      certainty: 'exact',
      message: '',
      before: 12000,
      after: 9000,
    }
    const copy = warningCopy(warning, ORTHOGONAL_CTX)
    expect(copy.badge).toBe('確定')
    expect(copy.body).toContain('12000')
    expect(copy.body).toContain('9000')
  })
})

describe('formatLiveYRange', () => {
  it('null なら null を返す', () => {
    expect(formatLiveYRange(null, 60)).toBeNull()
  })

  it('EMPTY_BAND と同じ mm 換算・丸めで帯を提示する', () => {
    // WORKING_HEIGHT=2 なので [-1, 1] は 0〜60mm の全域に一致する
    const text = formatLiveYRange([-1, 1], 60)
    expect(text).not.toBeNull()
    expect(text).toContain('0〜60mm')
  })

  it('負から始まらない部分帯も正しく mm 換算する', () => {
    // 正規化 Y = -0.5 は下端(-1)から見て 25%、heightMm=60 → 15mm
    const text = formatLiveYRange([-0.5, 0.5], 60)
    expect(text).toContain('15〜45mm')
  })
})
