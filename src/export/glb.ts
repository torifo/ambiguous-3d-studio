/**
 * GLB 出力（Task 6.4 / FR-029 / FR-031）。
 *
 * ## 構成 — stl.ts と同じ「バイト生成とダウンロード発火の分離」
 *
 * - {@link generateGlbBytes} … `BufferGeometry` → バイナリ glTF（GLB）の
 *   バイト列。DOM に触れないため Node 上の Vitest で検証できる
 *   （GLTFExporter の GLB 組み立てが使う `FileReader` だけはテスト側で
 *   最小ポリフィルする — glb.test.ts 冒頭参照）。
 * - {@link saveGlbBytesViaAnchor} … Blob + `<a download>` によるブラウザの
 *   ダウンロード発火。**DOM に触れるのはこの薄い層だけ**（stl.ts の
 *   `saveBytesViaAnchor` と同型。MIME が異なるため複製している）。
 * - {@link downloadGlb} … 上記 2 つを束ね、`componentCount > 1` の
 *   出力前警告（US-005 と同じ事実の提示）を差し込むオーケストレーション。
 *
 * ## スケール（FR-029）— 1000 倍事故の防止
 *
 * glTF / USDZ は**メートル**が慣例。STL 用の mm 倍率（`stlMmPerUnit`）を
 * そのまま流すと座標が 1000 倍になり、AR で机に置いたはずの立体が
 * **建物サイズ**で出現する。倍率は `studio/scale.ts`（アプリ唯一の換算点）の
 * {@link glbUsdzMetersPerUnit}（= `stlMmPerUnit × 0.001`）だけを使う。
 * **`stlMmPerUnit` をここで使ってはならない**（scale.ts 冒頭を参照）。
 *
 * スケールは stl.ts と違い、書き出し用の**クローンの頂点座標へ焼き込む**。
 * `GLTFExporter` は STLExporter と異なりノード変換を頂点へ適用せず TRS の
 * まま温存するため、Mesh の行列に載せるとアクセサの座標・min/max（AR
 * ビューアが読むバウンディング）が作業座標のまま出力されてしまう。
 * クローンに焼き込めばアクセサ自体がメートルになり、呼び出し元のジオメトリ
 * （ビューポートが参照している実体）は一切変更されない。
 */
import { Mesh, MeshStandardMaterial } from 'three'
import type { BufferGeometry } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { glbUsdzMetersPerUnit } from '../studio/scale'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'
import { multipleComponentsWarning } from './stl'
import type { ConfirmMultipleComponents, SaveBytes } from './stl'

/** GLB（バイナリ glTF）の MIME タイプ（IANA 登録名） */
export const GLB_MIME = 'model/gltf-binary'

/** 既定のダウンロードファイル名 */
export const DEFAULT_GLB_FILE_NAME = 'ambiguous-solid.glb'

/**
 * `BufferGeometry`（作業座標系）→ GLB のバイト列（**メートル**）。
 *
 * 実装は design.md「Export」どおり `GLTFExporter` の `{ binary: true }`。
 * マテリアルはビューポートの見た目（SolidMesh.tsx）と揃えた
 * `MeshStandardMaterial` を付け、pbrMetallicRoughness として書き出す
 * （FR-031「マテリアル情報付き」）。法線は出力しない — glTF 仕様では
 * NORMAL 欠落時にクライアントがフラット法線を計算するため、ビューポートの
 * flatShading と同じ見え方になる。
 *
 * @param geometry 生成パイプラインが公開する作業座標系のジオメトリ
 * @param heightMm 実寸の共通シルエット高さ（FR-029。10〜300mm）
 * @param workingHeight 正規化の共通高さ H。既定はパイプラインの
 *   {@link WORKING_HEIGHT}（テスト以外で上書きする理由はない）
 * @throws RangeError `heightMm` が FR-029 の範囲外（scale.ts が弾く）
 * @throws Error ジオメトリに position が無い、または三角形が 1 つも無い場合
 */
