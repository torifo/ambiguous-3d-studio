/**
 * Sweet Spot 判定・視点規約・カメラ数学の純粋ロジック（Task 5.4 /
 * FR-020〜FR-023 / NFR-002 / design.md「Camera & Sweet Spot」）。
 *
 * このファイルは **DOM にも three にも依存しない**。`useFrame` 内で毎フレーム
 * 呼ばれる計算（角度差・イージング・球面補間・投影切替のサイズ合わせ）を
 * ベクトルを引数に取る純関数として置き、Node の Vitest だけで検証できるように
 * する（SweetSpot.test.ts）。コンポーネント（CameraRig.tsx）は three の
 * `Vector3` をそのまま渡す（構造的に {@link Vec3Like} 互換）。
 *
 * ## カメラ規約（design.md「2.1 軸の割り当てとカメラ規約」— 拘束事項）
 *
 * | 視点 | カメラ位置 | 前方ベクトル | up |
 * |---|---|---|---|
 * | A（正面） | **+Z 側** | (0, 0, −1) | +Y |
 * | B（側面） | **+X 側** | (−1, 0, 0) | +Y |
 *
 * B 用の角柱は +Z 押し出し後に Y 軸まわり +90° 回転（`(x,y,z) → (z,y,−x)`）
 * されるため、B の局所 +X は world **−Z** に載る。+X カメラ（up=+Y）の画面右は
 * `right = up × backward = (0,1,0) × (1,0,0) = (0,0,−1)` = world −Z なので
 * B の局所 +X と一致する。**カメラを −X に置くと画面右が world +Z になり、
 * B だけ左右反転する** — 寸法は合うため CSG 側のテストでは検出できず、
 * ここの定数がその規約の唯一の実装点になる。
 *
 * ## store への書き込みは「変化したフレームのみ」（NFR-002 / ADR-004）
 *
 * 毎フレーム store に書くと React の再レンダリングが連続発生し 60fps が
 * 崩れる。{@link useViewerStore} の `setMatched` / `setProjection` は
 * **値が変わらない呼び出しを no-op** にしてあり（購読者へ通知しない）、
 * CameraRig 側の前回値ガードと二重の防御になる。連続量（現在の角度差）は
 * store を経由せず {@link sweetSpotLiveAngles} を直接ミューテートする —
 * インジケーターの数値表示は DOM を rAF から直接更新する（design.md）。
 */
import { create } from 'zustand'

/** three の `Vector3` と構造互換の読み取り専用 3 次元ベクトル */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** シルエット合致の対象視点。A = 正面（+Z カメラ）/ B = 側面（+X カメラ） */
export type SweetSpotView = 'A' | 'B'

/** スナップ先。front / side は正射影へ切り替わる（FR-023）。iso は俯瞰 */
export type SnapView = 'front' | 'side' | 'iso'

/** 投影モード。自由探索 = perspective、視点 A/B スナップ中 = orthographic */
export type ProjectionMode = 'perspective' | 'orthographic'

/** Sweet Spot 閾値 3.5°（FR-021 / US-003。≈ 0.0611 rad） */
export const SWEET_SPOT_THRESHOLD_DEG = 3.5
export const SWEET_SPOT_THRESHOLD_RAD = (SWEET_SPOT_THRESHOLD_DEG * Math.PI) / 180

/**
 * 各視点の**カメラ前方ベクトル**（カメラ → 原点方向、単位ベクトル）。
 * A: +Z 側から原点を見る → (0,0,−1)。B: **+X 側**から原点を見る → (−1,0,0)。
 * `camera.getWorldDirection()` の戻り値とそのまま比較できる形で持つ。
 */
export const VIEW_FORWARDS: Record<SweetSpotView, Vec3Like> = {
  A: { x: 0, y: 0, z: -1 },
  B: { x: -1, y: 0, z: 0 },
}

/** スナップ視点の定義。direction は原点 → カメラ位置の単位ベクトル */
export interface SnapViewSpec {
  /** 原点からカメラ位置へ向かう単位ベクトル */
  direction: Vec3Like
  /** スナップ完了時に適用する投影（FR-023） */
  projection: ProjectionMode
  /** この視点が対応する Sweet Spot。iso は錯視の視点ではないので null */
  sweetSpot: SweetSpotView | null
}

const ISO_DIRECTION: Vec3Like = normalized({ x: 1, y: 0.7, z: 1 })

