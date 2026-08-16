/**
 * SweetSpot.ts の単体テスト（Task 5.4）。Node の Vitest のみで動く —
 * DOM・canvas・three を必要としない（純関数と store だけを検証する）。
 *
 * 特に固定する仕様：
 * - 閾値 3.5°（≈ 0.0611 rad）と「未満で合致」の境界（FR-021）
 * - **側面カメラは +X**（design.md「2.1 軸の割り当てとカメラ規約」）。
 *   −X 前方（= −X カメラ相当ではなく「+X に向く前方」）が合致し、
 *   +X 前方（−X 側にカメラを置いた状態）は合致**しない**こと —
 *   CSG 側の回転回帰テストでは検出できない鏡像事故をここで塞ぐ
 * - store の書き込みが**値の変化時のみ**購読者へ通知されること（NFR-002）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  angleBetween,
  easeInOutCubic,
  matchedSweetSpot,
  orthoZoomToMatchPerspective,
  perspectiveDistanceToMatchOrtho,
  perspectiveHalfHeightAt,
  slerpDirection,
  SNAP_VIEWS,
  SWEET_SPOT_THRESHOLD_RAD,
  useViewerStore,
  VIEW_FORWARDS,
  type Vec3Like,
} from './SweetSpot'

const rad = (deg: number): number => (deg * Math.PI) / 180

/** 前方 (0,0,−1)（視点 A）を Y 軸まわりに `deg` 度だけ回した前方ベクトル */
function forwardYawedFromA(deg: number): Vec3Like {
  const t = rad(deg)
  return { x: -Math.sin(t), y: 0, z: -Math.cos(t) }
}

function length(v: Vec3Like): number {
  return Math.hypot(v.x, v.y, v.z)
}

