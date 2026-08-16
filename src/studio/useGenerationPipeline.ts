/**
 * 生成パイプライン（Task 4.1 / design.md「Components → studio/」）。
 *
 * 入力 → 輪郭抽出 → 正規化 → プリフライト → 押し出し深さ算出 → Worker
 * リクエスト → MeshGL → BufferGeometry → ストア反映 → ジオメトリ公開、を
 * 1 本に繋ぐ**唯一の場所**。各モジュールは「自分の隣」しか知らないため、
 * ここが全工程を所有しないとアプリとして繋がらない。
 *
 * ## ソース分岐はここで書き切る
 *
 * `source.kind` の `switch` は preset / text / svg の**全分岐**を持つ。
 * text と svg は Wave 1 のスタブ（現状は NotImplemented で reject）を呼び、
 * Wave 6 は**スタブの中身のみ**を差し替える — このファイルは編集しない。
 * スタブの reject は「入力の拒否」として扱われ、直前の有効入力へ復帰する
 * （FR-006 と同じ経路。実装が入れば同じ経路が本物のパースエラーを扱う）。
 *
 * ## 世代エポックの流れ（useStudioStore.ts のパイプライン契約）
 *
 * 1. 入力変更 → store が epoch を進める → 本パイプラインの購読が同期的に
 *    発火し、**同一トランザクションで**外部 ref のジオメトリを破棄する
 *    （store はジオメトリを持たない — ADR-004。ref のクリアはここの責務）
 * 2. 解析・正規化が**実際に通過した時点**で `inputAccepted(epoch)`、
 *    拒否なら `restoreLastValidInput(epoch)`。設定した瞬間にスナップ
 *    ショットすると、非同期の拒否より前の再編集で無効入力が復帰先になる
 * 3. Worker への送出時、client が `acquireEpoch`（= `startGenerating`）で
 *    epoch を取得し、終端通知（onSuccess / onError）に**同じ値**を返す。
 *    onSuccess は ref に触れる前に epoch を現在値と突き合わせる —
 *    追い越された旧世代の遅延レスポンスが stale なメッシュを再描画しない
 *
 * ## 生成のゲートは EMPTY_INTERSECTION のみ
 *
 * `PreflightReport.ok` は「警告ゼロ」の意味であり、生成可否の判定に
 * 使ってはならない。`EMPTY_BAND` が出る組み合わせ（離れたグリフ・複数
 * パーツの SVG）も生成は実行し、欠落する帯は警告として提示する（US-001）。
 * 生成しないのは交差が空だと断定できる `EMPTY_INTERSECTION` だけ。
 *
 * ## Wave 5 への公開面
 *
 * ジオメトリは React state ではなく `GeometryRef`（`{ current }`）で公開する
 * （ADR-004）。参照の差し替えは store の状態変化（`status: 'success'` /
 * `lastResult` 更新）と同期しているので、Viewport は store を購読して
 * 再描画のタイミングを知り、実体は `geometryRef.current` から読む。
 *
 * ## 工程計測（Task 7.2 / NFR-001）
 *
 * `studio/perf.ts` のカーソルを工程境界に置く。ここが持つのは
 * `contour` / `normalize` / `preflight` / `dispatch` / `render` の 5 工程で、
 * `debounce` / `transport` / `csg` は `worker/client.ts` が、`csg` の内訳は
 * `worker/csg.worker.ts` が記録する。**計測は工程の追加も分岐も行わない** —
 * `perf.*` は公開ビルドで no-op に畳まれるので、呼び出し位置を動かす以外の
 * 影響をパイプラインに与えてはならない。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { BufferGeometry } from 'three'
import type { StoreApi } from 'zustand/vanilla'
import { boundsOf, normalizeSilhouette } from '../geometry/normalize'
import { meshGLToBufferGeometry, validateMeshGL } from '../geometry/meshgl'
import { runPreflight } from '../geometry/preflight'
import type { Contour, SilhouetteSource } from '../geometry/types'
import { presetToContours } from '../sources/presets'
import { svgToContours } from '../sources/svg'
import { textToContours } from '../sources/text'
import { CsgWorkerClient, type CsgClientOptions } from '../worker/client'
import {
  computeDepths,
  DEPTH_MARGIN as PROTOCOL_DEPTH_MARGIN,
  viewpointCamera,
  type CsgRequest,
  type SilhouetteExtent,
  type ViewpointCamera,
} from '../worker/protocol'
import {
  useStudioStore,
  type StudioInput,
  type StudioOptions,
  type StudioState,
} from '../store/useStudioStore'
import { abandonRun, finishRunOnNextFrame, stage, startRun } from './perf'
import { stlMmPerUnit } from './scale'

/**
 * 正規化の共通高さ H（無次元の作業座標系。FR-010）。
 * プリセットが単位ボックス（±1）近傍で定義されているため 2 を採用する。
 * 実寸換算（studio/scale.ts）の `workingHeight` 引数にはこの値を渡すこと。
 */
