/**
 * プリフライト警告・live 帯の文言（StatusBanner.tsx から抽出。FR-012 / FR-101 /
 * FR-102）。同じファイルに置くと Fast Refresh が効かなくなる
 * （react-refresh/only-export-components）ため、純関数だけを切り出してある
 * （ui/liveAngleText.ts と同じ理由）。DOM を持たない Node 環境でも
 * そのままテストできる。
 *
 * ## 警告は「エラー」ではなく「この組み合わせの性質」
 *
 * `certainty` で文体を変える（geometry/preflight.ts の契約）：
 * - `'exact'`（スライス恒等式による断定）→「〜です」
 * - `'estimated'`（走査線サンプリングの推定）→「〜の可能性があります」
 * 断定 / 推定の区別はテキストバッジ（確定 / 推定）でも提示し、色に依存しない。
 *
 * ## FR-101 で視点名が増えたことへの追従
 *
 * `EMPTY_BAND` は `side: 'A' | 'B' | 'C'`、`EMPTY_INTERSECTION` は
 * `emptySides: ViewpointId[]` を持つ（geometry/preflight.ts の
 * `ViewpointPreflightWarning`）。旧文言の「片方のシルエット」は 2 視点限定の
 * 表現で、3 視点では単に誤り — ここでは常に視点名を名指しする。
 *
 * **視点 C は特別**：C の押し出し軸は +Y で、C の断面は XZ 平面に乗るため
 * 「高さごとの被覆」を持たない（illusion-catalogue.md の訂正 / preflight.ts
 * ファイル冒頭）。`side: 'C'` の `EMPTY_BAND` は「C 自身に材料がない帯」では
 * なく「A・B 両方に材料はあるが、C がその位置を許さない帯」なので、A / B と
 * 同じ文型を使い回すと事実と異なる。ここが `warningCopy` の要点。
 *
 * 同じ理由で `EMPTY_INTERSECTION.emptySides` に `'C'` が含まれる場合も、
 * A/B と同じ「C に必要な被覆がなかった」という文型を使わない（アドバイザリレビューの
 * 指摘で修正 — 以前はここが EMPTY_BAND の C 分岐と矛盾する誤ったモデルのまま
 * だった）。`geometry/preflight.ts` の `blamed.C` は「A・B が両方とも被覆を持つ
 * 高さで、C だけがその位置を許さなかった」ときに立つビットなので、正しい文は
 * 「A・B の被覆と C が許す位置が噛み合わない」であり、対処も C 限定ではなく
 * A・B のどちらを変えても同様に効くと書く。
 *
 * ## 2 つの並行した文言ソースのうち、ここ（statusCopy.ts）が勝つ
 *
 * `ViewpointPreflightWarning` は `message: string` フィールドも持ち、
 * `geometry/preflight.ts` 側で個別に文面を組み立てている（例: 視点 C の
 * カバレッジ皆無ケースの説明文）。しかし `StatusBanner.tsx` は常に
 * `warningCopy(warning, ctx)` の戻り値だけを描画し、`warning.message` を
 * 一度も読まない — 到達しない文言が計算されているだけ。しかも
 * `preflight.ts` 側の `EMPTY_BAND` メッセージは `side` によらず
 * 「${sideLabel(side)}に被覆がないため」という共通テンプレートを使っており、
 * `side: 'C'` に対しても「C 自身に被覆がない」と書いてしまう（この
 * ファイルが side: 'C' 用に特別扱いしている事実と矛盾する）。したがって
 * 「どちらが勝つべきか」に実装上の答えはこのファイル一択：UI に出るのは
 * ここの文言だけであり、`preflight.ts` の `message` は使われるべきではない
 * （削除するかどうかは preflight.ts の所有者の判断）。
 */
import type { ViewpointId, ViewpointPreflightWarning } from '../geometry/preflight'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'

/** 警告の文言 + 断定 / 推定を示すテキストバッジ（色以外の提示。FR-027） */
export interface WarningCopy {
  badge: '確定' | '推定'
  title: string
  body: string
}

/** {@link warningCopy} が必要とする文脈。呼び出し側の引数順のブレを防ぐため 1 つにまとめる */
export interface WarningCopyContext {
  /** 実寸の共通シルエット高さ（mm、FR-029）。帯の mm 換算に使う */
  heightMm: number
  /** 視点 B の押し出し軸角（度、FR-102）。THIN_NECK の斜交注記に使う */
  axisAngleDeg: number
  /** 直交か（store の `selectIsOrthogonalAxes` と同じ判定） */
  isOrthogonalAxes: boolean
}

