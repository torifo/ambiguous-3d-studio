# Ambiguous Solid Generator — Design

## Overview

パイプラインは一方向に流れる：

```
入力（プリセット / 文字 / SVG）
  → Contour[]（正規化済み 2D 閉輪郭、Y 上向き、穴は入れ子）
  → プリフライト判定（水平走査線の被覆解析）
  → [Worker] CrossSection → extrude → intersect
  → MeshGL（indexed, positions only）
  → BufferGeometry（メインスレッド）
  → 描画 / STL / GLB
```

`Contour[]` が全入力形式の合流点、`MeshGL` が Worker 境界。この 2 つの型さえ固定すれば、入力方式の追加も演算エンジンの差し替えもパイプライン全体に波及しない。

---

## Architecture Decision Record

### ADR-001: CSG エンジンは manifold-3d 一本

**採用:** `manifold-3d`（Wasm）
**却下:** `three-bvh-csg`

`three-bvh-csg` は Three.js との統合が容易で高速だが、**出力が 2-manifold である保証がない**。有効な入力に対してもひび割れ・重複三角形・共面の縮退を生じうる。本アプリの成果物は 3D プリンタのスライサーに直接渡るため、この保証が要件そのもの（FR-013 / NFR-010）。

フォールバックとして `three-bvh-csg` を併載する案は採らない。「プレビューは出るが印刷できるとは限らない」状態はユーザーに説明不可能で、実装コストも二重になる。Wasm 初期化に失敗した場合は生成機能を無効化し、理由を表示する。

### ADR-002: 押し出しは Manifold の `CrossSection` で行い、`THREE.ExtrudeGeometry` を使わない

**これは当初案からの変更。**

`ExtrudeGeometry` の出力は非インデックスの triangle soup で、UV・法線のシームによって同一位置の頂点が分裂する。`mergeVertices()` でも属性が衝突すると溶接されない。さらに穴あき形状のキャップが独立した三角ファンになり、非多様体になりやすい。これを CSG に渡すと Manifold は入力エラーで弾く。

`CrossSection` は 2D 輪郭集合を受け取り、コンストラクタ内で Positive fill rule のブール和を行って自己交差のない多角形集合に正規化する。`.extrude(height, 0, 0, [1,1], true)` は穴を含むキャップの三角形分割まで正しく生成し、原点対称に配置する。**入力が輪郭のうちは非多様体になりようがない。**

### ADR-005: `Contour` は内部型。Manifold へは明示アダプタで渡す

manifold-3d の入力型は

```ts
type Vec2 = [number, number]
type SimplePolygon = Vec2[]
type Polygons = SimplePolygon | SimplePolygon[]
```

であり、**フラットな `Float64Array` も `isHole` フィールドも受け付けない**。穴は API 上のフラグではなく、選択した fill rule のもとでの**巻き方向**として表現される。`Contour[]` をそのまま渡すと Wasm バインディング境界で失敗する。

内部型は `Contour` のまま維持する（正規化・プリフライト・テストがフラット配列の方が書きやすい）。境界にアダプタを 1 つだけ置く：

```ts
// geometry/toPolygons.ts — Manifold へ渡す唯一の入口
export function toPolygons(contours: Contour[]): [number, number][][] {
  return contours.map((c) => {
    if (c.points.length % 2 !== 0) throw new Error('odd point buffer')
    if (c.points.length < 6) throw new Error('contour needs >= 3 vertices')
    const poly: [number, number][] = []
    for (let i = 0; i < c.points.length; i += 2) {
      const x = c.points[i], y = c.points[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite vertex')
      poly.push([x, y])
    }
    return poly
  })
}

const section = new CrossSection(toPolygons(contours), 'Positive')
```

巻き方向（外輪郭 CCW / 穴 CW）はアダプタに入る**前**に `normalize.ts` が保証する。アダプタは形式変換と不変条件の検証だけを行う。

### ADR-006: 初期化とバージョン固定

```ts
import createManifold from 'manifold-3d'
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url'

const wasm = await createManifold({ locateFile: () => manifoldWasmUrl })
wasm.setup()
const { Manifold, CrossSection } = wasm
```

