/**
 * useGenerationPipeline のテスト（Task 4.1）。
 *
 * React には依存しない — パイプラインの実体 `createGenerationPipeline` を
 * vanilla store（createStudioStore）と注入したモック Worker で駆動する。
 * 時間（デバウンス 120ms）はすべて fake timers で進める。
 *
 * text ソースはモジュールモックで差し替える：プリセットは全図形が単一の
 * 連結輪郭で、正規化（共通高さフィット）後は両シルエットの Y 範囲が常に
 * 一致するため、EMPTY_BAND / EMPTY_INTERSECTION がプリセット同士では
 * 原理的に発生しない。空帯・空交差の回帰テストには複数輪郭のシルエットが
 * 必要で、その注入点が text スタブになる（svg スタブは「拒否 → 復帰」の
 * 回帰テストに**実物のまま**使う）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BufferGeometry } from 'three'
import createManifold from 'manifold-3d'
import type { StoreApi } from 'zustand/vanilla'
import { boundsOf } from '../geometry/normalize'
import type { Contour, SilhouetteSource } from '../geometry/types'
import { textToContours } from '../sources/text'
import {
  createStudioStore,
  INITIAL_INPUT,
  type StudioState,
} from '../store/useStudioStore'
import {
  DEFAULT_DEBOUNCE_MS,
  WARMUP_GENERATION,
  type WorkerLike,
} from '../worker/client'
import { DEPTH_MARGIN as WORKER_DEPTH_MARGIN, performCsg } from '../worker/csg.worker'
import type { CsgRequest, CsgResponse } from '../worker/protocol'
import {
  createGenerationPipeline,
  DEPTH_MARGIN,
  WORKING_HEIGHT,
  type GenerationPipelineHandle,
} from './useGenerationPipeline'

// text スタブをモック化する（このファイル冒頭のコメント参照）。
// 既定の実装は実スタブと同じ「NotImplemented で reject」
vi.mock('../sources/text', () => ({
  textToContours: vi.fn((value: string, fontId: string) =>
    Promise.reject(
      new Error(`NotImplemented: textToContours("${value}", "${fontId}") — mock default`),
    ),
  ),
}))

/** postMessage を記録し、応答・ready・初期化失敗を手動で発火できるモック */
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

  emitInitFailed(detail: string): void {
    this.onmessage?.({ data: { type: 'init-failed', detail } } as MessageEvent)
  }

  emitResponse(response: CsgResponse): void {
    this.onmessage?.({ data: response } as MessageEvent)
  }
}

interface Harness {
  store: StoreApi<StudioState>
  handle: GenerationPipelineHandle
  workers: MockWorker[]
}

const harnesses: Harness[] = []

function makeHarness(): Harness {
  const store = createStudioStore()
  const workers: MockWorker[] = []
  const handle = createGenerationPipeline({
    store,
    clientOptions: {
      createWorker: () => {
        const w = new MockWorker()
        workers.push(w)
        return w
      },
    },
  })
  const h: Harness = { store, handle, workers }
  harnesses.push(h)
  return h
}

/** 面積が正の実在する三角形 1 枚のメッシュ（validateMeshGL を通る最小形） */
function okResponse(generation: number): CsgResponse {
  return {
    generation,
    ok: true,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    componentCount: 1,
    volume: 0.5,
    elapsedMs: 7,
  }
}

