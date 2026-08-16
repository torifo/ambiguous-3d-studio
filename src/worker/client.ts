/**
 * CSG Worker のメインスレッド側窓口（design.md「4. Worker 境界」/ Task 3.2）。
 *
 * 責務：
 * - **常設 Worker の起動と Wasm の先読み（NFR-003）**。このクラスを生成した
 *   瞬間に Worker が立ち上がり、Wasm 初期化（100〜300ms）がユーザーの初回
 *   操作の外側で始まる。準備状態は `initState` / `whenReady()` で公開する
 * - **初期化の 10 秒タイムアウト → init-failed（FR-025）**。ハングではなく
 *   「失敗＋再試行（`retryInit`）」として提示する
 * - **生成リクエストの 120ms デバウンス（NFR-004）**。打鍵ごとに CSG を
 *   1 回ずつ積まず、最新の 1 件だけを送る
 * - **単調増加する世代 ID と stale 破棄**。Wasm のブール演算は途中キャンセル
 *   できないため、追い越されたリクエストも最後まで走ってレスポンスを返す。
 *   `generation === latestGeneration` でないレスポンスを破棄することが、
 *   古いメッシュが新しい結果を上書きするのを防ぐ唯一の機構（protocol.ts 冒頭）
 * - **クラッシュ回復**。Worker が死んだら（error / messageerror）作り直し、
 *   実行中だったリクエストを**ちょうど 1 回だけ**再試行する。2 度目の失敗は
 *   エラーとして表面化し、ループしない
 *
 * ## store の epoch との噛み合わせ（useStudioStore.ts のパイプライン契約）
 *
 * store の `startGenerating()` は「この生成が属する epoch」を返し、終端
 * アクション（`generationSucceeded` / `generationFailed`）はその epoch を
 * 要求する。epoch の対応付けを呼び出し側に任せると、デバウンス・supersede・
 * クラッシュ再試行のどこかで取り違える余地が生まれるため、本クライアントが
 * epoch を**自分で運ぶ**：
 *
 * - リクエストが実際に Worker へ送られる瞬間（デバウンス満了後）に
 *   `handlers.acquireEpoch()` を呼ぶ。Wave 4 はここに
 *   `useStudioStore.getState().startGenerating` をそのまま渡せばよい
 * - 戻り値の epoch を in-flight リクエストに紐付けて保持し、終端通知
 *   （`onSuccess` / `onError`）に**同じ値**を渡し返す。クラッシュ再試行でも
 *   epoch は取り直さない（同一の生成の続きだから）
 * - `acquireEpoch()` が null（store が loading-wasm / init-failed で開始
 *   不可）ならそのリクエストは破棄する。復帰後の再生成の起動は Wave 4 の責務
 *
 * 呼び出し側が epoch に触るのは「acquireEpoch に startGenerating を渡す」
 * ことと「終端通知の epoch を store へ横流しする」ことだけで、リクエストと
 * epoch の対応表を自前で管理する必要はない（= 取り違えようがない）。
 *
 * Wave 4 での結線イメージ：
 * ```ts
 * const client = new CsgWorkerClient({
 *   acquireEpoch: () => useStudioStore.getState().startGenerating(),
 *   onSuccess: (epoch, r) => {
 *     geometryRef.current = toBufferGeometry(r) // ref 保持は studio/ の責務
 *     useStudioStore.getState().generationSucceeded(epoch, summarize(r))
 *   },
 *   onError: (epoch, e) => useStudioStore.getState().generationFailed(epoch, toCsgError(e)),
 *   onReady: () => useStudioStore.getState().wasmReady(),
 *   onInitFailed: (d) => useStudioStore.getState().wasmInitFailed(d),
 * })
 * ```
 *
 * ## 初期化ハンドシェイク（protocol.ts に未定義のため、ここで契約を固定する）
 *
 * protocol.ts は CsgRequest / CsgResponse のみを定義し、初期化完了の通知形が
 * ない。そこでクライアントは Worker 生成直後に**世代 0 のウォームアップ
 * リクエスト**（`WARMUP_GENERATION`。極小の正方形どうし）を送る。世代 0 は
 * 実際の生成には決して使わないため、応答は結果としては常に破棄されるが、
 * 「応答が返せた＝Wasm 初期化が完了した」ことの証明になる。これにより、
 * リクエスト応答しかしない Worker 実装（現行の csg.worker.ts）とも、
 * ready を自発送信する実装とも噛み合う。受け付ける初期化の合図：
 * - `{ type: 'ready' }` — 初期化成功の自発通知（`WorkerLifecycleMessage`）
 * - 任意の有効な CsgResponse — 受信は初期化完了を含意する
 *   （ウォームアップ応答がこの経路で ready を確立する）
 * - `{ type: 'init-failed', detail }`、または初期化中に届いた `ok: false`
 *   かつ `WASM_INIT_FAILED` の CsgResponse — 初期化失敗
 * - 初期化完了前の Worker `error` イベント — 初期化失敗
 *
 * ウォームアップは NFR-003 の先読みも兼ねる：Worker が初期化を遅延実行する
 * 実装でも、世代 0 の要求が Wasm 初期化と最初の CSG パスをアプリ起動時に
 * 引き起こす。
 */
