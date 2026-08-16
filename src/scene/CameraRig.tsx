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
 * - **Sweet Spot 判定**（FR-021 / FR-102）。`useFrame` 内で毎フレーム角度差を
 *   計算し、store へは**判定値が変化したフレームのみ**書く（NFR-002 /
 *   ADR-004）。連続量は `sweetSpotLiveAngles` のミューテートのみで公開する。
 *   B の判定は `useStudioStore` の現在の `axisAngleDeg` を毎フレーム読んで
 *   反映する（購読ではなく `getState()` — 値の変化では再レンダリングしない）
 *
 * ## 側面カメラは軸角に従う（design.md「2.1 軸の割り当てとカメラ規約」の一般化）
 *
 * B の角柱は `rotate([0, axisAngleDeg, 0])` で押し出され、局所 +X は world
 * `(cos φ, 0, −sin φ)` に載る（φ = axisAngleDeg）。カメラは常に押し出し軸
 * そのものの向き `(sin φ, 0, cos φ)` に置く — 既定 90° では従来どおり +X。
 * 逆側に置くと B だけ左右反転し、CSG 側の回帰テストでは検出できない。
 * 視点 C（top スナップ）は常に +Y・up=(0,0,−1) で軸角に依存しない。
 * 方向の導出は `SweetSpot.ts` の `snapDirection` / `snapUp` / `viewForward`
 * に集約してある（実体は `worker/protocol.ts` の `viewpointCamera`）。
 *
 * ## カメラは演出されたシーケンス、常時自由回転ではない
 *
 * 「常に回転できるとすぐにネタバラシになる」— 自由にドラッグできると、
 * 最初に見えるのは錯視の「正解」ではなく、いびつな立体そのもの（種明かし）
 * になってしまう。カタログ（既定モード）は次の順序を強制する：
 *
 * 1. 選んだ瞬間に視点 A へスナップする（`useStudioStore` の
 *    `generationEpoch` を購読し、`curatedMode` 中の入力変更で
 *    `requestSnap('front')` を自動発行する）
 * 2. 視点 B は鏡（有効なら）かスナップで見せる —自由回転はまだ許さない
 * 3. 「仕組みを見る」で初めて自由回転（`rotationLocked` を外す）を許可する。
 *    戻るボタン（「錯視に戻る」）で視点 A ＋ロックへ一手で戻れる
 *
 * `rotationLocked` は `useViewerStore` の状態（scene/SweetSpot.ts）。
 * ロックは **OrbitControls を実際に `enabled = false` にする**（イベントを
 * 握りつぶすだけではない）。ロック・アンロックの境界は `flushInertia` を
 * 通す — 直前のドラッグ慣性を凍結したまま次の状態に持ち込むと、
 * 再度 `update()` したときにカメラが弾き飛ばされる事故になる
 * （既存のスナップ開始時と同じ理由）。ロック中でも `requestSnap` 経由の
 * プログラム的な遷移（スナップ・仕組みを見る時の視点復帰）は常に効く —
 * ロックが止めるのはユーザーのポインタ入力だけ。
 *
 * `curatedMode`（「演出モードにいるか」）は App.tsx / Gallery.tsx を編集
 * せずにモード連動を実現するための設計 — このタスクの所有範囲外の 2
 * ファイルに手を入れず、ui/Sidebar.tsx（自由モード）と ui/PuzzlePanel.tsx
 * （クイズ）の**マウント／アンマウント**を唯一の観測点にする。どちらも
 * マウント時に `curatedMode: false` ・アンマウント時に `curatedMode: true`
 * を書き戻すので、カタログ（どちらもマウントしないモード）は自動的に
 * 演出モードのままになる。自由モード・クイズは「隠すものがない」
 * （自由モード）・「調べることそのものがパズル」（クイズ）という理由で
 * 両方ともマウント時に `rotationLocked: false` にする —
 * クイズの A/B スナップ封鎖は PuzzlePanel.tsx 側（スナップ UI を出さない）
 * で既に達成済みで、ここでの二重対応は不要（ロックは自由回転だけを扱う）。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useStudioStore } from '../store/useStudioStore'
