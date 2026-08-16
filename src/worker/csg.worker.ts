import createManifold from 'manifold-3d'
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d'
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url'
import { boundsOf } from '../geometry/normalize'
import { toPolygons } from '../geometry/toPolygons'
import type { CsgError, CsgRequest, CsgResponse, WorkerOutbound } from './protocol'

/**
 * CSG Worker 本体（Task 3.1 / design.md「4. Worker 境界」「2.1 軸の割り当て」）。
 *
 * ## 構成
 *
 * このファイルは 2 層に分かれる：
 *
 * 1. **純粋な CSG ロジック** `performCsg(wasm, request)` — 初期化済みの
 *    Manifold モジュールを受け取り、リクエスト 1 件を同期的に処理して
 *    `CsgResponse` を返す。DOM / Worker API に依存しないため、
 *    Node 上の Vitest から直接テストできる（csg.integration.test.ts）。
 * 2. **Worker シェル** — Wasm の初期化（1 回のみ）と `onmessage` の配線。
 *    実際に Worker として起動されたときだけ有効化される。
 *
 * ## Wasm アセットの解決（ADR-006 / Deployment）
 *
 * `manifold-3d/manifold.wasm?url` の `?url` インポートが、Vite に Wasm を
 * アセットとして出力させ、GitHub Pages の `base` プレフィックスを付与させる。
 * これを外すと manifold-3d 既定の相対解決になり、**dev では動いて本番だけ
 * 404** になる。`locateFile` ごと消さないこと。
 *
 * ## メモリ規律（NFR-012）
 *
 * `CrossSection` / `Manifold` は Wasm 所有オブジェクトで GC されない。
 * **メソッドチェーン禁止** — チェーンすると中間オブジェクトへの参照が残らず
 * `delete()` できない。全オブジェクトを個別変数に保持し、`finally` で
 * 生成の逆順に破棄する。
 *
 * **ライブラリ内部でチェーンする API も禁止**。`extrude(..., center: true)` は
 * manifold.js 内部で `man.translate(...)` をチェーンし、中間の `man` が JS 側に
 * 返らないまま解放不能になる（1 呼び出しで Wasm Manifold が 2 個生成され、
 * 追跡できるのは translate 後の 1 個だけ）。センタリングは非センタリング押し出し
 * ＋明示的な `translate` として自前で追跡する。内部で変換をチェーンする
 * ライブラリメソッドを新たに使う前に、必ず manifold.js の実装を確認すること。
 *
 * リーク判定は 2 系統：生存オブジェクト数（`getLiveWasmObjectCount`）と、
 * テスト側で実測する Wasm ヒープ高水位の**停滞（plateau）**。カウンタは自前の
 * 記録に対する検算でしかなく、ライブラリ内部のリークはヒープ高水位でしか
 * 見えない。Emscripten のヒープは `delete()` しても縮まないため、
 * 容量の**減少**を見る判定は必ず偽陽性になる（見るべきは「増えないこと」）。
 */

/** 押し出し深さのマージン（design.md「2. 押し出し深さ」。深さ算出自体は studio/ 側の責務） */
export const DEPTH_MARGIN = 0.02

/** `delete()` を持つ Wasm 所有オブジェクトの共通形 */
interface WasmHandle {
  delete(): void
}

/**
 * 生存中の Wasm オブジェクト数。`track` で加算、`release` で減算。
 * リクエスト完了時にゼロへ戻ることをテストが検証する（NFR-012）。
 */
let liveWasmObjectCount = 0

/** Wasm オブジェクトの生成を記録する。`new` / ファクトリ呼び出しは必ずこれで包む */
function track<T extends WasmHandle>(obj: T): T {
  liveWasmObjectCount++
  return obj
}

/** Wasm オブジェクトを破棄しカウンタを減算する。未生成（null）は無視 */
function release(obj: WasmHandle | null): void {
  if (obj === null) return
  obj.delete()
  liveWasmObjectCount--
}

