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
 * 平面の**原点からの法線距離**は軸角によらず一定（`mirrorOffset/√2` —
 * 以下 `distance`）に保つ。有限矩形のどの点も、この法線距離**以上**
 * 原点から離れる（後述のスライドを含めても、この事実は変わらない）ため、
 * 立体（半径 ~1.5 程度）との交差を軸角によらず避けられる。`mirrorOffset`
 * はユーザー（ui/Sidebar.tsx）・カタログ項目（catalogue/illusions.ts の
 * `IllusionPreset.mirror.offset` → `store/useStudioStore.ts` の
 * `options.mirrorOffset`）のどちらからも設定できる — 「どちらを向くか」
 * （向き）は錯視の成立条件そのものなので固定し、「どれだけ離すか」
 * （オフセット）だけを自由パラメータにする。
 *
 * **矩形の中心は「原点にもっとも近い点」ではなく「原点の鏡像に画面 X が
 * 一致する点」に置く**（レビュー Finding 1 の修正。以前は前者だった —
 * 45° 等の斜交軸で反射像が矩形の外に落ち、鏡が黒いまま何も映さない
 * 欠陥があった）。理由：
 *
 * 1. Reflector は実カメラを鏡面で鏡映した仮想カメラでシーンを描画し、
 *    実カメラと**同じフラスタム**（zoom / 投影）を使ってそれを鏡の矩形へ
 *    投影する。したがって「点 X が鏡に映って見えるか」は「X を鏡面で
 *    鏡映した点 X′ の**画面 XY 座標**が、鏡の矩形自身の画面 XY 範囲に
 *    含まれるか」と同値になる（等長変換の性質 — 仮想カメラから X を見る
 *    のと、実カメラから X′ を見るのとで、画面上の局所座標が一致する）。
 *    視点 A のカメラは常に画面右 = world +X・画面上 = world +Y なので、
 *    「画面 XY 座標」は world X・Y そのもの。
 * 2. 原点を鏡映した点 X′ は `2·foot`（`foot` は原点から平面への垂線の足）
 *    — 鏡映の定義そのもの（`O′ = O − 2((O−foot)·n)n`、`(O−foot)·n = −distance`
 *    より `O′ = 2·distance·n`... 符号を追うと `O′ = 2·foot`）。
 *    一方 `foot` 自身の world X は `distance` の何倍かでしかない
 *    （軸角に依存する係数）。**`foot` を矩形の中心に選ぶと（旧実装）、
 *    中心の world X は `foot.x` だが反射像の world X は `2·foot.x` —
 *    2 倍のずれが生まれ、軸角が直交から離れるほど（`foot.x` が育つほど）
 *    このずれが致命的になる**。既定 90° だけ偶然ずれが小さかったのは、
 *    その角度でたまたま「反射像の world X」＝「矩形の world X」が別の
 *    式（後述の従来ハードコード値）で一致していたため。
 * 3. 修正：中心を `foot` から**平面の接線（矩形の幅方向）に沿って**
 *    スライドし、中心の world X が反射像の world X（`2·foot.x`）に一致
 *    するところまで動かす。接線方向のスライドは法線距離を変えない
 *    （幅方向は定義より法線と直交する）ので、上記の交差回避はそのまま
 *    保たれる。既定 90°（`rotationY = −45°`）でこの式を解くと厳密に
 *    `(mirrorOffset, center_y, 0)` になる — **従来のハードコード値と
 *    1 ビットも変わらない**（{@link mirrorTransform} の分岐はこれを
 *    厳密値のまま返すための最適化であって、別の配置規約ではない）。
 *
 * これでもなお、矩形の**半幅**（`(MIRROR_WIDTH/2)·|cos(rotationY)|`。
 * 軸角が直交から離れるほど前傾して画面上では細く見える — 遠近感のない
 * 正射影でも生じる純粋な幾何学的前縮み）が反射像の半幅より狭ければ、
 * 反射像は矩形の縁で欠ける（Finding 1 の 4 点目）。{@link MIRROR_WIDTH}
 * の値はこの前縮みを見込んで、カタログが使う軸角（45°・90°）の両方で
 * 欠けが実用上気にならない値を選んである。
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
 *
 * ## 額縁と台座（所有者フィードバック「鏡が鏡ってわかりにくい」への対応）
 *
 * 反射面だけでは「壁に開いた穴」「もう 1 枚の絵」にしか見えない —
 * スクリーンショットで確認済みの実際の症状（正面 (A) スナップは正射影の
 * 正面図なので、無限グリッド床は視線とほぼ平行に見え、直接視でも反射像
 * でもほぼ 1 本の線にしか映らない。したがって「反射像に床を映り込ませる」
 * だけでは鏡だと伝わらない）。ここでは反射面はそのまま（位置・回転・
 * ジオメトリ・{@link createMirrorMesh} は無変更）に、次の 2 つを別体の
 * 非反射メッシュとして追加する（{@link createMirrorFrame}）:
 *
 * 1. **額縁**（上・左・右の 3 辺、{@link FRAME_BORDER} 幅・
 *    {@link FRAME_DEPTH} の厚み）— 縁と厚みがあって初めて「そこに置かれた
 *    物」に見える。下辺だけ額縁を付けないのは、反射面の下端が既に
 *    グリッド床とちょうど接する高さにあり、下だけ縁を足すと床にめり込んで
 *    見えるため（2 の台座がこの辺を引き継ぐ）。
 * 2. **台座**（{@link STAND_WIDTH}×{@link STAND_HEIGHT}、床面から更に
 *    {@link STAND_DEPTH} だけ奥へ張り出す脚）— 「宙に浮く矩形」ではなく
 *    「床に立つ物」だと伝える最小限の接地。
 *
 * どちらも反射を持たない通常メッシュ 1 個（{@link buildMirrorFrameGeometry}
 * で 4 パーツを 1 ジオメトリへ統合、ドローコール 1 個）で、Viewport 既存の
 * 環境光・平行光だけで陰影が付く。反射面の追加レンダーパス（Reflector 側）
 * とは無関係に、このメッシュ自体は毎フレーム通常の 1 回描画のみ —
 * NFR-002 の 60fps 予算に対する追加コストは通常メッシュ 1 個分（実測して
 * 妥当なら許容、そうでなければ削る）。ゲート・解放は反射面と対で行う
 * （{@link disposeMirrorFrame}）。
 */
