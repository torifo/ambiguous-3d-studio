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
import {
  computeDepths,
  viewpointCamera,
  type CsgRequest,
  type CsgResponse,
} from '../worker/protocol'
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
  // 実装済みの svg.ts（Task 6.2）が**本当に拒否する**入力であること：
  // ストロークのみで閉じた塗り対象パスがない SVG は FR-005 / US-002 により拒否される。
  // （スタブ時代は何でも reject したため中身は不問だったが、実装後は
  // 「拒否 → 復帰」の回帰テストとして実パーサの拒否経路を通る）
  raw: '<svg><path d="M0 0 L1 1" stroke="black" fill="none"/></svg>',
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

describe('視点 C（FR-101）', () => {
  it('2 視点のリクエストは C を足す前と同一（c は null、軸角は 90）', async () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    await settle()

    const req = h.workers[0].requests[0]
    // 正方形（幅 2）× 円（直径 2）：従来の式そのままの値になること（近似ではなく厳密）
    expect(req.a.depth).toBe(2 * (1 + DEPTH_MARGIN))
    expect(req.b.depth).toBe(2 * (1 + DEPTH_MARGIN))
    expect(req.c).toBeNull()
    expect(req.axisAngleDeg).toBe(90)
  })

  it('視点 C を設定すると c 付きのリクエストになり、深さが深さ規則に一致する', async () => {
    const h = makeHarness()
    await boot(h)

    h.store.getState().setSilhouetteC({ kind: 'preset', id: 'triangle' })
    await settle()

    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    expect(req.c).not.toBeNull()
    expect(req.c!.contours.length).toBeGreaterThan(0)

    // 深さは protocol.ts の computeDepths が唯一の根拠。パイプラインが
    // 自前の式に戻っていないことを、同じ関数の出力との一致で固定する
    const extent = (contours: Contour[]) => {
      const b = boundsOf(contours)
      return { width: b.maxX - b.minX, height: b.maxY - b.minY }
    }
    const expected = computeDepths({
      a: extent(req.a.contours),
      b: extent(req.b.contours),
      c: extent(req.c!.contours),
    })
    expect(req.a.depth).toBe(expected.a)
    expect(req.b.depth).toBe(expected.b)
    expect(req.c!.depth).toBe(expected.c)

    // 正規化で全シルエットの高さが H=2 に揃うので、C の深さは 2 × (1 + margin)
    expect(req.c!.depth).toBeCloseTo(WORKING_HEIGHT * (1 + DEPTH_MARGIN), 12)
    // A の深さは「B の幅」と「C の高さ」の大きい方（三角形は幅 2.309）
    expect(req.a.depth).toBeGreaterThanOrEqual(2 * (1 + DEPTH_MARGIN))
  })

  it('live 帯（FR-101）がストアに載り、C を足すと狭くなる', async () => {
    const h = makeHarness()
    await boot(h)
    const twoViewpoints = h.store.getState().liveYRange
    expect(twoViewpoints).not.toBeNull()
    // 正方形 × 円は全高が立体になる（共通高さ H = 2、中心原点）
    expect(twoViewpoints![0]).toBeLessThan(-0.99)
    expect(twoViewpoints![1]).toBeGreaterThan(0.99)

    // C に「上下 2 本の棒（中央が空）」を入れると、C の材料がある奥行きに
    // 制限され、B（円）の断面と噛み合わない高さが出る
    vi.mocked(textToContours).mockImplementationOnce(() =>
      Promise.resolve(iShapeContours()),
    )
    h.store.getState().setSilhouetteC(textSource)
    await settle()

    const s = h.store.getState()
    expect(s.warnings.some((w) => w.code === 'EMPTY_BAND')).toBe(true)
    const cBand = s.warnings.find((w) => w.code === 'EMPTY_BAND')
    if (cBand?.code !== 'EMPTY_BAND') return
    expect(cBand.side).toBe('C')
  })

  it('視点 C を外すと、C を一度も使わなかったリクエストに戻る', async () => {
    const h = makeHarness()
    await boot(h)
    const baseline = h.workers[0].requests[0]

    h.store.getState().setSilhouetteC({ kind: 'preset', id: 'triangle' })
    await settle()
    h.store.getState().setSilhouetteC(null)
    await settle()

    const req = h.workers[0].requests.at(-1)!
    expect(req.c).toBeNull()
    expect(req.a.depth).toBe(baseline.a.depth)
    expect(req.b.depth).toBe(baseline.b.depth)
  })

  it('視点 C の解決失敗も入力の拒否として直前の有効入力へ復帰する（FR-006）', async () => {
    const h = makeHarness()
    await boot(h)

    h.store.getState().setSilhouetteC(svgSource)
    await settle()

    const s = h.store.getState()
    expect(s.input).toEqual(INITIAL_INPUT)
    expect(s.input.c).toBeNull()
    expect(s.lastValidInput).toEqual(INITIAL_INPUT)
    // 復帰した入力で再生成される
    expect(h.workers[0].requests).toHaveLength(2)
    expect(h.workers[0].requests[1].c).toBeNull()
  })

  it('C が共通帯のどこにも被覆を持たない三つ組は EMPTY_INTERSECTION で C を名指しし、送出しない', async () => {
    const h = makeHarness()
    await boot(h)

    // C は「外輪郭と同一の穴」で被覆が常に空 → どの高さでもスライスが空
    vi.mocked(textToContours).mockImplementationOnce(() =>
      Promise.resolve(emptyCoverageContours()),
    )
    h.store.getState().setSilhouetteC(textSource)
    await settle(1000)

    expect(h.workers[0].requests).toHaveLength(1)
    const s = h.store.getState()
    const warning = s.warnings.find((w) => w.code === 'EMPTY_INTERSECTION')
    expect(warning).toBeDefined()
    if (warning?.code !== 'EMPTY_INTERSECTION') return
    expect(warning.emptySides).toEqual(['C'])
    expect(s.status).toBe('error')
    expect(s.lastError).toEqual({ code: 'EMPTY_RESULT' })
  })

  it('3 視点のリクエストがそのまま実 Wasm の検証と演算を通過する', async () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.store.getState().applyInput({
      a: { kind: 'preset', id: 'square' },
      b: { kind: 'preset', id: 'circle' },
      c: { kind: 'preset', id: 'circle' },
    })
    await settle()
    const req = h.workers[0].requests.at(-1)!
    expect(req.c).not.toBeNull()

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

describe('斜交軸（FR-102）', () => {
  it('軸角の変更が再生成を起こし、深さが斜交の式に従う', async () => {
    const h = makeHarness()
    await boot(h)
    const orthogonal = h.workers[0].requests[0]

    h.store.getState().setAxisAngleDeg(45)
    await settle()

    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    expect(req.axisAngleDeg).toBe(45)

    // 直交式（相手 bbox 幅 × margin）のままなら、この不等式で落ちる
    expect(req.a.depth).toBeGreaterThan(orthogonal.a.depth)
    expect(req.b.depth).toBeGreaterThan(orthogonal.b.depth)

    // (wB + wA·cos45°) / sin45° × (1 + margin)。どちらの幅も 2
    const expected = ((2 + 2 * Math.SQRT1_2) / Math.SQRT1_2) * (1 + DEPTH_MARGIN)
    expect(req.a.depth).toBeCloseTo(expected, 10)
    expect(req.b.depth).toBeCloseTo(expected, 10)
  })

  it('90° に戻すと直交のリクエストと厳密に一致する', async () => {
    const h = makeHarness()
    await boot(h)
    const orthogonal = h.workers[0].requests[0]

    h.store.getState().setAxisAngleDeg(45)
    await settle()
    h.store.getState().setAxisAngleDeg(90)
    await settle()

    const req = h.workers[0].requests.at(-1)!
    expect(req.axisAngleDeg).toBe(90)
    expect(req.a.depth).toBe(orthogonal.a.depth)
    expect(req.b.depth).toBe(orthogonal.b.depth)
  })

  it('斜交 45° のリクエストがそのまま実 Wasm の検証と演算を通過する', async () => {
    const h = makeHarness()
    h.workers[0].emitReady()
    h.store.getState().applyInput({
      a: { kind: 'preset', id: 'square' },
      b: { kind: 'preset', id: 'circle' },
      axisAngleDeg: 45,
    })
    await settle()
    const req = h.workers[0].requests.at(-1)!
    expect(req.axisAngleDeg).toBe(45)

    vi.useRealTimers()
    const wasm = await createManifold()
    wasm.setup()
    const response = performCsg(wasm, req)
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.componentCount).toBe(1)
    }
  }, 30_000)
})