/** リークテスト用：現在生存している Wasm オブジェクト数を返す */
export function getLiveWasmObjectCount(): number {
  return liveWasmObjectCount
}

/** unknown な例外から人間が読めるメッセージを取り出す */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * リクエスト 1 件分のブール交差を実行する。
 *
 * パイプライン（design.md「2.1 軸の割り当てとカメラ規約」）:
 *
 * 1. `new CrossSection(toPolygons(contours), 'Positive')` — A / B とも XY 平面
 * 2. `.extrude(depth, 0, 0, [1, 1], false)` ＋ `translate([0, 0, -depth / 2])` —
 *    **原点対称のセンタリングは必須**（忘れると片方が Z=0 から始まり、交差が
 *    非対称に切り落とされる）が、`center: true` は**使用禁止**：ライブラリ内部で
 *    translate をチェーンし、中間 Manifold が毎回 2 個リークする
 *    （ファイル冒頭「メモリ規律」参照）。センタリングは明示的な translate で行い、
 *    押し出し結果・平行移動結果の両方を追跡・破棄する
 * 3. B のみ `rotate([0, 90, 0])` — Y 軸まわり **+90°** で押し出し軸を
 *    world +X へ向ける。回転は `(x, y, z) → (z, y, −x)` であり、この符号は
 *    +X 側カメラの規約と対で確定している。**符号を変えると B が鏡像になる**
 * 4. `prismA.intersect(prismB)`
 * 5. `status() !== 'NoError'` で破棄（文字列リテラル比較 — `NoError` という
 *    識別子は存在しない。ADR-006）
 * 6. `decompose()` が連結成分数の唯一の確定根拠（プリフライトは推定のみ）
 * 7. `getMesh()` の配列は Wasm 管理メモリを指しうるため、
 *    **新規 typed array にコピーしてから**返す
 *
 * 深さの防御的検証：深さの**算出**は studio 側（Wave 4）の責務だが、対向
 * シルエットの幅に足りない深さを受けても Manifold は `'NoError'` の正常な
 * 2-多様体を返すため、ここで拒否しない限り**欠けた立体が成功として通る**。
 * `a.depth >= width(B) × (1 + DEPTH_MARGIN)`（および対称に b）を検証し、
 * 不足は `INVALID_INPUT` で不足量を明示して拒否する。
 *
 * エラー分類：入力起因（輪郭検証・深さ・未実装オプション）は `INVALID_INPUT`、
 * エンジンが不正メッシュを報告したら `NOT_MANIFOLD`（detail に `status()` の
 * 文字列をそのまま載せる）、交差が空なら `EMPTY_RESULT`。
 */
