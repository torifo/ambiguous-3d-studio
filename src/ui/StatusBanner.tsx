/**
 * 生成ステータスとプリフライト警告の表示（Task 5.2 / FR-012 / FR-014 / FR-025 / FR-027）。
 *
 * ## 警告は「エラー」ではなく「この組み合わせの性質」
 *
 * プリフライト警告は、選んだ 2 図形の組み合わせが幾何学的に持つ性質の提示で
 * あって、ユーザーの誤りでも実装の不具合でもない（FR-012）。小文字の `i` を
 * 選べば空帯は**必ず**生じるし、どの実装でも回避できない。したがって文言は
 * 失敗の語彙（エラー / 失敗 / 無効）を使わず、性質の説明として書く。
 *
 * `certainty` で文体を変える（geometry/preflight.ts の `ViewpointPreflightWarning`
 * — FR-101 で視点名を足した以外はコードも契約も geometry/types.ts の
 * `PreflightWarning` と同一）：
 * - `'exact'`（スライス恒等式による断定）→「〜です」
 * - `'estimated'`（走査線サンプリングの推定）→「〜の可能性があります」
 * 断定 / 推定の区別はテキストバッジ（確定 / 推定）でも提示し、色に依存しない。
 * 文言そのものは ./statusCopy.ts に切り出してある（Fast Refresh 対応。
 * ui/liveAngleText.ts と同じ理由）。
 *
 * ## aria-live（FR-027）
 * ステータス行は `role="status"`、警告一覧は `aria-live="polite"` の常設
 * リージョンとして**常にマウントしておく**（後からリージョンごと現れた内容は
 * 支援技術に通知されないため、器を先に置き中身だけを差し替える）。
 */
import {
  selectIsOrthogonalAxes,
  selectViewpointCount,
  useStudioStore,
  type StudioStatus,
} from '../store/useStudioStore'
import type { CsgError } from '../worker/protocol'
import { stlMmPerUnit } from '../studio/scale'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'
import { formatLiveYRange, warningCopy, type WarningCopy } from './statusCopy'

export interface StatusBannerProps {
  /**
   * FR-025: `init-failed` からの再試行。App はパイプラインの `retry`
   * （store と Worker クライアントの両方を復帰させる）を渡すこと。
   * 未指定時は store の `retryInit()` のみにフォールバックする —
   * 状態機械は `loading-wasm` へ戻るが Worker は再起動されないため、
   * 配線済みのアプリでは必ずパイプラインの retry を渡す。
   */
  onRetryInit?: () => void
}

/**
 * FR-025 の状態 → 表示文言。`loading-wasm` は**正常系**であり、
 * エラーの語彙を使わない（「準備中」）。`error` の実際の見出しは
 * {@link describeError} が CsgError の内容から決める。
 */
const STATUS_LABELS: Record<StudioStatus, string> = {
  'loading-wasm': '準備中 — 演算エンジンを読み込んでいます',
  ready: '準備完了',
  generating: '生成中…',
  success: '生成完了',
  error: '生成を完了できませんでした',
  'init-failed': '演算エンジンの初期化に失敗しました',
}

interface Copy {
  title: string
  body: string
}

/**
 * 生成エラー（CsgError）の文言。`EMPTY_RESULT` は失敗ではなく
 * 「交差しない組み合わせ」という性質の提示（US-001）なので、
 * 他のコードと違い失敗の語彙を使わない。
 * switch は網羅的（default なし）— コード追加時はここがコンパイルエラーになる。
 *
 * `EMPTY_RESULT` だけは視点数で文面を分ける（FR-101 / illusion-catalogue.md の訂正）。
 * `CsgError` 自体は `{ code: 'EMPTY_RESULT' }` のみでどの視点が原因かの情報を
 * 持たないため（プリフライトの `EMPTY_INTERSECTION.emptySides` はここではなく
 * 下の警告一覧 `warningCopy()` 側が持つ — 責務は分けたまま、視点「数」だけをここで見る）：
 * - 2 視点: 「2 つのシルエットが同じ高さで同時に材料を持つ」という従来の文言のまま
 * - 3 視点: 「2 つ」「同じ高さで」のどちらも視点 C には当てはまらない。C は
 *   高さに依らず横から一様に削る固定領域であり「その高さの被覆」を持たないため
 *   （geometry/preflight.ts ファイル冒頭の訂正）、3 視点をひとまとめに「同じ高さで」と
 *   書くと C については誤りになる。ここでは「A・B の被覆と C が許す位置が噛み合わない」
 *   という正しいモデルで書く
 */
