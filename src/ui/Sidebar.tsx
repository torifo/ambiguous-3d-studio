/**
 * 左パネル本体（Task 5.2）。入力・オプション・リセット・状態表示のすべてを
 * ここで組み立てる。**必須 props なし**で動く — 状態はストアから読み、
 * ストアの外にあるもの（パイプラインの retry、カメラ、ジオメトリ ref、
 * Sweet Spot 判定）だけを省略可能な props として受け取る。これが App.tsx
 * との継ぎ目：オーケストレーターは `<Sidebar />` を置き、判明している
 * ものから順に props を配線すればよい。
 *
 * ## props の配線契約（App.tsx / Wave 5.1・5.4 との継ぎ目）
 * - `onRetryInit` — `useGenerationPipeline()` の `retry` を渡す（FR-025）。
 *   未配線時は store の `retryInit()` にフォールバックする（状態機械は戻るが
 *   Worker クライアントは再起動されないため、アプリでは必ず配線する）
 * - `onResetView` — カメラを初期の俯瞰へ戻す操作（FR-006）。カメラは
 *   scene/CameraRig（Task 5.4）の所有物でストアに存在しないため、コール
 *   バック注入とする。未配線時はボタンを無効化して未接続である旨を示す
 * - `geometryRef` — `useGenerationPipeline()` が公開する ref（ADR-004）。
 *   FR-029 の「指定値から導かれる X / Y / Z の実寸」表示に使う。未配線時は
 *   高さ（= 指定値そのもの）だけを表示する
 * - `sweetSpot` — scene/SweetSpot.ts（Task 5.4）の判定結果。未配線時は
 *   「未計測」を表示する
 *
 * ## 台座の開示（FR-015）
 * 台座は両視点から見える位置に材料を足すため、**錯視を確実に壊す**。
 * これはトレードオフの明示が要件そのもの — チェックボックスのラベルと
 * 説明文で、有効化するその場所で開示する（印刷後に気付かせない）。
 */
import { useCallback, useId, useRef, useSyncExternalStore } from 'react'
import type { BufferGeometry } from 'three'
import {
  MAX_BASEPLATE_MM,
  MIN_BASEPLATE_MM,
  useStudioStore,
} from '../store/useStudioStore'
import {
  HEIGHT_STEP_MM,
  MAX_HEIGHT_MM,
  MIN_HEIGHT_MM,
  realWorldSizeMm,
  type RealWorldSizeMm,
} from '../studio/scale'
import { WORKING_HEIGHT, type GeometryRef } from '../studio/useGenerationPipeline'
import { AxisAngleControl } from './AxisAngleControl'
import { ExportPanel } from './ExportPanel'
import { NumberField } from './NumberField'
import { SilhouettePicker } from './SilhouettePicker'
import { StatusBanner } from './StatusBanner'
import { SweetSpotIndicator, type SweetSpotIndicatorProps } from './SweetSpotIndicator'

/** ボタンの共通スタイル（44px 以上のタップ領域 + 可視フォーカス） */
const BUTTON_CLASS =
  'min-h-11 rounded border border-neutral-600 px-3 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

/** チェックボックスの共通スタイル */
const CHECKBOX_CLASS =
  'h-4 w-4 shrink-0 accent-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

/**
 * Sweet Spot 未配線時の表示（未計測）。シーン接続後に実値が流れ込む。
 * 角度差の数値は props ではなく scene 側の `useFrame` が DOM を直接
 * 更新する（SweetSpotIndicator.tsx / FR-021 / NFR-002）。
 */
const NO_SWEET_SPOT: SweetSpotIndicatorProps = {
  target: null,
  matched: false,
}

/** mm 表示（小数 1 桁まで） */
function fmtMm(value: number): string {
  return `${Math.round(value * 10) / 10}mm`
}