import {
  angleBetween,
  easeInOutCubic,
  frontMirrorFramingZoom,
  matchedSweetSpot,
  orthoZoomToMatchPerspective,
  perspectiveDistanceToMatchOrtho,
  slerpDirection,
  snapDirection,
  snapUp,
  SNAP_VIEWS,
  SWEET_SPOT_THRESHOLD_RAD,
  sweetSpotLiveAngles,
  useViewerStore,
  viewForward,
  VIEW_FORWARDS,
  type SnapView,
  type SweetSpotView,
  type Vec3Like,
} from './SweetSpot'
import { mirrorFrameExtent, selectVirtualMirrorEnabled } from './VirtualMirror'

/** サイドバーのボタンと揃えた見た目（44px 以上のタップ領域 + 可視フォーカス） */
const OVERLAY_BUTTON_CLASS =
  'min-h-11 rounded border border-neutral-600 bg-neutral-900/90 px-3 text-xs text-neutral-200 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

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
  /**
   * 遷移先の up ベクトル（`snapUp(view)`）。遷移開始時に確定し、tween 中は
   * 一定に保つ。top（視点 C）だけ (0,0,−1) — 遷移の最終フレームで direction
   * が (0,1,0) に達したとき up が (0,1,0) のままだと lookAt が退化するため、
   * 遷移全体であらかじめ正しい up を使う（SweetSpot.ts の `snapUp` を参照）
   */
  toUp: Vec3Like
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
 * `useViewerStore` の `rotationLocked` を `controls.enabled` へ反映する。
 * **tween の実行中は呼ばないこと** — tween は自前で `controls.enabled = false`
 * を管理する（プログラム的な遷移とユーザードラッグの取り合いを防ぐため）。
 * ロックは「自由なドラッグ探索を禁止する」ことが目的で、`requestSnap` 経由の
 * 遷移はロック中でも常に効く（この関数が呼ばれるのは遷移の**外側**でだけ）。
 */
function applyRotationLock(controls: OrbitControls): void {
  controls.enabled = !useViewerStore.getState().rotationLocked
}

/**
 * カメラリグ本体。`<Viewport>` の Canvas 直下に 1 つだけ置く。
 * OrbitControls・スナップ遷移・投影切替・Sweet Spot 判定のすべてを所有する。
 * 描画するのは「仕組みを見る／錯視に戻る」オーバーレイ（drei `Html`）だけ —
 * `curatedMode` のときだけ表示する、ビューポート右下の小さな操作群。
 * `curatedMode` / `rotationLocked` の読み出しは購読（`useViewerStore`）で
 * 行う — この 2 値は離散的なモード・ボタン操作でしか変わらないため、
 * 変化時の再レンダリングは NFR-002（毎フレームの再レンダリング回避）に
 * 抵触しない（抵触するのは連続量である角度差の類だけ）。
 */