describe('視点 C × 斜交軸の併用（レビュー Finding 1 の回帰）', () => {
  // レビューの失敗入力：A = 全面正方形（プリセット square がそのまま）、
  // B = 細い縦帯、C = 対角の 2 つの塊。90° では真に空だが、120° では非空な
  // 実体になる（geometry/preflight.test.ts の同じ入力での実 Wasm 検証を参照）。
  // ここで確かめたいのはプリフライトの数理そのものではなく、
  // **パイプラインが store の軸角を実際に runPreflight へ渡しているか**
  // （渡し忘れると常に 90° 相当で判定され、120° でも誤って EMPTY_RESULT に
  // 終端し Worker に一度もディスパッチされない）
  const thinStrip = (): Contour[] => [
    { points: new Float64Array([-0.05, -1, 0.05, -1, 0.05, 1, -0.05, 1]), isHole: false },
  ]
  const twoBlobs = (): Contour[] => [
    { points: new Float64Array([0.6, 0.6, 1, 0.6, 1, 1, 0.6, 1]), isHole: false },
    { points: new Float64Array([-1, -1, -0.6, -1, -0.6, -0.6, -1, -0.6]), isHole: false },
  ]
  const stripSource: SilhouetteSource = { kind: 'text', value: 'strip', fontId: 'builtin' }
  const blobsSource: SilhouetteSource = { kind: 'text', value: 'blobs', fontId: 'builtin' }

  it('90° は EMPTY_RESULT で終端し、120° に変えると実際に Worker へディスパッチされる', async () => {
    const h = makeHarness()
    await boot(h)

    vi.mocked(textToContours)
      .mockImplementationOnce(() => Promise.resolve(thinStrip()))
      .mockImplementationOnce(() => Promise.resolve(twoBlobs()))

    h.store.getState().applyInput({
      a: { kind: 'preset', id: 'square' },
      b: stripSource,
      c: blobsSource,
      axisAngleDeg: 90,
    })
    await settle()

    // 90° はこの入力では実際にも空なので、対照として先に確認する
    // （boot() 分の 1 件から増えていない = ディスパッチされていない）
    expect(h.workers[0].requests).toHaveLength(1)
    let s = h.store.getState()
    expect(s.status).toBe('error')
    expect(s.lastError).toEqual({ code: 'EMPTY_RESULT' })
    expect(s.warnings.some((w) => w.code === 'EMPTY_INTERSECTION')).toBe(true)

    // 同じ B・C のまま軸角だけ 120° にする。実体は非空になる
    // （geometry/preflight.test.ts で実 Wasm 検証済み）。axisAngleDeg を
    // runPreflight に渡していない実装なら、ここでも常に 90° 相当のまま
    // 誤って EMPTY_RESULT に終端し、Worker には一度も届かない
    vi.mocked(textToContours)
      .mockImplementationOnce(() => Promise.resolve(thinStrip()))
      .mockImplementationOnce(() => Promise.resolve(twoBlobs()))
    h.store.getState().setAxisAngleDeg(120)
    await settle()

    expect(h.workers[0].requests).toHaveLength(2)
    const req = h.workers[0].requests[1]
    expect(req.axisAngleDeg).toBe(120)
    expect(req.c).not.toBeNull()

    h.workers[0].emitResponse(okResponse(req.generation))
    s = h.store.getState()
    expect(s.status).toBe('success')
    expect(s.warnings.some((w) => w.code === 'EMPTY_INTERSECTION')).toBe(false)
  })
})

