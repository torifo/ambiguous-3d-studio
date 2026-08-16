/**
 * 生成パイプラインの工程別計測（Task 7.2 / NFR-001 / design.md「Performance Budget」）。
 *
 * `performance.mark` / `performance.measure` を工程境界に置き、1 回の生成を
 * **入力変更 → 描画ハンドオフ**の 1 本の run として記録する。開発時は
 * `globalThis.__ambiguousPerf` から内訳を読める（E2E の NFR-001 計測もここを読む）。
 *
 * ## 工程は「連続した非重複スパン」でなければならない
 *
 * 予算表（design.md）は工程ごとの上限を並べただけで、**工程の合計が実測の
 * エンドツーエンドと一致する保証をどこにも持たない**。一致しなければ、
 * どこかに計測されていない工程があるということで、予算の議論そのものが
 * 成り立たない（実際、この計測で 3 工程が予算表から抜けていることが分かった —
 * `dispatch` / `debounce` / `render`）。
 *
 * そこで API を「区間を個別に開閉する」形にせず、**カーソル**にした：
 * {@link stage} は「直前の工程を閉じて次を開く」だけで、隙間を作れない。
 * run 全体は `run-start` → `run-end` の**独立した 1 本の measure**で測り、
 * 工程の総和との差（{@link PerfSample.unaccountedMs}）を毎回突き合わせる。
 * 差が {@link PERF_SUM_TOLERANCE_MS} を超えるか、期待した工程が欠けていれば
 * `console.error` で表面化させる（= 配線漏れの検出）。
 *
 * ## 本番では 1 命令も残さない
 *
 * {@link PERF_ENABLED} は `import.meta.env.DEV` と `import.meta.env.VITE_ENABLE_PERF`
 * だけで決まる。どちらもビルド時に静的な真偽値へ置換されるため、公開ビルドでは
 * `PERF_ENABLED` が定数 `false` に畳まれ、各関数の先頭 `if (!PERF_ENABLED) return`
 * 以降が丸ごと DCE で消える（NFR-041 と同じ「フラグで落とす」規律）。
 * 計測を有効にしたまま本番ビルドを取りたいときだけ `VITE_ENABLE_PERF=true` を渡す。
 *
 * ## 本モジュールは依存ゼロ
 *
 * メインスレッド（studio / worker client）と CSG Worker の**両方**から import
 * されるため、`three` や `manifold-3d` はもちろん、いかなるモジュールにも
 * 依存しない。Worker 側は {@link createStageCursor} と
 * {@link isWorkerPerfMessage} の型だけを使う。
 */

/**
 * 計測を有効にするか（**モジュール内部の**ビルド時定数）。
 *
 * ここを跨いだ定数伝播をバンドラに期待しないために、モジュール内の全ガードは
 * この**ローカル**定数を見る。公開ビルドでは `false || undefined === 'true'`
 * が `false` に畳まれ、`if (!ENABLED) return` 以降が丸ごと DCE で消える
 * （実際に `dist/` を grep して mark 名の文字列が残らないことを確認している）。
 * 実行時の URL クエリや localStorage を見てはならない — 見た瞬間に公開ビルド
 * から消せなくなる。
 */
const ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_ENABLE_PERF === 'true'

/**
 * 計測が有効か（呼び出し側の分岐用）。値そのものは {@link ENABLED} と同じだが、
 * 各関数のガードは export 越しではなくローカル定数で行う。
 */
export const PERF_ENABLED: boolean = ENABLED

