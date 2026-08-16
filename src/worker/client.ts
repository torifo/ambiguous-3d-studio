/**
 * CSG Worker のメインスレッド側窓口（design.md「4. Worker 境界」/ Task 3.2）。
 *
 * 責務：
 * - **常設 Worker の起動と Wasm の先読み（NFR-003）**。このクラスを生成した
 *   瞬間に Worker が立ち上がり、Wasm 初期化（100〜300ms）がユーザーの初回
 *   操作の外側で始まる。準備状態は `initState` / `whenReady()` で公開する
 * - **初期化の 10 秒タイムアウト → init-failed（FR-025）**。ハングではなく
 *   「失敗＋再試行（`retryInit`）」として提示する。`new Worker()` や初回
 *   postMessage の**同期例外**（CSP による SecurityError 等）も同じ
 *   init-failed 経路に流す — コンストラクタは決して throw しない
 * - **生成リクエストの 120ms デバウンス（NFR-004）**。打鍵ごとに CSG を
 *   1 回ずつ積まず、最新の 1 件だけを送る
 * - **単調増加する世代 ID と stale 破棄**。Wasm のブール演算は途中キャンセル
 *   できないため、追い越されたリクエストも最後まで走ってレスポンスを返す。
 *   古いレスポンスは受信側で破棄する（protocol.ts 冒頭）。破棄の判定は
 *   ディスパッチ時ではなく**新しい入力を受理した瞬間**に効き始める：
 *   `requestGeneration()` が新しい payload を受理した時点で実行中の世代を
 *   無効化する。さもないとデバウンス窓の 120ms の間に届いた旧世代の
 *   レスポンスが「最新」として配達されてしまう
 * - **クラッシュ回復**。Worker が死んだら（error / messageerror）作り直し、
 *   実行中だったリクエストを**ちょうど 1 回だけ**再試行する。2 度目の
 *   クラッシュはエラー（`WORKER_CRASHED`）として表面化し、ループしない。
 *   作り直した Worker の**初期化が失敗した**場合は生成エラーではなく
 *   `onInitFailed` の単一通知に一本化する（下記「初期化失敗の一本化」）
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
 *   onError: (epoch, e) => useStudioStore.getState().generationFailed(epoch, e),
 *   onReady: () => useStudioStore.getState().wasmReady(),
 *   onInitFailed: (d) => useStudioStore.getState().wasmInitFailed(d),
 * })
 * ```
 *
 * ## 初期化失敗の一本化（onInitFailed が唯一の終端通知）
 *
 * インフラの初期化失敗（起動時・retryInit 時・クラッシュ回復中の再初期化を
 * 問わず）は、**常に `onInitFailed` の 1 回だけ**で通知する。生成の実行中
 * だったとしても `onError`（= store の `generationFailed`）は流さない。
 *
 * かつては「生成エラーとしても終端させる」ために onError → onInitFailed の
 * 順で両方を呼んでいたが、これは store を先に `error` へ落とし、続く
 * `wasmInitFailed` を no-op にしてしまう——クライアントは init-failed、
 * store は error、そして store の `retryInit()` は error からは動かないため
 * **回復不能**になる。store は現在 `generating → init-failed` を許容する
 * ので、初期化失敗はそのまま init-failed として正直に報告できる。実行中
 * だった payload は破棄せず pending に戻し（FR-025: 入力は保持）、
 * `retryInit()` → ready 到達後に新しい epoch で再送出される。
 *
 * ## 初期化ハンドシェイク（protocol.ts の `WorkerLifecycleMessage`）
 *
 * 準備完了の判定は Worker が自発送信する `{ type: 'ready' }`
 * （`WorkerLifecycleMessage`。`isLifecycleMessage()` で判別）を**正**とする。
 * クライアントは Worker 生成直後に世代 0 のウォームアップリクエスト
 * （`WARMUP_GENERATION`。極小の正方形どうし）も送る — これは NFR-003 の
 * 先読み（Wasm 初期化と最初の CSG パスをアプリ起動時に引き起こす）の
 * ためで、応答は結果としては常に破棄される。
 *
 * ready 信号を送らない Worker 実装への保険として、初期化中に**成功した**
 * CsgResponse を受信した場合も初期化完了と見なす（成功応答を返せた＝Wasm は
 * 動いている）。ただし**失敗応答は準備完了の証明にならない**：初期化中の
 * `ok: false` は WASM_INIT_FAILED に限らず初期化失敗として扱う。エンジン
 * 異常でウォームアップが INVALID_INPUT / NOT_MANIFOLD に分類されるケースを
 * 「正常起動」と誤認しないため。受け付ける合図のまとめ：
 * - `{ type: 'ready' }` — 初期化成功（正規の経路）
 * - 初期化中の成功 CsgResponse — 初期化完了のフォールバック
 * - `{ type: 'init-failed', detail }` / 初期化中の失敗 CsgResponse /
 *   初期化完了前の Worker `error` イベント / spawn 時の同期例外 — 初期化失敗
 * - どれも届かない — 10 秒タイムアウトが init-failed に落とす
 */
