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
 */
import { Canvas } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import type { GeometryRef } from '../studio/useGenerationPipeline'
import { CameraRig } from './CameraRig'
import { SNAP_VIEWS } from './SweetSpot'
import { SolidMesh } from './SolidMesh'

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
 * 3D ビューポート本体。`<Viewport geometryRef={geometryRef} />` として
 * App.tsx の `ViewportSlot` と差し替える（結線は Wave 5 の統合時）。
 */
export function Viewport(props: ViewportProps) {
  return (
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
      <CameraRig />
    </Canvas>
  )
}
