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
 * ## カメラ規約（design.md「2.1 軸の割り当てとカメラ規約」の一般化。
 * 唯一の幾何規約は `worker/protocol.ts` の {@link viewpointCamera} — ここは
 * それをベクトル演算の都合がよい {@link Vec3Like} 形へ橋渡しするだけ）
 *
 * | 視点 | カメラ位置の方向 | 前方ベクトル | up |
 * |---|---|---|---|
 * | A（正面） | **+Z 側**（固定） | (0, 0, −1) | +Y |
 * | B（側面） | `(sin φ, 0, cos φ)`（φ = axisAngleDeg。既定 90° で **+X 側**） | 位置の逆向き | +Y |
 * | C（上面） | **+Y 側**（固定。軸角に依存しない） | (0, −1, 0) | **(0, 0, −1)** |
 *
 * B の位置・前方は **axisAngleDeg に依存する**（FR-102）。既定 90° 以外を
 * 直交として扱うと、A↔B の実際の角度差とずれた Sweet Spot 判定になる
 * （45° なのに「B へ 90° ずれている」と表示される、など）。B 用の角柱は
 * 断面ローカル +Z を Y 軸まわり φ 回転して押し出すため、局所 +X は
 * world `(cos φ, 0, −sin φ)` に載る。カメラ位置 `(sin φ, 0, cos φ)`・
 * up=+Y の画面右は `right = up × backward = (0,1,0) × (sin φ,0,cos φ)
 * = (cos φ, 0, −sin φ)` = ローカル +X と一致する。**軸を挟んで逆側
 * （`(−sin φ, 0, −cos φ)`）に置くと画面右が反転し、B だけ左右反転する**
 * — 寸法は合うため CSG 側のテストでは検出できず、ここの実装がその規約の
 * 唯一の実装点になる。C は真上から見下ろすため前方 (0,−1,0) が既定 up
 * (0,1,0) と平行になり退化する。up を (0,0,−1) にしないと画面右が反転する
 * （B の左右反転と同じ種類の事故）。
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
import { DEFAULT_AXIS_ANGLE_DEG, viewpointCamera } from '../worker/protocol'

/** three の `Vector3` と構造互換の読み取り専用 3 次元ベクトル */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

/**
 * シルエット合致の対象視点。**ストア（`ViewerState.matched`）で公開するのは
 * A / B のみ**に固定してある — ui/SweetSpotIndicator.tsx の `target` 型が
 * `'A' | 'B' | null` のままであり、ここを C まで広げるとその型契約を破る。
 * C の合致は {@link AxisView} 側（内部専用）で扱う。
 */
export type SweetSpotView = 'A' | 'B'

/**
 * カメラ数学が内部で扱う視点。ストア公開の {@link SweetSpotView}（A/B）に
 * C を加えたもの。`viewpointCamera`（worker/protocol.ts）の引数と同じ集合。
 */
export type AxisView = 'A' | 'B' | 'C'

/** スナップ先。front / side / top は正射影へ切り替わる（FR-023）。iso は俯瞰 */
export type SnapView = 'front' | 'side' | 'top' | 'iso'

/** 投影モード。自由探索 = perspective、視点 A/B スナップ中 = orthographic */
export type ProjectionMode = 'perspective' | 'orthographic'

/** Sweet Spot 閾値 3.5°（FR-021 / US-003。≈ 0.0611 rad） */
export const SWEET_SPOT_THRESHOLD_DEG = 3.5
export const SWEET_SPOT_THRESHOLD_RAD = (SWEET_SPOT_THRESHOLD_DEG * Math.PI) / 180

