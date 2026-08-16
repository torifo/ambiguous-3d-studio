/**
 * バイナリ STL 出力（Task 5.3 / FR-029 / FR-030 / US-005）。
 *
 * ## 構成 — バイト生成とダウンロード発火を分離する
 *
 * - {@link generateStlBytes} … `BufferGeometry` → バイナリ STL のバイト列。
 *   純関数で DOM に触れないため、Node 上の Vitest でそのまま検証できる。
 * - {@link saveBytesViaAnchor} … Blob + `<a download>` によるブラウザの
 *   ダウンロード発火。**DOM に触れるのはこの薄い層だけ**。
 * - {@link downloadStl} … 上記 2 つを束ね、`componentCount > 1` の
 *   出力前警告（US-005）を差し込むオーケストレーション。ダウンロード
 *   発火と確認ダイアログは注入可能（テストではフェイクを渡す）。
 *
 * ## スケール（FR-029）
 *
 * 作業座標系は無次元。STL は**ミリメートル**で書き出す。倍率は
 * `studio/scale.ts` の {@link stlMmPerUnit}（アプリ唯一の換算点）から取得し、
 * `workingHeight` にはパイプラインの正規化定数 {@link WORKING_HEIGHT} を渡す。
 * **`glbUsdzMetersPerUnit`（m 換算）をここで使ってはならない** — あれは
 * GLB / USDZ 専用で、混用すると 1000 倍事故になる（scale.ts 冒頭を参照）。
 *
 * スケールはジオメトリ本体ではなく、書き出し用に一時生成する `Mesh` の
 * `matrixWorld` に適用する。呼び出し元のジオメトリ（ビューポートが参照
 * している実体）は一切変更しない。
 */
import { Mesh } from 'three'
import type { BufferGeometry } from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { stlMmPerUnit } from '../studio/scale'
import { WORKING_HEIGHT } from '../studio/useGenerationPipeline'

/** STL の MIME タイプ（IANA 登録名） */
export const STL_MIME = 'model/stl'

/** 既定のダウンロードファイル名 */
export const DEFAULT_STL_FILE_NAME = 'ambiguous-solid.stl'

/**
 * `componentCount > 1` の出力前警告文（US-005）。
 * `decompose()` 由来の確定値なので断定の文体（「〜です」ではなく事実の提示）。
 * UI（StatusBanner / aria-live）にもこの文言をそのまま使える。
 */
export function multipleComponentsWarning(componentCount: number): string {
  return (
    `生成結果は ${componentCount} 個の非連結パーツに分かれています。` +
    'プリントするとバラバラの破片になり、1 つの立体として組み立てることはできません。'
  )
}

/**
 * `BufferGeometry`（作業座標系）→ バイナリ STL のバイト列（**ミリメートル**）。
 *
 * 実装は design.md「Export」どおり `STLExporter` の `{ binary: true }`。
 * 倍率 `stlMmPerUnit(heightMm, workingHeight)` を一時 `Mesh` のワールド行列に
 * 載せてから書き出す（STLExporter は各頂点に `matrixWorld` を適用する）。
 * 入力ジオメトリは変更しない。
 *
 * @param geometry 生成パイプラインが公開する作業座標系のジオメトリ
 * @param heightMm 実寸の共通シルエット高さ（FR-029。10〜300mm）
 * @param workingHeight 正規化の共通高さ H。既定はパイプラインの
 *   {@link WORKING_HEIGHT}（テスト以外で上書きする理由はない）
 * @throws RangeError `heightMm` が FR-029 の範囲外（scale.ts が弾く）
 * @throws Error ジオメトリに position が無い、または三角形が 1 つも無い場合
 */