/** 正規化 Y（−H/2〜+H/2）→ 立体の下端からの実寸 mm */
function bandMm(y: number, heightMm: number): number {
  return ((y + WORKING_HEIGHT / 2) / WORKING_HEIGHT) * heightMm
}

/** 作業座標系の幅 → 実寸 mm */
function widthMm(width: number, heightMm: number): number {
  return (width * heightMm) / WORKING_HEIGHT
}

/** 警告文中の視点名。A・B は「高さごとの被覆」、C は「高さに依らない固定領域」（FR-101） */
const VIEWPOINT_LABEL: Record<ViewpointId, string> = {
  A: 'シルエット A',
  B: 'シルエット B',
  C: '視点 C',
}

/**
 * プリフライト警告の文言。
 *
 * certainty との対応を文体で守る：
 * - `'exact'`（EMPTY_INTERSECTION / EMPTY_BAND / SIMPLIFIED）→「〜です」と断定
 * - `'estimated'`（LIKELY_DISCONNECTED / THIN_NECK）→「〜の可能性があります」
 *
 * EMPTY_BAND / EMPTY_INTERSECTION に失敗の語彙は使わない — 幾何学的に必ず
 * 起きる正常な帰結であり、EMPTY_BAND では生成もそのまま実行される
 * （FR-012 / US-001）。数値には「約」を付ける（帯の存在自体は断定できるが、
 * 端の位置は走査線の標本解像度に依存する）。
 *
 * switch は網羅的（default なし）— 警告コード追加時はコンパイルエラーになる。
 */