`status()` は **文字列ユニオン `ErrorStatus`** を返す。`'NoError'` / `'NotManifold'` などの**文字列リテラルで比較する**（`NoError` という識別子は存在しない）。

API の細部（`Polygons` の形、`status()` の戻り値、`extrude` の引数順）はバージョンに依存するため、`manifold-3d` は `package.json` と lockfile で**厳密固定**する。基準バージョンは **3.5.1**。上げるときは Wave 3 の統合テストを必ず通す。

### ADR-003: 演算は専用 Web Worker、Wasm はシングルスレッド

GitHub Pages は COOP/COEP ヘッダを設定できないため cross-origin isolation が得られず、`SharedArrayBuffer` と Wasm threads は使えない（NFR-022）。シングルスレッド版 Wasm を常設 Worker 内で 1 回だけ初期化する。

`WebAssembly.Instance`・Wasm ヒープ・Manifold オブジェクトはいずれも postMessage で転送できない。Worker 内で完結させ、境界を越えるのは新規確保した `Float32Array` / `Uint32Array` のみ（transferable）。

### ADR-004: 状態管理は Zustand、R3F は状態を購読しない

CSG 結果（`BufferGeometry`）は React state に入れず ref で保持する。60fps 維持（NFR-002）のため、カメラ操作や Sweet Spot 判定は `useFrame` 内で完結させ、React の再レンダリングを発生させない。Sweet Spot の「合致した/外れた」という**離散イベントのみ**を store に書き戻す。

---

## Components

| コンポーネント | 責務 | 依存 |
|---|---|---|
| `sources/` | 入力形式ごとの `Contour[]` 抽出（preset / text / svg） | opentype.js（text）, SVGLoader（svg） |
| `geometry/normalize.ts` | 輪郭の正規化（縦横比保持フィット・原点センタリング・巻き方向補正） | — |
| `geometry/preflight.ts` | 水平走査線による被覆解析、空帯・分離リスクの検出 | — |
| `worker/csg.worker.ts` | Manifold 初期化、CrossSection→extrude→intersect、MeshGL 返却 | manifold-3d |
| `worker/client.ts` | Worker への窓口。世代 ID 管理・デバウンス・stale 破棄 | — |
| `geometry/meshgl.ts` | MeshGL ⇄ BufferGeometry 変換 | three |
| `scene/` | R3F シーン、カメラ制御、Sweet Spot、仮想ミラー | @react-three/fiber, drei |
| `export/` | バイナリ STL / GLB / USDZ 生成 | three/examples/jsm/exporters |
| `store/` | Zustand ストア（入力・オプション・生成ステータス） | zustand |
| `studio/` | **オーケストレーション。** 入力 → 正規化 → プリフライト → 深さ算出 → Worker → メッシュ変換 → ストア反映 を繋ぐ唯一の場所 | 上記すべて |

`studio/` を独立させる理由：入力・幾何・Worker・シーン・UI はいずれも「自分の隣」しか知らない。誰かがパイプライン全体を所有しないと、各モジュールが完成しても**アプリとして繋がらない**。並列実装では特に、この結合部分が誰の担当でもない状態になりやすい。

### ディレクトリ

```
src/
├── main.tsx
├── App.tsx
├── sources/
│   ├── presets.ts          # 円/正方形/正三角形/ハート/星/矢印/十字
│   ├── text.ts             # グリフ輪郭 → Contour[]
│   └── svg.ts              # SVG パース → Contour[]
├── geometry/
│   ├── types.ts            # Contour, Silhouette, PreflightReport
│   ├── normalize.ts
│   ├── preflight.ts
│   ├── meshgl.ts
│   └── analysis.ts         # 連結成分数・体積・最小肉厚
├── worker/
│   ├── csg.worker.ts
│   ├── protocol.ts         # リクエスト/レスポンス型
│   └── client.ts
├── scene/
│   ├── Viewport.tsx
│   ├── SolidMesh.tsx
│   ├── CameraRig.tsx       # スナップ + 正射影切替
│   ├── SweetSpot.ts        # useFrame 内の角度判定
│   └── VirtualMirror.tsx
├── export/
│   ├── stl.ts
│   ├── glb.ts
│   └── usdz.ts             # VITE_ENABLE_AR 配下
├── ui/
│   ├── Sidebar.tsx
│   ├── SilhouettePicker.tsx
│   ├── SweetSpotIndicator.tsx
│   └── StatusBanner.tsx
├── studio/
│   ├── useGenerationPipeline.ts   # 全工程の結線。App.tsx から 1 回だけ呼ぶ
│   └── scale.ts                   # 実寸 mm ⇄ 作業座標系の換算（FR-029）
└── store/
    └── useStudioStore.ts
```

