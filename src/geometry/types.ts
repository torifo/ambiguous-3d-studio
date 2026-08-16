import type * as THREE from 'three'

/**
 * プリセット図形の識別子（FR-001: 円 / 正方形 / 正三角形 / ハート / 星 / 矢印 / 十字）。
 * 実体（輪郭データ）は sources/presets.ts（Wave 2）が持つ。
 */
export type PresetId =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'heart'
  | 'star'
  | 'arrow'
  | 'cross'

/**
 * 単一の閉パス。Y 上向き、単位は正規化後の作業座標系。
 * これは **アプリ内部の型**であって、Manifold にこのまま渡すことはできない（ADR-005）。
 */
export interface Contour {
  /** [x0, y0, x1, y1, ...] のフラット配列。数値計算とテストが書きやすい形 */
  points: Float64Array
  /** true = 穴（内輪郭）。外輪郭は CCW、穴は CW に正規化済み */
  isHole: boolean
}

export type SilhouetteSource =
  | { kind: 'preset'; id: PresetId }
  | { kind: 'text'; value: string; fontId: string }
  | { kind: 'svg'; fileName: string; raw: string }

export interface Silhouette {
  source: SilhouetteSource
  /** 正規化済み輪郭集合。外輪郭と穴が混在する */
  contours: Contour[]
  /** 正規化前の元 bbox（表示用） */
  sourceBounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/** 生成前の適合性レポート（FR-012） */
export interface PreflightReport {
  ok: boolean
  /** 両シルエットが同時に被覆する Y 範囲。空なら交差は空集合 */
  sharedYRange: [number, number] | null
  /** 片方だけ空になる高さ帯（正規化 Y 座標） */
  emptyBands: Array<{ from: number; to: number; side: 'A' | 'B' }>
  /**
   * **両側に被覆があるサンプリング高さにおける、スライスの島の数 `m × n` の最小値。**
   * 実際の 3D 連結成分数の推定値でも下限でもない。
   *
   * ある高さで分かれた島は別の高さで合流しうるうえ、走査線サンプリングは
   * 細い橋を丸ごと取りこぼす。したがってこの値から 3D の連結成分数は
   * 導けない。確定値は生成後の `decompose()` のみが根拠
   * （FR-014 / design.md「厳密に言えること / 言えないこと」）。
   */
  estimatedComponents: number
  warnings: PreflightWarning[]
}

/**
 * `certainty` で断定と推定を分ける。UI はこれで文体を変える
 * （'exact' → 「〜です」/ 'estimated' → 「〜の可能性があります」）。
 * スライス恒等式 `slice(y) = A_y × B_y` は厳密なので空帯の検出は断定できるが、
 * 連結成分数と首の太さは走査線サンプリングの推定にすぎない。
 */
export type PreflightWarning =
  | { code: 'EMPTY_INTERSECTION'; certainty: 'exact'; message: string }
  | { code: 'EMPTY_BAND'; certainty: 'exact'; message: string; band: [number, number] }
  | { code: 'LIKELY_DISCONNECTED'; certainty: 'estimated'; message: string; components: number }
  | { code: 'THIN_NECK'; certainty: 'estimated'; message: string; minWidth: number }
  | { code: 'SIMPLIFIED'; certainty: 'exact'; message: string; before: number; after: number }

export interface GenerationResult {
  geometry: THREE.BufferGeometry
  /** 連結成分数。2 以上なら印刷時に分離する */
  componentCount: number
  volume: number
  triangleCount: number
  elapsedMs: number
}
