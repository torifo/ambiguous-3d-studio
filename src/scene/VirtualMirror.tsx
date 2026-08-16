/**
 * 仮想ミラー（Task 6.3 / FR-024 / US-004）。
 *
 * 視点 B(+X) 方向に 45° の反射面を立て、視点 A(+Z) からの構図で本体と
 * 鏡像を同時に見せる。実装は three 本体の `Reflector`
 * （three/examples/jsm/objects/Reflector.js）。
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
 * ## 配置の導出（design.md「2.1 軸の割り当てとカメラ規約」に従う）
 *
 * ミラーは平面 {x − z = MIRROR_OFFSET}（法線 (−1, 0, 1)/√2、Y 軸まわり
 * −45°）。視点 A のカメラ前方 (0, 0, −1) はこの面で
 * `v' = v − 2(v·n)n = (−1, 0, 0)` に反射する — つまり A から鏡を覗くと、
 * 視点 B のカメラ（+X 側から −X を見る）と同じ向きで立体の B 面が見える。
 * 鏡像は仮想的に (MIRROR_OFFSET, 0, −MIRROR_OFFSET) 付近、画面では本体の
 * 右奥に現れる。
 *
 * **既知の位相注意（handedness）**: 物理的な鏡は 1 回の反射で必ず利き手を
 * 反転させる。+X 側のこのミラーは「B 面そのもの」を映すため、左右非対称な
 * B（矢印・文字）は鏡の中で x 反転して見える — 実物の鏡に映したときと同じ
 * 挙動。鏡の中でも B を非反転で見せたい場合は、反対側の対角
 * （平面 {x + z = −MIRROR_OFFSET}、position.x の符号と rotation.y の符号を
 * 両方反転）に置くと、「−X から見た B の裏面（x 反転）」がもう一度反転して
 * 図形 B が正立する。現在の配置は tasks.md 6.3「視点 B(+X) 方向の反射面」の
 * 明示指定に従っている。
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
 */
/* eslint-disable react-refresh/only-export-components --
 * 生成・解放・ゲート判定を純関数として export し、Node の Vitest から
 * WebGL なしで検証する（VirtualMirror.test.ts）。コンポーネントと同居させる
 * のはタスクのファイル所有権（このタスクが触れるのは VirtualMirror.tsx のみ）
 * による。編集時の Fast Refresh がフルリロードになる小さな代償を許容する */
import { useEffect, useState } from 'react'
import { PlaneGeometry } from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { useStudioStore, type StudioState } from '../store/useStudioStore'

/**
 * ミラー平面 {x − z = MIRROR_OFFSET} のオフセット（作業座標）。
 * 原点からの法線距離は MIRROR_OFFSET/√2 ≈ 2.26。プリセット立体の
 * max(x − z) ≈ 2.1（|x|, |z| ≤ ~1.05）を上回り、立体と交差しない。
 */
export const MIRROR_OFFSET = 3.2

/**
 * 反射面の幅（作業座標）。鏡の中の B 像は、ミラー面のローカル X 座標
 * −√2·bx（bx は B の作業座標 X）を横切る。プリセットの |bx| ≤ ~1.05 に
 * 対し半幅 1.8 ≥ √2 × 1.05 ≈ 1.49 で全体を覆う（幅広のテキスト・SVG は
 * はみ出しうる — 固定サイズの既知の簡略化）。
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
 * 反射面メッシュを生成する（three `Reflector`）。純関数 — WebGL 不要で
 * 生成でき、GPU 資源は最初に描画されるまで確保されない（Node でテスト可能）。
 *
 * 位置 (MIRROR_OFFSET, MIRROR_CENTER_Y, 0)・Y 軸まわり −45° で
 * 平面 {x − z = MIRROR_OFFSET}、法線 (−1, 0, 1)/√2（ファイル冒頭の導出）。
 */
export function createMirrorMesh(): Reflector {
  const geometry = new PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT)
  const mirror = new Reflector(geometry, {
    clipBias: 0.003,
    textureWidth: MIRROR_TEXTURE_SIZE,
    textureHeight: MIRROR_TEXTURE_SIZE,
    // 反射をわずかに減衰させる（実鏡の吸収。1.0 だと発光して見え、
    // 本体のシルエットより鏡像が目立ってしまう）
    color: 0xa9adb8,
  })
  mirror.position.set(MIRROR_OFFSET, MIRROR_CENTER_Y, 0)
  mirror.rotation.y = -Math.PI / 4
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
 * トグル操作時のみ — カメラ操作中の再レンダリングは発生しない（NFR-002）。
 */
export function VirtualMirror() {
  const enabled = useStudioStore(selectVirtualMirrorEnabled)
  if (!enabled) return null
  return <MirrorPlane />
}

/** 反射面の実体。マウント中だけ Reflector が存在し、追加レンダーパスを払う */
function MirrorPlane() {
  // マウントにつき 1 個。StrictMode の initializer 二重呼び出しで捨てられる
  // 個体は一度も描画されないため GPU 資源を持たず、GC に任せてよい
  const [mirror] = useState(createMirrorMesh)
  // アンマウント（= 無効化）で反射レンダーターゲットを解放する。
  // R3F は <primitive> の外来オブジェクトを自動 dispose しないので、
  // このクリーンアップが唯一の解放経路
  useEffect(() => () => disposeMirrorMesh(mirror), [mirror])
  return <primitive object={mirror} />
}