/* eslint-disable react-refresh/only-export-components --
 * 生成・解放・ゲート判定を純関数として export し、Node の Vitest から
 * WebGL なしで検証する（VirtualMirror.test.ts）。コンポーネントと同居させる
 * のはタスクのファイル所有権（このタスクが触れるのは VirtualMirror.tsx のみ）
 * による。編集時の Fast Refresh がフルリロードになる小さな代償を許容する */
import { useEffect, useState } from 'react'
import {
  BoxGeometry,
  type BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
 * 反射面の幅（作業座標）。
 *
 * 鏡に映る像の実効半幅は、矩形自身のローカル半幅
 * `(MIRROR_WIDTH/2)·|cos(rotationY)|` で決まる — 正射影でも、鏡面を
 * 画面の正面方向（視点 A の +Z）から見た角度が直交から離れるほど、矩形は
 * 前縮みして画面上で細く見える（ファイル冒頭「配置」参照。遠近感とは
 * 無関係の純粋な幾何学的事実）。プリセットの |bx| ≤ ~1.05（既定軸角 90° の
 * 場合。`bx` は B の作業座標 X）を覆うにはローカル半幅が必要だが、
 * 軸角が斜交（例：アンビギュアス・シリンダーの 45°、`rotationY = −67.5°`、
 * `|cos| ≈ 0.383`）になるとその前縮みで必要な物理半幅が約 2.6 倍に膨らむ
 * （`1.05 / 0.383 ≈ 2.74` 倍）。カタログが使う 2 つの軸角（45°・90°）の
 * どちらでも像が矩形の縁で欠けないよう、45° 側（前縮みが大きい方）を
 * 基準に十分な余裕を持たせた値を選んである — 90° 側はこれで従来よりかなり
 * 余裕が増える（幅広のテキスト・SVG や、45° よりさらに斜交軸に振った
 * 自由入力ではなお欠けうる — 固定サイズの既知の簡略化）。
 */
export const MIRROR_WIDTH = 6.2

/** 反射面の高さ（作業座標）。B の y ∈ [−1, 1] を覆う（下記中心 y と対で決まる） */
export const MIRROR_HEIGHT = 2.6

/** ミラー中心の高さ。下端 (0.15 − 1.3 = −1.15) がグリッド床にちょうど接する */
export const MIRROR_CENTER_Y = 0.15

/** 反射レンダーターゲットの解像度（px）。B のシルエット判読を優先して 1024 */
export const MIRROR_TEXTURE_SIZE = 1024

/**
 * 額縁の縁幅（作業座標）。上・左・右の 3 辺のみに使う（下辺は
 * {@link STAND_HEIGHT} が受け持つ。ファイル冒頭「額縁と台座」参照）。
 *
 * **意図的に薄い**: {@link mirrorFrameExtent} 経由でこの値が
 * `CameraRig.tsx` の視点 A スナップの構図（`frontMirrorFramingZoom`）に
 * そのまま加算される。読みやすさは主に {@link FRAME_COLOR} のコントラスト
 * （明るいブラッシュドメタル調）で稼いでおり、縁の物理的な太さへの依存は
 * 小さいため、太さは構図側の予算を圧迫しない最小限に絞ってある —
 * それでも `OrbitControls.minZoom`（CameraRig.tsx、0.2）が要求ズームの
 * 下限として働くため、この縁が 0 でも同じ視点・軸角では画角の端で欠ける
 * 場合がある（既存の問題。詳細は VirtualMirror.tsx を呼び出す側のレビュー
 * コメント、または本コミットの説明を参照）。
 */
const FRAME_BORDER = 0.08

/** 額縁の奥行き（厚み）。平面ではなく厚みを持つ物体だと伝える最小値 */
const FRAME_DEPTH = 0.11

/** 額縁の前面を反射面よりわずかに手前へ出す量（縁が鏡面より一段高い、実際の額縁の見え方） */
const FRAME_FRONT_LIP = 0.02

/**
 * 額縁・台座の色。シーンがほぼ黒背景（ダーク UI）なので、反射像の減衰色
 * （0xa9adb8）よりむしろ明るいブラッシュドメタル調にして、背景にも反射面
 * にも埋もれず縁として読めるようにする（暗いグレーで揃えたところ、実機
 * 確認でほぼ背景と見分かなくなったための修正）。
 */
const FRAME_COLOR = 0x9098a3

/** 台座（脚）の幅。反射面いっぱいではなく中央だけ細く — 額縁ほど目立たせない */
const STAND_WIDTH = MIRROR_WIDTH * 0.34

/** 台座の高さ。反射面の下端（グリッド床面）からわずかに立ち上がるだけでよい */
const STAND_HEIGHT = 0.14

/** 台座が額縁背面からさらに奥へ張り出す奥行き。「床に接する脚」だと伝わる張り出し量 */
const STAND_DEPTH = 0.5

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
 * ミラーの配置（位置・Y 軸回転）を axisAngleDeg・offset から導出する
 * （レビュー Finding 1「反射像が鏡の外に落ちて何も映らない」の修正。
 * ファイル冒頭「配置」の導出を参照）。
 *
 * 平面上の点は「原点から平面への垂線の足」（`foot`。原点からの法線距離が
 * 常に `offset/√2` になる点）を基準に、**矩形の幅方向（平面の接線）へ
 * スライド**して選ぶ — スライド量は「中心の world X が、原点をこの平面で
 * 鏡映した点の world X（`2·foot.x`）に一致する」ように解く
 * （`tan(rotationY)` を使う閉形式。`rotationY` は直交 [15°,165°] の軸角
 * 範囲で決して ±90° にならないため 0 除算はしない）。これにより、視点 A
 * から見て「鏡に映るはずのもの」が矩形の中心付近に来る — スライドしない
 * （＝ `foot` をそのまま中心にする）と、既定 90° 以外では反射像が矩形の
 * 外側に落ちて鏡が黒いまま何も映さなくなる（Finding 1 の実体）。
 *
 * 既定 90°・既定オフセットは従来の厳密値 `(MIRROR_OFFSET, MIRROR_CENTER_Y, 0)`
 * をそのまま返す — この式で 90° を解いても同じ値になる（ファイル冒頭を
 * 参照）ため、意味の変わらない最適化（`atan2` 系の丸め誤差を混入させない）。
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
  const sin = Math.sin(rotationY)
  const cos = Math.cos(rotationY)
  const footX = -distance * sin
  const footZ = -distance * cos
  // 幅方向スライド量。中心の world X を footX から 2*footX（原点の鏡像の
  // world X）へ動かすのに必要な、幅方向単位ベクトル (cos, 0, -sin) 沿いの量
  const slide = -distance * (sin / cos)
  const x = footX + slide * cos
  const z = footZ - slide * sin
  return { position: [x, MIRROR_CENTER_Y, z], rotationY }
}