export function performCsg(wasm: ManifoldToplevel, request: CsgRequest): CsgResponse {
  const startedAt = performance.now()
  const fail = (error: CsgError): CsgResponse => ({
    generation: request.generation,
    ok: false,
    error,
  })

  if (request.baseplate !== null && request.baseplate.enabled) {
    // 台座は Task 6.4。有効化されたリクエストを黙って無視する（台座なしで返す）
    // より、明示的に拒否する方が事故が見える
    return fail({
      code: 'INVALID_INPUT',
      detail: 'baseplate is not implemented yet (Task 6.4)',
    })
  }
  if (!Number.isFinite(request.a.depth) || request.a.depth <= 0) {
    return fail({
      code: 'INVALID_INPUT',
      detail: `a.depth must be a positive finite number (got ${request.a.depth})`,
    })
  }
  if (!Number.isFinite(request.b.depth) || request.b.depth <= 0) {
    return fail({
      code: 'INVALID_INPUT',
      detail: `b.depth must be a positive finite number (got ${request.b.depth})`,
    })
  }

  // 生成される Wasm オブジェクトの全量を個別変数で保持する（チェーン禁止）。
  // 台座実装時（Task 6.4）は plate / withPlate をこの並びに追加し、
  // finally の破棄順にも同じ位置（生成の逆順）で組み込むこと。
  let sectionA: CrossSection | null = null
  let sectionB: CrossSection | null = null
  let rawA: Manifold | null = null
  let rawB: Manifold | null = null
  let prismA: Manifold | null = null
  let centeredB: Manifold | null = null
  let prismB: Manifold | null = null
  let solid: Manifold | null = null
  let parts: Manifold[] | null = null

  try {
    let polygonsA: [number, number][][]
    let polygonsB: [number, number][][]
    try {
      polygonsA = toPolygons(request.a.contours)
      polygonsB = toPolygons(request.b.contours)
    } catch (err) {
      return fail({ code: 'INVALID_INPUT', detail: messageOf(err) })
    }

    // 深さの防御的検証（関数 doc 参照）。toPolygons 成功後なので boundsOf は
    // 投げない（同じ不変条件を検証済み）。等値は許容（深さ算出側と同一式のため）、
    // 浮動小数点の経路差だけを相対 1e-9 で吸収する
    const boundsA = boundsOf(request.a.contours)
    const boundsB = boundsOf(request.b.contours)
    const requiredDepthA = (boundsB.maxX - boundsB.minX) * (1 + DEPTH_MARGIN)
    const requiredDepthB = (boundsA.maxX - boundsA.minX) * (1 + DEPTH_MARGIN)
    if (request.a.depth < requiredDepthA * (1 - 1e-9)) {
      return fail({
        code: 'INVALID_INPUT',
        detail:
          `a.depth ${request.a.depth} does not cover silhouette B along Z — ` +
          `need >= ${requiredDepthA} (= width(B) * (1 + DEPTH_MARGIN)); ` +
          'the intersection would be silently clipped',
      })
    }
    if (request.b.depth < requiredDepthB * (1 - 1e-9)) {
      return fail({
        code: 'INVALID_INPUT',
        detail:
          `b.depth ${request.b.depth} does not cover silhouette A along X — ` +
          `need >= ${requiredDepthB} (= width(A) * (1 + DEPTH_MARGIN)); ` +
          'the intersection would be silently clipped',
      })
    }

    sectionA = track(new wasm.CrossSection(polygonsA, 'Positive'))
    sectionB = track(new wasm.CrossSection(polygonsB, 'Positive'))

    // center: true は使用禁止（関数 doc の 2. 参照）— 非センタリングで押し出し、
    // センタリングは明示的に追跡した translate で行う
    rawA = track(sectionA.extrude(request.a.depth, 0, 0, [1, 1], false))
    rawB = track(sectionB.extrude(request.b.depth, 0, 0, [1, 1], false))
    prismA = track(rawA.translate([0, 0, -request.a.depth / 2]))
    centeredB = track(rawB.translate([0, 0, -request.b.depth / 2]))

    // A は回転しない（XY 断面のまま +Z 押し出し）。B のみ +90° で +X へ
    prismB = track(centeredB.rotate([0, 90, 0]))

    solid = track(prismA.intersect(prismB))

    const status = solid.status()
    if (status !== 'NoError') {
      return fail({ code: 'NOT_MANIFOLD', detail: `Manifold.status() returned '${status}'` })
    }
    if (solid.isEmpty()) {
      return fail({ code: 'EMPTY_RESULT' })
    }

    // 連結成分数の唯一の確定根拠。戻り配列の各要素も個別の Wasm オブジェクト
    parts = solid.decompose()
    for (const part of parts) {
      track(part)
    }
    const componentCount = parts.length
    const volume = solid.volume()

    const mesh = solid.getMesh()
    if (mesh.numProp !== 3) {
      // CrossSection 由来の Manifold はプロパティを持たないので常に 3 のはず。
      // 破れたらエンジンとの契約違反として扱う
      return fail({
        code: 'NOT_MANIFOLD',
        detail: `getMesh() returned numProp ${mesh.numProp} — expected positions-only (3)`,
      })
    }
    // Wasm 管理メモリからの防御的コピー。次の演算でヒープが動くと元の配列は壊れる
    const positions = new Float32Array(mesh.vertProperties)
    const indices = new Uint32Array(mesh.triVerts)

    return {
      generation: request.generation,
      ok: true,
      positions,
      indices,
      componentCount,
      volume,
      elapsedMs: performance.now() - startedAt,
    }
  } catch (err) {
    // Wasm バインディング境界の予期しない失敗。詳細をそのまま診断情報に載せる
    return fail({ code: 'INVALID_INPUT', detail: messageOf(err) })
  } finally {
    // 生成の逆順に破棄：parts[]（逆順）→ solid → prismB → centeredB → prismA
    // → rawB → rawA → sectionB → sectionA。decompose() の戻り配列が最も漏れやすい
    if (parts !== null) {
      for (let i = parts.length - 1; i >= 0; i--) {
        release(parts[i])
      }
    }
    release(solid)
    release(prismB)
    release(centeredB)
    release(prismA)
    release(rawB)
    release(rawA)
    release(sectionB)
    release(sectionA)
  }
}