/**
 * FR-029: 指定値（共通シルエット高さ mm）から導かれる X / Y / Z の実寸。
 *
 * ジオメトリは store でなく外部 ref にある（ADR-004）。ref はレンダー中に
 * 読めないため、`useSyncExternalStore` の external-store 接続として読む：
 * 「いつ読み直すか」は studio store の購読が知らせ（ref の差し替えは
 * `status: 'success'` の報告と同期している — useGenerationPipeline.ts）、
 * 実体の読み取りは getSnapshot（レンダー外）で行う。スナップショットは
 * (geometry, heightMm) が変わらない限り同一参照を返し、無限再レンダーを防ぐ。
 */
function useRealWorldSize(
  geometryRef: GeometryRef | undefined,
  heightMm: number,
): RealWorldSizeMm | null {
  const cacheRef = useRef<{
    geometry: BufferGeometry | null
    heightMm: number
    sizes: RealWorldSizeMm | null
  }>({ geometry: null, heightMm: 0, sizes: null })

  const subscribe = useCallback(
    (onChange: () => void) => useStudioStore.subscribe(onChange),
    [],
  )

  const getSnapshot = useCallback((): RealWorldSizeMm | null => {
    const status = useStudioStore.getState().status
    const geometry = status === 'success' ? (geometryRef?.current ?? null) : null
    const cache = cacheRef.current
    if (cache.geometry === geometry && cache.heightMm === heightMm) return cache.sizes
    let sizes: RealWorldSizeMm | null = null
    if (geometry !== null) {
      if (geometry.boundingBox === null) geometry.computeBoundingBox()
      const box = geometry.boundingBox
      if (box !== null) sizes = realWorldSizeMm(box, heightMm, WORKING_HEIGHT)
    }
    cacheRef.current = { geometry, heightMm, sizes }
    return sizes
  }, [geometryRef, heightMm])

  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 視点スナップのボタン定義（FR-022）。`view` は scene/SweetSpot.ts の `SnapView` に対応 */
const SNAP_BUTTONS: ReadonlyArray<{
  view: 'front' | 'side' | 'iso'
  label: string
  hint: string
}> = [
  { view: 'front', label: '正面 (A)', hint: '+Z から正射影。シルエット A が成立する角度' },
  { view: 'side', label: '側面 (B)', hint: '+X から正射影。シルエット B が成立する角度' },
  { view: 'iso', label: '俯瞰', hint: '立体の全体像を見る角度' },
]

export interface SidebarProps {
  /** FR-025: init-failed の再試行。`useGenerationPipeline()` の `retry` を渡す */
  onRetryInit?: () => void
  /** FR-006: 視点リセット。カメラ所有者（scene/ 側）が実装を注入する */
  onResetView?: () => void
  /** FR-022: 視点スナップ。scene/SweetSpot.ts の `requestSnap` を渡す */
  onSnapView?: (view: 'front' | 'side' | 'iso') => void
  /** ADR-004 のジオメトリ参照。FR-029 の X / Y / Z 実寸表示に使う */
  geometryRef?: GeometryRef
  /** Sweet Spot 判定結果（scene/SweetSpot.ts）。未配線時は未計測表示 */
  sweetSpot?: SweetSpotIndicatorProps
}

/** 左パネル。入力（視点 A / B）・オプション・視点スナップ・リセット・状態表示のすべて */
export function Sidebar({
  onRetryInit,
  onResetView,
  onSnapView,
  geometryRef,
  sweetSpot,
}: SidebarProps) {
  const baseId = useId()
  const options = useStudioStore((s) => s.options)
  const setVirtualMirror = useStudioStore((s) => s.setVirtualMirror)
  const setBaseplateEnabled = useStudioStore((s) => s.setBaseplateEnabled)
  const setBaseplateThicknessMm = useStudioStore((s) => s.setBaseplateThicknessMm)
  const setHeightMm = useStudioStore((s) => s.setHeightMm)
  const resetShapes = useStudioStore((s) => s.resetShapes)

  const mirrorId = `${baseId}-mirror`
  const plateId = `${baseId}-plate`
  const plateDescId = `${baseId}-plate-desc`
  const thicknessId = `${baseId}-plate-thickness`
  const heightId = `${baseId}-height`
  const heightDescId = `${baseId}-height-desc`

  const sizes = useRealWorldSize(geometryRef, options.heightMm)

  return (
    /*
      768px 未満ではこの枠がボトムシートの中身になる（App.tsx がシェルの
      向きを切り替える）。ここで効かせるのは 2 つ（FR-026 / Task 7.1）：
      - `pad-safe` … 左右下のセーフエリアを避けた内側余白（index.css）。
        ホームインジケータの上に「リセット」ボタンが潜り込むのを防ぐ
      - `overscroll-contain` … シートを端までスクロールしたあとの連鎖で
        背後のページが動かないようにする（1 本指ドラッグの誤スクロール防止）
    */
    <div className="pad-safe flex h-full flex-col gap-4 overflow-y-auto overscroll-contain pt-4">
      <h1 className="text-sm font-semibold tracking-wide text-neutral-100">
        Ambiguous 3D Studio
      </h1>

      <StatusBanner onRetryInit={onRetryInit} />
      <SweetSpotIndicator {...(sweetSpot ?? NO_SWEET_SPOT)} />

      <SilhouettePicker viewpoint="a" />
      <SilhouettePicker viewpoint="b" />
      {/* FR-102: 視点 B の押し出し軸角。既定 90°（直交）で従来と変わらない */}
      <AxisAngleControl />
      {/* FR-101: 視点 C は任意。既定は 2 視点で、追加は SilhouettePicker 側の
          「視点 C を追加する」ボタンから。三方向変身立体は特例であり既定ではない */}
      <SilhouettePicker viewpoint="c" />

      <section aria-labelledby={`${baseId}-options-heading`} className="flex flex-col gap-3">
        <h2 id={`${baseId}-options-heading`} className="text-xs font-semibold text-neutral-200">
          オプション
        </h2>

        {/* 仮想ミラー（FR-024） */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor={mirrorId}
            className="flex min-h-11 items-center gap-2 text-xs text-neutral-200"
          >
            <input
              id={mirrorId}
              type="checkbox"
              checked={options.virtualMirror}
              onChange={(event) => setVirtualMirror(event.target.checked)}
              className={CHECKBOX_CLASS}
            />
            仮想ミラー
          </label>
          <p className="text-[11px] text-neutral-500">
            視点 B 側に鏡を置き、1 つの画面で両方のシルエットを同時に確認できます。
          </p>
        </div>

        {/* 台座（FR-015）。錯視を壊すトレードオフを有効化の場で開示する */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor={plateId}
            className="flex min-h-11 items-center gap-2 text-xs text-neutral-200"
          >
            <input
              id={plateId}
              type="checkbox"
              checked={options.baseplate.enabled}
              aria-describedby={plateDescId}
              onChange={(event) => setBaseplateEnabled(event.target.checked)}
              className={CHECKBOX_CLASS}
            />
            台座を付ける（両方の見え方に台座が加わります）
          </label>
          <p id={plateDescId} className="text-[11px] text-neutral-500">
            台座は視点 A・B 両方のシルエットの下端に矩形として現れます。錯視は底面の分だけ確実に崩れます
            — 印刷の安定と引き換えのオプションです（既定は無効）。
          </p>
          <NumberField
            id={thicknessId}
            label={`台座の厚み（mm、${MIN_BASEPLATE_MM}〜${MAX_BASEPLATE_MM}）`}
            value={options.baseplate.thicknessMm}
            min={MIN_BASEPLATE_MM}
            max={MAX_BASEPLATE_MM}
            step={0.1}
            disabled={!options.baseplate.enabled}
            onCommit={setBaseplateThicknessMm}
          />
          <p className="text-[11px] text-neutral-500">
            厚みは実寸の高さに含まれません（立体の下方向に追加されます）。
          </p>
        </div>

        {/* 実寸（FR-029）。物理量は「共通シルエット高さ mm」ただ 1 つ */}
        <div className="flex flex-col gap-1">
          <NumberField
            id={heightId}
            label={`実寸の高さ（mm、${MIN_HEIGHT_MM}〜${MAX_HEIGHT_MM}）`}
            value={options.heightMm}
            min={MIN_HEIGHT_MM}
            max={MAX_HEIGHT_MM}
            step={HEIGHT_STEP_MM}
            describedById={heightDescId}
            onCommit={setHeightMm}
          />
          <p id={heightDescId} className="text-[11px] text-neutral-500">
            実寸は「共通シルエット高さ」のこの 1 つの値で決まります。出力される STL
            はミリメートル単位です。
          </p>
          <dl className="grid grid-cols-3 gap-1 text-[11px]">
            <div>
              <dt className="text-neutral-500">幅（X）</dt>
              <dd className="text-neutral-200">{sizes !== null ? fmtMm(sizes.x) : '—'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">高さ（Y）</dt>
              <dd className="text-neutral-200">
                {sizes !== null ? fmtMm(sizes.y) : fmtMm(options.heightMm)}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">奥行（Z）</dt>
              <dd className="text-neutral-200">{sizes !== null ? fmtMm(sizes.z) : '—'}</dd>
            </div>
          </dl>
          {sizes === null && (
            <p className="text-[11px] text-neutral-600">
              幅と奥行は生成完了後に実測から表示されます。
            </p>
          )}
        </div>
      </section>

      {/*
        視点スナップ（FR-022）。カメラの実装は scene/ が所有し、UI はここから
        `requestSnap` を呼ぶだけ。錯視の「正解アングル」に一手で到達できることが
        この機能の目的なので、探索に迷った利用者の逃げ道でもある。

        側面は必ず **+X** 側。−X に置くとシルエット B が左右反転する
        （design.md「2.1 軸の割り当てとカメラ規約」）。方向の指定は
        scene/SweetSpot.ts の SNAP_VIEWS が持つ。
      */}
      <section aria-labelledby={`${baseId}-snap-heading`} className="flex flex-col gap-1.5">
        <h2 id={`${baseId}-snap-heading`} className="text-xs font-semibold text-neutral-200">
          視点スナップ
        </h2>
        <div className="flex gap-1.5">
          {SNAP_BUTTONS.map(({ view, label, hint }) => (
            <button
              key={view}
              type="button"
              onClick={() => onSnapView?.(view)}
              disabled={onSnapView === undefined}
              title={hint}
              className={`${BUTTON_CLASS} flex-1`}
            >
              {label}
            </button>
          ))}
        </div>
        {onSnapView === undefined && (
          <p className="text-[10px] text-neutral-500">
            視点スナップは 3D ビューポート接続後に有効になります。
          </p>
        )}
        {/* FR-027: ズームだけはボタンではなくキー操作で提供する（実装は
            scene/Viewport.tsx）。到達方法が分からないと使えないので明示する */}
        <p className="text-[10px] text-neutral-500">
          3D ビューにフォーカスを移すと ＋ / − キーでズームできます。
        </p>
      </section>

      {/* 書き出し（FR-030 / FR-031）。ジオメトリ ref を渡す — ADR-004 */}
      <ExportPanel geometryRef={geometryRef} />

      <section aria-labelledby={`${baseId}-reset-heading`} className="flex flex-col gap-1.5">
        <h2 id={`${baseId}-reset-heading`} className="text-xs font-semibold text-neutral-200">
          リセット
        </h2>
        {/* FR-006: 形状リセットはストア所有。視点リセットはカメラ所有者から注入 */}
        <button type="button" onClick={resetShapes} className={BUTTON_CLASS}>
          形状をリセット（正方形 × 円へ）
        </button>
        <button
          type="button"
          onClick={onResetView}
          disabled={onResetView === undefined}
          className={BUTTON_CLASS}
        >
          視点をリセット
        </button>
        {onResetView === undefined && (
          <p className="text-[10px] text-neutral-500">
            視点リセットは 3D ビューポート接続後に有効になります。
          </p>
        )}
      </section>
    </div>
  )
}