export function generateStlBytes(
  geometry: BufferGeometry,
  heightMm: number,
  workingHeight: number = WORKING_HEIGHT,
): Uint8Array<ArrayBuffer> {
  const position = geometry.getAttribute('position')
  if (position === undefined) {
    throw new Error('generateStlBytes: geometry has no position attribute')
  }
  const index = geometry.getIndex()
  const triangleCount =
    index !== null ? index.count / 3 : position.count / 3
  if (triangleCount === 0) {
    throw new Error(
      'generateStlBytes: geometry has no triangles — nothing to export',
    )
  }

  // 唯一の単位換算点（studio/scale.ts）から STL 専用の mm 倍率を取得する。
  // 範囲外の heightMm はここで RangeError になる（黙って直さない）
  const mmPerUnit = stlMmPerUnit(heightMm, workingHeight)

  // 書き出し専用の一時 Mesh。ジオメトリは共有参照だが、スケールは
  // この Mesh の行列にだけ載るので呼び出し元の実体は変わらない。
  // マテリアルは exporter に読まれず、レンダリングもしないので GPU 資源を持たない
  const mesh = new Mesh(geometry)
  mesh.scale.setScalar(mmPerUnit)
  // Node / テスト環境にはレンダリングループが無く matrixWorld が自動更新
  // されないため、明示的に焼き込む（これを忘れると倍率 1 で書き出される）
  mesh.updateMatrixWorld(true)

  const data = new STLExporter().parse(mesh, { binary: true })
  return new Uint8Array(data.buffer)
}

/** ダウンロード発火の注入点。Node のテストはフェイクを渡す */
export type SaveBytes = (
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
) => void

/**
 * ブラウザでのダウンロード発火（Blob + `<a download>`）。
 * **DOM に触れる唯一の関数**なので、Node のユニットテストからは呼ばず、
 * E2E（Task 8.2）が実ブラウザで検証する。
 */
export function saveBytesViaAnchor(
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
): void {
  const blob = new Blob([bytes], { type: STL_MIME })
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

/**
 * `componentCount > 1` のときの確認の注入点。`false` を返すと書き出しを
 * 中止する。省略時は `window.confirm`（ブラウザ）、confirm が無い環境では
 * 続行（警告は結果オブジェクトに残る）。
 */
export type ConfirmMultipleComponents = (
  message: string,
  componentCount: number,
) => boolean

function defaultConfirm(message: string): boolean {
  if (typeof globalThis.confirm === 'function') {
    return globalThis.confirm(`${message}\nこのまま STL を書き出しますか？`)
  }
  return true
}

/** STL ダウンロードの要求。オーケストレータ（App 側の結線）が組み立てる */
export interface StlDownloadRequest {
  /** 作業座標系のジオメトリ（`GeometryRef.current`） */
  geometry: BufferGeometry
  /** 実寸の共通シルエット高さ mm（store の `options.heightMm`） */
  heightMm: number
  /** 連結成分数（store の `lastResult.componentCount`。`decompose()` 由来の確定値） */
  componentCount: number
  /** 省略時は {@link DEFAULT_STL_FILE_NAME} */
  fileName?: string
}

/** ダウンロード発火・確認ダイアログの注入点。テストはフェイクを渡す */
export interface StlDownloadDeps {
  confirmMultipleComponents?: ConfirmMultipleComponents
  save?: SaveBytes
}

export type StlDownloadResult =
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
 * STL ダウンロードの一連の流れ（US-005 / FR-030）：
 *
 * 1. `componentCount > 1` なら**書き出しの前に**警告して確認する
 *    （バラバラの破片は組み立てられない — 生成してから警告しても遅い）
 * 2. FR-029 の mm スケールでバイナリ STL を生成する
 * 3. ダウンロードを発火する（既定はブラウザの anchor、テストは注入）
 *
 * 戻り値に警告文を含めるので、確認を通した場合も UI（aria-live）で
 * 警告を提示し続けられる。
 */
export function downloadStl(
  request: StlDownloadRequest,
  deps: StlDownloadDeps = {},
): StlDownloadResult {
  const fileName = request.fileName ?? DEFAULT_STL_FILE_NAME
  const save = deps.save ?? saveBytesViaAnchor
  const confirm = deps.confirmMultipleComponents ?? defaultConfirm

  const warning =
    request.componentCount > 1
      ? multipleComponentsWarning(request.componentCount)
      : null
  if (warning !== null && !confirm(warning, request.componentCount)) {
    return { status: 'cancelled', warning }
  }

  const bytes = generateStlBytes(request.geometry, request.heightMm)
  save(bytes, fileName)
  return { status: 'saved', bytes, fileName, warning }
}