/**
 * 視点の**カメラ前方ベクトル**（カメラ → 原点方向、単位ベクトル）を
 * `viewpointCamera`（worker/protocol.ts。唯一の幾何規約）から導出する。
 *
 * B は axisAngleDeg に依存する — 既定 90° のときのみ従来の (−1,0,0) に
 * **厳密一致**する（`viewpointCamera` 自身が 90° を厳密値で返すため、
 * `Math.cos(π/2)` の丸め誤差 6.1e-17 はここにも伝播しない）。A・C は
 * axisAngleDeg を渡しても無視される（位置が固定のため）。
 */
export function viewForward(view: AxisView, axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG): Vec3Like {
  const { direction } = viewpointCamera(view, axisAngleDeg)
  // `-0 || 0` で −0 を +0 へ正規化する（`-direction[i]` は direction[i] が
  // 正の 0 のとき −0 になりうる。toEqual({x:0,...}) との比較を壊さないため）
  return {
    x: -direction[0] || 0,
    y: -direction[1] || 0,
    z: -direction[2] || 0,
  }
}

/**
 * 既定軸角（90°）での視点前方ベクトル。A・C は axisAngleDeg に依存しないため
 * 常にこの値でよい。**B はここでは既定 90° の参照値** — 実際の判定・
 * レンダリングは現在の axisAngleDeg を渡した {@link viewForward} を使うこと
 * （`matchedSweetSpot` / CameraRig.tsx を参照）。
 */
export const VIEW_FORWARDS: Record<AxisView, Vec3Like> = {
  A: viewForward('A'),
  B: viewForward('B'),
  C: viewForward('C'),
}

/** スナップ視点の定義。direction は原点 → カメラ位置の単位ベクトル */
export interface SnapViewSpec {
  /** 原点からカメラ位置へ向かう単位ベクトル。side は既定 90° の参照値
   *  （実際の方向は {@link snapDirection} が axisAngleDeg を反映して返す） */
  direction: Vec3Like
  /** スナップ完了時に適用する投影（FR-023） */
  projection: ProjectionMode
  /**
   * この視点が対応する Sweet Spot（内部の離脱判定にのみ使う。CameraRig.tsx）。
   * iso は錯視の視点ではないので null。**ストアの `matched`（A/B のみ）とは
   * 別物** — C はここにだけ現れ、`ViewerState.matched` の型契約は破らない。
   */
  sweetSpot: AxisView | null
}

const ISO_DIRECTION: Vec3Like = normalized({ x: 1, y: 0.7, z: 1 })

/**
 * スナップ視点の規約表。**side は既定 90° で +X**（−X に置くと B が鏡像になる
 * — ファイル冒頭のカメラ規約を参照）。front / side / top は完了時に正射影へ
 * 切り替え、iso（俯瞰）は透視のまま。
 *
 * top（視点 C）は `input.c` が設定されているときだけ意味を持つが、スナップ
 * 自体は常に到達可能にしてある（+Y から見ること自体は 2 視点でも無害）。
 * UI 側（ui/Sidebar.tsx）が「視点 C が有効なときだけボタンを出す」形で
 * 「主役でない」ことを示す。
 */
export const SNAP_VIEWS: Record<SnapView, SnapViewSpec> = {
  front: { direction: { x: 0, y: 0, z: 1 }, projection: 'orthographic', sweetSpot: 'A' },
  side: { direction: { x: 1, y: 0, z: 0 }, projection: 'orthographic', sweetSpot: 'B' },
  top: { direction: { x: 0, y: 1, z: 0 }, projection: 'orthographic', sweetSpot: 'C' },
  iso: { direction: ISO_DIRECTION, projection: 'perspective', sweetSpot: null },
}

/**
 * スナップ先カメラ位置の単位ベクトル。**side は axisAngleDeg に応じた実際の
 * 押し出し軸方向**（`viewpointCamera('B', axisAngleDeg).direction`）を返す —
 * `SNAP_VIEWS.side.direction` は既定 90° の参照値でしかなく、そのまま使うと
 * 斜交軸で「B のシルエットが成立しない角度」にスナップしてしまう
 * （アンビギュアス・シリンダーの 45° がまさにこのケース）。
 * front / top / iso は axisAngleDeg に依存しないため `SNAP_VIEWS` の値を
 * そのまま返す。既定 90° では `SNAP_VIEWS.side.direction` と厳密に一致する。
 */
