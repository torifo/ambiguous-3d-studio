/**
 * client.ts のテスト。実 Worker は使わない（node 環境・DOM なし）——
 * `WorkerLike` を実装したモック Worker をファクトリ注入する。
 * 時間（デバウンス 120ms / 初期化タイムアウト 10s）はすべて fake timers で
 * 進める。実時間では 1ms も眠らない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsgRequest, CsgResponse } from './protocol'
import {
  CsgWorkerClient,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  WARMUP_GENERATION,
  type CsgClientError,
  type CsgClientHandlers,
  type CsgSuccess,
  type GenerationPayload,
  type WorkerLike,
} from './client'

/** postMessage を記録し、応答・ready・クラッシュを手動で発火できるモック */
class MockWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onmessageerror: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  /** 送られた全メッセージ（spawn 直後のウォームアップも含む） */
  readonly posted: CsgRequest[] = []
  terminated = false

  /** ウォームアップ（世代 0）を除いた、実際の生成リクエストだけ */
  get requests(): CsgRequest[] {
    return this.posted.filter((m) => m.generation !== WARMUP_GENERATION)
  }

  postMessage(message: CsgRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emitReady(): void {
    this.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
  }

  emitResponse(response: CsgResponse): void {
    this.onmessage?.({ data: response } as MessageEvent)
  }

  emitCrash(message = 'boom'): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

interface Harness {
  client: CsgWorkerClient
  /** ファクトリが作った順のモック Worker（クラッシュ回復で増えていく） */
  workers: MockWorker[]
  /** onReady / acquireEpoch の呼び出し順の記録 */
  calls: string[]
  successes: Array<{ epoch: number; result: CsgSuccess }>
  errors: Array<{ epoch: number; error: CsgClientError }>
  initFailures: string[]
}

/**
 * acquireEpoch は store の startGenerating を模して 1, 2, 3, ... を返す
 * （supersede のたびに epoch が進む、という store 契約の再現）。
 */
function makeHarness(overrides: Partial<CsgClientHandlers> = {}): Harness {
  const workers: MockWorker[] = []
  const calls: string[] = []
  const successes: Harness['successes'] = []
  const errors: Harness['errors'] = []
  const initFailures: string[] = []
  let epochCounter = 0
  const handlers: CsgClientHandlers = {
    acquireEpoch: () => {
      calls.push('acquireEpoch')
      epochCounter += 1
      return epochCounter
    },
    onSuccess: (epoch, result) => {
      successes.push({ epoch, result })
    },
    onError: (epoch, error) => {
      errors.push({ epoch, error })
    },
    onReady: () => {
      calls.push('onReady')
    },
    onInitFailed: (detail) => {
      initFailures.push(detail)
    },
    ...overrides,
  }
  const client = new CsgWorkerClient(handlers, {
    createWorker: () => {
      const w = new MockWorker()
      workers.push(w)
      return w
    },
  })
  return { client, workers, calls, successes, errors, initFailures }
}

/** marker（depth に埋める）で「どの入力のリクエストか」を識別できる payload */
function trianglePayload(marker: number): GenerationPayload {
  const points = new Float64Array([0, 0, 1, 0, 0, 1])
  return {
    a: { contours: [{ points, isHole: false }], depth: marker },
    b: { contours: [{ points: points.slice(), isHole: false }], depth: marker },
    baseplate: null,
  }
}

function okResponse(generation: number, marker = generation): CsgResponse {
  return {
    generation,
    ok: true,
    positions: new Float32Array([marker]),
    indices: new Uint32Array([0, 1, 2]),
    componentCount: 1,
    volume: 1.5,
    elapsedMs: 42,
  }
}

/** リクエスト発行 → デバウンス満了まで進めて、直近の送信内容を返す */
function dispatch(h: Harness, worker: MockWorker, marker: number): CsgRequest {
  h.client.requestGeneration(trianglePayload(marker))
  vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
  return worker.requests[worker.requests.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('起動と Wasm 先読み（NFR-003）', () => {
  it('生成した瞬間に Worker が起動する（初回操作の中で初期化しない）', () => {
    const h = makeHarness()
    expect(h.workers).toHaveLength(1)
    expect(h.client.initState).toBe('initializing')
  })

  it('ready 信号で initState が ready になり、onReady と whenReady が解決する', async () => {
    const h = makeHarness()
    const ready = h.client.whenReady()
    h.workers[0].emitReady()
    expect(h.client.initState).toBe('ready')
    expect(h.calls).toContain('onReady')
    await expect(ready).resolves.toBeUndefined()
  })

  it('spawn 直後に世代 0 のウォームアップリクエストが送られる', () => {
    const h = makeHarness()
    expect(h.workers[0].posted).toHaveLength(1)
    expect(h.workers[0].posted[0].generation).toBe(WARMUP_GENERATION)
    expect(h.workers[0].requests).toHaveLength(0) // 実リクエストとしては数えない
  })

  it('ready 信号を送らない Worker でも、ウォームアップ応答が初期化完了として扱われる', () => {
    const h = makeHarness()
    // 現行 csg.worker.ts の挙動：ready は送らず、リクエストに応答するだけ
    h.workers[0].emitResponse(okResponse(WARMUP_GENERATION, 0))
    expect(h.client.initState).toBe('ready')
    expect(h.calls).toContain('onReady')
    // ウォームアップの結果自体は破棄され、onSuccess には決して届かない
    expect(h.successes).toHaveLength(0)
  })

  it('ウォームアップ応答が WASM_INIT_FAILED なら init-failed になる', () => {
    const h = makeHarness()
    h.workers[0].emitResponse({
      generation: WARMUP_GENERATION,
      ok: false,
      error: { code: 'WASM_INIT_FAILED', detail: 'wasm fetch 404' },
    })
    expect(h.client.initState).toBe('init-failed')
    expect(h.initFailures).toEqual(['wasm fetch 404'])
    expect(h.errors).toHaveLength(0) // 生成中ではないので epoch 向けの通知はない
  })
})

describe('初期化の 10 秒タイムアウト（FR-025）', () => {
  it('10 秒を超えると init-failed になる（直前までは initializing）', () => {
    const h = makeHarness()
    vi.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS - 1)
    expect(h.client.initState).toBe('initializing')
    expect(h.initFailures).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(h.client.initState).toBe('init-failed')
    expect(h.initFailures).toHaveLength(1)
    expect(h.workers[0].terminated).toBe(true)
  })

  it('whenReady はタイムアウトで reject する', async () => {
    const h = makeHarness()
    const ready = h.client.whenReady()
    vi.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS)
    await expect(ready).rejects.toThrow(/10000ms/)
  })

  it('ready 後はタイムアウトが発火しない', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    vi.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS * 2)
    expect(h.client.initState).toBe('ready')
    expect(h.initFailures).toHaveLength(0)
  })

  it('retryInit で新しい Worker が立ち上がり、ready で復帰する', () => {
    const h = makeHarness()
    vi.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS)
    expect(h.client.initState).toBe('init-failed')
    h.client.retryInit()
    expect(h.workers).toHaveLength(2)
    expect(h.client.initState).toBe('initializing')
    h.workers[1].emitReady()
    expect(h.client.initState).toBe('ready')
  })

  it('init-failed 中のリクエストは破棄されず、retryInit → ready 後に送出される', () => {
    const h = makeHarness()
    vi.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS)
    h.client.requestGeneration(trianglePayload(7))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    expect(h.workers[0].requests).toHaveLength(0)
    h.client.retryInit()
    h.workers[1].emitReady()
    expect(h.workers[1].requests).toHaveLength(1)
    expect(h.workers[1].requests[0].a.depth).toBe(7)
  })
})