import {
  isLifecycleMessage,
  type CsgError,
  type CsgRequest,
  type CsgResponse,
  type WorkerOutbound,
} from './protocol'

/** NFR-004: 連続入力を合流させるデバウンス幅 */
export const DEFAULT_DEBOUNCE_MS = 120

/** FR-025: これを超えて初期化が完了しなければ init-failed */
export const DEFAULT_INIT_TIMEOUT_MS = 10_000

/**
 * ウォームアップリクエストの予約世代。実際の生成は 1 から始まるため衝突
 * しない。この世代への応答は結果としては破棄され、初期化完了のフォール
 * バック合図としてだけ使われる（ファイル冒頭「初期化ハンドシェイク」を参照）。
 */
export const WARMUP_GENERATION = 0

/** 1 回の生成リクエスト。世代 ID はクライアントが払い出すので含まない */
export type GenerationPayload = Omit<CsgRequest, 'generation'>

/** 成功レスポンスの中身（generation / ok を除いた形）。protocol.ts と常に同期する */
export type CsgSuccess = Omit<Extract<CsgResponse, { ok: true }>, 'generation' | 'ok'>

/**
 * dispose() による準備待ちの中断。dispose 時点で未解決の `whenReady()` は
 * このエラーで reject する（永久 pending にしない）。
 */
export class CsgClientDisposedError extends Error {
  constructor() {
    super('CsgWorkerClient は dispose() 済みです')
    this.name = 'CsgClientDisposedError'
  }
}

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
   * 最新世代の生成が失敗した（Worker 内エラー / 2 度目のクラッシュ）。
   * `epoch` は acquireEpoch が返した値そのもの。インフラの初期化失敗は
   * ここには**流れず**、`onInitFailed` に一本化される（ファイル冒頭
   * 「初期化失敗の一本化」を参照）
   */
  onError: (epoch: number, error: CsgError) => void
  /** Wasm 初期化完了。`wasmReady` を渡す。Worker 再生成後にも呼ばれうる（store 側は no-op） */
  onReady?: () => void
  /**
   * 初期化失敗 / 10 秒タイムアウト / クラッシュ回復中の再初期化失敗。
   * `wasmInitFailed` を渡す（store はどの状態からでも init-failed を受ける）
   */
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

function isCsgResponse(data: unknown): data is CsgResponse {
  if (typeof data !== 'object' || data === null) return false
  const d = data as { generation?: unknown; ok?: unknown }
  return typeof d.generation === 'number' && typeof d.ok === 'boolean'
}

