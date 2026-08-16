import type { Contour, PresetId, PreflightWarning } from '../geometry/types'
import { runPreflight } from '../geometry/preflight'
import { boundsOf, normalizeSilhouette, signedArea } from '../geometry/normalize'
import { PRESET_IDS, presetToContours } from '../sources/presets'

/**
 * 「この立体は何と何からできている？」パズル（FR-100 系のカタログ本編に対する副次要素）。
 *
 * 2 つのプリセットシルエットを交差させた立体をイソメトリック視点で見せ、元になった
 * シルエットの組を当てさせるクイズのロジック。ここでは**出題と採点だけ**を扱う。
 * 実際の立体生成・レンダリングは呼び出し側（worker / scene 層）の責務であり、
 * このモジュールは `PuzzlePair`（プリセット id の組）を返すのみで Manifold には触れない。
 *
 * 依存関係は read-only:
 * - `geometry/preflight.ts` の `runPreflight` … 出題する組が実際に立体を作れるかの判定
 * - `geometry/normalize.ts` … 両シルエットを共通高さへ揃えてから判定・比較するため
 * - `sources/presets.ts` の `PRESET_IDS` / `presetToContours` … 図形の実体（id は
 *   ハードコードせず `PRESET_IDS` から動的に導出する。プリセットが増えても自動的に拾う）
 */

// ---------------------------------------------------------------------------
// 基本の型
// ---------------------------------------------------------------------------

/** 出題・選択肢の 1 単位：どのプリセットを A 視点・B 視点に割り当てるかの組。 */
export interface PuzzlePair {
  a: PresetId
  b: PresetId
}

/** 難易度の 3 段階。 */
export type DifficultyLevel = 'easy' | 'medium' | 'hard'

/** 1 問分の出題データ。呼び出し側は `correct` を生成・レンダリングして正解画像にする。 */
export interface PuzzleQuestion {
  /** `seed` と `index` から一意に決まる識別子（`"${seed}::${index}"`）。 */
  id: string
  seed: string
  /** シード内での出題順（0 始まり）。 */
  index: number
  difficulty: DifficultyLevel
  /** 出題順にシャッフル済みの選択肢。正解をちょうど 1 つ含む。 */
  options: PuzzlePair[]
  /** `options` の中で正解の添字。 */
  correctOptionIndex: number
}

// ---------------------------------------------------------------------------
// プリフライトによる出題フィルタ（1. 質問生成）
// ---------------------------------------------------------------------------

/** 出題プールに残す前に判定する共通の作業高さ。縦横比だけが本質で絶対値は意味を持たない。 */
const WORKING_HEIGHT = 2

/**
 * 出題を却下する preflight 警告コード。
 *
 * - `EMPTY_INTERSECTION`：交差が空集合。正解画像そのものが存在しないので出題不能（必須の除外）。
 * - `LIKELY_DISCONNECTED`：スライスの島の数が全高さで 2 以上 → 立体が複数パーツに分離する
 *   可能性が高い（design.md の「厳密に言えないこと」どおり estimated だが、`estimatedComponents`
 *   が高いパーツはプレビュー画像として「バラバラに砕けた塊」になりやすく、パズルの画像として
 *   質が悪い＝「shattered」。安全側に倒して除外する）。
 *
 * 意図して除外**しない**もの：
 * - `EMPTY_BAND`：帯の途中で片側の被覆が途切れるだけで、立体そのものは 1 個のまま生成される
 *   （design.md 「EMPTY_BAND があっても生成は行う」）。くびれとして見えるだけなので出題可能。
 * - `THIN_NECK`：3D 印刷でその厚みが折れやすいという物理的な警告であり、このパズルは画像を
 *   見せるだけで印刷はしない。細い首があっても連結成分は 1 のままなので出題として問題ない。
 */
const REJECTED_WARNING_CODES = new Set<PreflightWarning['code']>([
  'EMPTY_INTERSECTION',
  'LIKELY_DISCONNECTED',
])

