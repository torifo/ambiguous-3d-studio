/**
 * 3D ビューポート（Task 5.1 / FR-020 / NFR-002）。
 *
 * R3F の Canvas・ライティング・グリッド床・メッシュ・カメラリグを合成する。
 * `App.tsx` の `ViewportSlot` を置き換える結合面で、受け取るのは
 * `geometryRef`（`GeometryRef`）ただ 1 つ（ADR-004: ジオメトリは React state
 * ではなく ref で渡る。読み直しタイミングの購読は `SolidMesh` が持つ）。
 *
 * OrbitControls は `CameraRig` が所有する（Task 5.1 + 5.4 の統合実装）。
 * 投影切替（透視 ⇄ 正射影）でカメラを差し替えるとき、コントロールを
 * ここに置くとカメラとコントロールの生存期間が食い違うため、カメラを
 * 管理する側にまとめてある。視点スナップは `useViewerStore.requestSnap`
 * （scene/SweetSpot.ts）経由で UI から要求する。
 *
 * このコンポーネント自体は store を購読しない — カメラ操作中に再レンダリング
 * される要素は Canvas 以下に存在せず、毎フレームの仕事はすべて `useFrame`
 * （CameraRig）と GPU に閉じる（NFR-002: 60fps）。
 *
 * ## キーボードとタッチ（Task 7.1 / FR-026 / FR-027）
 *
 * Canvas を `role="application"` の**フォーカス可能な枠**で包む：
 *
 * - キーボードのズーム（FR-027「キーボードで…ズームを操作可能にする」）。
 *   OrbitControls は `listenToKeyEvents()` を呼ばない限りキー入力を受け取らず、
 *   受け取ってもキーに割り当てられるのはパン / 回転でズームは無い。そこで
 *   `+` / `-` を canvas への `wheel` イベントに翻訳して、OrbitControls 本来の
 *   ドリー処理（透視は距離、正射影は zoom）をそのまま通す。ここで独自に
 *   カメラを動かすと、CameraRig が持つ投影切替・慣性・スナップと二重管理になる
 * - 1 本指ドラッグでページをスクロールさせない（FR-026）。canvas 自体は
 *   OrbitControls が `touch-action: none` を立てるが、枠にも `touch-none` を
 *   置き、canvas の外側（レイアウト上の余白）で始まったドラッグも拾わせない
 */
import { useCallback, type KeyboardEvent } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import type { GeometryRef } from '../studio/useGenerationPipeline'
import { CameraRig } from './CameraRig'
import { publishLiveAngles, SNAP_VIEWS } from './SweetSpot'
import { SolidMesh } from './SolidMesh'
import { VirtualMirror } from './VirtualMirror'

export interface ViewportProps {
  /** 生成パイプライン（useGenerationPipeline）が公開するジオメトリ参照 */
  geometryRef: GeometryRef
}

/** 初期カメラの原点距離。俯瞰（iso）方向に置く（FR-006「視点をリセット」と同じ構図） */
const INITIAL_RADIUS = 5

/**
 * Canvas の camera 設定。**モジュール定数**にして参照を固定する —
 * 毎レンダーで新しいオブジェクトを渡すと R3F が既定カメラへ props を
 * 再適用し、スナップやズームで動かした位置が巻き戻る事故につながる。
 * fov・near・far の実値は CameraRig が実行時に camera から読むため、
 * ここ以外に複製はない。
 */
const CAMERA_PROPS = {
  position: [
    SNAP_VIEWS.iso.direction.x * INITIAL_RADIUS,
    SNAP_VIEWS.iso.direction.y * INITIAL_RADIUS,
    SNAP_VIEWS.iso.direction.z * INITIAL_RADIUS,
  ] as [number, number, number],
  fov: 40,
  near: 0.1,
  far: 200,
}

/** dpr の上限。Retina で 3x まで描くと 60fps 予算（NFR-002）を圧迫する */
const DPR_RANGE: [number, number] = [1, 2]