describe('120ms デバウンス（NFR-004）', () => {
  it('連続 10 リクエストは最後の 1 件だけが Worker に届く', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    for (let i = 1; i <= 10; i++) {
      h.client.requestGeneration(trianglePayload(i))
      vi.advanceTimersByTime(10) // 打鍵間隔 10ms（デバウンス窓の中）
    }
    expect(h.workers[0].requests).toHaveLength(0) // まだ窓の中
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    expect(h.workers[0].requests).toHaveLength(1)
    expect(h.workers[0].requests[0].a.depth).toBe(10) // 最新の入力
    expect(h.calls.filter((c) => c === 'acquireEpoch')).toHaveLength(1)
  })

  it('リクエストのたびにデバウンス窓が延長される', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.client.requestGeneration(trianglePayload(1))
    vi.advanceTimersByTime(100)
    h.client.requestGeneration(trianglePayload(2))
    vi.advanceTimersByTime(100) // 最初の発行からは 200ms、2 件目からは 100ms
    expect(h.workers[0].requests).toHaveLength(0)
    vi.advanceTimersByTime(20) // 2 件目から 120ms
    expect(h.workers[0].requests).toHaveLength(1)
    expect(h.workers[0].requests[0].a.depth).toBe(2)
  })

  it('ready 前のリクエストは保持され、onReady → acquireEpoch の順で送出される', () => {
    const h = makeHarness()
    h.client.requestGeneration(trianglePayload(1))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    expect(h.workers[0].requests).toHaveLength(0)
    h.workers[0].emitReady()
    expect(h.workers[0].requests).toHaveLength(1)
    // store の wasmReady()（onReady）が startGenerating（acquireEpoch）より先
    expect(h.calls).toEqual(['onReady', 'acquireEpoch'])
  })

  it('acquireEpoch が null（store 側が開始不可）ならリクエストを破棄する', () => {
    const h = makeHarness({ acquireEpoch: () => null })
    h.workers[0].emitReady()
    h.client.requestGeneration(trianglePayload(1))
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)
    expect(h.workers[0].requests).toHaveLength(0)
    expect(h.successes).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('世代 ID と stale 破棄（US-001）', () => {
  it('世代 ID は単調増加でリクエストに載る', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    const r1 = dispatch(h, h.workers[0], 1)
    const r2 = dispatch(h, h.workers[0], 2)
    expect(r1.generation).toBe(1)
    expect(r2.generation).toBe(2)
  })

  it('古い世代のレスポンスは、後から届いても新しい結果を上書きしない', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    // 生成 1 を開始 → 生成 2 を開始（両方 in flight。Wasm は中断できない）
    const r1 = dispatch(h, h.workers[0], 1)
    const r2 = dispatch(h, h.workers[0], 2)
    // 生成 2 の応答が先に届き、採用される
    h.workers[0].emitResponse(okResponse(r2.generation, 200))
    expect(h.successes).toHaveLength(1)
    expect(h.successes[0].epoch).toBe(2)
    expect(h.successes[0].result.positions[0]).toBe(200)
    // 生成 1 の応答が**最後に**届く → 破棄。上書きも追加通知も起きない
    h.workers[0].emitResponse(okResponse(r1.generation, 100))
    expect(h.successes).toHaveLength(1)
    expect(h.successes[0].result.positions[0]).toBe(200)
    expect(h.errors).toHaveLength(0)
  })

  it('stale はエラー応答でも破棄される', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    const r1 = dispatch(h, h.workers[0], 1)
    dispatch(h, h.workers[0], 2)
    h.workers[0].emitResponse({
      generation: r1.generation,
      ok: false,
      error: { code: 'EMPTY_RESULT' },
    })
    expect(h.errors).toHaveLength(0)
  })
})