export function CameraRig() {
  const gl = useThree((s) => s.gl)
  const get = useThree((s) => s.get)
  const set = useThree((s) => s.set)
  const size = useThree((s) => s.size)
  const curatedMode = useViewerStore((s) => s.curatedMode)
  const rotationLocked = useViewerStore((s) => s.rotationLocked)

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
   *
   * **視点 A（front）でミラーが有効なときだけ**、この見かけサイズ一致の
   * zoom をさらに広げる（レビュー Finding 1）。ミラーは装飾ではなく錯視の
   * 成立機構そのものなので、A の構図は立体とミラーの反射面を両方画角に
   * 収めて初めて意味を持つ — 直前の透視カメラがどれだけズームしていたかに
   * 依存する見かけサイズ一致だけでは、ミラーがビューポート外に落ちうる
   * （実際の不具合の症状）。`frontMirrorFramingZoom`（SweetSpot.ts）が
   * 純関数として計算し、ここは軸角・オフセット・ミラーの実配置
   * （`mirrorFrameExtent`。VirtualMirror.tsx）を橋渡しするだけ。
   * side / top / iso とミラー無効時は 1 ビットも変えない。
   */
  const switchToOrthographic = useCallback(
    (view: SnapView): void => {
      const persp = perspRef.current
      const ortho = orthoRef.current
      const controls = controlsRef.current
      if (persp === null || ortho === null || controls === null) return
      const st = get()

      const distance = Math.max(persp.position.distanceTo(controls.target), 1e-3)
      let zoom = orthoZoomToMatchPerspective(ORTHO_HALF_HEIGHT, persp.fov, distance)
      const aspect = st.size.width / Math.max(st.size.height, 1)

      if (view === 'front' && selectVirtualMirrorEnabled(useStudioStore.getState())) {
        const { input, options } = useStudioStore.getState()
        const mirror = mirrorFrameExtent(input.axisAngleDeg, options.mirrorOffset)
        zoom = frontMirrorFramingZoom(
          zoom,
          aspect,
          ORTHO_HALF_HEIGHT,
          [mirror.minX, mirror.maxX],
          [mirror.minY, mirror.maxY],
        )
      }

      ortho.zoom = zoom
      ortho.left = -ORTHO_HALF_HEIGHT * aspect
      ortho.right = ORTHO_HALF_HEIGHT * aspect
      ortho.top = ORTHO_HALF_HEIGHT
      ortho.bottom = -ORTHO_HALF_HEIGHT
      ortho.position.copy(persp.position)
      const up = snapUp(view)
      ortho.up.set(up.x, up.y, up.z)
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

  /** スナップ遷移の終端処理。front / side / top のみ正射影へ切り替える */
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

      // FR-102: side の実際のスナップ方向は現在の軸角に従う（既定 90° は
      // 従来どおり +X）。read はここだけ — 購読しないので軸角変更それ自体は
      // 再レンダリングを起こさない
      const axisAngleDeg = useStudioStore.getState().input.axisAngleDeg
      const targetDirection = snapDirection(view, axisAngleDeg)
      const targetUp = snapUp(view)
      const radius = clamp(
        camera.position.distanceTo(ORIGIN),
        MIN_SNAP_RADIUS,
        MAX_SNAP_RADIUS,
      )

      if (prefersReducedMotion()) {
        // FR-027: 遷移アニメーションを行わず即時切替
        tweenRef.current = null
        camera.position
          .set(targetDirection.x, targetDirection.y, targetDirection.z)
          .multiplyScalar(radius)
        controls.target.set(0, 0, 0)
        camera.up.set(targetUp.x, targetUp.y, targetUp.z)
        camera.lookAt(ORIGIN)
        applyRotationLock(controls)
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
        toDir: targetDirection,
        toUp: targetUp,
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
    // 既定モード（カタログ）は curatedMode / rotationLocked ともに true で
    // 始まる（SweetSpot.ts の初期値）。マウント直後の 1 フレーム目から
    // ドラッグを禁止するため、ここで初期状態を反映する
    applyRotationLock(controls)
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

  // rotationLocked の購読。tween 実行中の付け外しと衝突しないよう、
  // tween が動いていないときだけ controls.enabled に反映する（tween 完了時の
  // 反映は useFrame 側の finalizeSnap 直前で行う。ここは「tween 外での
  // ロック切り替え」— 仕組みを見る／錯視に戻るボタン専用の経路）
  useEffect(
    () =>
      useViewerStore.subscribe((state, prev) => {
        if (state.rotationLocked === prev.rotationLocked) return
        const controls = controlsRef.current
        if (controls === null) return
        // ロック境界を跨ぐ前に残留慣性を確定させる（スナップ開始時と同じ理由 —
        // 凍結したデルタを次の update() まで持ち越すとカメラが弾き飛ばされる）
        flushInertia(controls)
        if (tweenRef.current === null) applyRotationLock(controls)
      }),
    [],
  )

  // カタログ選択の自動演出（FR: 「常に回転できるとすぐにネタバラシになる」）。
  // curatedMode 中の入力変更（= カタログ項目の選択。Gallery.tsx は
  // applyInput(entry.preset) を 1 トランザクションで呼ぶので、生成世代が
  // ちょうど 1 回進む）を検知して、視点 A への着地とロックの再確定を行う。
  // 自由モード（Sidebar.tsx）はここを経由せず個別セッターを呼ぶため
  // generationEpoch を進めず、クイズ（PuzzlePanel.tsx）は curatedMode を
  // 自ら false にしているのでこの分岐に入らない
  useEffect(
    () =>
      useStudioStore.subscribe((state, prev) => {
        if (state.generationEpoch === prev.generationEpoch) return
        if (!useViewerStore.getState().curatedMode) return
        useViewerStore.getState().setRotationLocked(true)
        beginSnap('front')
      }),
    [beginSnap],
  )

  useFrame((state) => {
    const controls = controlsRef.current
    if (controls === null) return

    // FR-102: 現在の軸角。購読ではなく getState() で読むので、値の変化は
    // このフレームの計算に反映されるだけで React 再レンダリングは起きない
    const axisAngleDeg = useStudioStore.getState().input.axisAngleDeg

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
      camera.up.set(tween.toUp.x, tween.toUp.y, tween.toUp.z)
      camera.lookAt(controls.target)
      if (t >= 1) {
        tweenRef.current = null
        applyRotationLock(controls)
        controls.update()
        finalizeSnap(tween.view)
      }
    } else {
      controls.update() // 減衰（慣性）はここで進む
    }

    // --- 2. Sweet Spot 角度（毎フレーム計算、公開はミューテートのみ） ---
    // finalizeSnap でカメラが切り替わった可能性があるため読み直す。
    // B は現在の axisAngleDeg に応じた実際の前方と比較する（FR-102）
    const activeCamera = get().camera
    activeCamera.getWorldDirection(TMP_FORWARD)
    sweetSpotLiveAngles.a = angleBetween(TMP_FORWARD, VIEW_FORWARDS.A)
    sweetSpotLiveAngles.b = angleBetween(TMP_FORWARD, viewForward('B', axisAngleDeg))
    sweetSpotLiveAngles.c = angleBetween(TMP_FORWARD, VIEW_FORWARDS.C)

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
      const angle =
        sweet === 'A'
          ? sweetSpotLiveAngles.a
          : sweet === 'B'
            ? sweetSpotLiveAngles.b
            : sweetSpotLiveAngles.c
      if (sweet !== null && angle > SWEET_SPOT_THRESHOLD_RAD) {
        switchToPerspective()
      }
    }

    // --- 4. 合致判定の store 書き込み（変化したフレームのみ。NFR-002） ---
    const matched = matchedSweetSpot(TMP_FORWARD, axisAngleDeg)
    if (matched !== lastMatchedRef.current) {
      lastMatchedRef.current = matched
      useViewerStore.getState().setMatched(matched)
    }
  })

  /** 「仕組みを見る」。curatedMode は保ったまま自由回転だけを解く */
  const handleReveal = useCallback((): void => {
    useViewerStore.getState().setRotationLocked(false)
  }, [])

  /** 「錯視に戻る」。ロックを戻し、視点 A へスナップし直す（一手で戻す） */
  const handleReturnToIllusion = useCallback((): void => {
    useViewerStore.getState().setRotationLocked(true)
    beginSnap('front')
  }, [beginSnap])

  if (!curatedMode) return null

  return (
    <Html fullscreen style={{ pointerEvents: 'none' }}>
      {/*
        カタログ（演出モード）専用のオーバーレイ。ビューポート右下、
        サイドバーのボタンと同じ見た目（44px タップ領域 + フォーカスリング）。
        ロック中は A / B スナップ ＋「仕組みを見る」、解除後は「錯視に戻る」
        だけを出す — 「戻る手段」を常に 1 手で提供する。
      */}
      <div
        className="absolute right-3 bottom-3 flex gap-1.5"
        style={{ pointerEvents: 'auto' }}
      >
        {rotationLocked ? (
          <>
            <button
              type="button"
              onClick={() => useViewerStore.getState().requestSnap('front')}
              title="+Z から正射影。シルエット A が成立する角度"
              className={OVERLAY_BUTTON_CLASS}
            >
              正面 (A)
            </button>
            <button
              type="button"
              onClick={() => useViewerStore.getState().requestSnap('side')}
              title="視点 B の軸方向から正射影。シルエット B が成立する角度"
              className={OVERLAY_BUTTON_CLASS}
            >
              側面 (B)
            </button>
            <button type="button" onClick={handleReveal} className={OVERLAY_BUTTON_CLASS}>
              仕組みを見る
            </button>
          </>
        ) : (
          <button type="button" onClick={handleReturnToIllusion} className={OVERLAY_BUTTON_CLASS}>
            錯視に戻る
          </button>
        )}
      </div>
    </Html>
  )
}