function describeError(error: CsgError, viewpointCount: 2 | 3): Copy {
  switch (error.code) {
    case 'EMPTY_RESULT':
      return {
        title: 'この組み合わせは交差しません',
        body:
          viewpointCount === 3
            ? '3 つの視点が同時に材料を持つ位置の組み合わせがないため、交差立体は生じません。視点 C は高さに依らず横から一様に削る固定の領域なので、シルエット A・B の両方に材料がある高さでも、C がその位置を許さなければ交差は空になります。これは図形の組み合わせの性質です。視点 C・シルエット A・シルエット B のいずれかを変えると生成できることがあります。'
            : '2 つのシルエットが同じ高さで同時に材料を持つことがないため、交差立体は生じません。これは図形の組み合わせの性質です。どちらかの図形を変えると生成できます。',
      }
    case 'NOT_MANIFOLD':
      return {
        title: '生成結果を検証できませんでした',
        body: `演算結果が印刷可能なメッシュ（2-manifold）の検証を通りませんでした。入力を少し単純な形にすると生成できることがあります。（詳細: ${error.detail}）`,
      }
    case 'INVALID_INPUT':
      return {
        title: '入力を処理できませんでした',
        body: `この入力は演算エンジンに受け付けられませんでした。（詳細: ${error.detail}）`,
      }
    case 'WORKER_CRASHED':
      return {
        title: '演算エンジンを再起動しました',
        body: `生成中に演算エンジンが停止したため、自動で再起動して 1 回だけ再試行しましたが完了しませんでした。入力を変更すると再生成されます。（詳細: ${error.detail}）`,
      }
    case 'WASM_INIT_FAILED':
      return {
        title: '演算エンジンの初期化に失敗しました',
        body: `WebAssembly エンジンを起動できませんでした。「再試行」を押すか、ブラウザを最新版に更新してください。（詳細: ${error.detail}）`,
      }
  }
}

/** 警告 1 件の表示。バッジ（確定 / 推定）はテキストなので色覚に依存しない */
function WarningItem(props: { copy: WarningCopy }) {
  const { copy } = props
  return (
    <li className="rounded border border-neutral-700 p-2 text-xs">
      <p className="font-medium text-neutral-200">
        <span
          className={`mr-1.5 inline-block rounded border border-current px-1 align-middle text-[10px] ${
            copy.badge === '確定' ? 'text-sky-300' : 'text-amber-300'
          }`}
        >
          {copy.badge}
        </span>
        {copy.title}
      </p>
      <p className="mt-1 text-neutral-400">{copy.body}</p>
    </li>
  )
}