/**
 * ミラー平面の world-space バウンディング（X 半幅・Y 範囲）。**A スナップ
 * （視点 A / front）の構図計算専用**（CameraRig.tsx `switchToOrthographic`。
 * FR-102 拡張 / レビュー Finding 1「ミラーがビューポート右端で欠ける」の
 * 修正点）。
 *
 * 視点 A のカメラは常に +Z に置かれ up=+Y なので、正射影の画面右 = world
 * +X・画面上 = world +Y（CameraRig.tsx / SweetSpot.ts のカメラ規約）。
 * したがって「鏡がスナップの画角に収まるか」は world X・Y の範囲だけで
 * 決まり、Z（奥行き）は無関係 — このバウンディングもその 2 軸だけを返す。
 *
 * {@link mirrorTransform} を経由するので、実際にレンダーされる位置・回転
 * （軸角 90° の厳密値分岐も含む）と常に一致する。ここで独自に位置を
 * 再計算すると、ミラーの実配置とスナップの構図がずれる事故になる —
 * 「ミラーとカメラの構図は独立に計算しない」という Finding 1 の指摘そのもの。
 *
 * 回転（Y 軸）は平面のローカル Y をそのまま world Y に写す（PlaneGeometry
 * の Y 軸回転は Y 成分を変えない）ので、Y 方向の半幅は常に
 * `MIRROR_HEIGHT/2`（回転に依存しない）。X 方向はローカル X が
 * `cos(rotationY)` 倍されて world X に載るため、半幅は
 * `(MIRROR_WIDTH/2) * |cos(rotationY)|`。
 */