/** デバウンス満了とマイクロタスクをまとめて進める */
async function settle(ms = DEFAULT_DEBOUNCE_MS + 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** ready → 初期生成（正方形 × 円）を成功させ、success まで進める */
async function boot(h: Harness): Promise<void> {
  h.workers[0].emitReady()
  await settle()
  const req = h.workers[0].requests.at(-1)
  expect(req).toBeDefined()
  h.workers[0].emitResponse(okResponse(req!.generation))
  expect(h.store.getState().status).toBe('success')
  expect(h.handle.geometryRef.current).toBeInstanceOf(BufferGeometry)
}

// ---------------------------------------------------------------------------
// EMPTY_BAND / EMPTY_INTERSECTION を注入するための複数輪郭シルエット
// ---------------------------------------------------------------------------

/** x ∈ [-0.4, 0.4]、y ∈ [y0, y1] の横棒（CCW 外輪郭） */
function bar(y0: number, y1: number): Contour {
  return {
    points: new Float64Array([-0.4, y0, 0.4, y0, 0.4, y1, -0.4, y1]),
    isHole: false,
  }
}

/** 「i」型：上下 2 本の棒と中央の空帯。EMPTY_BAND が必ず出るが交差は空でない */
function iShapeContours(): Contour[] {
  return [bar(-1, -0.2), bar(0.2, 1)]
}

/**
 * 外輪郭と同一の穴を持つシルエット。bbox は正常だが被覆が常に空になり、
 * プリフライトが EMPTY_INTERSECTION を断定する（preflight.ts の doc 参照）。
 */
function emptyCoverageContours(): Contour[] {
  const square = [-1, -1, 1, -1, 1, 1, -1, 1]
  return [
    { points: new Float64Array(square), isHole: false },
    // 巻きは normalize が isHole に合わせて CW へ反転する
    { points: new Float64Array(square), isHole: true },
  ]
}

const star: SilhouetteSource = { kind: 'preset', id: 'star' }
const heart: SilhouetteSource = { kind: 'preset', id: 'heart' }
const textSource: SilhouetteSource = { kind: 'text', value: 'i', fontId: 'builtin' }
const svgSource: SilhouetteSource = {
  kind: 'svg',
  fileName: 'broken.svg',
  raw: '<svg><rect width="1" height="1"/></svg>',
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.handle.dispose()
  vi.useRealTimers()
  vi.mocked(textToContours).mockClear()
})

describe('初期生成（FR-025）', () => {
  it('ready 到達時に初期入力（正方形 × 円）で生成がちょうど 1 回走る', async () => {
    const h = makeHarness()
    expect(h.store.getState().status).toBe('loading-wasm')
    expect(h.workers).toHaveLength(1)
    // ウォームアップ（世代 0）は client 内部の先読みで、生成には数えない
    expect(h.workers[0].posted[0]?.generation).toBe(WARMUP_GENERATION)

    h.workers[0].emitReady()
    expect(h.store.getState().status).toBe('ready')

    await settle()
    expect(h.workers[0].requests).toHaveLength(1)

    // 時間が経っても追加の生成は走らない（1 回だけ）
    await settle(1000)
    expect(h.workers[0].requests).toHaveLength(1)

    const req = h.workers[0].requests[0]
    // 正方形（幅 2）× 円（直径 2）：どちらの深さも相手の幅 × (1 + margin)
    expect(req.a.depth).toBeCloseTo(2 * (1 + DEPTH_MARGIN), 10)
    expect(req.b.depth).toBeCloseTo(2 * (1 + DEPTH_MARGIN), 10)
    expect(req.baseplate).toBeNull()

    h.workers[0].emitResponse(okResponse(req.generation))
    const s = h.store.getState()
    expect(s.status).toBe('success')
    expect(s.lastResult).toEqual({
      componentCount: 1,
      volume: 0.5,
      triangleCount: 1,
      elapsedMs: 7,
    })
    expect(s.warnings).toEqual([])
    const geometry = h.handle.geometryRef.current
    expect(geometry).toBeInstanceOf(BufferGeometry)
    expect(geometry!.getAttribute('position').count).toBe(3)
  })
})

describe('プリセット変更（US-001）', () => {
  it('変更と同一トランザクションで ref がクリアされ、応答で success とジオメトリが入る', async () => {
    const h = makeHarness()
    await boot(h)

    h.store.getState().setSilhouetteA(star)
    // 入力変更の set() と同期して外部 ref のジオメトリが破棄される（トラップ 2）
    expect(h.handle.geometryRef.current).toBeNull()
    expect(h.store.getState().lastResult).toBeNull()

    await settle()
    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    h.workers[0].emitResponse(okResponse(req.generation))

    expect(h.store.getState().status).toBe('success')
    expect(h.handle.geometryRef.current).toBeInstanceOf(BufferGeometry)
  })
})

