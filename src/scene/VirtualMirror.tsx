/**
 * 仮想ミラー（Task 6.3 / FR-024 / US-004 / FR-102）。
 *
 * **ミラーは装飾ではなく、いくつかの錯視の成立機構そのもの**
 * （アンビギュアス・シリンダー／トランプマークの変身立体は「直接見える形」
 * と「鏡に映る形」が異なって初めて成立する。design.md「仮想ミラー」）。
 * 視点 B 方向に反射面を立て、視点 A(+Z) からの構図で本体と鏡像を同時に
 * 見せる。実装は three 本体の `Reflector`（three/examples/jsm/objects/Reflector.js）。
 *
 * ## drei の MeshReflectorMaterial を使わない理由（設計からの逸脱）
 *
 * design.md「仮想ミラー」は drei の `MeshReflectorMaterial` を挙げているが、
 * 実装（drei 10.7.8 / core/MeshReflectorMaterial.js）を確認すると、2 枚の
 * `WebGLRenderTarget` を `useMemo` 内で生成したまま**アンマウント時に一切
 * dispose しない** — 「無効時はアンマウントして反射レンダーターゲットを
 * 解放する」という FR-024 / US-004 の要件そのものをライブラリ側が満たせない。
 * three 本体の `Reflector` は `dispose()` がレンダーターゲットとマテリアルを
 * 明示的に解放し、正射影カメラ（FR-023 の A スナップ）にも対応している。
 *
 * ## 向きの導出（FR-102。ここが「装飾でなく機構」の実装点）
 *
 * ミラーが映すのは反射方向のカメラ像。直接見る視点 A のカメラ位置方向を
 * `d_A`、映したい視点 B のカメラ位置方向を `d_B`
 * （どちらも `worker/protocol.ts` の `viewpointCamera(side, axisAngleDeg).direction`）
 * とすると、反射の公式 `d_B = d_A − 2(d_A·n)n` は、単位ベクトル `d_A`・`d_B`
 * に対し法線 `n ∝ d_A − d_B` のときに成り立つ（|d_A|=|d_B|=1 の場合の
 * 標準的な事実。**反射方向は法線だけで決まり、平面のオフセットには依らない**
 * — オフセットは「どこに置くか」だけを決める独立なパラメータ）。
 *
 * 既定 90° では `d_A − d_B = (0,0,1) − (1,0,0) = (−1,0,1)` — 従来の
 * ハードコード実装が使っていた法線 (−1,0,1)/√2（Y 軸まわり −45°）と
 * 符号違いで同じ平面になる（反射は法線の符号に依らない）。**既定 90° は
 * 厳密値 −45° をそのまま返す**（`Math.atan2` 経由の浮動小数点誤差を混入
 * させない。{@link mirrorRotationY}）。
 *
 * 軸角が既定から外れると（例：アンビギュアス・シリンダーの 45°）、`d_B` が
 * 動くため `n` も動く — 45° 固定のまま 90° 用の鏡を使うと、鏡は「B の
 * シルエットが実際に成立する角度」からずれた別の断面を映してしまい、
 * カタログの「鏡に映った丸い筒」が出ない（35 のカメラ・スナップと
 * 同じ欠陥がミラーにもあった）。
 *
 * ## 配置（オフセットは独立パラメータ。FR-102 拡張）
 *
 * 位置は「原点からの法線距離を軸角によらず一定（`mirrorOffset/√2`）に保つ」
 * ことで求める。有限矩形の反射面のうち原点にもっとも近い点は常にこの法線
 * 距離と一致するため、立体（半径 ~1.5 程度）との交差を軸角によらず避け
 * られる。`mirrorOffset` はユーザー（ui/Sidebar.tsx）・カタログ項目
 * （catalogue/illusions.ts の `IllusionPreset.mirror.offset` →
 * `store/useStudioStore.ts` の `options.mirrorOffset`）のどちらからも
 * 設定できる — 「どちらを向くか」（向き）は錯視の成立条件そのものなので
 * 固定し、「どれだけ離すか」（オフセット）だけを自由パラメータにする。
 *
 * ## カタログ項目による自動設定
 *
 * `store/useStudioStore.ts` の `applyInput` が `StudioInputSpec.mirror` を
 * 読んで `options.virtualMirror` / `options.mirrorOffset` を**同じ
 * トランザクションで**設定する。`IllusionPreset`（catalogue/illusions.ts）
 * が同名の `mirror` フィールドを持ち、`ui/Gallery.tsx` は
 * `applyInput(entry.preset)` を構造そのまま渡すだけなので、カタログ側の
 * 変更だけで「ミラーを使う項目を選ぶと自動でミラーが立つ」が成立する
 * （Gallery.tsx 自体は無編集）。ミラーを使わない項目を選んだときは
 * `spec.mirror` が省略され、明示的に無効化される — 直前の項目で有効化
 * されたミラーが残留して見える事故を防ぐ。
 *
 * **既知の位相注意（handedness）**: 物理的な鏡は 1 回の反射で必ず利き手を
 * 反転させる。このミラーは「B 面そのもの」を映すため、左右非対称な
 * B（矢印・文字）は鏡の中で反転して見える — 実物の鏡に映したときと同じ
 * 挙動。鏡の中でも B を非反転で見せたい場合は反対側の対角に置く必要が
 * あるが、現在の配置は tasks.md 6.3「視点 B 方向の反射面」の明示指定に
 * 従っている。
 *
 * ## 解放（NFR-002 / US-004「描画コストを完全に除去」）
 *
 * `Reflector` はシーンに描画されている間、毎フレーム 1 回シーン全体を
 * 反射ターゲットへ再描画する（フルの追加レンダーパス）。無効時にこの
 * コストと VRAM を残さないため、ゲート（store の `virtualMirror` 購読）で
 * 内側の {@link MirrorPlane} ごとアンマウントし、クリーンアップで
 * {@link disposeMirrorMesh} がレンダーターゲット・マテリアル・ジオメトリを
 * 解放する。ゲートをこのファイルに置くのは、Viewport が「store を購読
 * しない」不変条件（Viewport.tsx 冒頭）を保つため。
 *
 * 軸角・オフセットの変更はジオメトリ・マテリアルの再生成を伴わない —
 * {@link applyMirrorTransform} が位置・回転だけを更新する（GPU 資源は
 * 再利用。連続的な操作でも Reflector の再生成コストを払わない）。
 */