describe('クラッシュ回復', () => {
  it('クラッシュで Worker を作り直し、実行中のリクエストを 1 回だけ再試行する', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 5)
    expect(h.workers[0].requests).toHaveLength(1)

    h.workers[0].emitCrash()
    expect(h.workers[0].terminated).toBe(true)
    expect(h.workers).toHaveLength(2)

    // 作り直した Worker の初期化完了後に、同一世代・同一 payload が再送される
    h.workers[1].emitReady()
    expect(h.workers[1].requests).toHaveLength(1)
    expect(h.workers[1].requests[0]).toEqual(h.workers[0].requests[0])
    // epoch は取り直さない（acquireEpoch は最初の 1 回だけ）
    expect(h.calls.filter((c) => c === 'acquireEpoch')).toHaveLength(1)

    // 再試行の応答は、最初に取得した epoch で成功として届く
    h.workers[1].emitResponse(okResponse(1, 99))
    expect(h.successes).toHaveLength(1)
    expect(h.successes[0].epoch).toBe(1)
  })

  it('2 回目のクラッシュは再試行せず、エラーとして表面化する', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 5)

    h.workers[0].emitCrash() // 1 回目 → 再試行へ
    h.workers[1].emitReady() // 再送される
    expect(h.workers[1].requests).toHaveLength(1)
    h.workers[1].emitCrash() // 2 回目 → 打ち切り

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0].epoch).toBe(1)
    expect(h.errors[0].error.code).toBe('WORKER_CRASHED')
    expect(h.successes).toHaveLength(0)
    // Worker は次のリクエストに備えて作り直されるが、再々試行はしない
    expect(h.workers).toHaveLength(3)
    h.workers[2].emitReady()
    expect(h.workers[2].requests).toHaveLength(0)
  })

  it('作り直した Worker が初期化前に死んだ場合もエラーで終端し、ループしない', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 5)

    h.workers[0].emitCrash() // 1 回目のクラッシュ
    h.workers[1].emitCrash() // ready 前に死んだ → 初期化失敗として扱う
    expect(h.client.initState).toBe('init-failed')
    expect(h.initFailures).toHaveLength(1)
    // 実行中だった生成もエラーで終端する（スピナーが止まる）
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0].epoch).toBe(1)
    expect(h.errors[0].error.code).toBe('WASM_INIT_FAILED')
    // 3 台目は勝手に作らない（復帰は retryInit 経由のみ）
    expect(h.workers).toHaveLength(2)
  })

  it('アイドル中のクラッシュは作り直すだけで、誤ったエラー通知をしない', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.workers[0].emitCrash()
    expect(h.workers).toHaveLength(2)
    expect(h.errors).toHaveLength(0)
    expect(h.initFailures).toHaveLength(0)
  })

  it('クラッシュ回復後も新しいリクエストを処理できる', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 1)
    h.workers[0].emitCrash()
    h.workers[1].emitReady() // 再試行が走る
    h.workers[1].emitResponse(okResponse(1))
    expect(h.successes).toHaveLength(1)

    dispatch(h, h.workers[1], 2)
    expect(h.workers[1].requests).toHaveLength(2)
    expect(h.workers[1].requests[1].generation).toBe(2)
    expect(h.workers[1].requests[1].a.depth).toBe(2)
  })
})