### アプリ状態機械（FR-025）

```
loading-wasm ──成功──> ready ──入力変更──> generating ──> success
     │                   ▲                      │
     │                   └──────────────────────┴──> error
     └──失敗 / 10s タイムアウト──> init-failed ──再試行──> loading-wasm
```

- `loading-wasm` は**正常系**。エラー表示にしない。「準備中」を出し、出力ボタンは無効、入力の選択は受け付けて保持する
- `ready` に到達した時点で、保持していた初期入力（正方形 × 円）で生成を 1 回だけ走らせる
- `init-failed` はフォールバック演算を行わず、再試行のみを提供する（ADR-001）

初期表示で何も出ないビューポートは「壊れている」と読まれる。この状態機械がないと、Wasm 初期化の 100〜300ms が毎回そう見える。

---

## Data Models

```ts
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
  /** 走査線から推定した連結成分数の下限 */
  estimatedComponents: number
  warnings: PreflightWarning[]
}

export type PreflightWarning =
  | { code: 'EMPTY_INTERSECTION'; message: string }
  | { code: 'EMPTY_BAND'; message: string; band: [number, number] }
  | { code: 'LIKELY_DISCONNECTED'; message: string; components: number }
  | { code: 'THIN_NECK'; message: string; minWidth: number }
  | { code: 'SIMPLIFIED'; message: string; before: number; after: number }

export interface GenerationResult {
  geometry: THREE.BufferGeometry
  /** 連結成分数。2 以上なら印刷時に分離する */
  componentCount: number
  volume: number
  triangleCount: number
  elapsedMs: number
}
```

---

## Geometry Pipeline

### 1. 正規化（`normalize.ts`）

両シルエットは **共通の高さ `H`** に、縦横比を保ったまま合わせる。X/Z を独立に引き伸ばすことは禁止（形が崩れる）。

```
scale_A = H / (A.bbox.height)
scale_B = H / (B.bbox.height)
```

正規化後、各輪郭の bbox 中心を原点に移す。A は XY 平面、B は ZY 平面に配置される。

**巻き方向:** 外輪郭 CCW / 穴 CW（Positive fill rule）。SVG は Y 下向きなので Y 反転**後**に符号付き面積で再判定する。反転前に判定すると全ての巻きが逆になる。

### 2. 押し出し深さ

A の角柱は B の Z 方向の全範囲を覆う必要がある（逆も同様）。

```
depth_A = B.bbox.width * (1 + MARGIN)   // A を Z 方向に押し出す深さ
depth_B = A.bbox.width * (1 + MARGIN)   // B を X 方向に押し出す深さ
MARGIN = 0.02
```

`CrossSection.extrude(depth, 0, 0, [1,1], true)` で **`center = true`** を指定し、両角柱を原点対称にする。センタリングを忘れると片方が Z=0 から始まり、交差が非対称に切り落とされる。

### 2.1 軸の割り当てとカメラ規約（鏡像事故の防止）

`CrossSection.extrude` は常に **+Z 方向**に押し出す。B 用の角柱は押し出し後に Y 軸まわりに回して X 軸方向へ向けるが、**回転の符号とカメラの置き場所はセットで決めないと B が鏡像になる**。寸法は合うので目視でも気づきにくく、非対称な形（文字・矢印・ロゴ）でだけ露見する。