/** プリセット 1 つ分の、出題判定に使う幾何情報。プリセット id ごとに 1 回だけ計算してキャッシュする。 */
interface ShapeDescriptor {
  /** 共通高さへ正規化済みの輪郭（preflight と特徴量計算の両方で使い回す）。 */
  contours: Contour[]
  /** 自身の bbox 縦中心線に対して左右対称か（2.2 節参照）。 */
  mirrorSymmetric: boolean
  /** bbox の幅 / 高さ（正規化後は高さが `WORKING_HEIGHT` に揃うので、実質は幅の代理）。 */
  aspectRatio: number
  /** bbox 面積に対する図形の面積の比（0〜1 に近い密度の代理指標）。 */
  fillRatio: number
}

const descriptorCache = new Map<PresetId, ShapeDescriptor>()

/** 点集合が許容誤差つきで一致するか（順序・出現位置に依存しない全単射マッチング）。 */
function samePointMultiset(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
  eps: number,
): boolean {
  if (a.length !== b.length) return false
  const used = new Array<boolean>(b.length).fill(false)
  for (const [ax, ay] of a) {
    const idx = b.findIndex(
      ([bx, by], i) => !used[i] && Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps,
    )
    if (idx === -1) return false
    used[idx] = true
  }
  return true
}

const MIRROR_EPS = 1e-6

/**
 * 輪郭群が自身の bbox 縦中心線（x = cx）に対して左右対称かどうか。
 *
 * 2.2 節「順序に依存する／しないペア」の判定に使う唯一の幾何情報。すべての点を
 * x → 2·cx − x で鏡映し、元の点集合と一致するかを見る。穴を含む複数輪郭でも、
 * 全輪郭の点をまとめて多重集合として比較するので破綻しない（現行プリセットは
 * いずれも単一の外輪郭のみだが、将来穴付き図形が増えても成立する）。
 */
function isBboxMirrorSymmetric(contours: Contour[]): boolean {
  const bounds = boundsOf(contours)
  const cx = (bounds.minX + bounds.maxX) / 2
  const points: Array<[number, number]> = []
  for (const contour of contours) {
    const p = contour.points
    for (let i = 0; i < p.length; i += 2) points.push([p[i], p[i + 1]])
  }
  const mirrored = points.map(([x, y]): [number, number] => [2 * cx - x, y])
  return samePointMultiset(points, mirrored, MIRROR_EPS)
}

/** プリセット id → `ShapeDescriptor`。初回のみ計算し、以降はキャッシュを返す。 */
function descriptorOf(id: PresetId): ShapeDescriptor {
  const cached = descriptorCache.get(id)
  if (cached !== undefined) return cached

  const { contours } = normalizeSilhouette(presetToContours(id), WORKING_HEIGHT)
  const bounds = boundsOf(contours)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  // 外輪郭 CCW（正）・穴 CW（負）に正規化済みなので、単純総和で穴が自動的に差し引かれる
  const area = contours.reduce((sum, c) => sum + signedArea(c.points), 0)

  const descriptor: ShapeDescriptor = {
    contours,
    mirrorSymmetric: isBboxMirrorSymmetric(contours),
    aspectRatio: width / height,
    fillRatio: Math.abs(area) / (width * height),
  }
  descriptorCache.set(id, descriptor)
  return descriptor
}