/**
 * キーボードのズーム 1 回分に相当するホイール移動量（px 相当）。
 * OrbitControls の `_getZoomScale` は `0.95^(zoomSpeed * |deltaY| * 0.01)`
 * なので、200 で 1 打鍵あたり約 9% 拡縮になる。
 */
const KEY_ZOOM_DELTA = 200

/**
 * 角度差の連続表示（FR-021）を毎フレーム UI へ流すだけの部品。
 *
 * CameraRig の `useFrame` が `sweetSpotLiveAngles` を更新したあと、同じ
 * R3F のフレームループ（同一の rAF）でその値を購読者へ渡す。React state を
 * 一切通らないので、カメラを動かしても再レンダリングは 1 回も起きない
 * （NFR-002）。`<CameraRig/>` の**後ろ**に置くこと — useFrame の購読は
 * 同一優先度ならマウント順に実行されるため、同じフレームの最新値が流れる。
 */
function SweetSpotReadout(): null {
  useFrame(() => {
    publishLiveAngles()
  })
  return null
}

/**
 * 3D ビューポート本体。`<Viewport geometryRef={geometryRef} />` として
 * App.tsx の `ViewportSlot` と差し替える（結線は Wave 5 の統合時）。
 */
export function Viewport(props: ViewportProps) {
  /**
   * `+` / `-` を canvas への wheel イベントに翻訳する（FR-027）。
   * OrbitControls は wheel を `{ passive: false }` で canvas に直接
   * 購読しているため、canvas 上で dispatch すればドリー処理に入る。
   */
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const zoomIn = event.key === '+' || event.key === '='
    const zoomOut = event.key === '-' || event.key === '_'
    if (!zoomIn && !zoomOut) return
    const canvas = event.currentTarget.querySelector('canvas')
    if (canvas === null) return
    event.preventDefault()
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: zoomIn ? -KEY_ZOOM_DELTA : KEY_ZOOM_DELTA,
        deltaMode: 0,
        cancelable: true,
      }),
    )
  }, [])

  return (
    <div
      role="application"
      aria-label="3D ビュー（カメラ操作）"
      aria-describedby="viewport-keys"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative h-full w-full touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-400"
    >
      {/* キーボード操作の説明。視覚的には隠すが、フォーカス時に読み上げられる。
          視点スナップ / リセットはサイドバーのボタンから到達する（FR-027） */}
      <p id="viewport-keys" className="sr-only">
        ドラッグで回転、ホイールまたは ＋ / − キーでズームします。視点のスナップとリセットはサイドバーのボタンから操作できます。
      </p>
      <Canvas camera={CAMERA_PROPS} dpr={DPR_RANGE} gl={{ antialias: true }}>
        <color attach="background" args={['#0a0a0a']} />
        {/* 三点照明の簡易形。強い影は付けない（シルエットの視認を優先） */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 6, 3]} intensity={1.1} />
        <directionalLight position={[-5, 2, -2]} intensity={0.35} />
        {/* グリッド床。立体は原点中心・高さ 2（WORKING_HEIGHT）なので
            最小 Y (=-1) の少し下に敷く（Z-fighting と正面ビューの重なり回避） */}
        <Grid
          position={[0, -1.15, 0]}
          cellSize={0.5}
          cellThickness={0.6}
          cellColor="#33333c"
          sectionSize={2}
          sectionThickness={1}
          sectionColor="#4a4f60"
          fadeDistance={28}
          fadeStrength={1}
          infiniteGrid
        />
        <SolidMesh geometryRef={props.geometryRef} />
        {/* 仮想ミラー（Task 6.3 / FR-024）。有効/無効のゲート（store の
            virtualMirror 購読）と反射ターゲットの解放は VirtualMirror 側が
            持つ — Viewport は store を購読しない、という冒頭の不変条件を保つ */}
        <VirtualMirror />
        <CameraRig />
        <SweetSpotReadout />
      </Canvas>
    </div>
  )
}