describe('カメラ規約の公開（Wave 5 への契約）', () => {
  it('A / B / C の視点方向と up。C の up は −Z（+Z にすると C だけ鏡像になる）', () => {
    expect(viewpointCamera('A')).toEqual({ direction: [0, 0, 1], up: [0, 1, 0] })
    // 直交では従来どおり +X 側
    expect(viewpointCamera('B')).toEqual({ direction: [1, 0, 0], up: [0, 1, 0] })
    expect(viewpointCamera('C')).toEqual({ direction: [0, 1, 0], up: [0, 0, -1] })
  })

  it('斜交では側面カメラが押し出し軸 (sin φ, 0, cos φ) の側へ回る', () => {
    const camera = viewpointCamera('B', 45)
    expect(camera.direction[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(camera.direction[1]).toBe(0)
    expect(camera.direction[2]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(camera.up).toEqual([0, 1, 0])

    // 画面右 = up × backward が B の断面ローカル +X = (cos φ, 0, −sin φ) と一致する
    const [dx, dy, dz] = camera.direction
    const [ux, uy, uz] = camera.up
    const right: [number, number, number] = [
      uy * dz - uz * dy,
      uz * dx - ux * dz,
      ux * dy - uy * dx,
    ]
    expect(right[0]).toBeCloseTo(Math.cos(Math.PI / 4), 12)
    expect(right[1]).toBeCloseTo(0, 12)
    expect(right[2]).toBeCloseTo(-Math.sin(Math.PI / 4), 12)
  })
})