**確定した規約**

| | シルエット A | シルエット B |
|---|---|---|
| 断面が乗る平面 | XY | XY（回転前） |
| 押し出し | +Z | +Z → Y 軸まわり **+90°** |
| カメラ位置 | **+Z 側**（原点を見る） | **+X 側**（原点を見る） |
| up ベクトル | +Y | +Y |

**導出**（実装時にこの計算を再現できること）

Y 軸まわり +90° の回転は `(x, y, z) → (z, y, −x)`。したがって
- 断面の局所 +Z（押し出し軸）→ world **+X** ✓
- 断面の局所 +X（形の右方向）→ world **−Z**

カメラ基底は `right = up × backward`。
- A: backward `(0,0,1)`、`(0,1,0) × (0,0,1) = (1,0,0)` → 画面右 = world **+X**。A の局所 +X と一致 ✓
- B: backward `(1,0,0)`、`(0,1,0) × (1,0,0) = (0,0,−1)` → 画面右 = world **−Z**。B の局所 +X と一致 ✓

**カメラを −X 側に置くと画面右が world +Z になり、B だけ左右反転する。** 視点スナップ・仮想ミラー・AR の初期姿勢はすべてこの表に従うこと。

```ts
const prismA = sectionA.extrude(depthA, 0, 0, [1, 1], true)
const rawB   = sectionB.extrude(depthB, 0, 0, [1, 1], true)
const prismB = rawB.rotate([0, 90, 0])
const solid  = prismA.intersect(prismB)
```

**回帰テスト（必須）**: 左右非対称なシルエット（`F` または矢印）を B に入れ、+X カメラからの正射影レンダを参照画像と比較する。対称な図形（円・正方形）では鏡像バグが原理的に検出できないため、テスト入力は必ず非対称にする。

### 3. プリフライト判定（`preflight.ts`）— FR-012

高さ `y` における交差のスライスは

```
slice(y) = { A の x 区間集合 at y } × { B の z 区間集合 at y }
```

という**直積**になる。したがって：

- どちらか一方でも `y` における被覆が空 → その高さの交差は空
- A の区間が m 個、B の区間が n 個 → その高さのスライスは最大 m×n 個の島に分かれる

`H` を `N = 256` 本の走査線に分割し、各シルエットについて区間集合を求める。判定：

| 条件 | 警告 | 厳密性 |
|---|---|---|
| 共通被覆 Y 範囲が空 | `EMPTY_INTERSECTION`（生成を実行しない） | **厳密** |
| 片方のみ空の帯が存在 | `EMPTY_BAND`（その高さで立体が途切れる） | **厳密**（サンプリング解像度の範囲で） |
| 区間数の積が全走査線で 2 以上 | `LIKELY_DISCONNECTED` | **推定のみ** |
| 最小区間幅が閾値未満 | `THIN_NECK`（印刷時に折れる） | **推定のみ** |

**厳密に言えること / 言えないこと**を分ける。

言える：スライス恒等式 `slice(y) = A_y × B_y` は（押し出し深さが十分で軸が直交していれば）厳密。よって「片方が空 → 交差もそこで空」は厳密。区間数 m と n が互いに素な位置にあれば、その高さのスライスはちょうど m×n 個の矩形になる。

**言えない：スライスの島の数は 3D の連結成分数の下限にならない。** ある高さで分かれていても、別の高さで合流しうる。さらに 256 本のサンプリングでは、狭い空帯・細い首・位相の変化を取りこぼす。したがって「全走査線で積が 2 以上」は分離の**証明にならない**。

この非対称性を実装に落とす：
- `EMPTY_INTERSECTION` / `EMPTY_BAND` → 断定的な文言でよい
- `LIKELY_DISCONNECTED` / `THIN_NECK` → 「〜の可能性があります」に留め、**確定した連結成分数は生成後の `decompose()` を唯一の根拠とする**

厳密な空帯保証が必要になったら、走査線サンプリングではなく多角形の頂点 Y 値をイベント点として取り、イベント間で区間判定する方式に置き換える（現時点ではオーバースペックと判断）。