import type { CsgError, CsgRequest, CsgResponse } from './protocol'

/** NFR-004: 連続入力を合流させるデバウンス幅 */
export const DEFAULT_DEBOUNCE_MS = 120

/** FR-025: これを超えて初期化が完了しなければ init-failed */
export const DEFAULT_INIT_TIMEOUT_MS = 10_000

/**
 * ウォームアップリクエストの予約世代。実際の生成は 1 から始まるため衝突
 * しない。この世代への応答は結果としては破棄され、初期化完了の合図として
 * だけ使われる（ファイル冒頭「初期化ハンドシェイク」を参照）。
 */
export const WARMUP_GENERATION = 0

/** 1 回の生成リクエスト。世代 ID はクライアントが払い出すので含まない */
export type GenerationPayload = Omit<CsgRequest, 'generation'>

/** 成功レスポンスの中身（generation / ok を除いた形）。protocol.ts と常に同期する */
export type CsgSuccess = Omit<Extract<CsgResponse, { ok: true }>, 'generation' | 'ok'>

/**
 * Worker のクラッシュ由来の失敗。protocol.ts の `CsgError` には該当コードが
 * 存在しないため、クライアント層で拡張する。store の `generationFailed` は
 * `CsgError` を要求するので、Wave 4 はこのコードを適宜マップすること。
 */
export interface WorkerCrashError {
  code: 'WORKER_CRASHED'
  detail: string
}

/** `onError` に届きうる失敗の全体（Worker 内の失敗 ∪ クラッシュ） */
export type CsgClientError = CsgError | WorkerCrashError

/**
 * Worker → メインスレッドの初期化ハンドシェイク。protocol.ts に未定義の
 * ため、client がここで契約を固定する（ファイル冒頭の解説を参照）。
 * csg.worker.ts は初期化の成否をこの形で 1 回だけ post することが望ましい。
 */
export type WorkerLifecycleMessage =
  | { type: 'ready' }
  | { type: 'init-failed'; detail: string }

/** 初期化の進行状態。FR-025 の loading-wasm / ready / init-failed に対応する */
export type CsgClientInitState = 'initializing' | 'ready' | 'init-failed'

/**
 * クライアントが必要とする Worker の最小界面。実 Worker（DOM）は構造的に
 * これを満たす。テストはこの型を実装したモックを注入する。
 */
export interface WorkerLike {
  postMessage(message: CsgRequest): void
  terminate(): void
  onmessage: ((ev: MessageEvent) => void) | null
  onmessageerror: ((ev: MessageEvent) => void) | null
  onerror: ((ev: ErrorEvent) => void) | null
}