export async function generateGlbBytes(
  geometry: BufferGeometry,
  heightMm: number,
  workingHeight: number = WORKING_HEIGHT,
): Promise<Uint8Array<ArrayBuffer>> {
  const position = geometry.getAttribute('position')
  if (position === undefined) {
    throw new Error('generateGlbBytes: geometry has no position attribute')
  }
  const index = geometry.getIndex()
  const triangleCount = index !== null ? index.count / 3 : position.count / 3
  if (triangleCount === 0) {
    throw new Error(
      'generateGlbBytes: geometry has no triangles — nothing to export',
    )
  }

  // 唯一の単位換算点（studio/scale.ts）から GLB / USDZ 専用の m 倍率を取得。
  // 範囲外の heightMm はここで RangeError になる（黙って直さない）
  const metersPerUnit = glbUsdzMetersPerUnit(heightMm, workingHeight)

  // 書き出し専用のクローンに m スケールを焼き込む（ファイル冒頭の解説）。
  // 呼び出し元のジオメトリは変更しない
  const scaled = geometry.clone()
  scaled.scale(metersPerUnit, metersPerUnit, metersPerUnit)
  const material = new MeshStandardMaterial({
    color: '#cfcac1',
    roughness: 0.6,
    metalness: 0.05,
  })
  const mesh = new Mesh(scaled, material)

  try {
    const result = await new GLTFExporter().parseAsync(mesh, { binary: true })
    if (!(result instanceof ArrayBuffer)) {
      // { binary: true } の契約違反（JSON が返るのは binary: false のときだけ）
      throw new Error('generateGlbBytes: GLTFExporter did not return an ArrayBuffer')
    }
    return new Uint8Array(result)
  } finally {
    // クローンとマテリアルはこの関数の所有物。GPU にアップロードされる前に
    // 破棄する（レンダリングには一度も使われない）
    scaled.dispose()
    material.dispose()
  }
}

/**
 * ブラウザでのダウンロード発火（Blob + `<a download>`）。
 * **DOM に触れる唯一の関数**なので、Node のユニットテストからは呼ばず、
 * E2E（Task 8.2）が実ブラウザで検証する。stl.ts の `saveBytesViaAnchor` と
 * 同型だが、Blob の MIME が {@link GLB_MIME} である点だけが異なる。
 */
export function saveGlbBytesViaAnchor(
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
): void {
  const blob = new Blob([bytes], { type: GLB_MIME })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  // Firefox は DOM に接続されていない anchor の click() を無視する
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Safari で click 直後の同期 revoke がダウンロードを取りこぼすことが
  // あるため、現在のタスクを抜けてから解放する
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function defaultConfirm(message: string): boolean {
  if (typeof globalThis.confirm === 'function') {
    return globalThis.confirm(`${message}\nこのまま GLB を書き出しますか？`)
  }
  return true
}

/** GLB ダウンロードの要求。オーケストレータ（App 側の結線）が組み立てる */
export interface GlbDownloadRequest {
  /** 作業座標系のジオメトリ（`GeometryRef.current`） */
  geometry: BufferGeometry
  /** 実寸の共通シルエット高さ mm（store の `options.heightMm`） */
  heightMm: number
  /** 連結成分数（store の `lastResult.componentCount`。`decompose()` 由来の確定値） */
  componentCount: number
  /** 省略時は {@link DEFAULT_GLB_FILE_NAME} */
  fileName?: string
}

/** ダウンロード発火・確認ダイアログの注入点。テストはフェイクを渡す */
export interface GlbDownloadDeps {
  confirmMultipleComponents?: ConfirmMultipleComponents
  save?: SaveBytes
}

export type GlbDownloadResult =
  | {
      status: 'saved'
      bytes: Uint8Array<ArrayBuffer>
      fileName: string
      /** `componentCount > 1` だった場合の警告文（UI 表示用）。単一パーツなら null */
      warning: string | null
    }
  | {
      /** `componentCount > 1` の確認でユーザーが中止した。バイト生成前に抜ける */
      status: 'cancelled'
      warning: string
    }

/**
 * GLB ダウンロードの一連の流れ（FR-031。stl.ts の `downloadStl` と同型）：
 *
 * 1. `componentCount > 1` なら**書き出しの前に**警告して確認する
 *    （警告文は stl.ts の {@link multipleComponentsWarning} を共有 —
 *    同じ事実に別の文言を作らない）
 * 2. FR-029 の m スケールで GLB を生成する
 * 3. ダウンロードを発火する（既定はブラウザの anchor、テストは注入）
 *
 * 戻り値に警告文を含めるので、確認を通した場合も UI（aria-live）で
 * 警告を提示し続けられる。
 */
export async function downloadGlb(
  request: GlbDownloadRequest,
  deps: GlbDownloadDeps = {},
): Promise<GlbDownloadResult> {
  const fileName = request.fileName ?? DEFAULT_GLB_FILE_NAME
  const save = deps.save ?? saveGlbBytesViaAnchor
  const confirm = deps.confirmMultipleComponents ?? defaultConfirm

  const warning =
    request.componentCount > 1
      ? multipleComponentsWarning(request.componentCount)
      : null
  if (warning !== null && !confirm(warning, request.componentCount)) {
    return { status: 'cancelled', warning }
  }

  const bytes = await generateGlbBytes(request.geometry, request.heightMm)
  save(bytes, fileName)
  return { status: 'saved', bytes, fileName, warning }
}