describe('プリフライトのゲート（トラップ 1）', () => {
  it('EMPTY_BAND が出る組み合わせでも生成は実行される', async () => {
    const h = makeHarness()
    await boot(h)

    vi.mocked(textToContours).mockImplementationOnce(() =>
      Promise.resolve(iShapeContours()),
    )
    h.store.getState().setSilhouetteB(textSource)
    await settle()

    // 空帯は警告として提示しつつ、生成自体は Worker へディスパッチされる
    const warnings = h.store.getState().warnings
    expect(warnings.some((w) => w.code === 'EMPTY_BAND')).toBe(true)
    expect(warnings.some((w) => w.code === 'EMPTY_INTERSECTION')).toBe(false)
    expect(h.workers[0].requests).toHaveLength(2)

    const req = h.workers[0].requests[1]
    h.workers[0].emitResponse(okResponse(req.generation))
    expect(h.store.getState().status).toBe('success')
    // 生成成功後も空帯の警告は残る（組み合わせの性質の提示）
    expect(
      h.store.getState().warnings.some((w) => w.code === 'EMPTY_BAND'),
    ).toBe(true)
  })

  it('EMPTY_INTERSECTION は Worker へディスパッチせず、EMPTY_RESULT として終端する', async () => {
    const h = makeHarness()
    await boot(h)

    vi.mocked(textToContours).mockImplementationOnce(() =>
      Promise.resolve(emptyCoverageContours()),
    )
    h.store.getState().setSilhouetteB(textSource)
    await settle(1000)

    // 新しいリクエストは 1 件も送られていない
    expect(h.workers[0].requests).toHaveLength(1)
    const s = h.store.getState()
    expect(s.warnings.some((w) => w.code === 'EMPTY_INTERSECTION')).toBe(true)
    // Worker が空交差を計算したときと同じ終端に揃える
    expect(s.status).toBe('error')
    expect(s.lastError).toEqual({ code: 'EMPTY_RESULT' })
    expect(h.handle.geometryRef.current).toBeNull()
  })

  it('デバウンス待ちの古い payload も、EMPTY_INTERSECTION 確定後は送出されない', async () => {
    const h = makeHarness()
    await boot(h)

    // 有効な入力変更（star）を受理させ、デバウンス窓の中に payload を残す
    h.store.getState().setSilhouetteA(star)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.workers[0].requests).toHaveLength(1) // まだ送出されていない

    // デバウンス満了前に空交差の入力へ切り替える
    vi.mocked(textToContours).mockImplementationOnce(() =>
      Promise.resolve(emptyCoverageContours()),
    )
    h.store.getState().setSilhouetteB(textSource)
    await settle(1000)

    // star の payload はゲート確定後の送出時刻に acquireEpoch=null で破棄される
    expect(h.workers[0].requests).toHaveLength(1)
    expect(h.store.getState().status).toBe('error')
    expect(h.store.getState().lastError).toEqual({ code: 'EMPTY_RESULT' })
  })
})

describe('世代エポックの突き合わせ（トラップ 2）', () => {
  it('追い越された epoch の遅延レスポンスは store もジオメトリ ref も更新しない', async () => {
    const h = makeHarness()
    await boot(h)

    // star の生成を実行中にする
    h.store.getState().setSilhouetteA(star)
    await settle()
    expect(h.workers[0].requests).toHaveLength(2)
    const staleReq = h.workers[0].requests[1]
    expect(h.store.getState().status).toBe('generating')

    // 応答が届く前に入力を変更し（epoch 前進 + ref クリア）、その直後に
    // 旧世代の遅延レスポンスを届ける（新入力の解析はまだ走っていない瞬間）
    h.store.getState().setSilhouetteA(heart)
    expect(h.handle.geometryRef.current).toBeNull()
    h.workers[0].emitResponse(okResponse(staleReq.generation))

    // stale なレスポンスは何も更新しない
    expect(h.handle.geometryRef.current).toBeNull()
    expect(h.store.getState().status).toBe('generating')
    expect(h.store.getState().lastResult).toBeNull()

    // 最新入力（heart）の生成は通常どおり完了する
    await settle()
    expect(h.workers[0].requests).toHaveLength(3)
    const freshReq = h.workers[0].requests[2]
    h.workers[0].emitResponse(okResponse(freshReq.generation))
    expect(h.store.getState().status).toBe('success')
    expect(h.handle.geometryRef.current).toBeInstanceOf(BufferGeometry)
  })
})