/** Wave 4 が store のアクションを差し込む結線点 */
export interface CsgClientHandlers {
  /**
   * リクエストが実際に Worker へ送られる直前に呼ばれる。
   * `useStudioStore.getState().startGenerating` をそのまま渡すこと。
   * null を返すと（store が開始不可）そのリクエストは破棄される。
   */
  acquireEpoch: () => number | null
  /** 最新世代の生成が成功した。`epoch` は acquireEpoch が返した値そのもの */
  onSuccess: (epoch: number, result: CsgSuccess) => void
  /**
   * 最新世代の生成が失敗した（Worker 内エラー / 2 度目のクラッシュ /
   * 再試行中の再初期化失敗）。`epoch` は acquireEpoch が返した値そのもの
   */
  onError: (epoch: number, error: CsgClientError) => void
  /** Wasm 初期化完了。`wasmReady` を渡す。Worker 再生成後にも呼ばれうる（store 側は no-op） */
  onReady?: () => void
  /** 初期化失敗 / 10 秒タイムアウト。`wasmInitFailed` を渡す */
  onInitFailed?: (detail: string) => void
}

export interface CsgClientOptions {
  /**
   * Worker の生成方法。省略時は本物の csg.worker.ts を起動する。
   * テストはここにモックのファクトリを注入する。クラッシュ回復・retryInit の
   * たびに呼び直される
   */
  createWorker?: () => WorkerLike
  /** 既定 120ms（NFR-004） */
  debounceMs?: number
  /** 既定 10 秒（FR-025） */
  initTimeoutMs?: number
}

/**
 * 本番用の Worker 生成。`new Worker(new URL('./csg.worker.ts', import.meta.url),
 * { type: 'module' })` という**この記述形そのもの**が、Vite に Worker チャンク
 * として認識・バンドルさせる唯一の書き方（design.md「Deployment」）。
 * URL を変数に括り出したり文字列連結にすると、dev では動いて本番だけ 404 になる。
 */
export function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('./csg.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/** デバウンス満了後、実際に Worker へ送られたリクエスト */
interface InFlightRequest {
  /** クライアント内部の世代 ID（CsgRequest.generation に載せた値） */
  generation: number
  /** acquireEpoch が返した store の epoch。終端通知にそのまま返す */
  epoch: number
  /** クラッシュ再試行のために保持する（transfer しない理由もこれ） */
  payload: GenerationPayload
  /** 残り再試行回数。1 で開始し、クラッシュのたびに減る */
  retriesLeft: number
}

function isLifecycleMessage(data: unknown): data is WorkerLifecycleMessage {
  if (typeof data !== 'object' || data === null) return false
  const type = (data as { type?: unknown }).type
  return type === 'ready' || type === 'init-failed'
}

function isCsgResponse(data: unknown): data is CsgResponse {
  if (typeof data !== 'object' || data === null) return false
  const d = data as { generation?: unknown; ok?: unknown }
  return typeof d.generation === 'number' && typeof d.ok === 'boolean'
}

/**
 * ウォームアップ用の極小リクエスト（単位正方形 × 単位正方形）。確実に交差
 * するので Worker 側は正常系（初期化 → CSG → 応答）を一巡する。
 */
function warmupRequest(): CsgRequest {
  const square = (): Float64Array =>
    new Float64Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5])
  return {
    generation: WARMUP_GENERATION,
    a: { contours: [{ points: square(), isHole: false }], depth: 1 },
    b: { contours: [{ points: square(), isHole: false }], depth: 1 },
    baseplate: null,
  }
}

export class CsgWorkerClient {
  private readonly handlers: CsgClientHandlers
  private readonly createWorker: () => WorkerLike
  private readonly debounceMs: number
  private readonly initTimeoutMs: number

  private worker: WorkerLike | null = null
  private state: CsgClientInitState = 'initializing'
  private readyPromise: Promise<void> = Promise.resolve()
  private readyResolve: () => void = () => {}
  private readyReject: (error: Error) => void = () => {}

  private initTimer: ReturnType<typeof setTimeout> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** 払い出した世代 ID の最新値。これと一致しないレスポンスは stale */
  private latestGeneration = 0
  /** デバウンス窓の中で待っている最新 payload（常に 1 件だけ保持） */
  private pending: GenerationPayload | null = null
  /** デバウンスは満了したが ready でなく送出できていない（ready 到達時に送る） */
  private pendingElapsed = false
  private inFlight: InFlightRequest | null = null
  private disposed = false