`i` の点、離れた 2 文字、複数パーツの SVG では `EMPTY_BAND` が必ず出る。これは**実装の不具合ではなく数学的必然**なので、UI では「バグ」ではなく「この組み合わせの性質」として提示する。

### 4. Worker 境界（`protocol.ts`）

```ts
export type CsgRequest = {
  /** 単調増加。古い世代のレスポンスは破棄する */
  generation: number
  a: { contours: SerializedContour[]; depth: number }
  b: { contours: SerializedContour[]; depth: number }
  baseplate: { enabled: boolean; height: number } | null
}

export type CsgResponse =
  | { generation: number; ok: true
      positions: Float32Array   // transferable
      indices: Uint32Array      // transferable
      componentCount: number
      volume: number
      elapsedMs: number }
  | { generation: number; ok: false; error: CsgError }

export type CsgError =
  | { code: 'WASM_INIT_FAILED'; detail: string }
  | { code: 'NOT_MANIFOLD'; detail: string }
  | { code: 'EMPTY_RESULT' }
  | { code: 'INVALID_INPUT'; detail: string }
```

**世代 ID:** Wasm のブール演算は途中キャンセルできない。打鍵ごとにリクエストを積むと処理が詰まるので、クライアント側で 120ms デバウンスし、レスポンスは `generation === latestGeneration` のときのみ採用する。

**メモリ:** `Manifold` / `CrossSection` は Wasm 所有オブジェクト。「全部 delete する」では実行できる指示にならないので、**所有権を列挙し、メソッドチェーンを禁止する**。

チェーンすると中間オブジェクトへの参照が残らず、確実に漏れる：

```ts
// ❌ rawB への参照が消え、delete できない
const prismB = sectionB.extrude(...).rotate([0, 90, 0])
```

生成 1 回で作られる Wasm オブジェクトの全量（台座なしの場合）:

| 変数 | 生成元 |
|---|---|
| `sectionA` `sectionB` | `new CrossSection()` |
| `rawA` `rawB` | `.extrude()` |
| `prismB` | `rawB.rotate()` — `rawA` は回転しないので `prismA = rawA` |
| `solid` | `prismA.intersect(prismB)` |
| `parts[]` | `solid.decompose()` — **配列の各要素が個別の Wasm オブジェクト** |
| `plate` `withPlate` | 台座オプション有効時のみ |

`finally` で**生成の逆順**に破棄する。`decompose()` の戻り配列を破棄し忘れるのが最も起きやすい漏れ。

リーク判定は生存オブジェクト数で行う（NFR-012）。`.delete()` してもヒープ容量は縮まないため、`HEAP8.length` を見る判定は必ず偽陽性になる。Worker 内に生成/破棄カウンタを持ち、リクエスト完了時に差分がゼロであることをテストで検証する。

**転送:** `getMesh()` が返す配列は Wasm 管理メモリを指しうる。**新規 typed array にコピーしてから** transfer する。コピーせずに transfer すると次の演算でヒープが動いた瞬間に壊れる。

### 5. MeshGL ⇄ BufferGeometry（`meshgl.ts`）

CSG 用途では位置のみを渡す（`numProp = 3`）。UV や法線を載せるとシーム頂点の分裂を `mergeFromVert` / `mergeToVert` で明示しなければならず、間違えると非マニホールド扱いになる。

```ts
// Manifold → three
const mesh = solid.getMesh()
const geom = new THREE.BufferGeometry()
geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertProperties), 3))
geom.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1))
geom.computeVertexNormals()   // 元の側面/キャップ法線は引き継がない
```

`solid.status()` は文字列ユニオンを返すので、**`solid.status() !== 'NoError'`** で判定し、返ってきた文字列をそのまま診断情報として `CsgError.detail` に載せる（`NoError` という識別子は存在しない — ADR-006）。

---

## Camera & Sweet Spot

### 投影の切り替え（FR-023）

錯視の「正解」は**正射影**で定義される。透視投影ではシルエットが厳密に一致しない。

