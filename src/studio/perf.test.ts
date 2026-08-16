import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPerfSamples,
  createStageCursor,
  finishRunOnNextFrame,
  getAbandonedRuns,
  getPerfSamples,
  isWorkerPerfMessage,
  PERF_ENABLED,
  PERF_STAGE_ORDER,
  PERF_SUM_TOLERANCE_MS,
  abandonRun,
  stage,
  stageAfterWorker,
  startRun,
  subscribePerf,
  type PerfStage,
} from './perf'

/**
 * 工程計測の契約テスト（Task 7.2）。
 *
 * 検証する性質は 1 つだけ：**工程の合計が実測エンドツーエンドと一致すること**。
 * 予算表（design.md）はこれを保証しないので、保証をここに置く。一致しない
 * ときに黙って通ってしまうと、抜けた工程のぶんだけ予算が過小に見える。
 */

/** rAF が無い node では `finishRunOnNextFrame` はマイクロタスクで確定する */
async function nextTick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** 指定 ms ぶん実時間を消費する（`performance.now` を進めるため sleep ではなくスピン） */
function burn(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* spin */
  }
}

beforeEach(() => {
  clearPerfSamples()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearPerfSamples()
})

describe('計測の前提', () => {
  it('Vitest（DEV）では計測が有効', () => {
    expect(PERF_ENABLED).toBe(true)
  })
})

describe('工程の合計 = 実測エンドツーエンド', () => {
  it('全工程を通した run はサンプルを 1 件出し、合計が実測と一致する', async () => {
    const middle: readonly PerfStage[] = [
      'normalize',
      'preflight',
      'dispatch',
      'debounce',
      'transport',
    ]
    startRun(7)
    burn(2)
    for (const name of middle) {
      stage(name)
      burn(1)
    }
    stageAfterWorker(3, { intersect: 2, mesh: 1 })
    burn(1)
    stage('render')
    burn(1)
    finishRunOnNextFrame()
    await nextTick()

    const samples = getPerfSamples()
    expect(samples).toHaveLength(1)
    const sample = samples[0]
    expect(sample.epoch).toBe(7)
    expect(sample.missingStages).toEqual([])
    // 実測 total は工程の総和と**別の measure**なので、一致は自明ではない
    const sum = PERF_STAGE_ORDER.reduce((acc, name) => acc + (sample.stages[name] ?? 0), 0)
    expect(sum).toBeCloseTo(sample.totalMs, 1)
    expect(Math.abs(sample.unaccountedMs)).toBeLessThanOrEqual(PERF_SUM_TOLERANCE_MS)
    expect(sample.worker).toEqual({ intersect: 2, mesh: 1 })
  })

  it('Worker 実行時間は往復から切り出され、合計は変わらない', async () => {
    startRun(1)
    stage('normalize')
    stage('preflight')
    stage('dispatch')
    stage('debounce')
    stage('transport')
    burn(5)
    stageAfterWorker(3, null)
    stage('render')
    finishRunOnNextFrame()
    await nextTick()

    const sample = getPerfSamples()[0]
    expect(sample.stages.csg).toBeCloseTo(3, 6)
    // 往復 5ms のうち 3ms が csg へ移り、残りが純粋な postMessage コスト
    expect(sample.stages.transport).toBeGreaterThan(0)
    expect((sample.stages.transport ?? 0) + (sample.stages.csg ?? 0)).toBeGreaterThanOrEqual(5)
    const sum = PERF_STAGE_ORDER.reduce((acc, name) => acc + (sample.stages[name] ?? 0), 0)
    expect(sum).toBeCloseTo(sample.totalMs, 1)
  })

  it('工程を 1 つ飛ばすと欠落として検出され、console.error が出る', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startRun(2)
    stage('normalize')
    stage('preflight')
    // 'dispatch' を飛ばす（＝配線漏れ）
    stage('debounce')
    stage('transport')
    stageAfterWorker(1, null)
    stage('render')
    finishRunOnNextFrame()
    await nextTick()

    const sample = getPerfSamples()[0]
    expect(sample.missingStages).toEqual(['dispatch'])
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('欠落工程=dispatch')
  })

  it('中断した run はサンプルにならず、理由が記録される', async () => {
    startRun(3)
    stage('normalize')
    abandonRun('input-rejected')
    finishRunOnNextFrame()
    await nextTick()

    expect(getPerfSamples()).toHaveLength(0)
    expect(getAbandonedRuns()).toEqual({ 'input-rejected': 1 })
  })

  it('追い越された run は superseded として捨てられ、新しい run だけが残る', async () => {
    startRun(4)
    stage('normalize')
    startRun(5)
    stage('normalize')
    stage('preflight')
    stage('dispatch')
    stage('debounce')
    stage('transport')
    stageAfterWorker(1, null)
    stage('render')
    finishRunOnNextFrame()
    await nextTick()

    const samples = getPerfSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].epoch).toBe(5)
    expect(getAbandonedRuns()).toEqual({ superseded: 1 })
  })

  it('購読者は確定したサンプルを受け取る', async () => {
    const received: number[] = []
    const unsubscribe = subscribePerf((s) => received.push(s.epoch))
    startRun(9)
    stage('normalize')
    stage('preflight')
    stage('dispatch')
    stage('debounce')
    stage('transport')
    stageAfterWorker(0, null)
    stage('render')
    finishRunOnNextFrame()
    await nextTick()
    unsubscribe()

    expect(received).toEqual([9])
  })
})

describe('カーソル', () => {
  it('隙間なく連続し、閉じた工程だけが記録される', () => {
    const cursor = createStageCursor<'a' | 'b' | 'c'>('test')
    cursor.enter('a')
    burn(1)
    cursor.enter('b')
    burn(1)
    // 'b' は閉じていないので、この時点では記録されていない
    expect(cursor.durations.a).toBeGreaterThan(0)
    expect(cursor.durations.b).toBeUndefined()
    cursor.close()
    expect(cursor.durations.b).toBeGreaterThan(0)
    expect(cursor.durations.c).toBeUndefined()
    cursor.dispose()
  })

  it('split は合計を変えずに時間を付け替える', () => {
    const cursor = createStageCursor<'a' | 'b'>('test')
    cursor.enter('a')
    burn(4)
    cursor.close()
    const before = cursor.durations.a ?? 0
    cursor.split('a', 'b', 3)
    expect((cursor.durations.a ?? 0) + (cursor.durations.b ?? 0)).toBeCloseTo(before, 6)
    expect(cursor.durations.b).toBeCloseTo(3, 6)
    cursor.dispose()
  })

  it('split は実測より長い切り出しでも負の工程を作らない', () => {
    const cursor = createStageCursor<'a' | 'b'>('test')
    cursor.enter('a')
    cursor.close()
    const before = cursor.durations.a ?? 0
    cursor.split('a', 'b', 1000)
    expect(cursor.durations.a).toBe(0)
    expect(cursor.durations.b).toBeCloseTo(before, 6)
    cursor.dispose()
  })
})

describe('Worker からの計測通知の判別', () => {
  it('csg-perf だけを受け付ける', () => {
    expect(isWorkerPerfMessage({ type: 'csg-perf', generation: 1, stages: {} })).toBe(true)
    expect(isWorkerPerfMessage({ type: 'ready' })).toBe(false)
    expect(isWorkerPerfMessage({ generation: 1, ok: true })).toBe(false)
    expect(isWorkerPerfMessage(null)).toBe(false)
    expect(isWorkerPerfMessage('csg-perf')).toBe(false)
  })
})