describe('成功応答', () => {
  it('transfer された positions / indices がそのまま（コピーされずに）届く', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 1)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    h.workers[0].emitResponse({
      generation: 1,
      ok: true,
      positions,
      indices,
      componentCount: 1,
      volume: 0.5,
      elapsedMs: 12,
    })
    expect(h.successes).toHaveLength(1)
    const { epoch, result } = h.successes[0]
    expect(epoch).toBe(1)
    expect(result.positions).toBe(positions) // 同一インスタンス
    expect(result.indices).toBe(indices)
    expect(result.componentCount).toBe(1)
    expect(result.volume).toBe(0.5)
    expect(result.elapsedMs).toBe(12)
  })

  it('最新世代のエラー応答は onError に届く', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    dispatch(h, h.workers[0], 1)
    h.workers[0].emitResponse({
      generation: 1,
      ok: false,
      error: { code: 'EMPTY_RESULT' },
    })
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toEqual({ epoch: 1, error: { code: 'EMPTY_RESULT' } })
  })
})

describe('dispose', () => {
  it('破棄後はタイマーもリクエストも動かない', () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.client.requestGeneration(trianglePayload(1))
    h.client.dispose()
    expect(h.workers[0].terminated).toBe(true)
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS * 2)
    expect(h.workers[0].requests).toHaveLength(0)
  })
})