/**
 * `(a, b)` と `(b, a)` が異なる立体になりうるか（= 順序が意味を持つか）。
 *
 * 交差立体は `M(a, b) = { (x,y,z) : (x,y)∈a かつ (−z,y)∈b }`（design.md §2.1 のカメラ規約より、
 * B 側は Y 軸まわり +90° 回転で local +X が world −Z に写る）。座標入れ替え
 * `T(x,y,z) = (z,y,x)`（x=z 平面に対する鏡映で、B のカメラ位置・向き・up ベクトルを不変に保つ）
 * を適用すると `T(M(a,b)) = M(b,a)` が成り立つのは、a・b それぞれが**自身の bbox 縦中心線に対して
 * 左右対称**（`x → 2cx − x` で不変）なときに限る（両者とも対称なら、各シルエット内での座標反転が打ち消し合う）。
 * このとき `M(a,b)` と `M(b,a)` は固定カメラ軸を含む平面での鏡映で移り合う合同な立体になり、
 * 対称な形どうしの組では鏡映後も同じ絵にしかならないため実質「同じ見た目」。少なくとも一方が
 * 非対称（矢印など）なら、この鏡映は解にならず一般に異なる絵になる。
 *
 * この関数は「同じ見た目になりうる」を安全側で判定する幾何ヒューリスティックであり、
 * 実際にレンダリングして画素比較しているわけではない。保守的に倒す方針として、
 * 対称ペアは常に「同じ見た目になりうる」＝順序を区別しないものとして扱う。
 */
function pairOrderMatters(a: PresetId, b: PresetId): boolean {
  return !(descriptorOf(a).mirrorSymmetric && descriptorOf(b).mirrorSymmetric)
}

/**
 * ペアの正準キー。順序が意味を持たないペアは `(a,b)` と `(b,a)` を同じキーへ畳み込み、
 * 出題プール構築時にどちらか一方しか残らないようにする（2.2 節の「同じ見た目」対策の要）。
 * 順序が意味を持つペアはキーにも順序を残し、`(a,b)` `(b,a)` を別の出題候補として扱う。
 */
function canonicalPairKey(a: PresetId, b: PresetId): string {
  if (!pairOrderMatters(a, b)) {
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    return `${lo}::${hi}`
  }
  return `${a}::${b}`
}

/**
 * 2 つのペアが「同じ立体に見える」ものかどうか（`canonicalPairKey` の外部向け窓口）。
 * 出題プールの重複除去だけでなく、1 問内のどの 2 選択肢も同じ立体にならないことの検証にも使う。
 */
export function pairsProduceSameSolid(x: PuzzlePair, y: PuzzlePair): boolean {
  return canonicalPairKey(x.a, x.b) === canonicalPairKey(y.a, y.b)
}

/** 2 つのプリセットの見た目の異なり具合（0 に近いほど似ている）。難易度づけの入力。 */
function shapeDistance(a: PresetId, b: PresetId): number {
  const da = descriptorOf(a)
  const db = descriptorOf(b)
  return Math.hypot(da.aspectRatio - db.aspectRatio, da.fillRatio - db.fillRatio)
}

/** 正規化済み輪郭同士に preflight を通し、却下対象の警告が出ていないかを見る。 */
function passesQualityGate(a: PresetId, b: PresetId): boolean {
  const report = runPreflight(descriptorOf(a).contours, descriptorOf(b).contours)
  return !report.warnings.some((w) => REJECTED_WARNING_CODES.has(w.code))
}

/**
 * 出題候補プール（全プリセットの非順序 or 順序付きペアのうち、preflight を通ったもの）。
 * `PRESET_IDS` はモジュール読み込み時点で確定しているため、初回アクセス時に一度だけ構築して
 * キャッシュする（プリセット数は高々十数個なので、preflight を総当たりしてもコストは小さい）。
 */
let cachedPool: PuzzlePair[] | null = null

function candidatePool(): PuzzlePair[] {
  if (cachedPool !== null) return cachedPool

  const seen = new Set<string>()
  const pool: PuzzlePair[] = []
  for (const a of PRESET_IDS) {
    for (const b of PRESET_IDS) {
      if (a === b) continue
      const key = canonicalPairKey(a, b)
      if (seen.has(key)) continue
      seen.add(key)
      if (!passesQualityGate(a, b)) continue
      pool.push({ a, b })
    }
  }
  cachedPool = pool
  return pool
}

/**
 * 出題可能なペアの一覧（preflight を通り、同じ見た目の重複を除いたもの）。
 * `difficulty` を指定するとそのレベルのみへ絞り込む。UI 側の練習モードや、
 * 難易度ごとの母集団を検証するテストから使う。
 */