describe('angleBetween', () => {
  it('同一方向は 0、直交は π/2、反対方向は π', () => {
    expect(angleBetween({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 12)
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(
      Math.PI / 2,
      12,
    )
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(
      Math.PI,
      12,
    )
  })

  it('入力の長さに依存しない（内部で正規化される）', () => {
    expect(angleBetween({ x: 0, y: 0, z: 10 }, { x: 0, y: 5, z: 0 })).toBeCloseTo(
      Math.PI / 2,
      12,
    )
  })

  it('既知の角度を再現する（30°）', () => {
    const a = { x: 0, y: 0, z: 1 }
    const b = { x: Math.sin(rad(30)), y: 0, z: Math.cos(rad(30)) }
    expect(angleBetween(a, b)).toBeCloseTo(rad(30), 10)
  })

  it('長さ 0 の縮退入力は π（不一致側）に倒す', () => {
    expect(angleBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBe(Math.PI)
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(Math.PI)
  })
})

describe('閾値と視点規約（FR-021 / design.md 2.1）', () => {
  it('閾値は 3.5° = 0.0611 rad', () => {
    expect(SWEET_SPOT_THRESHOLD_RAD).toBeCloseTo((3.5 * Math.PI) / 180, 12)
    expect(SWEET_SPOT_THRESHOLD_RAD).toBeCloseTo(0.0611, 4)
  })

  it('視点 A の前方は (0,0,−1)、視点 B の前方は (−1,0,0)', () => {
    expect(VIEW_FORWARDS.A).toEqual({ x: 0, y: 0, z: -1 })
    expect(VIEW_FORWARDS.B).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('スナップ規約：front は +Z、side は **+X**、iso は透視のまま', () => {
    expect(SNAP_VIEWS.front.direction).toEqual({ x: 0, y: 0, z: 1 })
    // side を −X にすると B が左右反転する（鏡像事故）。ここで +X を固定する
    expect(SNAP_VIEWS.side.direction).toEqual({ x: 1, y: 0, z: 0 })
    expect(SNAP_VIEWS.front.projection).toBe('orthographic')
    expect(SNAP_VIEWS.side.projection).toBe('orthographic')
    expect(SNAP_VIEWS.iso.projection).toBe('perspective')
    expect(SNAP_VIEWS.front.sweetSpot).toBe('A')
    expect(SNAP_VIEWS.side.sweetSpot).toBe('B')
    expect(SNAP_VIEWS.iso.sweetSpot).toBeNull()
  })

  it('スナップ方向は単位ベクトルで、A/B の前方はスナップ方向の逆向き', () => {
    for (const spec of Object.values(SNAP_VIEWS)) {
      expect(length(spec.direction)).toBeCloseTo(1, 12)
    }
    expect(VIEW_FORWARDS.A.z).toBe(-SNAP_VIEWS.front.direction.z)
    expect(VIEW_FORWARDS.B.x).toBe(-SNAP_VIEWS.side.direction.x)
  })
})

describe('matchedSweetSpot', () => {
  it('正確に視点 A / B を向くと合致する', () => {
    expect(matchedSweetSpot({ x: 0, y: 0, z: -1 })).toBe('A')
    expect(matchedSweetSpot({ x: -1, y: 0, z: 0 })).toBe('B')
  })

  it('3.4° ずれは合致、3.6° ずれは不一致（3.5° 未満で合致）', () => {
    expect(matchedSweetSpot(forwardYawedFromA(3.4))).toBe('A')
    expect(matchedSweetSpot(forwardYawedFromA(3.6))).toBeNull()
    expect(matchedSweetSpot(forwardYawedFromA(-3.4))).toBe('A')
  })

  it('カメラを −X 側に置いた前方 (+1,0,0) は B に合致**しない**（鏡像側）', () => {
    // B のカメラは +X 側（前方 (−1,0,0)）。反対側は 180° ずれであって
    // 「もう 1 つの正解」ではない — ここが緩いと鏡像ビューが合致扱いになる
    expect(matchedSweetSpot({ x: 1, y: 0, z: 0 })).toBeNull()
  })

  it('背面 (0,0,+1) や俯瞰方向は合致しない', () => {
    expect(matchedSweetSpot({ x: 0, y: 0, z: 1 })).toBeNull()
    expect(matchedSweetSpot({ x: -0.577, y: -0.577, z: -0.577 })).toBeNull()
  })

  it('前方ベクトルの長さに依存しない', () => {
    expect(matchedSweetSpot({ x: 0, y: 0, z: -0.25 })).toBe('A')
  })
})

describe('easeInOutCubic', () => {
  it('端点と中点', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12)
  })

  it('単調非減少', () => {
    let prev = -Infinity
    for (let i = 0; i <= 20; i++) {
      const v = easeInOutCubic(i / 20)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('範囲外の t は 0〜1 に clamp される', () => {
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(2)).toBe(1)
  })
})

describe('slerpDirection', () => {
  const X: Vec3Like = { x: 1, y: 0, z: 0 }
  const Z: Vec3Like = { x: 0, y: 0, z: 1 }

  it('端点で両端の方向（正規化済み）を返す', () => {
    expect(slerpDirection(X, Z, 0)).toEqual(X)
    expect(slerpDirection(X, Z, 1)).toEqual(Z)
    // 入力が非正規でも出力は単位ベクトル
    const r = slerpDirection({ x: 3, y: 0, z: 0 }, Z, 0)
    expect(r.x).toBeCloseTo(1, 12)
  })

  it('直交ベクトルの中点は 45° 方向の単位ベクトル', () => {
    const mid = slerpDirection(X, Z, 0.5)
    expect(mid.x).toBeCloseTo(Math.SQRT1_2, 10)
    expect(mid.y).toBeCloseTo(0, 12)
    expect(mid.z).toBeCloseTo(Math.SQRT1_2, 10)
    expect(length(mid)).toBeCloseTo(1, 12)
  })

  it('一定角速度（t=0.25 で 1/4 の角度）', () => {
    const q = slerpDirection(X, Z, 0.25)
    expect(angleBetween(X, q)).toBeCloseTo(Math.PI / 8, 10)
    expect(length(q)).toBeCloseTo(1, 12)
  })

  it('反平行でも NaN にならず単位ベクトルを返す', () => {
    const mid = slerpDirection(X, { x: -1, y: 0, z: 0 }, 0.5)
    expect(Number.isFinite(mid.x)).toBe(true)
    expect(Number.isFinite(mid.y)).toBe(true)
    expect(Number.isFinite(mid.z)).toBe(true)
    expect(length(mid)).toBeCloseTo(1, 10)
    // 中点は両端とほぼ直交する（回転面の途中にいる）
    expect(Math.abs(mid.x)).toBeLessThan(0.01)
  })

  it('t は 0〜1 に clamp される', () => {
    expect(slerpDirection(X, Z, -1)).toEqual(X)
    expect(slerpDirection(X, Z, 2)).toEqual(Z)
  })
})

describe('投影切替のサイズ一致（FR-023）', () => {
  it('透視の可視半高：fov 50° / 距離 4 → 4·tan25°', () => {
    expect(perspectiveHalfHeightAt(50, 4)).toBeCloseTo(4 * Math.tan(rad(25)), 12)
  })

  it('orthoZoom は「正射影の可視半高 = 透視の可視半高」を満たす', () => {
    const orthoHalfHeight = 1
    const zoom = orthoZoomToMatchPerspective(orthoHalfHeight, 50, 4)
    // 正射影の可視半高 = orthoHalfHeight / zoom
    expect(orthoHalfHeight / zoom).toBeCloseTo(perspectiveHalfHeightAt(50, 4), 12)
  })

  it('往復で距離が戻る（ortho ← → perspective の round-trip）', () => {
    const orthoHalfHeight = 1.5
    const fov = 40
    const distance = 6.25
    const zoom = orthoZoomToMatchPerspective(orthoHalfHeight, fov, distance)
    expect(perspectiveDistanceToMatchOrtho(orthoHalfHeight, fov, zoom)).toBeCloseTo(
      distance,
      10,
    )
  })

  it('正射影中のズームイン（zoom 増）は透視の距離短縮に対応する', () => {
    const near = perspectiveDistanceToMatchOrtho(1, 50, 4)
    const far = perspectiveDistanceToMatchOrtho(1, 50, 0.5)
    expect(near).toBeLessThan(far)
  })
})

describe('useViewerStore（書き込みは値の変化時のみ。NFR-002）', () => {
  beforeEach(() => {
    useViewerStore.setState({ matched: null, projection: 'perspective', snapRequest: null })
  })

  it('setMatched は同値の再書き込みで購読者へ通知しない', () => {
    const listener = vi.fn()
    const unsubscribe = useViewerStore.subscribe(listener)
    const { setMatched } = useViewerStore.getState()

    setMatched('A')
    expect(useViewerStore.getState().matched).toBe('A')
    expect(listener).toHaveBeenCalledTimes(1)

    // 毎フレーム同じ値で呼ばれても通知ゼロ（React 再レンダリングが起きない）
    setMatched('A')
    setMatched('A')
    expect(listener).toHaveBeenCalledTimes(1)

    setMatched(null)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('setProjection も同値なら no-op', () => {
    const listener = vi.fn()
    const unsubscribe = useViewerStore.subscribe(listener)
    const { setProjection } = useViewerStore.getState()

    setProjection('perspective') // 初期値と同じ
    expect(listener).toHaveBeenCalledTimes(0)
    setProjection('orthographic')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('requestSnap は同じ視点の連打でも毎回新しい要求として発火する', () => {
    const { requestSnap } = useViewerStore.getState()
    requestSnap('side')
    const first = useViewerStore.getState().snapRequest
    expect(first).toEqual({ view: 'side', seq: 1 })

    requestSnap('side')
    const second = useViewerStore.getState().snapRequest
    expect(second).toEqual({ view: 'side', seq: 2 })
    // 参照同一性が変わる — CameraRig はこれで再スナップを検知する
    expect(second).not.toBe(first)
  })
})