/* eslint-disable react-refresh/only-export-components --
 * 生成・解放・ゲート判定を純関数として export し、Node の Vitest から
 * WebGL なしで検証する（VirtualMirror.test.ts）。コンポーネントと同居させる
 * のはタスクのファイル所有権（このタスクが触れるのは VirtualMirror.tsx のみ）
 * による。編集時の Fast Refresh がフルリロードになる小さな代償を許容する */
import { useEffect, useState } from 'react'
import { PlaneGeometry } from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import {
  DEFAULT_MIRROR_OFFSET,
  useStudioStore,
  type StudioState,
} from '../store/useStudioStore'
import { DEFAULT_AXIS_ANGLE_DEG, viewpointCamera } from '../worker/protocol'

/**
 * ミラーオフセットの既定値（作業座標）。既定軸角ではミラー平面
 * {x − z = MIRROR_OFFSET}、原点からの法線距離は MIRROR_OFFSET/√2 ≈ 2.26。
 * プリセット立体の max(x − z) ≈ 2.1（|x|, |z| ≤ ~1.05）を上回り、
 * 立体と交差しない。実体は `store/useStudioStore.ts` の
 * `DEFAULT_MIRROR_OFFSET`（範囲・既定値の単一の定義元）の再エクスポート。
 */
export const MIRROR_OFFSET = DEFAULT_MIRROR_OFFSET

/**
 * 反射面の幅（作業座標）。鏡の中の B 像は、ミラー面のローカル X 座標
 * −√2·bx（bx は B の作業座標 X、既定軸角の場合）を横切る。プリセットの
 * |bx| ≤ ~1.05 に対し半幅 1.8 ≥ √2 × 1.05 ≈ 1.49 で全体を覆う（幅広の
 * テキスト・SVG や大きく傾いた軸角ではみ出しうる — 固定サイズの既知の簡略化）。
 */
export const MIRROR_WIDTH = 3.6