export function snapDirection(view: SnapView, axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG): Vec3Like {
  if (view === 'side') {
    const { direction } = viewpointCamera('B', axisAngleDeg)
    return { x: direction[0], y: direction[1], z: direction[2] }
  }
  return SNAP_VIEWS[view].direction
}

/**
 * スナップ完了時のカメラ up ベクトル。**top（視点 C）だけ (0,0,−1)** —
 * 真上から見下ろすとカメラ前方 (0,−1,0) が既定 up (0,1,0) と平行になり、
 * カメラの姿勢計算（lookAt）が退化する。up を変えないと画面右が不定 /
 * 反転する（ファイル冒頭のカメラ規約を参照）。front / side / iso は
 * 従来どおり (0,1,0)。
 */
export function snapUp(view: SnapView): Vec3Like {
  if (view === 'top') {
    const { up } = viewpointCamera('C')
    return { x: up[0], y: up[1], z: up[2] }
  }
  return { x: 0, y: 1, z: 0 }
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
 *
 * B は `axisAngleDeg`（省略時は既定 90°）に応じた**実際の**前方
 * （{@link viewForward}）と比較する — 固定 (−1,0,0) のまま判定すると、
 * 斜交軸で「A↔B の真の角度差」とずれた誤判定になる（例：45° のとき
 * A スナップ中でも B との角度差が 90° 相当に見えてしまい、B の
 * シルエットが実際に成立する角度では逆に一切合致しなくなる）。
 * 既定 90° では A・B は直交するため同時合致はありえないが、関数としては
 * 角度差の小さい方を選ぶ全域定義にしてある。
 */
export function matchedSweetSpot(
  cameraForward: Vec3Like,
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
): SweetSpotView | null {
  const angleA = angleBetween(cameraForward, VIEW_FORWARDS.A)
  const angleB = angleBetween(cameraForward, viewForward('B', axisAngleDeg))
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
 *
 * `c` は視点 C（top スナップ）専用。ui/SweetSpotIndicator.tsx は A/B しか
 * 表示しないため配線しない（{@link LiveAngleSink} は 2 引数のまま） —
 * CameraRig.tsx が top スナップからの離脱判定にだけ使う内部値。
 */
export const sweetSpotLiveAngles = { a: Math.PI, b: Math.PI, c: Math.PI }

/**
 * 連続表示の書き出し先（FR-021「カメラが動いている間、角度差をリアルタイムに
 * 表示する」の配線点）。毎フレーム呼ばれる関数を 1 つだけ保持する受け口で、
 * **store でも React state でもない** — ここを経由しても再レンダリングは
 * 1 回も起きない（NFR-002: 60fps 予算をレンダリングに使わない）。
 *
 * 実際に DOM へ書くのは ui 側の購読者（SweetSpotIndicator）で、このファイルは
 * DOM にも three にも依存しないまま保つ（冒頭の不変条件）。
 */
export type LiveAngleSink = (angleA: number, angleB: number) => void

let liveAngleSink: LiveAngleSink | null = null

/** 連続表示の購読を登録する。保持できるのは 1 つだけで、後勝ち */
export function setLiveAngleSink(sink: LiveAngleSink): void {
  liveAngleSink = sink
}

/**
 * 登録した購読を解除する。**自分が登録したものだけ**を外す —
 * StrictMode の二重マウント（mount → cleanup → mount）で、後から登録された
 * 購読を古い cleanup が消してしまう事故を防ぐ。
 */
export function clearLiveAngleSink(sink: LiveAngleSink): void {
  if (liveAngleSink === sink) liveAngleSink = null
}

/**
 * 現在の角度差を購読者へ流す。`useFrame` の中から毎フレーム呼ぶ（Viewport）。
 * 未登録なら何もしない（シーンだけを単体で動かす場合や、UI 未マウント時）。
 */
export function publishLiveAngles(): void {
  if (liveAngleSink === null) return
  liveAngleSink(sweetSpotLiveAngles.a, sweetSpotLiveAngles.b)
}

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
 * - `curatedMode` / `rotationLocked`: 「常に回転できるとすぐにネタバラシに
 *   なる」— カタログは演出されたカメラのシーケンス（A を見せる → B を鏡 /
 *   スナップで見せる → 「仕組みを見る」で初めて自由回転を許す）であって、
 *   自由なドラッグ探索ではない。詳細は CameraRig.tsx の冒頭コメントを参照。
 */
export interface ViewerState {
  /** 現在合致中の Sweet Spot（FR-021）。UI のインジケーターが購読する */
  matched: SweetSpotView | null
  /** 現在の投影モード（FR-023） */
  projection: ProjectionMode
  /** 未消費のスナップ要求。CameraRig が参照同一性の変化で検知する */
  snapRequest: SnapRequest | null
  /**
   * 「演出されたカメラ」文脈にいるか。true = カタログ（既定モード）を含む、
   * 自由なドラッグ探索が錯視の驚きを台無しにする文脈。ui/Sidebar.tsx
   * （自由モード）・ui/PuzzlePanel.tsx（クイズ）が**マウント／アンマウント**
   * で追従させる（App.tsx / Gallery.tsx を編集せずにモード連動を実現する
   * ための唯一の観測点 — 両ファイルはこのタスクの所有範囲外）。
   * 既定 true（起動直後の既定モードはカタログ）。
   */
  curatedMode: boolean
  /**
   * OrbitControls のドラッグ回転を禁止するか。既定は `curatedMode` と同じ
   * 値で始まるが、「仕組みを見る」ボタンで `curatedMode` を保ったまま
   * 独立に外せる（CameraRig.tsx のオーバーレイ）。スナップ（requestSnap）は
   * ロック中でも常に有効 — ロックが止めるのはユーザーのドラッグ入力だけで、
   * プログラムによるカメラ遷移ではない。
   */
  rotationLocked: boolean
  /** 視点スナップを要求する（front / side / top / iso）。連打も再発火する */
  requestSnap: (view: SnapView) => void
  /** 合致状態の書き込み。**同値なら no-op**（購読者へ通知しない） */
  setMatched: (view: SweetSpotView | null) => void
  /** 投影モードの書き込み。**同値なら no-op** */
  setProjection: (mode: ProjectionMode) => void
  /** `curatedMode` の書き込み。Sidebar / PuzzlePanel のマウント境界専用 */
  setCuratedMode: (curated: boolean) => void
  /** `rotationLocked` の書き込み。CameraRig の「仕組みを見る」オーバーレイ専用 */
  setRotationLocked: (locked: boolean) => void
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  matched: null,
  projection: 'perspective',
  snapRequest: null,
  // 既定モードはカタログ（ui/modeStore.ts の INITIAL_MODE_STATE）なので、
  // 起動直後は演出モード・ロック済みで始まる
  curatedMode: true,
  rotationLocked: true,

  requestSnap: (view) =>
    set((s) => ({ snapRequest: { view, seq: (s.snapRequest?.seq ?? 0) + 1 } })),

  setMatched: (view) => {
    if (get().matched === view) return
    set({ matched: view })
  },

  setCuratedMode: (curated) => {
    if (get().curatedMode === curated) return
    set({ curatedMode: curated })
  },

  setRotationLocked: (locked) => {
    if (get().rotationLocked === locked) return
    set({ rotationLocked: locked })
  },

  setProjection: (mode) => {
    if (get().projection === mode) return
    set({ projection: mode })
  },
}))