/**
 * 生成 1 回を構成する工程。**この順序で連続する**（カーソルが順に開閉する）。
 *
 * design.md「Performance Budget」との対応：
 * - `contour` = 輪郭抽出（5ms）
 * - `normalize` = 正規化（2ms）
 * - `preflight` = プリフライト 256 走査線（10ms）
 * - `dispatch` = **予算表に無い**。深さ算出（bbox×2）とリクエスト組み立て
 * - `debounce` = **予算表に無い**。NFR-004 の合流待ち（既定 120ms）
 * - `transport` = postMessage 往復（5ms）— Worker の実行時間は差し引く
 * - `csg` = CrossSection 構築 + extrude + intersect + MeshGL コピー（20+30+150+15）
 * - `mesh` = BufferGeometry 構築 + 法線（20ms）
 * - `render` = **予算表に無い**。ジオメトリ差し替え → store コミット → 次フレーム
 */
export type PerfStage =
  | 'contour'
  | 'normalize'
  | 'preflight'
  | 'dispatch'
  | 'debounce'
  | 'transport'
  | 'csg'
  | 'mesh'
  | 'render'

/** {@link PerfStage} の正順。欠落検出（`missingStages`）の基準にもなる */
export const PERF_STAGE_ORDER: readonly PerfStage[] = [
  'contour',
  'normalize',
  'preflight',
  'dispatch',
  'debounce',
  'transport',
  'csg',
  'mesh',
  'render',
]

/**
 * Worker 内の CSG 内訳。予算表の CrossSection / extrude / intersect /
 * MeshGL コピーの各行を個別に検証するために必要。
 *
 * `validate`〜`mesh` の合計は `CsgResponse.elapsedMs`（= メインスレッドの
 * `csg` 工程）に一致する。**`cleanup` だけは合計に含まれない** —
 * Wasm オブジェクトの `delete()` 掃除は `elapsedMs` を確定した**後**、
 * postMessage の**前**に走るため、メインスレッド側では `transport` に
 * 計上される。往復が予算の 5ms より重く見えるときの内訳がこれ。
 */
export type WorkerCsgStage =
  | 'validate'
  | 'section'
  | 'extrude'
  | 'intersect'
  | 'baseplate'
  | 'mesh'
  | 'cleanup'

/** {@link WorkerCsgStage} の正順 */
export const WORKER_CSG_STAGE_ORDER: readonly WorkerCsgStage[] = [
  'validate',
  'section',
  'extrude',
  'intersect',
  'baseplate',
  'mesh',
  'cleanup',
]

/** Worker → メインスレッドの計測通知。生成レスポンスとは別系統で送る */
export interface WorkerPerfMessage {
  type: 'csg-perf'
  /** 対応する `CsgRequest.generation` */
  generation: number
  /** 工程 → 実測 ms。`performCsg` が早期 return した工程は欠ける */
  stages: Partial<Record<WorkerCsgStage, number>>
}

/**
 * Worker からの計測通知か。
 *
 * `protocol.ts` の `WorkerOutbound` には**含めない**（計測は本番プロトコルの
 * 一部ではなく、公開ビルドでは送信自体が消える）。client 側は生成レスポンス
 * とライフサイクル通知の判別より**先に**これを弾くこと — `{ type: ... }` を
 * 持つため `isLifecycleMessage` に食われてしまう。
 */
export function isWorkerPerfMessage(data: unknown): data is WorkerPerfMessage {
  if (typeof data !== 'object' || data === null) return false
  return (data as { type?: unknown }).type === 'csg-perf'
}

/** 1 回の生成の計測結果 */
export interface PerfSample {
  /** この生成が属する store の epoch */
  epoch: number
  /** `run-start` → `run-end` の**独立した measure**。工程の総和とは別に測る */
  totalMs: number
  /** 工程 → 実測 ms。中断した run はサンプルにならないので通常は全工程が揃う */
  stages: Partial<Record<PerfStage, number>>
  /** `totalMs − Σstages`。0 から離れていれば計測されていない工程がある */
  unaccountedMs: number
  /** 記録されなかった工程（配線漏れ） */
  missingStages: PerfStage[]
  /** Worker 内の CSG 内訳（受け取れた場合のみ） */
  worker: Partial<Record<WorkerCsgStage, number>> | null
}