/** 同期例外（unknown）を init-failed の detail 文字列に変換する */
function causeDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 初期化中に受信した失敗レスポンスを init-failed の detail に変換する */
function warmupFailureDetail(error: CsgError): string {
  if (error.code === 'WASM_INIT_FAILED') return error.detail
  return 'detail' in error
    ? `ウォームアップ生成が失敗しました（${error.code}）: ${error.detail}`
    : `ウォームアップ生成が失敗しました（${error.code}）`
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
   * アプリ起動時に 1 度だけ生成し、常設すること。Worker の起動が同期的に
   * 失敗しても throw せず、`onInitFailed` / `whenReady()` の reject で
   * 報告する（FR-025 の再試行 UI に必ず到達させる）。
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
   * 現在の初期化サイクルの完了を待つ。初期化失敗 / タイムアウトで reject し、
   * `dispose()` 時は `CsgClientDisposedError` で reject する（永久 pending に
   * しない）。`retryInit()` 後は新しい Promise になるため、再取得すること。
   */
  whenReady(): Promise<void> {
    return this.readyPromise
  }

  /**
   * 生成リクエストを発行する。120ms のデバウンス窓の中で後続が来るたびに
   * 窓が延長され、**最新の 1 件だけ**が Worker に届く（NFR-004）。
   * ready 前 / init-failed 中の発行は破棄せず保持し、ready 到達時に送出する
   * （FR-025: 入力は受け付けて保持する、の Worker 側対応）。
   *
   * 受理した瞬間に、実行中の世代を無効化する：以後その応答は届いても
   * 配達せず、クラッシュしても再試行しない。ディスパッチ（デバウンス満了）
   * まで無効化を遅らせると、120ms の窓の間に届いた旧世代のレスポンスが
   * 「最新」として配達されてしまう。
   */
  requestGeneration(payload: GenerationPayload): void {
    if (this.disposed) return
    // 新しい入力の受理＝実行中の生成の supersede。演算自体は中断できないが
    // （protocol.ts 冒頭）、結果の採用と再試行はこの時点で打ち切る
    this.inFlight = null
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
   * 呼ぶこと。保持中の pending リクエスト（初期化失敗時に中断された生成の
   * payload を含む）は ready 到達後に送出される。
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
    // 未解決の whenReady() を永久 pending にしない。すでに解決済みの
    // Promise に対しては no-op
    this.readyReject(new CsgClientDisposedError())
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

    let w: WorkerLike
    try {
      w = this.createWorker()
    } catch (cause) {
      // new Worker() の同期失敗（CSP の SecurityError 等）。throw を呼び出し元へ
      // 逃さず、FR-025 の init-failed 経路（onInitFailed / whenReady reject）に流す
      this.worker = null
      this.handleInitFailure(`Worker を起動できませんでした: ${causeDetail(cause)}`)
      return
    }
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

    // 初期化ハンドシェイク：世代 0 のウォームアップを送る（NFR-003 の先読み）。
    // ready の判定は lifecycle メッセージが正で、成功応答はフォールバック。
    // 何も返らなければ上のタイムアウトが init-failed に落とす
    try {
      w.postMessage(warmupRequest())
    } catch (cause) {
      // postMessage の同期失敗も同じ init-failed 経路へ（コンストラクタ・
      // retryInit から throw を逃さない）
      this.handleInitFailure(
        `ウォームアップの送信に失敗しました: ${causeDetail(cause)}`,
      )
    }
  }

  private handleMessage(data: unknown): void {
    if (this.disposed) return
    if (typeof data !== 'object' || data === null) return
    const message = data as WorkerOutbound
    if (isLifecycleMessage(message)) {
      if (message.type === 'ready') this.handleWorkerReady()
      else if (message.type === 'init-failed') this.handleInitFailure(message.detail)
      return
    }
    if (!isCsgResponse(message)) return // 未知のメッセージは無視
    if (this.state === 'initializing') {
      if (!message.ok) {
        // 失敗応答は準備完了の証明にならない。エンジン異常でウォームアップが
        // INVALID_INPUT 等に分類されても「正常起動」とは扱わず、初期化失敗
        // として提示する（復帰は retryInit 経由）
        this.handleInitFailure(warmupFailureDetail(message.error))
        return
      }
      // 成功応答を返せている＝初期化は完了している（ready 信号を送らない
      // Worker 実装へのフォールバック）
      this.handleWorkerReady()
    }
    this.handleResponse(message)
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
      // デバウンス満了済みの新しい入力が待っている。この場合 inFlight は
      // requestGeneration の受理時点で無効化済み（supersede）
      this.inFlight = null
      this.dispatchPending()
      return
    }
    if (this.inFlight !== null && this.worker !== null) {
      // クラッシュ再試行：epoch も世代 ID も取り直さない（同一の生成の続き）。
      // 追い越された生成はここに到達しない（requestGeneration が受理時に
      // inFlight を無効化するため）
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
    // stale 破棄（US-001 / NFR-004）：最新世代でない、または supersede で
    // 無効化済み（inFlight から外れた）レスポンスは成否にかかわらず採用
    // しない。Wasm 演算はキャンセルできないため追い越された演算も完走して
    // レスポンスを返すが、古いメッシュが新しい結果を上書きする経路は
    // ここで断つ
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
      // クラッシュ再試行中の再初期化失敗など。インフラの初期化失敗は
      // onInitFailed の**単一通知**に一本化する（ファイル冒頭「初期化失敗の
      // 一本化」— onError を先に流すと store が error に落ち、init-failed へ
      // 遷移できず回復不能になる）。中断された payload は pending に戻し、
      // retryInit → ready 後に新しい epoch で再送出する（FR-025: 入力は保持）。
      // 注: inFlight が生きている間 pending は常に null（requestGeneration が
      // 受理時に inFlight を無効化するため）なので、新しい入力を潰す心配はない
      this.inFlight = null
      this.pending = inFlight.payload
      this.pendingElapsed = true
    }
    this.readyReject(new Error(detail))
    this.handlers.onInitFailed?.(detail)
    // pending は破棄しない（FR-025: 入力は保持）。retryInit → ready 後に送出される
  }
}