/** 反射面の高さ（作業座標）。B の y ∈ [−1, 1] を覆う（下記中心 y と対で決まる） */
export const MIRROR_HEIGHT = 2.6

/** ミラー中心の高さ。下端 (0.15 − 1.3 = −1.15) がグリッド床にちょうど接する */
export const MIRROR_CENTER_Y = 0.15

/** 反射レンダーターゲットの解像度（px）。B のシルエット判読を優先して 1024 */
export const MIRROR_TEXTURE_SIZE = 1024

/** ゲート判定。コンポーネントとテストが同じ判定を共有する */
export function selectVirtualMirrorEnabled(state: StudioState): boolean {
  return state.options.virtualMirror
}

/**
 * ミラー平面の法線（単位ベクトル、XZ 平面内）を axisAngleDeg から導出する。
 * `n ∝ d_A − d_B`（d_A / d_B はカメラ位置方向。ファイル冒頭の導出を参照）。
 */
function mirrorNormal(axisAngleDeg: number): readonly [number, number, number] {
  const dA = viewpointCamera('A', axisAngleDeg).direction
  const dB = viewpointCamera('B', axisAngleDeg).direction
  const nx = dA[0] - dB[0]
  const nz = dA[2] - dB[2]
  const len = Math.hypot(nx, nz)
  return [nx / len, 0, nz / len]
}

/**
 * ミラー平面の Y 軸回転角（rad）を axisAngleDeg から導出する。
 * PlaneGeometry の +Z 法線を Y 軸まわり θ 回転すると世界法線
 * `(sinθ, 0, cosθ)` になるので、{@link mirrorNormal} と付き合わせて
 * `θ = atan2(n.x, n.z)` を解く。
 *
 * 既定 90° は従来の厳密値 −π/4 をそのまま返す（`atan2` 経由の丸め誤差
 * 6.1e-17 オーダーの混入を避け、90° の描画を従来と 1 ビットも変えない）。
 */
function mirrorRotationY(axisAngleDeg: number): number {
  if (axisAngleDeg === DEFAULT_AXIS_ANGLE_DEG) return -Math.PI / 4
  const [nx, , nz] = mirrorNormal(axisAngleDeg)
  return Math.atan2(nx, nz)
}

/**
 * ミラーの配置（位置・Y 軸回転）を axisAngleDeg・offset から導出する。
 *
 * 位置は「原点からの法線距離を常に offset/√2 に保つ」ことで求める —
 * 有限矩形の反射面のうち原点にもっとも近い点はこの法線距離と一致するため、
 * 立体との交差を軸角によらず避けられる（ファイル冒頭の解説を参照）。
 * 既定 90°・既定オフセットは従来の厳密値 `(MIRROR_OFFSET, MIRROR_CENTER_Y, 0)`
 * をそのまま返す。
 */
function mirrorTransform(
  axisAngleDeg: number,
  offset: number,
): {
  position: readonly [number, number, number]
  rotationY: number
} {
  const rotationY = mirrorRotationY(axisAngleDeg)
  if (axisAngleDeg === DEFAULT_AXIS_ANGLE_DEG && offset === MIRROR_OFFSET) {
    return { position: [MIRROR_OFFSET, MIRROR_CENTER_Y, 0], rotationY }
  }
  const distance = offset / Math.SQRT2
  const x = -distance * Math.sin(rotationY)
  const z = -distance * Math.cos(rotationY)
  return { position: [x, MIRROR_CENTER_Y, z], rotationY }
}

/**
 * ミラーの位置・回転だけを更新する（ジオメトリ・マテリアル・GPU 資源は
 * 再利用する）。軸角の変更（ui/AxisAngleControl.tsx）・オフセットの変更
 * （ui/Sidebar.tsx）に追従させるための再入可能な適用関数 —
 * {@link MirrorPlane} がどちらかの変化ごとに呼ぶ。
 */
export function applyMirrorTransform(
  mirror: Reflector,
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
  offset: number = MIRROR_OFFSET,
): void {
  const { position, rotationY } = mirrorTransform(axisAngleDeg, offset)
  mirror.position.set(position[0], position[1], position[2])
  mirror.rotation.y = rotationY
}