export const WORKING_HEIGHT = 2

/**
 * 押し出し深さのマージン（design.md「2. 押し出し深さ」）。
 *
 * かつては Worker 側と**同じ値を 2 か所に書いて**テストで等値を検証していた。
 * 現在は `worker/protocol.ts`（依存ゼロ・Wasm を引き込まない）が唯一の定義で、
 * ここは再輸出。深さの算出式そのものも同じファイルの `computeDepths` に一本化
 * してあるので、視点 C や斜交軸を足しても算出側と検証側が食い違わない。
 * csg.worker.ts を import しないのは変わらない — あちらは `manifold-3d` と
 * `manifold.wasm?url` をトップレベルで読み、メインスレッドのバンドルへ
 * Wasm 一式を引き込んでしまうため。
 */
export const DEPTH_MARGIN = PROTOCOL_DEPTH_MARGIN

/**
 * 視点ごとのカメラ規約（design.md「2.1」の一般化）を Wave 5 のシーンへ公開する。
 * 実体は `worker/protocol.ts` の {@link viewpointCamera}（軸の割り当てと
 * カメラの置き場所を 1 か所で決めているファイル）。
 *
 * - **A**: 位置 `(0, 0, 1)` 方向 / up `(0, 1, 0)`
 * - **B**: 位置 `(sin φ, 0, cos φ)` 方向 / up `(0, 1, 0)`（φ=90° で従来の +X）
 * - **C**: 位置 `(0, 1, 0)` 方向（真上）/ up **`(0, 0, -1)`**
 *
 * up を取り違えると、寸法は合ったまま**そのシルエットだけ鏡像になる**。
 */
export { viewpointCamera, type ViewpointCamera }

/** ジオメトリの外部保持点（ADR-004）。React の `RefObject` と構造互換 */
export interface GeometryRef {
  current: BufferGeometry | null
}

export interface GenerationPipelineOptions {
  /** 省略時はアプリ本体の `useStudioStore`。テストは vanilla store を注入する */
  store?: StoreApi<StudioState>
  /** 省略時は内部で生成。React フックは自前の ref を渡して再マウントを跨がせる */
  geometryRef?: GeometryRef
  /** Worker クライアントへの注入点（テストはモック Worker ファクトリを渡す） */
  clientOptions?: CsgClientOptions
}

export interface GenerationPipelineHandle {
  /** 最新の生成結果の BufferGeometry。store が success を報告した時点で最新 */
  geometryRef: GeometryRef
  /** init-failed からの再試行（FR-025）。store と Worker client の両方を復帰させる */
  retry: () => void
  /** 購読解除・Worker 破棄・ジオメトリ破棄（アンマウント・テスト用） */
  dispose: () => void
}