/**
 * 「工程の合計 = 実測エンドツーエンド」の許容差。`performance.mark` の
 * 解像度（Chrome は 5μs 刻みに丸める）と measure 自体のコスト分の余裕で、
 * 工程の抜けは必ずこれを超える。
 */
export const PERF_SUM_TOLERANCE_MS = 1

/** 保持するサンプル数の上限。長時間の開発セッションで際限なく溜めない */
const MAX_SAMPLES = 1000

/** mark / measure 名の名前空間。他ライブラリの計測と混ざらないようにする */
const MARK_NS = 'ambiguous'

/** `performance.mark` / `measure` が使えるか（Node の一部実行環境への保険） */
const HAS_USER_TIMING =
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function'

/**
 * 連続する工程を計測するカーソル。**隙間も重なりも作れない**のが唯一の存在理由
 * （ファイル冒頭「工程は連続した非重複スパンでなければならない」）。
 * メインスレッドの run と Worker 内の CSG 内訳で共用する。
 */
export interface StageCursor<K extends string> {
  /** 開始マークの名前（run 全体の measure の起点にも使う） */
  readonly startMark: string
  /** 現在の工程を閉じ、`next` を開始する */
  enter(next: K): void
  /** 現在の工程を閉じる（以後 `enter` しない） */
  close(): void
  /**
   * 直前に計測済みの工程 `from` から `ms` を切り出し、`to` に付け替える。
   * 往復時間から Worker の実行時間を分離する用途（合計は不変）。
   */
  split(from: K, to: K, ms: number): void
  /** 工程 → 実測 ms（閉じた工程のみ） */
  readonly durations: Partial<Record<K, number>>
  /** 使用した mark / measure をユーザータイミングのバッファから消す */
  dispose(): void
}

/** 計測無効時のカーソル。全メソッドが空で、mark も measure も打たない */
const NOOP_CURSOR: StageCursor<string> = {
  startMark: '',
  enter: () => {},
  close: () => {},
  split: () => {},
  durations: {},
  dispose: () => {},
}

/**
 * カーソルを 1 本作り、開始マークを打つ。計測無効時は共有の no-op を返す
 * （Worker のリクエスト経路から呼ばれるため、無効時は 1 バイトも触らせない）。
 *
 * @param prefix mark / measure 名の接頭辞（`run` / `csg` など）
 */