- 自由探索中：透視投影（立体感が分かる）
- 視点 A / B にスナップ中：正射影

スナップ遷移中に投影行列を切り替えると視野が飛ぶため、遷移完了後に切り替え、その瞬間に画面上の見かけサイズが保たれるよう正射影の `zoom` を合わせる。

### Sweet Spot 判定（FR-021）

```ts
// useFrame 内。React state は触らない
const dot = camera.getWorldDirection(tmp).dot(targetDir)
const theta = Math.acos(THREE.MathUtils.clamp(-dot, -1, 1))
const hit = theta < THRESHOLD_RAD   // 3.5° = 0.0611
```

毎フレーム store に書き戻すと再レンダリングで 60fps が崩れる。`hit` の**値が変化したフレームだけ** store を更新する。インジケーターの連続的な角度表示は、DOM を `useFrame` から直接更新する（React を経由しない）。

### 仮想ミラー（FR-024）

視点 B の方向に反射面を置き、視点 A 側から本体と鏡像を同時に見る構図。実装は drei の `MeshReflectorMaterial`。無効時はコンポーネントごとアンマウントして反射レンダーターゲットを解放する。

---

## Export

| 形式 | 実装 | 備考 |
|---|---|---|
| STL（バイナリ） | `STLExporter` の `{ binary: true }` | 出力前に `componentCount > 1` を警告 |
| GLB | `GLTFExporter` の `{ binary: true }` | |
| USDZ | `USDZExporter` | `VITE_ENABLE_AR` 配下。動的 import でバンドル分離 |

### スケール（FR-029）

作業座標系は無次元。実寸は「**共通シルエット高さの mm 値**」ただ 1 つで定義する（既定 60mm）。`studio/scale.ts` が唯一の換算点：

```ts
// 正規化時の共通高さ H（無次元）→ 実寸 heightMm
const mmPerUnit = heightMm / H
```

| 出力 | 単位 | 適用倍率 |
|---|---|---|
| STL | ミリメートル | `mmPerUnit` |
| GLB / USDZ | **メートル** | `mmPerUnit * 0.001` |

glTF / USDZ はメートルが慣例。STL と同じ座標をそのまま流すと **AR で 1000 倍**になり、机の上に置いたはずの立体が建物サイズで出る。この 0.001 は忘れやすいので換算を 1 箇所に閉じ込め、テストで両方の bbox を検証する。

### 台座（FR-015）

台座は Worker 内で `solid.add(plate)` として結合する。メインスレッドで結合するとマニホールド保証が切れる。

**台座は錯視を壊す。** 底面に置いた矩形は、視点 A / B の両方のシルエットに必ず現れる。これは実装で回避できない（両視点から見える位置に材料を足しているため）。よって台座は既定で無効、有効化時は「両方の見え方に台座が加わります」と明示する。

さらに、**台座を付けても 1 パーツになるとは限らない**。全体の最小 Y に届かない連結成分は台座に接触しない。結合後に再度 `decompose()` し、成分数が 1 に落ちなければ「台座に接続されていないパーツがあります」と警告する。

---

## Error Handling

| ケース | 扱い |
|---|---|
| Wasm 初期化失敗 | 生成機能全体を無効化し、理由と対処（ブラウザ更新）を表示。フォールバック演算は行わない |
| `EMPTY_INTERSECTION` | 生成を実行せず、プリフライトの根拠（共通 Y 範囲なし）を示す |
| `NOT_MANIFOLD` | 結果を破棄し出力ボタンを無効化。入力の単純化を促す |
| SVG に閉パスなし | アップロードを拒否 |
| 頂点数超過 | 許容誤差付きで単純化し、`SIMPLIFIED` 警告を出す |
| Worker のクラッシュ | Worker を再生成し、直近のリクエストを 1 回だけ再試行する |

---

## Testing Strategy