  /**
   * 生成した瞬間に Worker が起動し、Wasm 初期化が始まる（NFR-003 の先読み）。
   * アプリ起動時に 1 度だけ生成し、常設すること。
   */
  constructor(handlers: CsgClientHandlers, options: CsgClientOptions = {}) {
    this.handlers = handlers
    this.createWorker = options.createWorker ?? createDefaultWorker
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
    this.spawnWorker()
  }

  /** 初期化の進行状態（FR-025 の loading-wasm / ready / init-failed に対応） */
  get initState(): CsgClientInitState {
    return this.state
  }

  /**
   * 現在の初期化サイクルの完了を待つ。初期化失敗 / タイムアウトで reject する。
   * `retryInit()` 後は新しい Promise になるため、再取得すること。
   */
  whenReady(): Promise<void> {
    return this.readyPromise
  }

  /**
   * 生成リクエストを発行する。120ms のデバウンス窓の中で後続が来るたびに
   * 窓が延長され、**最新の 1 件だけ**が Worker に届く（NFR-004）。
   * ready 前 / init-failed 中の発行は破棄せず保持し、ready 到達時に送出する
   * （FR-025: 入力は受け付けて保持する、の Worker 側対応）。
   */
  requestGeneration(payload: GenerationPayload): void {
    if (this.disposed) return
    this.pending = payload
    this.pendingElapsed = false
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.state !== 'ready') {
        // まだ送れない。ready 到達時（handleWorkerReady）に flush する
        this.pendingElapsed = true
        return
      }
      this.dispatchPending()
    }, this.debounceMs)
  }

  /**
   * init-failed からの再試行（FR-025）。store 側の `retryInit()` と併せて
   * 呼ぶこと。保持中の pending リクエストは ready 到達後に送出される。
   */
  retryInit(): void {
    if (this.disposed) return
    if (this.state !== 'init-failed') return
    this.spawnWorker()
  }

  /** Worker とタイマーを破棄する（アンマウント・テスト用） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
    this.worker?.terminate()
    this.worker = null
    this.pending = null
    this.inFlight = null
  }

  // ---- 内部 ----

  private spawnWorker(): void {
    this.state = 'initializing'
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // 誰も await していなくても unhandled rejection にしない
    this.readyPromise.catch(() => {})

    const w = this.createWorker()
    this.worker = w
    // 差し替え済み（クラッシュで作り直した後の旧 Worker）からの遅延イベントは
    // すべて無視する — `this.worker !== w` のガードがその境界
    w.onmessage = (ev) => {
      if (this.worker !== w) return
      this.handleMessage(ev.data)
    }
    w.onerror = (ev) => {
      if (this.worker !== w) return
      this.handleCrash(ev.message || 'Worker の error イベント')
    }
    w.onmessageerror = () => {
      if (this.worker !== w) return
      this.handleCrash('postMessage のデシリアライズに失敗（messageerror）')
    }

    this.initTimer = setTimeout(() => {
      this.handleInitFailure(
        `Wasm の初期化が ${this.initTimeoutMs}ms 以内に完了しませんでした`,
      )
    }, this.initTimeoutMs)

    // 初期化ハンドシェイク：世代 0 のウォームアップを送る。応答が返れば
    // 初期化完了、WASM_INIT_FAILED が返れば失敗、何も返らなければ上の
    // タイムアウトが init-failed に落とす（ファイル冒頭の解説を参照）
    w.postMessage(warmupRequest())
  }

  private handleMessage(data: unknown): void {
    if (this.disposed) return
    if (isLifecycleMessage(data)) {
      if (data.type === 'ready') this.handleWorkerReady()
      else this.handleInitFailure(data.detail)
      return
    }
    if (!isCsgResponse(data)) return // 未知のメッセージは無視
    if (this.state === 'initializing') {
      if (!data.ok && data.error.code === 'WASM_INIT_FAILED') {
        this.handleInitFailure(data.error.detail)
        return
      }
      // レスポンスを返せている＝初期化は完了している（ready 信号欠落への保険）
      this.handleWorkerReady()
    }
    this.handleResponse(data)
  }

  private handleWorkerReady(): void {
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
    if (this.state === 'ready') return
    this.state = 'ready'
    this.readyResolve()
    // onReady → 送出、の順を保証する。Wave 4 が onReady で wasmReady() を
    // 呼べば、直後の acquireEpoch（= startGenerating）は ready の store に届く
    this.handlers.onReady?.()

    if (this.pending !== null && this.pendingElapsed) {
      // デバウンス満了済みの新しい入力が待っている。クラッシュ再試行より
      // 優先する（再試行しても新しい世代に追い越されて stale になるだけ）
      this.inFlight = null
      this.dispatchPending()
      return
    }
    if (this.inFlight !== null && this.worker !== null) {
      // クラッシュ再試行：epoch も世代 ID も取り直さない（同一の生成の続き）
      this.worker.postMessage({
        ...this.inFlight.payload,
        generation: this.inFlight.generation,
      })
    }
  }

  private dispatchPending(): void {
    const payload = this.pending
    if (payload === null || this.worker === null) return
    this.pending = null
    this.pendingElapsed = false

    const epoch = this.handlers.acquireEpoch()
    if (epoch === null) return // store 側が開始不可（loading-wasm / init-failed）

    const generation = ++this.latestGeneration
    this.inFlight = { generation, epoch, payload, retriesLeft: 1 }
    // transfer リストは渡さない：points を転送すると neutered になり、
    // クラッシュ時に同じ payload を再送できなくなる。輪郭は高々数千点で
    // 構造化クローンのコストは無視できる（応答側の大きな配列は Worker が
    // transfer する — protocol.ts / ADR-003）
    this.worker.postMessage({ ...payload, generation })
  }

  private handleResponse(response: CsgResponse): void {
    // stale 破棄（US-001 / NFR-004）：最新世代でないレスポンスは成否に
    // かかわらず採用しない。Wasm 演算はキャンセルできないため追い越された
    // 演算も完走してレスポンスを返すが、古いメッシュが新しい結果を
    // 上書きする経路はここで断つ
    if (response.generation !== this.latestGeneration) return
    const inFlight = this.inFlight
    if (inFlight === null || inFlight.generation !== response.generation) return
    this.inFlight = null
    if (response.ok) {
      this.handlers.onSuccess(inFlight.epoch, {
        positions: response.positions,
        indices: response.indices,
        componentCount: response.componentCount,
        volume: response.volume,
        elapsedMs: response.elapsedMs,
      })
    } else {
      this.handlers.onError(inFlight.epoch, response.error)
    }
  }

  private handleCrash(detail: string): void {
    if (this.disposed) return
    if (this.state === 'initializing') {
      // 初期化が完了しないまま死んだ → 初期化失敗として扱い、作り直しの
      // ループに入らない（復帰は retryInit 経由のみ）
      this.handleInitFailure(detail)
      return
    }
    const dead = this.worker
    this.worker = null
    dead?.terminate()

    const inFlight = this.inFlight
    if (inFlight !== null && inFlight.retriesLeft <= 0) {
      // 2 度目の失敗：これ以上再試行せず、エラーとして表面化する
      this.inFlight = null
      this.handlers.onError(inFlight.epoch, { code: 'WORKER_CRASHED', detail })
    } else if (inFlight !== null) {
      inFlight.retriesLeft -= 1
    }
    // Worker は作り直す（以後のリクエストのため）。実行中だったリクエストの
    // 再試行は、新しい Worker の ready 到達時に 1 回だけ行う
    this.spawnWorker()
  }

  private handleInitFailure(detail: string): void {
    if (this.disposed) return
    if (this.state !== 'initializing') return
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
    this.state = 'init-failed'
    const dead = this.worker
    this.worker = null
    dead?.terminate()

    const inFlight = this.inFlight
    if (inFlight !== null) {
      // クラッシュ再試行中の再初期化失敗など。生成としても終端させ、
      // スピナーを止める（store は generating → error で受ける）
      this.inFlight = null
      this.handlers.onError(inFlight.epoch, {
        code: 'WASM_INIT_FAILED',
        detail,
      })
    }
    this.readyReject(new Error(detail))
    this.handlers.onInitFailed?.(detail)
    // pending は破棄しない（FR-025: 入力は保持）。retryInit → ready 後に送出される
  }
}