export function warningCopy(
  warning: ViewpointPreflightWarning,
  ctx: WarningCopyContext,
): WarningCopy {
  switch (warning.code) {
    case 'EMPTY_INTERSECTION': {
      const emptySides = warning.emptySides
      if (emptySides.length === 0) {
        // 高さ範囲そのものが重ならない場合、どちらも「相手の高さにいない」だけで
        // 特定の視点に責任を帰せない（geometry/preflight.ts の emptyIntersection）
        return {
          badge: '確定',
          title: '交差しない組み合わせです',
          body: '高さ範囲そのものが重ならないため、この組み合わせの交差は空です。特定の図形が原因とは言えません。図形の高さや大きさを見直すと立体が生成できます。',
        }
      }

      const abSides = emptySides.filter((side): side is 'A' | 'B' => side !== 'C')
      const abNamed = abSides.map((side) => VIEWPOINT_LABEL[side])
      const blamesC = emptySides.includes('C')

      if (!blamesC) {
        // A・B のみ：これらは文字どおり「その視点自身に被覆がない高さがある」ので
        // 従来どおり「必要な被覆がなかった」と書いてよい
        return {
          badge: '確定',
          title: '交差しない組み合わせです',
          body: `${abNamed.join('・')}に必要な被覆がなかったため、この組み合わせの交差は空です。${abNamed.join('・')}を変えると立体が生成できることがあります。`,
        }
      }

      // C が責任視点に含まれる場合：preflight.ts の `blamed.C` は「A・B が
      // 両方とも被覆を持つ高さで、C がその位置を許さなかった」ときに立つ
      // （emptyC の判定は !emptyA && !emptyB の下でしか行わない）。つまり
      // 「C 自身に必要な被覆がなかった」という A/B と同型の文は事実として誤り —
      // C は高さごとの被覆という量を持たない固定領域である（EMPTY_BAND の C 分岐と
      // 同じ理由）。ここでは「A・B の被覆と、C が許す位置が噛み合わない」という
      // 正しい形で書き、対処も C だけでなく A・B のどちらを変えても同様に効くことを示す
      // （「C を変えると」とだけ書くと、A・B を変える方が簡単な場合にも C だけを
      // 勧める誤ったアドバイスになる）
      const abClause = abNamed.length > 0 ? `${abNamed.join('・')}に材料がない高さもあり、` : ''
      return {
        badge: '確定',
        title: '交差しない組み合わせです',
        body: `${abClause}シルエット A・B の両方に材料がある高さでも、視点 C がその位置を一度も許していないため、この組み合わせの交差は空です。視点 C は高さに依らず横から一様に削る固定の領域であり、C 自身に高さごとの被覆が欠けているわけではありません。視点 C・シルエット A・シルエット B のいずれを変えても立体が生成できることがあります。`,
      }
    }
    case 'EMPTY_BAND': {
      const [y0, y1] = warning.band
      const lo = Math.round(bandMm(Math.min(y0, y1), ctx.heightMm))
      const hi = Math.round(bandMm(Math.max(y0, y1), ctx.heightMm))
      const label = VIEWPOINT_LABEL[warning.side]
      if (warning.side === 'C') {
        // 訂正済みの適格性ルール（illusion-catalogue.md）: 視点 C は
        // 「高さごとの被覆」を持たない固定領域なので、A・B にはこの帯の
        // 材料があるのに C がその位置を許さない、という事実を書く。
        // 「3 つとも被覆がない」と書くと誤り。
        return {
          badge: '確定',
          title: '視点 C がこの高さ帯を許していません',
          body: `下から約 ${lo}〜${hi}mm の帯には、シルエット A・B の両方に材料がありますが、${label}がこの位置を許さないため、立体はこの帯で途切れます。${label}は高さに依らず横から一様に削る固定の領域です（A・B のような高さごとの被覆ではありません）。A・B の被覆の位置がこの許容範囲とずれるとこの帯になります。これは不具合ではなく、この組み合わせの性質です。生成はそのまま行われます。`,
        }
      }
      return {
        badge: '確定',
        title: `${label}が欠ける高さ帯があります`,
        body: `下から約 ${lo}〜${hi}mm の帯では${label}に材料がないため、他の視点に材料があってもこの帯では立体が途切れます。これは不具合ではなく、離れたパーツを持つ図形（小文字の i や複数パーツの SVG など）で必ず生じる、この組み合わせの性質です。生成はそのまま行われます。`,
      }
    }
    case 'LIKELY_DISCONNECTED':
      return {
        badge: '推定',
        title: '複数パーツに分かれる可能性があります',
        body: `走査線の解析では、立体が複数のパーツ（${warning.components} 個程度）に分かれる可能性があります。確定した数は生成後にパーツ数として表示されます。分かれたまま印刷すると別々の部品になります。`,
      }
    case 'THIN_NECK': {
      const mm = widthMm(warning.minWidth, ctx.heightMm)
      const mmText = mm.toFixed(1)
      // FR-102: 斜交軸ではせん断により実際のくびれがここでの推定より
      // |sin φ| 倍ぶん細くなりうる（geometry/preflight.ts「斜交軸とプリフライト」）。
      // 直交（既定 90°）ではこの注記は付けない — sin 90° = 1 で影響がないため
      const obliqueCaveat = ctx.isOrthogonalAxes
        ? ''
        : (() => {
            const sinPhi = Math.abs(Math.sin((ctx.axisAngleDeg * Math.PI) / 180))
            const worstMm = (mm * sinPhi).toFixed(1)
            return ` 現在は斜交軸（軸角 ${ctx.axisAngleDeg}°）のため、この推定は楽観的です — せん断により実際のくびれは最大で |sin ${ctx.axisAngleDeg}°| ≈ ${sinPhi.toFixed(2)} 倍、約 ${worstMm}mm まで細くなる可能性があります。`
          })()
      return {
        badge: '推定',
        title: '細いくびれがある可能性があります',
        body: `最も細い部分の幅は約 ${mmText}mm と推定されます。この細さでは印刷時に折れたり、スライサーで消えたりする可能性があります。実寸を大きくするか、くびれの少ない図形にすると緩和できます。${obliqueCaveat}`,
      }
    }
    case 'SIMPLIFIED':
      return {
        badge: '確定',
        title: '輪郭を単純化しました',
        body: `頂点数が上限（10,000）を超えたため、輪郭を ${warning.before} 点から ${warning.after} 点へ許容誤差付きで単純化しています。ごく細部は変わりますが、全体の形は保たれます。`,
      }
  }
}

/**
 * `store.liveYRange`（FR-101: すべての視点が同時に材料を持つ高さ帯）の
 * mm 提示。`EMPTY_BAND` と同じ丸め規約（`Math.round` + 「約」）を使う —
 * どちらも走査線サンプリングの標本解像度に依存する数値だから。
 * 帯がない（プリフライト前・空交差）ときは null。
 */
export function formatLiveYRange(
  liveYRange: readonly [number, number] | null,
  heightMm: number,
): string | null {
  if (liveYRange === null) return null
  const [y0, y1] = liveYRange
  const lo = Math.round(bandMm(Math.min(y0, y1), heightMm))
  const hi = Math.round(bandMm(Math.max(y0, y1), heightMm))
  return `下から約 ${lo}〜${hi}mm の帯だけが、すべての視点で同時に材料を持ち、立体になります。`
}