/**
 * 反射面メッシュを生成する（three `Reflector`）。純関数 — WebGL 不要で
 * 生成でき、GPU 資源は最初に描画されるまで確保されない（Node でテスト可能）。
 *
 * 既定（axisAngleDeg・offset 省略）では従来どおり位置
 * (MIRROR_OFFSET, MIRROR_CENTER_Y, 0)・Y 軸まわり −45° で
 * 平面 {x − z = MIRROR_OFFSET}、法線 (−1, 0, 1)/√2（ファイル冒頭の導出）。
 * axisAngleDeg / offset を渡すと、視点 B の実際の軸・指定した離隔に
 * 追従した配置になる（FR-102）。
 */
export function createMirrorMesh(
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
  offset: number = MIRROR_OFFSET,
): Reflector {
  const geometry = new PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT)
  const mirror = new Reflector(geometry, {
    clipBias: 0.003,
    textureWidth: MIRROR_TEXTURE_SIZE,
    textureHeight: MIRROR_TEXTURE_SIZE,
    // 反射をわずかに減衰させる（実鏡の吸収。1.0 だと発光して見え、
    // 本体のシルエットより鏡像が目立ってしまう）
    color: 0xa9adb8,
  })
  applyMirrorTransform(mirror, axisAngleDeg, offset)
  return mirror
}

/**
 * 反射面の全資源を解放する。`Reflector.dispose()` はレンダーターゲットと
 * マテリアルを解放するが、**ジオメトリはコンストラクタ引数のまま所有
 * しない**ため、ここでまとめて破棄する。アンマウント時のクリーンアップは
 * 必ずこの関数を通す（解放漏れの単一検証点にするため）。
 */
export function disposeMirrorMesh(mirror: Reflector): void {
  mirror.dispose()
  mirror.geometry.dispose()
}

/**
 * 仮想ミラー（Viewport の Canvas 直下にマウントする）。
 * store の `options.virtualMirror` がゲート — 無効なら {@link MirrorPlane} を
 * マウントせず、有効 → 無効の切り替えでアンマウントして反射レンダー
 * ターゲットを解放する（FR-024）。購読は boolean 1 つで、変化はユーザーの
 * トグル操作・カタログ項目選択時のみ — カメラ操作中の再レンダリングは
 * 発生しない（NFR-002）。
 */
export function VirtualMirror() {
  const enabled = useStudioStore(selectVirtualMirrorEnabled)
  if (!enabled) return null
  return <MirrorPlane />
}

/** ミラーの配置（軸角追従）に使うセレクタ。FR-102 */
function selectAxisAngleDeg(state: StudioState): number {
  return state.input.axisAngleDeg
}

/** ミラーのオフセットに使うセレクタ。ユーザー調整・カタログ項目の両方の反映先 */
function selectMirrorOffset(state: StudioState): number {
  return state.options.mirrorOffset
}

/** 反射面の実体。マウント中だけ Reflector が存在し、追加レンダーパスを払う */
function MirrorPlane() {
  // FR-102: 軸角・オフセットの変更（NumberField のコミット単位。連続ドラッグ
  // ではない）だけ再レンダリングする — カメラ操作中の 60fps 予算（NFR-002）
  // とは無関係の、離散的なユーザー入力 / カタログ選択への反応
  const axisAngleDeg = useStudioStore(selectAxisAngleDeg)
  const offset = useStudioStore(selectMirrorOffset)
  // マウントにつき 1 個。StrictMode の initializer 二重呼び出しで捨てられる
  // 個体は一度も描画されないため GPU 資源を持たず、GC に任せてよい
  const [mirror] = useState(() => createMirrorMesh(axisAngleDeg, offset))
  // アンマウント（= 無効化）で反射レンダーターゲットを解放する。
  // R3F は <primitive> の外来オブジェクトを自動 dispose しないので、
  // このクリーンアップが唯一の解放経路
  useEffect(() => () => disposeMirrorMesh(mirror), [mirror])
  // 軸角・オフセットが変わるたびに位置・回転だけ更新する（ジオメトリ・
  // マテリアル・反射レンダーターゲットは再生成しない — Reflector の
  // 再生成は高コスト）
  useEffect(() => {
    applyMirrorTransform(mirror, axisAngleDeg, offset)
  }, [mirror, axisAngleDeg, offset])
  return <primitive object={mirror} />
}