**Unit（Vitest）** — 純粋な幾何ロジックはブラウザ不要で全て検証できる。ここに厚みを置く。
- `normalize`: 縦横比保持、原点センタリング、Y 反転後の巻き方向判定（SVG 由来の穴が穴として認識されること）
- `preflight`: `i` 型（空帯あり）、離れた 2 パーツ、完全に重ならない Y 範囲、単一連結の正常系
- `meshgl`: 既知の MeshGL → BufferGeometry の頂点数・インデックス範囲

**Integration（Vitest + node 上の manifold-3d）** — Wasm は Node でも動く。ブラウザなしで CSG 本体を検証できる。
- 正方形 × 円 → 連結成分 1、体積が解析解の許容範囲、`status() === NoError`
- 文字 `A` × 円 → カウンター（穴）が貫通していること
- 空交差になる組み合わせ → `EMPTY_RESULT`
- 200 回連続生成でヒープが単調増加しない（NFR-012）

**STL 検証（Vitest）** — ヘッダ検査だけでは「バイナリ STL としてシリアライズできた」ことしか示せない。STL は位相情報を捨てるため、入力が Manifold だったことは出力の保証にならない。書き出したバイトを読み戻して検証する：
- 全頂点が有限値
- 全三角形の面積が正（面積ゼロの縮退面がない）
- **全ての無向辺がちょうど 2 回、逆向きに現れる**（閉じていて向きが一貫している）
- bbox が FR-029 の指定寸法と一致（mm）
- GLB の bbox が同じ形状の 1/1000（m 換算の検証）

**鏡像回帰（Vitest + headless WebGL）** — 非対称シルエット（`F` / 矢印）を B に入れ、+X カメラの正射影レンダを参照画像と比較する。円・正方形では鏡像バグが**原理的に検出できない**ため、対称図形をこのテストに使わない。

**E2E（Playwright）**
- 初期表示: `loading-wasm` の表示 → 正方形 × 円の立体が描画される（FR-025）
- プリセット変更のレイテンシ（NFR-001 の測定条件どおり 147 サンプル、P95 < 300ms）
- カメラ回転 10 秒でフレーム間隔 P95 < 16.7ms、50ms 超のロングタスクゼロ（NFR-002）
- STL ダウンロードが発火し、上記 STL 検証を通る
- **本番ビルド検証**: `dist/` を静的配信し、Worker が参照する `.wasm` の URL が `base` を含み 200 を返す
- **モバイル**: 375×812 ビューポートでボトムシート化、1 本指ドラッグでページがスクロールしない
- **外部送信ゼロ**: 外部画像参照を含む SVG を投入し、ネットワークリクエストが 1 件も発生しないこと（NFR-030 / FR-005）

**アクセシビリティ（axe-core）** — 主要画面で violations ゼロ。キーボードのみで視点スナップとリセットに到達できること

**手動（Phase 3）**
- iOS 実機での USDZ Quick Look、Android での Scene Viewer

---

## Deployment — GitHub Pages

- `vite.config.ts` の `base: '/ambiguous-3d-studio/'`
- GitHub Actions（`actions/deploy-pages`）で main への push 時にビルド・公開
- **Wasm アセット**: 「ビルド後に確認する」では設計になっていない。**構成を確定させる。**

  `manifold-3d` の既定の Wasm 探索は生成された Worker チャンクからの相対解決になりうる。Vite はその名前で Wasm を出力しておらず、Pages の `base` も適用されないため、**dev では動いて本番だけ 404** になる。これを避けるには 3 箇所を揃える：

  ```ts
  // vite.config.ts
  export default defineConfig({
    base: '/ambiguous-3d-studio/',
    worker: { format: 'es' },   // 'iife' だと ES import を含む Worker が壊れる
  })
  ```
  ```ts
  // worker/client.ts — Vite に Worker を認識させる唯一の書き方
  new Worker(new URL('./csg.worker.ts', import.meta.url), { type: 'module' })
  ```
  ```ts
  // worker/csg.worker.ts — ?url で Vite にアセットとして出力・ハッシュ・base 付与させる
  import createManifold from 'manifold-3d'
  import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url'
  const wasm = await createManifold({ locateFile: () => manifoldWasmUrl })
  ```

  この構成は **Task 1.1（vite 設定）と Task 3.1/3.2（Worker 実装）の責務**であり、デプロイタスクでは直せない。

