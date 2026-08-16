/**
 * カメラリグ（Task 5.4 / FR-020〜FR-023 / NFR-002）。
 *
 * 責務：
 * - **OrbitControls（減衰付き）の生成と保持**（FR-020）。drei のラッパーではなく
 *   three の実装を直接使う — 投影切替でカメラを差し替えるとき、ラッパーだと
 *   コントロールごと再生成されてドラッグ・ターゲット・慣性が失われるため、
 *   同一インスタンスの `controls.object` だけを差し替える
 * - **視点スナップ**（front / side / iso。400ms イージング、FR-022）。
 *   `useViewerStore.requestSnap` が UI からの唯一の入口。
 *   `prefers-reduced-motion` では遷移せず即時切替（FR-027）
 * - **スナップ完了時の正射影切替**（FR-023）。錯視の「正解」は正射影でのみ
 *   厳密（透視ではシルエットが一致しない）。遷移中に投影を切り替えると視野が
 *   飛ぶため**完了後**に切り替え、`SweetSpot.ts` のサイズ一致計算で見かけの
 *   大きさを保つ。正射影中に視線が閾値（3.5°）を超えて逸れたら自由探索と
 *   みなして透視へ戻す（こちらもサイズ一致）
 * - **Sweet Spot 判定**（FR-021）。`useFrame` 内で毎フレーム角度差を計算し、
 *   store へは**判定値が変化したフレームのみ**書く（NFR-002 / ADR-004）。
 *   連続量は `sweetSpotLiveAngles` のミューテートのみで公開する
 *
 * ## 側面カメラは +X（design.md「2.1 軸の割り当てとカメラ規約」— 拘束）
 *
 * B の角柱は `rotate([0,90,0])` で局所 +X が world −Z に載る。+X カメラ
 * （up=+Y）の画面右は world −Z なので B は正立する。−X に置くと B だけ
 * 左右反転し、CSG 側の回帰テストでは検出できない。方向の定数は
 * `SweetSpot.ts` の `SNAP_VIEWS` / `VIEW_FORWARDS` に集約してある。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  angleBetween,
  easeInOutCubic,
  matchedSweetSpot,
  orthoZoomToMatchPerspective,
  perspectiveDistanceToMatchOrtho,
  slerpDirection,
  SNAP_VIEWS,
  SWEET_SPOT_THRESHOLD_RAD,
  sweetSpotLiveAngles,
  useViewerStore,
  VIEW_FORWARDS,
  type SnapView,
  type SweetSpotView,
  type Vec3Like,
} from './SweetSpot'

/** スナップ遷移の所要時間（FR-022: 400ms 以内） */
const SNAP_DURATION_SEC = 0.4
/**
 * 正射影カメラの基準半高（無次元）。可視サイズは常に zoom で合わせるため
 * 値自体に意味はないが、SweetSpot.ts のサイズ一致計算と同じ値を渡すこと。
 */
const ORTHO_HALF_HEIGHT = 1
/** スナップ後のカメラ距離の許容範囲（近すぎ・遠すぎの暴走を防ぐ） */
const MIN_SNAP_RADIUS = 2
const MAX_SNAP_RADIUS = 30

/** 進行中のスナップ遷移。null なら自由操作中 */
interface ActiveTween {
  view: SnapView
  fromDir: Vec3Like
  toDir: Vec3Like
  fromTarget: Vector3
  radius: number
  /** 最初のフレームで clock から充填する（マウント直後のジャンプ防止） */
  start: number | null
  duration: number
}

/** 原点（スナップ視点の注視点）。読み取り専用として扱うこと */
const ORIGIN = new Vector3(0, 0, 0)
/** 毎フレームの一時ベクトル（アロケーション回避。リグは 1 個しか置かない） */
const TMP_FORWARD = new Vector3()
const TMP_DIR = new Vector3()

/** OS の「視差効果を減らす」設定。スナップ時に都度評価する（FR-027） */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * OrbitControls の残留慣性（sphericalDelta / panOffset）を即時消化して
 * ゼロに戻す。damping を一時的に切って update() すると three の実装は
 * 差分を全量適用したうえで内部デルタをクリアする。
 *
 * スナップ開始時にこれを呼ばないと、直前のドラッグの慣性が遷移中も内部に
 * 凍結されたまま残り、遷移完了後の最初の update() でカメラがスナップ先から
 * 弾き飛ばされる（→ 正射影の離脱判定が即発動して透視へ戻る、という
 * 「スナップが効かない」誤動作になる）。
 */