// ---------------------------------------------------------------------------
// Worker シェル — 実際に Worker として起動されたときだけ有効化される。
// Node（Vitest）からこのモジュールを import しても副作用は起きない。
// ---------------------------------------------------------------------------

/**
 * Worker スコープの最小型。tsconfig は lib DOM（Window 前提）なので、
 * Worker 側の `postMessage(message, transfer)` シグネチャをここで明示する。
 * 送信できるのは生成レスポンスとライフサイクル通知（`WorkerOutbound`）のみ。
 */
interface CsgWorkerScope {
  onmessage: ((event: MessageEvent<CsgRequest>) => void) | null
  postMessage(message: WorkerOutbound, transfer?: Transferable[]): void
}

/** Worker スコープ内で実行されているか（Node / メインスレッドでは false） */
function isWorkerScope(): boolean {
  const g = globalThis as { WorkerGlobalScope?: abstract new () => unknown }
  return typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope
}

/** 初期化は Worker の生存期間で 1 回のみ（ADR-006）。失敗時は次の要求で再試行 */
let manifoldReady: Promise<ManifoldToplevel> | null = null

function ensureManifold(): Promise<ManifoldToplevel> {
  if (manifoldReady === null) {
    manifoldReady = (async () => {
      try {
        const wasm = await createManifold({ locateFile: () => manifoldWasmUrl })
        wasm.setup()
        return wasm
      } catch (err) {
        // 失敗した Promise を持ち続けると永久に復帰できない。捨てて再試行可能にする
        manifoldReady = null
        throw err
      }
    })()
  }
  return manifoldReady
}

/** リクエスト 1 件の受理 → 演算 → 転送。成功時の typed array は transferable として渡す */
async function handleRequest(scope: CsgWorkerScope, request: CsgRequest): Promise<void> {
  let wasm: ManifoldToplevel
  try {
    wasm = await ensureManifold()
  } catch (err) {
    scope.postMessage({
      generation: request.generation,
      ok: false,
      error: { code: 'WASM_INIT_FAILED', detail: messageOf(err) },
    })
    return
  }

  const response = performCsg(wasm, request)
  if (response.ok) {
    scope.postMessage(response, [response.positions.buffer, response.indices.buffer])
  } else {
    scope.postMessage(response)
  }
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as CsgWorkerScope
  // 起動と同時に Wasm を先読みし（NFR-003）、成否をライフサイクル通知として
  // 明示する。通知なしだとクライアントはウォームアップ生成の結果から準備完了を
  // 推測するしかなく、エンジン異常の INVALID_INPUT が「正常起動」に化ける
  // （protocol.ts の WorkerLifecycleMessage 解説参照）。init-failed 後も
  // ensureManifold は破棄済みなので、後続リクエストで再試行される
  ensureManifold()
    .then(() => scope.postMessage({ type: 'ready' }))
    .catch((err: unknown) => scope.postMessage({ type: 'init-failed', detail: messageOf(err) }))
  scope.onmessage = (event: MessageEvent<CsgRequest>): void => {
    void handleRequest(scope, event.data)
  }
}