- **本番ビルド検証（自動）**: `npm run build` 後の `dist/` を静的配信し、Playwright で (a) Worker チャンクが読み込まれる、(b) その Worker が参照する `.wasm` の URL が `/ambiguous-3d-studio/` を含む、(c) その URL が 200 を返す、を確認する。dev サーバでの確認では不十分
- **MIME**: GitHub Pages は `.wasm` を `application/wasm` で返す。ローダーの ArrayBuffer フォールバックは残しておく
- **フォント**: テキスト入力用フォントは同梱し、CDN に依存しない（NFR-030）
- `VITE_ENABLE_AR` は Pages ビルドで `false`。AR 関連は動的 import にしてツリーシェイクを効かせる

---

## Performance Budget（NFR-001: 300ms）

**当初の予算表は大きく外れていた。** 以下は Task 7.2 の実測（147 サンプル、Apple Silicon / Chrome、NFR-001 の測定条件どおり）に基づく改訂版。

| 工程 | 実測 P95 | 当初の予算 | 乖離 |
|---|---|---|---|
| **デバウンス合流待ち** | **122.4ms** | **表に無し** | 予算に存在しなかった |
| 輪郭抽出（実体は React の同期再レンダリング — 後述） | 12.1ms | 5ms | 2.4× 超過 |
| **描画ハンドオフ** | **11.8ms** | **表に無し** | 予算に存在しなかった |
| intersect | 4.3ms | 150ms | **35× 過大** |
| postMessage 往復 | 2.4ms | 5ms | ほぼ的中 |
| extrude ×2 | 0.9ms | 30ms | 33× 過大 |
| CrossSection 構築 ×2 | 0.8ms | 20ms | 25× 過大 |
| プリフライト（256 走査線） | 0.3ms | 10ms | 33× 過大 |
| MeshGL コピー + 転送 | 0.3ms | 15ms | 50× 過大 |
| BufferGeometry 構築 + 法線 | 0.2ms | 20ms | 100× 過大 |
| 正規化 | 0.2ms | 2ms | 10× 過大 |
| **合計 P95** | **149.9ms** | 257ms | 予算内 |

**当初の予算が名前を挙げた工程の実測合計は 21.3ms しかない。** 実際の 149.9ms のうち **89% は当初の表に存在しなかった 2 工程**（デバウンス + 描画ハンドオフ）が占める。幾何演算をボトルネックと想定したことが誤りで、Manifold は想定よりはるかに速い。

**この予算表の教訓**：見積もりは「重そうな処理」に張り付きやすい。実際にはフレームワークの再レンダリングと、自分で入れた待ち時間が支配的だった。

### 2 つの注意点

**「輪郭抽出」の実体は React の同期再レンダリング。** 生成の起点が click ハンドラ内の zustand `set()` にあるため、`await` の継続はマイクロタスクとなり、React が離散更新をフラッシュし終えてから再開する。つまりサイドバー全体の再レンダリングがこの区間に入る。実際の輪郭抽出は約 0.2ms（React イベント由来でない起動時の生成で計測）。NFR-001 の定義（入力変更 → メッシュ描画完了）としては正しい計測だが、**予算表の「輪郭抽出」行と比較してはいけない**。

**デバウンス 120ms が体感遅延の 81%。** NFR-004 が定めるこの値は、当初の 257ms 予算のほぼ半分にあたるのに表に載っていなかった。CSG 本体が 4ms で終わる以上、この値は再検討の余地がある（打鍵の合流という目的自体は有効）。

### 補足
- SVG 由来の高頂点数入力ではこの限りでない。頂点数上限（10,000）と曲線フラット化の許容誤差で入力側を抑える
- Wasm 初期化（実測 100〜300ms）は起動時に先読みし予算外（NFR-003）
- 計測コードは `import.meta.env` のビルド時定数で畳み込まれ、本番バンドルに mark / measure 名は 1 つも残らない（実測の増分：メイン +0.30kB、Worker +0.40kB）