/** 生成ステータス・エラー・プリフライト警告・パーツ数の提示 */
export function StatusBanner(props: StatusBannerProps) {
  const status = useStudioStore((s) => s.status)
  const lastError = useStudioStore((s) => s.lastError)
  const warnings = useStudioStore((s) => s.warnings)
  const lastResult = useStudioStore((s) => s.lastResult)
  const liveYRange = useStudioStore((s) => s.liveYRange)
  const heightMm = useStudioStore((s) => s.options.heightMm)
  const axisAngleDeg = useStudioStore((s) => s.input.axisAngleDeg)
  const isOrthogonalAxes = useStudioStore(selectIsOrthogonalAxes)
  const viewpointCount = useStudioStore(selectViewpointCount)
  const storeRetryInit = useStudioStore((s) => s.retryInit)
  const retry = props.onRetryInit ?? storeRetryInit
  const warningCtx = { heightMm, axisAngleDeg, isOrthogonalAxes }
  const liveRangeText = formatLiveYRange(liveYRange, heightMm)

  const errorCopy =
    (status === 'error' || status === 'init-failed') && lastError !== null
      ? describeError(lastError, viewpointCount)
      : null

  // EMPTY_RESULT は性質の提示なので中立の枠、それ以外の失敗は注意の枠。
  // 枠の色は補助であり、区別の実体は見出しと本文のテキストが担う
  const errorTone =
    lastError?.code === 'EMPTY_RESULT' ? 'border-neutral-700' : 'border-amber-400/60'

  // FR-014: decompose() による確定値。推定（LIKELY_DISCONNECTED）と違い断定で書く
  const splitNote =
    status === 'success' && lastResult !== null && lastResult.componentCount > 1
      ? {
          badge: '確定' as const,
          title: `${lastResult.componentCount} 個のパーツに分かれています`,
          body: `生成結果は ${lastResult.componentCount} 個の非連結パーツです（分解による確定値です）。このまま印刷すると別々の部品になります。`,
        }
      : null

  const volumeCm3 =
    lastResult !== null
      ? ((lastResult.volume * stlMmPerUnit(heightMm, WORKING_HEIGHT) ** 3) / 1000).toFixed(1)
      : null

  return (
    <div className="flex flex-col gap-2">
      {/* ステータス行（FR-025）。role="status" = aria-live: polite の常設リージョン */}
      <div role="status" className="text-xs text-neutral-300">
        <p className="font-medium">
          {status === 'error' && errorCopy !== null ? errorCopy.title : STATUS_LABELS[status]}
        </p>
        {status === 'success' && lastResult !== null && (
          <p className="mt-0.5 text-[11px] text-neutral-500">
            パーツ {lastResult.componentCount} ・ 三角形 {lastResult.triangleCount} ・ 体積 約
            {volumeCm3}cm³ ・ {Math.round(lastResult.elapsedMs)}ms
          </p>
        )}
        {/* FR-101: すべての視点が同時に材料を持つ帯（liveYRange）。2 視点でも
            3 視点でも意味は同じだが、3 視点では 2 視点よりずっと狭くなりうるため
            常に mm で提示する（store.liveYRange の doc を参照） */}
        {liveRangeText !== null && (
          <p className="mt-0.5 text-[11px] text-neutral-500">{liveRangeText}</p>
        )}
        {status === 'error' && errorCopy !== null && (
          <p className={`mt-1 rounded border p-2 text-neutral-300 ${errorTone}`}>
            {errorCopy.body}
          </p>
        )}
      </div>

      {/* FR-025: init-failed は再試行手段を添えて提示する */}
      {status === 'init-failed' && (
        <div role="alert" className="rounded border border-red-400/60 p-2 text-xs">
          <p className="font-medium text-neutral-100">
            {errorCopy?.title ?? STATUS_LABELS['init-failed']}
          </p>
          <p className="mt-1 text-neutral-300">
            {errorCopy?.body ?? '再試行するか、ブラウザを最新版に更新してください。'}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-2 min-h-11 w-full rounded border border-neutral-500 px-3 text-xs text-neutral-100 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            再試行
          </button>
        </div>
      )}

      {/* 警告 = この組み合わせの性質（FR-012）。リージョンは常にマウントしておく */}
      <section aria-live="polite" aria-label="この組み合わせの性質">
        {(warnings.length > 0 || splitNote !== null) && (
          <>
            <h2 className="mb-1.5 text-xs font-semibold text-neutral-200">
              この組み合わせの性質
            </h2>
            <ul className="flex flex-col gap-1.5">
              {splitNote !== null && <WarningItem copy={splitNote} />}
              {warnings.map((warning, index) => (
                <WarningItem
                  key={`${warning.code}-${index}`}
                  copy={warningCopy(warning, warningCtx)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