export function listValidPairs(difficulty?: DifficultyLevel): PuzzlePair[] {
  const pool = candidatePool()
  if (difficulty === undefined) return [...pool]
  return pool.filter((p) => pairDifficulty(p.a, p.b) === difficulty)
}

// ---------------------------------------------------------------------------
// 難易度（2. 難易度）
// ---------------------------------------------------------------------------

/**
 * `shapeDistance` がこの値以上なら「十分に違う」とみなす閾値。
 * 現行 7 プリセット（円・正方形・三角形・ハート・星・矢印・十字）で対称ペア同士の距離を
 * 総当たりすると、円×正方形のように輪郭比・充填率がほぼ同じ組（〜0.03）から、
 * 正方形×十字のように片方が凸で密、片方が凹で疎な組（〜0.5 前後）まで分布する。
 * 中央値のやや上にあたる 0.22 を境にすると、対称ペアの母集団が easy / medium へ
 * ほぼ均等に分かれる（tuning は下記スクリプトの実測に基づく。プリセットが増えれば
 * 分布も変わるが、閾値は形の指標そのものなので追随して意味を持ち続ける）。
 */
const EASY_DISTANCE_THRESHOLD = 0.22

/**
 * ペアの難易度（FR-100 系の副次要素としての最小要件）。
 *
 * 1. 非対称な図形（矢印など）が絡むペアは常に `hard`：`pairOrderMatters` が真になる組であり、
 *    A/B のどちらに割り当てたかで絵が変わるため、正しい軸の理解を要求する分だけ難しい。
 * 2. 対称な図形どうしのペアは、輪郭の異なり具合（`shapeDistance`）で easy / medium を分ける。
 *    大きく異なる形どうし（例：正方形×十字）は投影の見分けが直感的につきやすく `easy`、
 *    似た形どうし（例：円×正方形）は交差の結果から元のシルエットを当てにくく `medium`。
 */
export function pairDifficulty(a: PresetId, b: PresetId): DifficultyLevel {
  if (pairOrderMatters(a, b)) return 'hard'
  return shapeDistance(a, b) >= EASY_DISTANCE_THRESHOLD ? 'easy' : 'medium'
}

// ---------------------------------------------------------------------------
// シード付き擬似乱数（4. 決定性）
// ---------------------------------------------------------------------------

/** 文字列 → 32bit ハッシュ（FNV-1a）。乱数シードの種にする。 */
function fnv1aHash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32：32bit 整数演算のみの決定的 PRNG。`[0, 1)` の疑似乱数列を返す。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `seed` と出題順 `index` から、その 1 問専用の決定的な乱数生成器を作る。 */
function createRng(seed: string, index: number): () => number {
  return mulberry32(fnv1aHash(`${seed}::${index}`))
}

/** Fisher–Yates シャッフル（`rng` 駆動・破壊しない）。 */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. 出題生成
// ---------------------------------------------------------------------------

const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = ['easy', 'medium', 'hard']

/** 既定の選択肢数（正解 1 つ＋誤答 3 つ）。 */
export const DEFAULT_OPTION_COUNT = 4

export interface GeneratePuzzleQuestionOptions {
  /** 省略時はシードから決定的に選ぶ（`easy` / `medium` / `hard` を等確率で回す）。 */
  difficulty?: DifficultyLevel
  /** 選択肢の総数（正解を含む）。既定は {@link DEFAULT_OPTION_COUNT}。2 以上の整数が必要。 */
  optionCount?: number
}

/**
 * 1 問を決定的に生成する（FR-100 系の副次パズル本体）。
 *
 * 正解ペアは必ず `listValidPairs` のプール（preflight を通り、順序重複を除いたもの）から
 * 選ぶため、**生成される正解は常に `runPreflight` で `EMPTY_INTERSECTION` を出さない**。
 * 誤答も同じプールから重複なく選ぶため、**どの 2 つの選択肢も同じ立体にはならない**。
 *
 * 同じ `seed` と `index` の組は常に同じ問題を返す（`fnv1aHash` → `mulberry32` の合成が
 * 決定的なため）。`seed` を変えれば選ばれる問題列も変わる。
 */