function flushInertia(controls: OrbitControls): void {
  const damped = controls.enableDamping
  controls.enableDamping = false
  controls.update()
  controls.enableDamping = damped
}

/**
 * カメラリグ本体。`<Viewport>` の Canvas 直下に 1 つだけ置く。
 * 何も描画しない（null を返す）が、OrbitControls・スナップ遷移・投影切替・
 * Sweet Spot 判定のすべてを所有する。
 */
export function CameraRig(): null {
  const gl = useThree((s) => s.gl)
  const get = useThree((s) => s.get)
  const set = useThree((s) => s.set)
  const size = useThree((s) => s.size)

  const controlsRef = useRef<OrbitControls | null>(null)
  /** Canvas が作った既定の透視カメラ（自由探索用）。マウント時に捕捉する */
  const perspRef = useRef<PerspectiveCamera | null>(null)
  /** 正射影カメラ（スナップ視点用）。フラスタムは自前管理（manual） */
  const orthoRef = useRef<OrthographicCamera | null>(null)
  const draggingRef = useRef(false)
  /** 正射影で表示中のスナップ視点。透視中は null */
  const snappedViewRef = useRef<SnapView | null>(null)
  /** 前フレームの合致判定。変化したフレームだけ store に書く（NFR-002） */
  const lastMatchedRef = useRef<SweetSpotView | null>(null)
  const tweenRef = useRef<ActiveTween | null>(null)

  if (orthoRef.current === null) {
    const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.01, 200)
    ortho.up.set(0, 1, 0)
    // R3F はリサイズ時に既定カメラのフラスタムをピクセル基準で書き換える。
    // ここでは半高 ORTHO_HALF_HEIGHT 基準で自前管理するため manual を立てる
    Object.assign(ortho, { manual: true })
    orthoRef.current = ortho
  }

  /**
   * 正射影 → 透視（自由探索へ復帰）。見かけサイズを保つ距離
   * （`perspectiveDistanceToMatchOrtho`）に透視カメラを置き直すので、
   * 正射影中のズーム操作（zoom 変化）も距離として引き継がれる。
   */
  const switchToPerspective = useCallback((): PerspectiveCamera | null => {
    const persp = perspRef.current
    const ortho = orthoRef.current
    const controls = controlsRef.current
    if (persp === null || ortho === null || controls === null) return null
    const st = get()
    if (st.camera !== ortho) return persp // すでに透視

    const distance = perspectiveDistanceToMatchOrtho(
      ORTHO_HALF_HEIGHT,
      persp.fov,
      Math.max(ortho.zoom, 1e-6),
    )
    TMP_DIR.copy(ortho.position).sub(controls.target)
    if (TMP_DIR.lengthSq() < 1e-12) {
      const iso = SNAP_VIEWS.iso.direction
      TMP_DIR.set(iso.x, iso.y, iso.z)
    }
    TMP_DIR.normalize()
    persp.position.copy(controls.target).addScaledVector(TMP_DIR, distance)
    persp.up.set(0, 1, 0)
    persp.aspect = st.size.width / Math.max(st.size.height, 1)
    persp.updateProjectionMatrix()
    persp.lookAt(controls.target)
    controls.object = persp
    controls.update()
    set({ camera: persp })
    snappedViewRef.current = null
    useViewerStore.getState().setProjection('perspective')
    return persp
  }, [get, set])

  /**
   * 透視 → 正射影（スナップ完了時。FR-023）。切替の瞬間に画面上の見かけ
   * サイズが変わらないよう、現在距離から zoom を解く（design.md
   * 「投影の切り替え」）。位置・姿勢は透視カメラをそのまま引き継ぐ。
   */
  const switchToOrthographic = useCallback(
    (view: SnapView): void => {
      const persp = perspRef.current
      const ortho = orthoRef.current
      const controls = controlsRef.current
      if (persp === null || ortho === null || controls === null) return
      const st = get()

      const distance = Math.max(persp.position.distanceTo(controls.target), 1e-3)
      ortho.zoom = orthoZoomToMatchPerspective(ORTHO_HALF_HEIGHT, persp.fov, distance)
      const aspect = st.size.width / Math.max(st.size.height, 1)
      ortho.left = -ORTHO_HALF_HEIGHT * aspect
      ortho.right = ORTHO_HALF_HEIGHT * aspect
      ortho.top = ORTHO_HALF_HEIGHT
      ortho.bottom = -ORTHO_HALF_HEIGHT
      ortho.position.copy(persp.position)
      ortho.up.set(0, 1, 0)
      ortho.updateProjectionMatrix()
      ortho.lookAt(controls.target)
      controls.object = ortho
      controls.update()
      set({ camera: ortho })
      snappedViewRef.current = view
      useViewerStore.getState().setProjection('orthographic')
    },
    [get, set],
  )

  /** スナップ遷移の終端処理。front / side のみ正射影へ切り替える */
  const finalizeSnap = useCallback(
    (view: SnapView): void => {
      if (SNAP_VIEWS[view].projection === 'orthographic') {
        switchToOrthographic(view)
      } else {
        snappedViewRef.current = null
        useViewerStore.getState().setProjection('perspective')
      }
    },
    [switchToOrthographic],
  )

  /**
   * スナップ開始（FR-022）。正射影中なら（サイズを保って）透視へ戻してから
   * 透視のまま遷移し、完了時に finalizeSnap が投影を確定する。距離は現在の
   * 原点距離を維持する（スナップでズームが飛ばないように）。
   */
  const beginSnap = useCallback(
    (view: SnapView): void => {
      const controls = controlsRef.current
      if (controls === null) return
      // 直前のドラッグの慣性をここで確定させる（凍結したまま持ち越すと
      // 遷移完了後の update() でスナップ先から弾かれる）
      flushInertia(controls)
      const current = get().camera
      const camera = (current as OrthographicCamera).isOrthographicCamera
        ? switchToPerspective()
        : (current as PerspectiveCamera)
      if (camera === null || !camera.isPerspectiveCamera) return

      const spec = SNAP_VIEWS[view]
      const radius = clamp(
        camera.position.distanceTo(ORIGIN),
        MIN_SNAP_RADIUS,
        MAX_SNAP_RADIUS,
      )

      if (prefersReducedMotion()) {
        // FR-027: 遷移アニメーションを行わず即時切替
        tweenRef.current = null
        camera.position
          .set(spec.direction.x, spec.direction.y, spec.direction.z)
          .multiplyScalar(radius)
        controls.target.set(0, 0, 0)
        camera.up.set(0, 1, 0)
        camera.lookAt(ORIGIN)
        controls.enabled = true
        controls.update()
        finalizeSnap(view)
        return
      }

      TMP_DIR.copy(camera.position).sub(ORIGIN)
      const fromDir: Vec3Like =
        TMP_DIR.lengthSq() < 1e-12
          ? SNAP_VIEWS.iso.direction
          : { x: TMP_DIR.x, y: TMP_DIR.y, z: TMP_DIR.z }
      tweenRef.current = {
        view,
        fromDir,
        toDir: spec.direction,
        fromTarget: controls.target.clone(),
        radius,
        start: null,
        duration: SNAP_DURATION_SEC,
      }
      // 遷移中はユーザー操作を受け付けない（tween とコントロールの取り合い防止）
      draggingRef.current = false
      controls.enabled = false
    },
    [finalizeSnap, get, switchToPerspective],
  )

  // OrbitControls の生成（FR-020: 減衰付きの回転・パン・ズーム）
  useEffect(() => {
    const camera = get().camera
    if (perspRef.current === null && (camera as PerspectiveCamera).isPerspectiveCamera) {
      perspRef.current = camera as PerspectiveCamera
    }
    const controls = new OrbitControls(camera, gl.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 1.5
    controls.maxDistance = 40
    controls.minZoom = 0.2
    controls.maxZoom = 40
    controls.target.set(0, 0, 0)
    controls.update()
    const onStart = (): void => {
      draggingRef.current = true
    }
    const onEnd = (): void => {
      draggingRef.current = false
    }
    controls.addEventListener('start', onStart)
    controls.addEventListener('end', onEnd)
    controlsRef.current = controls
    return () => {
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('end', onEnd)
      controls.dispose()
      controlsRef.current = null
    }
  }, [get, gl])

  // リサイズ：両カメラのフラスタムを半高基準で追従させる。
  // （R3F が自動更新するのは「現在の既定カメラ」だけなので、非アクティブ側も
  // ここで揃えておかないと切替の瞬間に古いアスペクトが露出する）
  useEffect(() => {
    const aspect = size.width / Math.max(size.height, 1)
    const ortho = orthoRef.current
    if (ortho !== null) {
      ortho.left = -ORTHO_HALF_HEIGHT * aspect
      ortho.right = ORTHO_HALF_HEIGHT * aspect
      ortho.top = ORTHO_HALF_HEIGHT
      ortho.bottom = -ORTHO_HALF_HEIGHT
      ortho.updateProjectionMatrix()
    }
    const persp = perspRef.current
    if (persp !== null) {
      persp.aspect = aspect
      persp.updateProjectionMatrix()
    }
  }, [size])

  // スナップ要求の購読（UI からの seam）。zustand の transient subscribe なので
  // 要求が来ても React の再レンダリングは発生しない
  useEffect(
    () =>
      useViewerStore.subscribe((state, prev) => {
        if (state.snapRequest !== null && state.snapRequest !== prev.snapRequest) {
          beginSnap(state.snapRequest.view)
        }
      }),
    [beginSnap],
  )

  useFrame((state) => {
    const controls = controlsRef.current
    if (controls === null) return

    // --- 1. スナップ遷移 or 通常の減衰更新 ---
    const tween = tweenRef.current
    if (tween !== null) {
      const camera = state.camera
      if (tween.start === null) tween.start = state.clock.elapsedTime
      const t = Math.min((state.clock.elapsedTime - tween.start) / tween.duration, 1)
      const k = easeInOutCubic(t)
      const dir = slerpDirection(tween.fromDir, tween.toDir, k)
      camera.position.set(
        dir.x * tween.radius,
        dir.y * tween.radius,
        dir.z * tween.radius,
      )
      controls.target.lerpVectors(tween.fromTarget, ORIGIN, k)
      camera.up.set(0, 1, 0)
      camera.lookAt(controls.target)
      if (t >= 1) {
        tweenRef.current = null
        controls.enabled = true
        controls.update()
        finalizeSnap(tween.view)
      }
    } else {
      controls.update() // 減衰（慣性）はここで進む
    }

    // --- 2. Sweet Spot 角度（毎フレーム計算、公開はミューテートのみ） ---
    // finalizeSnap でカメラが切り替わった可能性があるため読み直す
    const activeCamera = get().camera
    activeCamera.getWorldDirection(TMP_FORWARD)
    sweetSpotLiveAngles.a = angleBetween(TMP_FORWARD, VIEW_FORWARDS.A)
    sweetSpotLiveAngles.b = angleBetween(TMP_FORWARD, VIEW_FORWARDS.B)

    // --- 3. 正射影からの離脱判定 ---
    // スナップ視点から 3.5° を超えて逸れたら自由探索へ（透視に戻す）。
    // ドラッグ中の切替はカメラ差し替えで操作が切れるので、指を離したあと
    // （慣性中を含む）だけ判定する
    const snapped = snappedViewRef.current
    if (
      tweenRef.current === null &&
      snapped !== null &&
      activeCamera === orthoRef.current &&
      !draggingRef.current
    ) {
      const sweet = SNAP_VIEWS[snapped].sweetSpot
      const angle = sweet === 'A' ? sweetSpotLiveAngles.a : sweetSpotLiveAngles.b
      if (sweet !== null && angle > SWEET_SPOT_THRESHOLD_RAD) {
        switchToPerspective()
      }
    }

    // --- 4. 合致判定の store 書き込み（変化したフレームのみ。NFR-002） ---
    const matched = matchedSweetSpot(TMP_FORWARD)
    if (matched !== lastMatchedRef.current) {
      lastMatchedRef.current = matched
      useViewerStore.getState().setMatched(matched)
    }
  })

  return null
}