/** unknown な例外から人間が読めるメッセージを取り出す */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 入力ソース → `Contour[]`。**全 3 分岐をここで書き切る**（Task 4.1）。
 * reject は呼び出し側で「入力の拒否」として扱われる。
 *
 * ## ここは静的 import のままにしてある（Task 7.2 のバンドル分割）
 *
 * `sources/svg.ts` を `await import()` に移すとメインチャンクを 19.4kB
 * （gzip 7.4kB）減らせるが、拒否経路に非同期ホップが 1 つ増え、フェイク
 * タイマーで駆動している既存の復帰テスト（「svg の拒否で直前の有効入力へ
 * 復帰する」）が確定的に落ちる。得られる 7.4kB に対して割に合わないので
 * 静的のまま残す。分割済みなのは `opentype.js`（gzip 50.6kB）だけで、
 * これは `sources/text.ts` の中に閉じている。
 * **preset も動的にしない** — 初期入力（正方形 × 円）は初回描画の依存で、
 * 遅延させると初期表示そのものが遅くなる。
 */
function resolveSource(source: SilhouetteSource): Promise<Contour[]> {
  switch (source.kind) {
    case 'preset':
      // presetToContours は未知 id で同期 throw する。呼び出し側の try が
      // Promise.all の引数評価ごと捕まえるので、拒否経路は text / svg と同じ
      return Promise.resolve(presetToContours(source.id))
    case 'text':
      return textToContours(source.value, source.fontId)
    case 'svg':
      return svgToContours(source.raw, source.fileName)
  }
}

/**
 * 台座オプション → Worker リクエストの台座指定。
 * 厚みは mm 指定（FR-015）なので、実寸換算（FR-029）の逆向きで
 * 作業座標系の厚みへ変換する（Worker は作業座標しか知らない）。
 * 実装されるまで（Task 6.4）は有効化すると Worker が INVALID_INPUT で拒否する。
 */
function baseplateFor(options: StudioOptions): CsgRequest['baseplate'] {
  if (!options.baseplate.enabled) return null
  const height =
    options.baseplate.thicknessMm / stlMmPerUnit(options.heightMm, WORKING_HEIGHT)
  return { enabled: true, height }
}

/**
 * 再生成が必要な台座設定の指紋。store のオプション変更は epoch を進めない
 * （入力変更ではない）ため、CSG 結果に影響する台座だけをここで監視する。
 * `heightMm` は台座の作業座標厚みの分母に入るので、有効時のみ指紋に含める。
 */
function baseplateSignature(options: StudioOptions): string {
  return options.baseplate.enabled
    ? `${options.baseplate.thicknessMm}mm@${options.heightMm}mm`
    : 'off'
}

/**
 * パイプライン本体（React 非依存）。テストは vanilla store とモック Worker で
 * これを直接駆動する。アプリ本体は {@link useGenerationPipeline} 経由で
 * **1 回だけ**生成する（購読ごとに生成が走ってはならない）。
 *
 * 生成した瞬間に Worker が起動して Wasm 先読みが始まり、現在の入力
 * （初期状態なら正方形 × 円、epoch 0）の解析が走る。生成リクエストは
 * client が ready 到達まで保持するため、`ready` に達した時点で初期入力の
 * 生成がちょうど 1 回実行される（FR-025）。
 */