describe('入力の拒否と復帰（トラップ 3 / FR-006）', () => {
  it('svg スタブの拒否で直前の有効入力へ復帰し、拒否された入力はコミットされない', async () => {
    const h = makeHarness()
    await boot(h)

    h.store.getState().setSilhouetteB(svgSource)
    await settle()

    const s = h.store.getState()
    // 拒否された svg 入力は復帰先（lastValidInput）に昇格していない
    expect(s.lastValidInput).toEqual(INITIAL_INPUT)
    // 入力は直前の有効入力（正方形 × 円）へ巻き戻っている
    expect(s.input).toEqual(INITIAL_INPUT)

    // 復帰した入力に対応するメッシュが再生成される（svg 入力の分は送出されない）
    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    expect(req.a.depth).toBeCloseTo(2 * (1 + DEPTH_MARGIN), 10)
    h.workers[0].emitResponse(okResponse(req.generation))
    expect(h.store.getState().status).toBe('success')
    expect(h.handle.geometryRef.current).toBeInstanceOf(BufferGeometry)
  })

  it('text スタブの拒否（既定実装）も同じ復帰経路を通る', async () => {
    const h = makeHarness()
    await boot(h)

    // モックの既定実装は実スタブと同じく NotImplemented で reject する
    h.store.getState().setSilhouetteB(textSource)
    await settle()

    expect(h.store.getState().input).toEqual(INITIAL_INPUT)
    expect(h.workers[0].requests).toHaveLength(2)
  })
})

describe('init-failed → 再試行（FR-025）', () => {
  it('初期化失敗から retry で復帰し、保持していた初期入力で生成が走る', async () => {
    const h = makeHarness()

    h.workers[0].emitInitFailed('wasm unavailable')
    const failed = h.store.getState()
    expect(failed.status).toBe('init-failed')
    expect(failed.lastError?.code).toBe('WASM_INIT_FAILED')

    h.handle.retry()
    expect(h.store.getState().status).toBe('loading-wasm')
    expect(h.workers).toHaveLength(2)

    h.workers[1].emitReady()
    expect(h.store.getState().status).toBe('ready')

    // 失敗中も保持されていた初期入力（FR-025）が新しい Worker で送出される
    await settle()
    expect(h.workers[1].requests).toHaveLength(1)
    const req = h.workers[1].requests[0]
    h.workers[1].emitResponse(okResponse(req.generation))
    expect(h.store.getState().status).toBe('success')
    expect(h.handle.geometryRef.current).toBeInstanceOf(BufferGeometry)
  })
})

describe('台座オプション（FR-015 / Task 6.4 への契約）', () => {
  it('台座の有効化で再生成が走り、mm 厚が作業座標へ換算されて載る', async () => {
    const h = makeHarness()
    await boot(h)

    h.store.getState().setBaseplateEnabled(true)
    await settle()

    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    // 既定 2.0mm 厚・実寸高さ 60mm・作業高さ H=2 → 2 × 2 / 60
    expect(req.baseplate).not.toBeNull()
    expect(req.baseplate!.enabled).toBe(true)
    expect(req.baseplate!.height).toBeCloseTo((2.0 * WORKING_HEIGHT) / 60, 12)
  })
})

describe('押し出し深さ（FR-011）', () => {
  it('DEPTH_MARGIN が Worker の検証定数と一致する', () => {
    expect(DEPTH_MARGIN).toBe(WORKER_DEPTH_MARGIN)
  })

  it('算出した深さが Worker の要求（相手 bbox 幅 × (1 + margin)）を満たす', async () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.store.getState().setSilhouetteA(star) // 非対称寄りの組でも式が成立すること
    await settle()

    const req = h.workers[0].requests.at(-1)!
    const widthA = boundsOf(req.a.contours).maxX - boundsOf(req.a.contours).minX
    const widthB = boundsOf(req.b.contours).maxX - boundsOf(req.b.contours).minX
    expect(req.a.depth).toBeGreaterThanOrEqual(widthB * (1 + WORKER_DEPTH_MARGIN) * (1 - 1e-9))
    expect(req.b.depth).toBeGreaterThanOrEqual(widthA * (1 + WORKER_DEPTH_MARGIN) * (1 - 1e-9))
  })

  it('パイプラインが組んだリクエストがそのまま実 Wasm の検証と演算を通過する', async () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    await settle()
    const req = h.workers[0].requests.at(-1)!

    // Wasm 初期化は実時間で待つ（Node では locateFile 不要）
    vi.useRealTimers()
    const wasm = await createManifold()
    wasm.setup()
    const response = performCsg(wasm, req)
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.componentCount).toBe(1)
      expect(response.positions.length).toBeGreaterThan(0)
    }
  }, 30_000)
})