export function generatePuzzleQuestion(
  seed: string,
  index: number,
  options: GeneratePuzzleQuestionOptions = {},
): PuzzleQuestion {
  const optionCount = options.optionCount ?? DEFAULT_OPTION_COUNT
  if (!Number.isInteger(optionCount) || optionCount < 2) {
    throw new Error(`optionCount は 2 以上の整数が必要です（指定値: ${optionCount}）`)
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`index は 0 以上の整数が必要です（指定値: ${index}）`)
  }

  const rng = createRng(seed, index)

  const requestedDifficulty =
    options.difficulty ?? DIFFICULTY_LEVELS[Math.floor(rng() * DIFFICULTY_LEVELS.length)]

  let pool = listValidPairs(requestedDifficulty)
  if (pool.length === 0) {
    // 指定難易度に該当ペアがない（極端に少ないプリセット構成など）場合は全体プールへ縮退する
    pool = listValidPairs()
  }
  if (pool.length === 0) {
    throw new Error(
      '出題可能な図形ペアがありません（プリセットが少なすぎるか、preflight を通る組がありません）',
    )
  }

  const correct = pool[Math.floor(rng() * pool.length)]
  const correctKey = canonicalPairKey(correct.a, correct.b)

  const distractorSource = pool.length - 1 >= optionCount - 1 ? pool : candidatePool()
  const distractorCandidates = distractorSource.filter(
    (p) => canonicalPairKey(p.a, p.b) !== correctKey,
  )
  const distractors = shuffle(distractorCandidates, rng).slice(0, optionCount - 1)

  const shuffledOptions = shuffle([correct, ...distractors], rng)
  const correctOptionIndex = shuffledOptions.findIndex(
    (p) => canonicalPairKey(p.a, p.b) === correctKey,
  )

  return {
    id: `${seed}::${index}`,
    seed,
    index,
    // 縮退時に実際に選ばれたペアの難易度と `requestedDifficulty` がずれることがあるため、
    // 「実際に出題したペア」の難易度を測り直して詰める（見せかけの難易度表示を避ける）
    difficulty: pairDifficulty(correct.a, correct.b),
    options: shuffledOptions,
    correctOptionIndex,
  }
}

/**
 * `seed` から `count` 問ぶんの決定的な出題列を作る（共有可能なデイリーパズルの土台）。
 * `generatePuzzleQuestion(seed, i, options)` を `i = 0..count-1` で呼ぶのと同じ。
 */