export function createGenerationPipeline(
  options: GenerationPipelineOptions = {},
): GenerationPipelineHandle {
  const store = options.store ?? useStudioStore
  const geometryRef = options.geometryRef ?? { current: null }

  let disposed = false
  /**
   * 最新 epoch の入力が「Worker へ送ってよい」と確定しているか。
   * 入力変更で false に戻し、解析・ゲートを通過した時点で true にする。
   * client にはデバウンス窓・ready 待ちの pending を取り消す API がないため、
   * ゲートで却下された入力が最新の間に古い payload の送出時刻が来ても、
   * `acquireEpoch` が null を返して破棄させる（ここが唯一の関所）。
   */
  let dispatchAllowed = false
  /**
   * `startGenerating()` の supersede（generating 中の開始）による epoch 前進を
   * 入力変更と区別するフラグ。区別しないと「生成開始 → epoch 前進 → 入力変更と
   * 誤認して再解析 → 再生成 → …」の無限ループになる。
   */
  let inAcquireEpoch = false
  /** 処理済みの epoch。-1 は未処理で、生成直後に現在の入力を必ず 1 回処理する */
  let handledEpoch = -1
  let handledBaseplateSig = ''

  /** ref の差し替え。古いジオメトリは GPU リソースごと破棄する */
  const setGeometry = (geometry: BufferGeometry | null): void => {
    const previous = geometryRef.current
    if (previous !== null && previous !== geometry) previous.dispose()
    geometryRef.current = geometry
  }

  /** supersede による epoch 前進を購読側が入力変更と誤認しないための包み */
  const acquire = (): number | null => {
    inAcquireEpoch = true
    try {
      return store.getState().startGenerating()
    } finally {
      inAcquireEpoch = false
    }
  }

  const client = new CsgWorkerClient(
    {
      acquireEpoch: () => {
        if (disposed || !dispatchAllowed) return null
        return acquire()
      },
      onSuccess: (epoch, result) => {
        if (disposed) return
        // ref に触れる前に必ず epoch を突き合わせる（トラップ 2）。client の
        // 世代 ID と store の epoch 検査に加えた三重目の防御で、「レスポンス
        // 到着〜requestGeneration 発行」の隙間に届く旧世代を確実に弾く
        if (epoch !== store.getState().generationEpoch) {
          abandonRun('stale-response')
          return
        }
        let geometry: BufferGeometry
        try {
          const mesh = {
            numProp: 3,
            vertProperties: result.positions,
            triVerts: result.indices,
          }
          validateMeshGL(mesh)
          geometry = meshGLToBufferGeometry(mesh)
        } catch (err) {
          // 転送途中の破損・契約違反。壊れたメッシュを描画・出力させない
          abandonRun('mesh-invalid')
          store.getState().generationFailed(epoch, {
            code: 'NOT_MANIFOLD',
            detail: messageOf(err),
          })
          return
        }
        // ここから先が描画ハンドオフ：ジオメトリ差し替え → store コミット →
        // React 再レンダリング → 次フレームの描画発行（perf.ts の 'render' 解説）
        stage('render')
        setGeometry(geometry)
        store.getState().generationSucceeded(epoch, {
          componentCount: result.componentCount,
          volume: result.volume,
          triangleCount: result.indices.length / 3,
          elapsedMs: result.elapsedMs,
        })
        finishRunOnNextFrame()
      },
      onError: (epoch, error) => {
        if (disposed) return
        abandonRun(`generation-failed:${error.code}`)
        store.getState().generationFailed(epoch, error)
      },
      onReady: () => {
        if (disposed) return
        store.getState().wasmReady()
      },
      onInitFailed: (detail) => {
        if (disposed) return
        store.getState().wasmInitFailed(detail)
      },
    },
    options.clientOptions,
  )

  /**
   * epoch 1 つ分の処理：輪郭抽出 → 正規化 → 受理コミット → プリフライト →
   * ゲート → 深さ算出 → Worker リクエスト。
   *
   * 深さ（FR-011 / FR-101 / FR-102）は `worker/protocol.ts` の
   * {@link computeDepths} が**唯一の根拠**。Worker は同じ関数で防御的に検証し、
   * 不足を INVALID_INPUT で弾く。以前はこの 2 か所に同じ式を手書きしていたが、
   * 視点 C と斜交軸で式が「相手 bbox の幅」から
   * `(wB + wA·|cos φ|)/|sin φ|` と `max(…, C の寄与)` に変わるため、
   * 手書きを 2 本維持すると必ずどちらかが取り残される。
   *
   * 視点 C（`input.c === null`）と軸角（既定 90°）に触らない限り、
   * 組み立てられるリクエストは従来と同一値になる。
   */
  const process = async (epoch: number, input: StudioInput): Promise<void> => {
    let contoursA: Contour[]
    let contoursB: Contour[]
    // 初期値を置かない：try で必ず代入され、catch は return する。
    // `= null` を置くと「使われない代入」になる（no-useless-assignment）
    let contoursC: Contour[] | null
    try {
      const [rawA, rawB, rawC] = await Promise.all([
        resolveSource(input.a),
        resolveSource(input.b),
        // 視点 C は任意。null のときは解決も正規化も行わない
        input.c === null ? Promise.resolve(null) : resolveSource(input.c),
      ])
      // dispose 済みのパイプラインは計測に触らない。StrictMode の二重マウントでは
      // 破棄済みパイプラインの process() が後から解決し、**新しいパイプラインの
      // run** のカーソルを進めてしまう（計測だけの問題で、生成本体は下の
      // disposed チェックで止まる）
      if (!disposed) stage('normalize')
      contoursA = normalizeSilhouette(rawA, WORKING_HEIGHT).contours
      contoursB = normalizeSilhouette(rawB, WORKING_HEIGHT).contours
      // C も共通高さ H へ合わせる。C の断面ローカル Y は world −Z に載るので
      // （protocol.ts `VIEWPOINT_AXES`）、この「高さ」は立体の奥行きになる
      contoursC = rawC === null ? null : normalizeSilhouette(rawC, WORKING_HEIGHT).contours
    } catch {
      // 解析・正規化の失敗 = 入力の拒否（FR-006）。受理コミットの**前**なので
      // 拒否された入力が復帰先になることはない（トラップ 3）。拒否が届く前に
      // 再編集されていた場合（epoch 不一致）は store 側が復帰を無視する。
      // 復帰自体も入力変更として epoch を進めるため、復帰先の入力で
      // このパイプラインが再度走り、対応するメッシュが再生成される
      if (!disposed) {
        abandonRun('input-rejected')
        store.getState().restoreLastValidInput(epoch)
      }
      return
    }
    if (disposed || epoch !== store.getState().generationEpoch) {
      if (!disposed) abandonRun('superseded-before-preflight')
      return
    }

    // 解析・正規化を実際に通過した今、有効入力としてコミットする（トラップ 3）
    store.getState().inputAccepted(epoch)

    stage('preflight')
    const report = runPreflight(contoursA, contoursB, { c: contoursC })
    store.getState().setWarnings(epoch, report.warnings, report.liveYRange)

    // 生成のゲートは EMPTY_INTERSECTION の有無**のみ**（トラップ 1）。
    // `report.ok` は「警告ゼロ」であり、EMPTY_BAND があっても生成は実行する
    // 深さ算出（bbox×2）とリクエスト組み立て。予算表にこの行は無い
    stage('dispatch')
    if (report.warnings.some((w) => w.code === 'EMPTY_INTERSECTION')) {
      // Worker へはディスパッチしない。ただし実行中の生成が superseded の
      // まま残っていると status が generating で取り残される（旧世代の終端は
      // epoch 不一致で棄却されるため）ので、状態機械をここで終端させる。
      // Worker が空交差を計算したときと同じ EMPTY_RESULT に落とすことで、
      // プリフライト検出と演算検出が同じ提示（error + 警告の根拠）に揃う
      abandonRun('empty-intersection')
      const settledEpoch = acquire()
      if (settledEpoch !== null) {
        store.getState().generationFailed(settledEpoch, { code: 'EMPTY_RESULT' })
      }
      return
    }

    const extentOf = (contours: Contour[]): SilhouetteExtent => {
      const b = boundsOf(contours)
      return { width: b.maxX - b.minX, height: b.maxY - b.minY }
    }
    let depths: ReturnType<typeof computeDepths>
    try {
      depths = computeDepths({
        a: extentOf(contoursA),
        b: extentOf(contoursB),
        c: contoursC === null ? null : extentOf(contoursC),
        axisAngleDeg: input.axisAngleDeg,
      })
    } catch (err) {
      // 深さが算出できない入力（軸角が範囲外・寸法が縮退）は生成しない。
      // Worker へ送っても同じ理由で弾かれるだけなので、ここで終端させる
      abandonRun('depth-rule-rejected')
      const settledEpoch = acquire()
      if (settledEpoch !== null) {
        store
          .getState()
          .generationFailed(settledEpoch, { code: 'INVALID_INPUT', detail: messageOf(err) })
      }
      return
    }
    dispatchAllowed = true
    client.requestGeneration({
      a: { contours: contoursA, depth: depths.a },
      b: { contours: contoursB, depth: depths.b },
      c:
        contoursC === null || depths.c === null
          ? null
          : { contours: contoursC, depth: depths.c },
      axisAngleDeg: input.axisAngleDeg,
      baseplate: baseplateFor(store.getState().options),
    })
  }

  /**
   * store の購読。set() の同期通知の中で走るため、ジオメトリ ref の破棄は
   * 入力変更（epoch 前進）と**同一トランザクション**になる（トラップ 2）。
   */
  const onStoreChange = (state: StudioState): void => {
    if (disposed) return
    if (state.generationEpoch !== handledEpoch) {
      handledEpoch = state.generationEpoch
      // startGenerating の supersede による前進は入力変更ではない。
      // ref もパイプラインもそのまま（対応する入力は処理済み）
      if (inAcquireEpoch) return
      // 計測 run の起点は「入力変更そのもの」。以降 render まで工程が連続する
      startRun(state.generationEpoch)
      handledBaseplateSig = baseplateSignature(state.options)
      dispatchAllowed = false
      setGeometry(null)
      void process(state.generationEpoch, state.input)
      return
    }
    // 台座オプションの変更は epoch を進めないが CSG 結果を変えるため、
    // 指紋の変化で同じ epoch のまま再生成する
    const sig = baseplateSignature(state.options)
    if (sig === handledBaseplateSig) return
    startRun(state.generationEpoch)
    handledBaseplateSig = sig
    dispatchAllowed = false
    setGeometry(null)
    void process(state.generationEpoch, state.input)
  }

  const unsubscribe = store.subscribe(onStoreChange)
  // 現在の入力（初期状態なら epoch 0 の正方形 × 円）を起動時に 1 回処理する。
  // リクエストは client が ready まで保持し、ready 到達時に送出される（FR-025）
  onStoreChange(store.getState())

  return {
    geometryRef,
    retry: () => {
      if (disposed) return
      // store を先に loading-wasm へ戻す（client の onReady → wasmReady →
      // acquireEpoch の順序が成立するように）。どちらも該当状態以外では no-op
      store.getState().retryInit()
      client.retryInit()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      abandonRun('pipeline-disposed')
      unsubscribe()
      client.dispose()
      setGeometry(null)
    },
  }
}

export interface UseGenerationPipelineResult {
  /** Wave 5 の `<Viewport geometryRef={…} />` がそのまま受け取る参照 */
  geometryRef: GeometryRef
  /** init-failed からの再試行（FR-025）。サイドバーの再試行ボタンに配線する */
  retry: () => void
}

/**
 * アプリ本体用フック。**App.tsx から 1 回だけ呼ぶ**（design.md ディレクトリ表）。
 * 実体は {@link createGenerationPipeline} で、フックはライフサイクル
 * （StrictMode の再マウントを含む）への接続だけを行う。ジオメトリ ref は
 * フック側で保持するため、再マウントを跨いで同一の参照を Wave 5 に渡せる。
 */
export function useGenerationPipeline(): UseGenerationPipelineResult {
  const geometryRef = useRef<BufferGeometry | null>(null)
  const handleRef = useRef<GenerationPipelineHandle | null>(null)

  useEffect(() => {
    const handle = createGenerationPipeline({ geometryRef })
    handleRef.current = handle
    return () => {
      handleRef.current = null
      handle.dispose()
    }
  }, [])

  const retry = useCallback(() => {
    handleRef.current?.retry()
  }, [])

  return { geometryRef, retry }
}