/**
 * スナップ視点の規約表。**side は +X**（−X に置くと B が鏡像になる —
 * ファイル冒頭のカメラ規約を参照）。front / side は完了時に正射影へ切り替え、
 * iso（俯瞰）は透視のまま。
 */
export const SNAP_VIEWS: Record<SnapView, SnapViewSpec> = {
  front: { direction: { x: 0, y: 0, z: 1 }, projection: 'orthographic', sweetSpot: 'A' },
  side: { direction: { x: 1, y: 0, z: 0 }, projection: 'orthographic', sweetSpot: 'B' },
  iso: { direction: ISO_DIRECTION, projection: 'perspective', sweetSpot: null },
}

const EPS = 1e-12

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalized(v: Vec3Like): Vec3Like {
  const len = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** 長さ 0 の縮退入力なら null を返す正規化 */
function tryNormalize(v: Vec3Like): Vec3Like | null {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len < EPS) return null
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function dotOf(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * 2 ベクトルのなす角（rad、0〜π）。入力の長さは問わない（内部で正規化）。
 * 長さ 0 の縮退入力は「一致しない」側に倒して π を返す — 壊れたカメラ状態が
 * 誤って Sweet Spot 合致になることを防ぐ。
 */
export function angleBetween(a: Vec3Like, b: Vec3Like): number {
  const na = tryNormalize(a)
  const nb = tryNormalize(b)
  if (na === null || nb === null) return Math.PI
  return Math.acos(clamp(dotOf(na, nb), -1, 1))
}

/**
 * カメラ前方ベクトルから合致中の Sweet Spot を返す（FR-021）。
 * 角度差が {@link SWEET_SPOT_THRESHOLD_RAD}（3.5°）**未満**で合致。
 * A と B は直交しているため同時合致はありえないが、関数としては
 * 角度差の小さい方を選ぶ全域定義にしてある。
 */
export function matchedSweetSpot(cameraForward: Vec3Like): SweetSpotView | null {
  const angleA = angleBetween(cameraForward, VIEW_FORWARDS.A)
  const angleB = angleBetween(cameraForward, VIEW_FORWARDS.B)
  const best: SweetSpotView = angleA <= angleB ? 'A' : 'B'
  const bestAngle = Math.min(angleA, angleB)
  return bestAngle < SWEET_SPOT_THRESHOLD_RAD ? best : null
}

/**
 * easeInOutCubic。`t` は 0〜1 に clamp される（400ms スナップ遷移の
 * イージング。FR-022）。
 */
export function easeInOutCubic(t: number): number {
  const k = clamp(t, 0, 1)
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
}

/**
 * 方向ベクトルの球面補間（スナップ遷移のカメラ軌道。FR-022）。
 * 一定角速度で `a` から `b` へ回り、戻り値は常に単位ベクトル。
 *
 * - `t` は 0〜1 に clamp
 * - 縮退入力（長さ 0）はもう一方へ倒す（両方縮退なら +Z）
 * - ほぼ反平行（経由平面が不定）の場合は `a` を直交方向へ僅かに逃がしてから
 *   補間する — NaN や零ベクトル正規化を発生させない
 */
export function slerpDirection(a: Vec3Like, b: Vec3Like, t: number): Vec3Like {
  const k = clamp(t, 0, 1)
  const na = tryNormalize(a)
  const nb = tryNormalize(b)
  if (na === null && nb === null) return { x: 0, y: 0, z: 1 }
  if (na === null) return nb as Vec3Like
  if (nb === null) return na

  let from = na
  let dot = clamp(dotOf(from, nb), -1, 1)
  if (dot < -0.9999) {
    // 反平行：任意の直交軸側へ 1e-3 だけ倒し、回転面を確定させる
    const ortho = orthogonalTo(from)
    from = normalized({
      x: from.x + ortho.x * 1e-3,
      y: from.y + ortho.y * 1e-3,
      z: from.z + ortho.z * 1e-3,
    })
    dot = clamp(dotOf(from, nb), -1, 1)
  }
  const theta = Math.acos(dot)
  if (theta < 1e-6) return nb
  const sinTheta = Math.sin(theta)
  const w1 = Math.sin((1 - k) * theta) / sinTheta
  const w2 = Math.sin(k * theta) / sinTheta
  return normalized({
    x: from.x * w1 + nb.x * w2,
    y: from.y * w1 + nb.y * w2,
    z: from.z * w1 + nb.z * w2,
  })
}

/** `v` に直交する単位ベクトルを 1 つ返す（反平行 slerp の逃がし先） */
function orthogonalTo(v: Vec3Like): Vec3Like {
  const ref: Vec3Like = Math.abs(v.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  return normalized({
    x: v.y * ref.z - v.z * ref.y,
    y: v.z * ref.x - v.x * ref.z,
    z: v.x * ref.y - v.y * ref.x,
  })
}

/**
 * 透視カメラが距離 `distance` の注視面で見せる**半分の高さ**（作業座標）。
 * `fovDeg` は three の `PerspectiveCamera.fov`（垂直視野角、度）。
 */
export function perspectiveHalfHeightAt(fovDeg: number, distance: number): number {
  return distance * Math.tan((fovDeg * Math.PI) / 360)
}

/**
 * 透視 → 正射影の切替で**見かけサイズを保つ** zoom（FR-023 /
 * design.md「投影の切り替え」）。正射影カメラの可視半高は
 * `orthoHalfHeight / zoom` なので、透視の可視半高
 * {@link perspectiveHalfHeightAt} と等置して解く。
 */
export function orthoZoomToMatchPerspective(
  orthoHalfHeight: number,
  fovDeg: number,
  distance: number,
): number {
  return orthoHalfHeight / perspectiveHalfHeightAt(fovDeg, distance)
}

/**
 * 正射影 → 透視へ戻すときに見かけサイズを保つ**カメラ距離**。
 * {@link orthoZoomToMatchPerspective} の逆関数（round-trip で距離が戻る）。
 * 正射影中のズーム操作（`camera.zoom` の変化）を距離に読み替える。
 */
export function perspectiveDistanceToMatchOrtho(
  orthoHalfHeight: number,
  fovDeg: number,
  zoom: number,
): number {
  return orthoHalfHeight / (zoom * Math.tan((fovDeg * Math.PI) / 360))
}

/**
 * 連続量（現在の角度差 rad）の**非リアクティブ**な公開点。CameraRig が
 * `useFrame` 内で毎フレーム ミューテートする。React の再レンダリングを
 * 起こさないので、インジケーターの数値表示はこれを rAF で読んで DOM を
 * 直接更新する（design.md「Sweet Spot 判定」）。初期値は π（不一致）。
 */
export const sweetSpotLiveAngles = { a: Math.PI, b: Math.PI }

/** UI からのスナップ要求。同じ視点の連打を区別するため単調な seq を持つ */
export interface SnapRequest {
  view: SnapView
  seq: number
}

/**
 * シーン（ビューア）状態の store。`useStudioStore`（src/store/ — Wave 5 では
 * 編集禁止）は生成パイプラインの状態機械専用で Sweet Spot のフィールドを
 * 持たないため、ビューア固有の**離散状態**はここで持つ。
 *
 * - `matched` / `projection`: CameraRig が**値の変化したフレームだけ**書く
 *   （actions 側でも同値を no-op にして二重にガード。NFR-002）
 * - `requestSnap`: UI（Task 5.2 のスナップボタン / Task 7.1 のキーボード）
 *   からの唯一の入口。CameraRig が購読して遷移を開始する（FR-022）
 */
export interface ViewerState {
  /** 現在合致中の Sweet Spot（FR-021）。UI のインジケーターが購読する */
  matched: SweetSpotView | null
  /** 現在の投影モード（FR-023） */
  projection: ProjectionMode
  /** 未消費のスナップ要求。CameraRig が参照同一性の変化で検知する */
  snapRequest: SnapRequest | null
  /** 視点スナップを要求する（front / side / iso）。連打も再発火する */
  requestSnap: (view: SnapView) => void
  /** 合致状態の書き込み。**同値なら no-op**（購読者へ通知しない） */
  setMatched: (view: SweetSpotView | null) => void
  /** 投影モードの書き込み。**同値なら no-op** */
  setProjection: (mode: ProjectionMode) => void
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  matched: null,
  projection: 'perspective',
  snapRequest: null,

  requestSnap: (view) =>
    set((s) => ({ snapRequest: { view, seq: (s.snapRequest?.seq ?? 0) + 1 } })),

  setMatched: (view) => {
    if (get().matched === view) return
    set({ matched: view })
  },

  setProjection: (mode) => {
    if (get().projection === mode) return
    set({ projection: mode })
  },
}))