export function generatePuzzleSequence(
  seed: string,
  count: number,
  options: GeneratePuzzleQuestionOptions = {},
): PuzzleQuestion[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count は 0 以上の整数が必要です（指定値: ${count}）`)
  }
  return Array.from({ length: count }, (_, i) => generatePuzzleQuestion(seed, i, options))
}

// ---------------------------------------------------------------------------
// 3. 採点・セッション状態（純粋なリデューサー）
// ---------------------------------------------------------------------------

export interface PuzzleSessionState {
  /** 現在出題中の問題。未出題なら `null`。 */
  question: PuzzleQuestion | null
  /** プレイヤーが選んだ選択肢の添字。まだ回答していなければ `null`。 */
  selectedOptionIndex: number | null
  /** 直近の回答が正解だったか。まだ回答していなければ `null`。 */
  isCorrect: boolean | null
  /** 連続正解数。誤答で 0 に戻る。 */
  streak: number
  /** セッション中の最大連続正解数。 */
  bestStreak: number
  /** 累計スコア。 */
  score: number
  /** 回答した問題数（正誤を問わない）。 */
  answeredCount: number
  /** 正解した問題数。 */
  correctCount: number
}

/** セッション状態の初期値。 */
export function createInitialPuzzleSession(): PuzzleSessionState {
  return {
    question: null,
    selectedOptionIndex: null,
    isCorrect: null,
    streak: 0,
    bestStreak: 0,
    score: 0,
    answeredCount: 0,
    correctCount: 0,
  }
}

export type PuzzleAction =
  | { type: 'question-loaded'; question: PuzzleQuestion }
  | { type: 'answer-submitted'; optionIndex: number; elapsedMs: number }
  | { type: 'session-reset' }

/** 正解 1 問あたりの基礎点。 */
const BASE_POINTS = 100
/** 即答（`elapsedMs = 0`）で満額になる速度ボーナスの上限。 */
const MAX_SPEED_BONUS = 50
/** このミリ秒数を超えて回答すると速度ボーナスは 0 になる（呼び出し側が計測して渡す）。 */
const SPEED_BONUS_WINDOW_MS = 10_000
/** 難易度が高い問題ほど正解時の得点を割り増しする係数。 */
const DIFFICULTY_MULTIPLIER: Record<DifficultyLevel, number> = {
  easy: 1,
  medium: 1.25,
  hard: 1.5,
}

/**
 * 正解時の加点を計算する（純関数。タイマーは持たず `elapsedMs` を受け取るだけ）。
 * 基礎点 + 速度ボーナス（`elapsedMs` が 0 に近いほど大きく、`SPEED_BONUS_WINDOW_MS` で 0）
 * に、難易度係数を掛けて丸める。
 */
function scoreDeltaFor(difficulty: DifficultyLevel, elapsedMs: number): number {
  const clampedElapsed = Math.min(Math.max(elapsedMs, 0), SPEED_BONUS_WINDOW_MS)
  const speedBonus = MAX_SPEED_BONUS * (1 - clampedElapsed / SPEED_BONUS_WINDOW_MS)
  return Math.round((BASE_POINTS + speedBonus) * DIFFICULTY_MULTIPLIER[difficulty])
}

/**
 * パズルセッションの純粋なリデューサー。DOM にもタイマーにも触れない。
 *
 * - `question-loaded`：新しい問題を表示状態にする。`streak` / `score` などの累計は引き継ぐ。
 * - `answer-submitted`：`question` が未設定、または**その問題にすでに回答済み**
 *   （`selectedOptionIndex !== null`）なら何もせず同じ状態を返す（二重採点の防止）。
 *   それ以外は正誤判定・加点・streak 更新を行う。
 * - `session-reset`：初期状態に戻す。
 */
export function puzzleReducer(state: PuzzleSessionState, action: PuzzleAction): PuzzleSessionState {
  switch (action.type) {
    case 'question-loaded':
      return {
        ...state,
        question: action.question,
        selectedOptionIndex: null,
        isCorrect: null,
      }

    case 'answer-submitted': {
      if (state.question === null) return state
      if (state.selectedOptionIndex !== null) return state // 既に回答済み：二重カウントしない

      const isCorrect = action.optionIndex === state.question.correctOptionIndex
      const streak = isCorrect ? state.streak + 1 : 0
      const delta = isCorrect ? scoreDeltaFor(state.question.difficulty, action.elapsedMs) : 0

      return {
        ...state,
        selectedOptionIndex: action.optionIndex,
        isCorrect,
        streak,
        bestStreak: Math.max(state.bestStreak, streak),
        score: state.score + delta,
        answeredCount: state.answeredCount + 1,
        correctCount: state.correctCount + (isCorrect ? 1 : 0),
      }
    }

    case 'session-reset':
      return createInitialPuzzleSession()

    default: {
      // 判別共用体を網羅していない呼び出しはコンパイル時に弾かれる（`never` 代入）。
      // 型を無視した呼び出し（JS からの誤用など）はここで明確に例外にする。
      const exhaustiveCheck: never = action
      throw new Error(`未知の PuzzleAction です: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}