export function createStageCursor<K extends string>(prefix: string): StageCursor<K> {
  if (!ENABLED) return NOOP_CURSOR as StageCursor<K>
  const startMark = `${MARK_NS}:${prefix}:start`
  const durations: Partial<Record<K, number>> = {}
  const marks: string[] = [startMark]
  const measures: string[] = []
  let openStage: K | null = null
  let openMark = startMark

  if (HAS_USER_TIMING) performance.mark(startMark)

  const closeOpen = (endMark: string): void => {
    if (openStage === null) return
    if (HAS_USER_TIMING) {
      const name = `${MARK_NS}:${prefix}:${openStage}`
      const entry = performance.measure(name, openMark, endMark)
      measures.push(name)
      durations[openStage] = entry.duration
    } else {
      durations[openStage] = 0
    }
    openStage = null
  }

  let entered = false

  return {
    startMark,
    enter(next: K): void {
      if (!entered) {
        // 最初の工程は**開始マークそのもの**から始める。ここで新しいマークを
        // 打つと「カーソル生成 〜 最初の enter」が誰の工程にも属さない隙間に
        // なり、工程の合計が実測エンドツーエンドに届かなくなる
        entered = true
        openStage = next
        openMark = startMark
        return
      }
      const endMark = `${MARK_NS}:${prefix}:${next}@`
      if (HAS_USER_TIMING) performance.mark(endMark)
      marks.push(endMark)
      closeOpen(endMark)
      openStage = next
      openMark = endMark
    },
    close(): void {
      const endMark = `${MARK_NS}:${prefix}:end`
      if (HAS_USER_TIMING) performance.mark(endMark)
      marks.push(endMark)
      closeOpen(endMark)
    },
    split(from: K, to: K, ms: number): void {
      const measured = durations[from]
      if (measured === undefined) return
      // 付け替えは合計を変えない。往復が Worker の実行時間より短く出た場合
      // （タイマー解像度の差）でも負の工程を作らないよう 0 で止める
      const moved = Math.min(ms, measured)
      durations[from] = measured - moved
      durations[to] = (durations[to] ?? 0) + moved
    },
    durations,
    dispose(): void {
      if (!HAS_USER_TIMING) return
      for (const name of measures) performance.clearMeasures(name)
      for (const name of marks) performance.clearMarks(name)
      marks.length = 0
      measures.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// メインスレッドの run（入力変更 → 描画ハンドオフ）
// ---------------------------------------------------------------------------

interface ActiveRun {
  epoch: number
  cursor: StageCursor<PerfStage>
  /** Worker から届いた CSG 内訳（`stageAfterWorker` で受け取る） */
  worker: Partial<Record<WorkerCsgStage, number>> | null
}

let activeRun: ActiveRun | null = null
const samples: PerfSample[] = []
const listeners = new Set<(sample: PerfSample) => void>()
/** 中断理由 → 回数。「サンプルが 147 に足りない」の内訳を後から説明できるようにする */
const abandoned = new Map<string, number>()

/** rAF が無い環境（Vitest の node）ではマイクロタスクで代用する */
function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback())
  else queueMicrotask(callback)
}

/**
 * 新しい run を開始し、`contour`（輪郭抽出）工程に入る。
 * 入力変更（epoch 前進）と台座指紋の変化のたびに呼ぶ。
 * 未完了の run が残っていれば superseded として捨てる。
 */
export function startRun(epoch: number): void {
  if (!ENABLED) return
  if (activeRun !== null) {
    abandoned.set('superseded', (abandoned.get('superseded') ?? 0) + 1)
    activeRun.cursor.dispose()
  }
  const cursor = createStageCursor<PerfStage>('run')
  cursor.enter('contour')
  activeRun = { epoch, cursor, worker: null }
}

/** 現在の工程を閉じ、`next` を開始する。run が無ければ no-op */
export function stage(next: PerfStage): void {
  if (!ENABLED) return
  activeRun?.cursor.enter(next)
}

/**
 * 生成レスポンス受信時に呼ぶ。`transport`（往復）を閉じてから Worker の
 * 実行時間 `csgMs` をそこから切り出して `csg` に付け替え、`mesh` 工程に入る。
 *
 * 往復から Worker 実行時間を引いた残りが**純粋な postMessage の往復コスト**
 * （予算表の 5ms 行）で、これを分離しないと Worker の CSG が往復に埋もれる。
 */
export function stageAfterWorker(
  csgMs: number,
  worker: Partial<Record<WorkerCsgStage, number>> | null,
): void {
  if (!ENABLED) return
  const run = activeRun
  if (run === null) return
  run.cursor.enter('mesh')
  run.cursor.split('transport', 'csg', csgMs)
  run.worker = worker
}

/**
 * 進行中の `render`（描画ハンドオフ）工程を**次のアニメーションフレーム**で
 * 閉じ、run を確定する。呼ぶ前に `stage('render')` に入っていること。
 *
 * 呼ぶのは「ジオメトリ ref を差し替え、store に success をコミットした直後」。
 * R3F の連続フレームループは既に次フレームの rAF を登録済みなので、そのフレーム
 * で新しいメッシュが描画され、後から登録した本コールバックはその**直後**に走る。
 * つまりこの工程は「ジオメトリ差し替え → store コミット → React 再レンダリング
 * → 当該フレームの描画発行」までを含む（vsync 待ちを含むので CPU コストでは
 * ない点に注意 — 予算表と比べるときはここを区別すること）。
 */
export function finishRunOnNextFrame(): void {
  if (!ENABLED) return
  const run = activeRun
  if (run === null) return
  nextFrame(() => {
    if (activeRun !== run) return // 追い越された run の遅延コールバック
    finishRun(run)
  })
}

/** run を中断する（入力拒否・EMPTY_INTERSECTION・生成失敗・dispose） */
export function abandonRun(reason: string): void {
  if (!ENABLED) return
  const run = activeRun
  if (run === null) return
  activeRun = null
  run.cursor.dispose()
  abandoned.set(reason, (abandoned.get(reason) ?? 0) + 1)
}

function finishRun(run: ActiveRun): void {
  activeRun = null
  run.cursor.close()

  let totalMs = 0
  if (HAS_USER_TIMING) {
    const name = `${MARK_NS}:run:total`
    totalMs = performance.measure(name, run.cursor.startMark, `${MARK_NS}:run:end`).duration
    performance.clearMeasures(name)
  }

  const stages = run.cursor.durations
  let sum = 0
  const missingStages: PerfStage[] = []
  for (const name of PERF_STAGE_ORDER) {
    const value = stages[name]
    if (value === undefined) missingStages.push(name)
    else sum += value
  }
  const unaccountedMs = totalMs - sum

  const sample: PerfSample = {
    epoch: run.epoch,
    totalMs,
    stages,
    unaccountedMs,
    missingStages,
    worker: run.worker,
  }
  run.cursor.dispose()

  // 予算を議論できる前提条件の検証（ファイル冒頭）。破れたら計測値ではなく
  // 計測の配線が壊れている
  if (missingStages.length > 0 || Math.abs(unaccountedMs) > PERF_SUM_TOLERANCE_MS) {
    console.error(
      `[perf] 工程の合計が実測レイテンシと一致しません: total=${totalMs.toFixed(2)}ms ` +
        `sum=${sum.toFixed(2)}ms 差=${unaccountedMs.toFixed(2)}ms` +
        (missingStages.length > 0 ? ` 欠落工程=${missingStages.join(',')}` : ''),
    )
  }

  samples.push(sample)
  if (samples.length > MAX_SAMPLES) samples.shift()
  for (const listener of listeners) listener(sample)
}

/** サンプル確定の購読。戻り値を呼ぶと解除する */
export function subscribePerf(listener: (sample: PerfSample) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 確定済みサンプルの一覧（新しいものが末尾） */
export function getPerfSamples(): readonly PerfSample[] {
  return samples
}

/** 中断した run の理由別回数（ウォームアップ以降にサンプルが欠ける理由の説明） */
export function getAbandonedRuns(): Record<string, number> {
  return Object.fromEntries(abandoned)
}

/** サンプルと進行中の run を捨てる（ウォームアップの切り離し・テスト用） */
export function clearPerfSamples(): void {
  samples.length = 0
  abandoned.clear()
  if (activeRun !== null) {
    activeRun.cursor.dispose()
    activeRun = null
  }
}

/** 開発時に `globalThis.__ambiguousPerf` から読める形（E2E の NFR-001 計測もこれを使う） */
export interface PerfDevHandle {
  readonly stageOrder: readonly PerfStage[]
  readonly workerStageOrder: readonly WorkerCsgStage[]
  samples(): readonly PerfSample[]
  abandoned(): Record<string, number>
  subscribe(listener: (sample: PerfSample) => void): () => void
  clear(): void
}

if (ENABLED) {
  const handle: PerfDevHandle = {
    stageOrder: PERF_STAGE_ORDER,
    workerStageOrder: WORKER_CSG_STAGE_ORDER,
    samples: getPerfSamples,
    abandoned: getAbandonedRuns,
    subscribe: subscribePerf,
    clear: clearPerfSamples,
  }
  ;(globalThis as { __ambiguousPerf?: PerfDevHandle }).__ambiguousPerf = handle
}
