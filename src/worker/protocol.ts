/**
 * Worker 境界のプロトコル型（design.md「4. Worker 境界」）。
 *
 * このファイルは**型のみ**を持つ。実装（csg.worker.ts / client.ts）は Wave 3。
 *
 * ## なぜ `generation` があるのか
 *
 * Wasm のブール演算は**途中キャンセルできない**。リクエストを発行した時点で、
 * その演算は最後まで走る。ユーザーの打鍵ごとにリクエストを積むと処理が詰まり、
 * さらに古い入力に対する結果が新しい入力の結果を上書きしうる。
 *
 * そこで発行元（client.ts）が単調増加する世代 ID を各リクエストに付与し、
 * レスポンス受信時に `generation === latestGeneration` のときだけ採用する。
 * つまり stale なレスポンスは**発生源で中断するのではなく、受信側で破棄する**。
 * これが Wasm 演算を安全に「キャンセル」できる唯一の方法である。
 */

/**
 * postMessage 越しに渡す輪郭表現。
 *
 * `Float64Array` + boolean のみで構成され structured clone 可能
 * （`points` は transferable でもある）。内部型 `Contour`（geometry/types.ts）と
 * 構造的に互換だが、Worker 境界を越える形をここで明示的に固定する：
 * クラスインスタンスや関数を含む型は postMessage で壊れるため、
 * 境界を越えてよい形はこの型が定義するものだけとする。
 */
export interface SerializedContour {
  /** [x0, y0, x1, y1, ...] のフラット配列。Y 上向き、正規化済み作業座標系 */
  points: Float64Array
  /** true = 穴（内輪郭）。外輪郭は CCW、穴は CW に正規化済み */
  isHole: boolean
}

/** メインスレッド → Worker。1 回の CSG 生成のリクエスト */
export type CsgRequest = {
  /** 単調増加。古い世代のレスポンスは破棄する（ファイル冒頭の解説を参照） */
  generation: number
  /** シルエット A（XY 平面、+Z へ押し出し） */
  a: { contours: SerializedContour[]; depth: number }
  /** シルエット B（XY 平面 → 押し出し後に Y 軸まわり +90° 回転） */
  b: { contours: SerializedContour[]; depth: number }
  /** 台座（FR-015）。null = 無効。height は作業座標系の厚み */
  baseplate: { enabled: boolean; height: number } | null
}

/**
 * Worker → メインスレッド。成功時の typed array は Wasm 管理メモリからの
 * **新規コピー**であり、transferable として転送される（ADR-003）。
 */
export type CsgResponse =
  | {
      generation: number
      ok: true
      /** 頂点座標 [x, y, z, ...]。transferable */
      positions: Float32Array
      /** 三角形インデックス。transferable */
      indices: Uint32Array
      /** decompose() で確定した連結成分数。2 以上なら印刷時に分離する */
      componentCount: number
      volume: number
      elapsedMs: number
    }
  | { generation: number; ok: false; error: CsgError }

/**
 * CSG 生成が失敗しうる分類。
 *
 * `WORKER_CRASHED` は Worker 内で起きるのではなく、Worker が死んだことを
 * メインスレッド側が検出して発行する。それでもこの union に含めるのは、
 * **ストアの `generationFailed` が受け取れる型が 1 つでなければならない**ため。
 * クライアント専用の別 union を作ると、Wave 4 がクラッシュを無関係なエラーに
 * 読み替えるか、キャストで型を潰すしかなくなる。
 */
export type CsgError =
  | { code: 'WASM_INIT_FAILED'; detail: string }
  | { code: 'NOT_MANIFOLD'; detail: string }
  | { code: 'EMPTY_RESULT' }
  | { code: 'INVALID_INPUT'; detail: string }
  | { code: 'WORKER_CRASHED'; detail: string }

/**
 * Worker → メインスレッド。生成結果とは別系統の、初期化ライフサイクル通知。
 *
 * これがないと、クライアントは「準備完了」を推測するしかない。実際に
 * ウォームアップ生成の**成否を問わず** ready と見なす実装になっていたため、
 * エンジン側の異常で `INVALID_INPUT` が返っても正常起動として扱われていた。
 * Worker が `setup()` 直後に明示的に通知することで、準備完了の判定が
 * 推測ではなく事実になる。
 */
export type WorkerLifecycleMessage =
  | { type: 'ready' }
  | { type: 'init-failed'; detail: string }

/** Worker から届きうるメッセージの全体 */
export type WorkerOutbound = CsgResponse | WorkerLifecycleMessage

/** ライフサイクル通知か生成レスポンスかを判別する */
export function isLifecycleMessage(message: WorkerOutbound): message is WorkerLifecycleMessage {
  return 'type' in message
}