export function mirrorFrameExtent(
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
  offset: number = MIRROR_OFFSET,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const { position, rotationY } = mirrorTransform(axisAngleDeg, offset)
  // 額縁（左右の縁）を含めた実効半幅。上辺の縁も同じ半幅で四隅を覆うので
  // X 方向はこの半幅のままでよい
  const halfWidthX = (MIRROR_WIDTH / 2 + FRAME_BORDER) * Math.abs(Math.cos(rotationY))
  const halfHeightY = MIRROR_HEIGHT / 2
  return {
    minX: position[0] - halfWidthX,
    maxX: position[0] + halfWidthX,
    // 下辺は台座がグリッド床の高さに合わせてあるので反射面の下端のまま。
    // 上辺だけ額縁の縁の分だけ広げる（額縁と台座の実際の footprint と一致させる）
    minY: position[1] - halfHeightY,
    maxY: position[1] + halfHeightY + FRAME_BORDER,
  }
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
 * 額縁＋台座の形状を作る（反射面とは別体・非反射のメッシュ 1 つにまとめる
 * — パーツを増やしてもドローコールは 1 個のまま）。ローカル座標は反射面
 * （`PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT)`）と同じ原点・同じ軸を
 * 共有するので、{@link applyMirrorFrameTransform} で反射面とまったく
 * 同じ position・rotationY を与えるだけで縁取りとして揃う（ファイル冒頭
 * 「額縁と台座」参照）。
 */
function buildMirrorFrameGeometry(): BufferGeometry {
  const halfW = MIRROR_WIDTH / 2
  const halfH = MIRROR_HEIGHT / 2
  const frameZ = FRAME_FRONT_LIP - FRAME_DEPTH / 2
  const parts = [
    // 上辺（左右の縁の分だけ幅広く作り、四隅を覆う）
    new BoxGeometry(MIRROR_WIDTH + FRAME_BORDER * 2, FRAME_BORDER, FRAME_DEPTH).translate(
      0,
      halfH + FRAME_BORDER / 2,
      frameZ,
    ),
    // 左辺
    new BoxGeometry(FRAME_BORDER, MIRROR_HEIGHT, FRAME_DEPTH).translate(
      -(halfW + FRAME_BORDER / 2),
      0,
      frameZ,
    ),
    // 右辺
    new BoxGeometry(FRAME_BORDER, MIRROR_HEIGHT, FRAME_DEPTH).translate(
      halfW + FRAME_BORDER / 2,
      0,
      frameZ,
    ),
    // 台座。下端は反射面の下端（＝グリッド床）とちょうど同じ高さ — 床に
    // めり込ませず、額縁背面からさらに奥へ張り出して脚だと分かる幅を持たせる
    new BoxGeometry(STAND_WIDTH, STAND_HEIGHT, STAND_DEPTH).translate(
      0,
      -halfH + STAND_HEIGHT / 2,
      FRAME_FRONT_LIP - FRAME_DEPTH - STAND_DEPTH / 2,
    ),
  ]
  const merged = mergeGeometries(parts)
  for (const part of parts) part.dispose()
  return merged
}

/**
 * 額縁＋台座のメッシュを生成する。純関数 — {@link createMirrorMesh} と対に
 * なる（GPU 資源は最初の描画まで確保されない。Node でテスト可能）。反射は
 * 行わない通常のライト受けメッシュなので、Viewport 既存の環境光・平行光
 * だけで陰影が付き、追加の反射レンダーパスは発生しない（反射面側の
 * 追加パスとは無関係。NFR-002 に対しては通常メッシュ 1 個分のコストのみ）。
 */
/** 額縁＋台座メッシュの型（マテリアルを具体型に固定し、dispose() を型エラーなく呼べるようにする） */
type MirrorFrameMesh = Mesh<BufferGeometry, MeshStandardMaterial>

export function createMirrorFrame(
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
  offset: number = MIRROR_OFFSET,
): MirrorFrameMesh {
  const geometry = buildMirrorFrameGeometry()
  const material = new MeshStandardMaterial({
    color: FRAME_COLOR,
    roughness: 0.35,
    metalness: 0.5,
  })
  const frame: MirrorFrameMesh = new Mesh(geometry, material)
  applyMirrorFrameTransform(frame, axisAngleDeg, offset)
  return frame
}

/**
 * 額縁＋台座の位置・回転だけを更新する。{@link applyMirrorTransform} と
 * 同じ {@link mirrorTransform} を呼ぶので、反射面と常に同じ配置を保つ —
 * 鏡本体の向き・配置そのものは一切変更しない（このファイルはあくまで
 * 反射面に追従するだけ）。
 */
export function applyMirrorFrameTransform(
  frame: MirrorFrameMesh,
  axisAngleDeg: number = DEFAULT_AXIS_ANGLE_DEG,
  offset: number = MIRROR_OFFSET,
): void {
  const { position, rotationY } = mirrorTransform(axisAngleDeg, offset)
  frame.position.set(position[0], position[1], position[2])
  frame.rotation.y = rotationY
}

/** 額縁＋台座の資源を解放する（{@link disposeMirrorMesh} と対で呼ぶ） */
export function disposeMirrorFrame(frame: MirrorFrameMesh): void {
  frame.geometry.dispose()
  frame.material.dispose()
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

/**
 * 反射面＋額縁＋台座の実体。マウント中だけ存在し、反射面（Reflector）が
 * 追加レンダーパスを払う。額縁・台座は反射を持たない通常メッシュ 1 個
 * （{@link createMirrorFrame}）で、追加パスは発生しない。
 */
function MirrorPlane() {
  // FR-102: 軸角・オフセットの変更（NumberField のコミット単位。連続ドラッグ
  // ではない）だけ再レンダリングする — カメラ操作中の 60fps 予算（NFR-002）
  // とは無関係の、離散的なユーザー入力 / カタログ選択への反応
  const axisAngleDeg = useStudioStore(selectAxisAngleDeg)
  const offset = useStudioStore(selectMirrorOffset)
  // マウントにつき 1 個。StrictMode の initializer 二重呼び出しで捨てられる
  // 個体は一度も描画されないため GPU 資源を持たず、GC に任せてよい
  const [mirror] = useState(() => createMirrorMesh(axisAngleDeg, offset))
  const [frame] = useState(() => createMirrorFrame(axisAngleDeg, offset))
  // アンマウント（= 無効化）で反射レンダーターゲットを解放する。
  // R3F は <primitive> の外来オブジェクトを自動 dispose しないので、
  // このクリーンアップが唯一の解放経路
  useEffect(() => () => disposeMirrorMesh(mirror), [mirror])
  useEffect(() => () => disposeMirrorFrame(frame), [frame])
  // 軸角・オフセットが変わるたびに位置・回転だけ更新する（ジオメトリ・
  // マテリアル・反射レンダーターゲットは再生成しない — Reflector の
  // 再生成は高コスト）。額縁・台座も同じ配置に追従させる
  useEffect(() => {
    applyMirrorTransform(mirror, axisAngleDeg, offset)
    applyMirrorFrameTransform(frame, axisAngleDeg, offset)
  }, [mirror, frame, axisAngleDeg, offset])
  return (
    <>
      <primitive object={mirror} />
      <primitive object={frame} />
    </>
  )
}
