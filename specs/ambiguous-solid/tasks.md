# Ambiguous Solid Generator — Tasks

並列エージェントで実行する前提。**各タスクは所有ファイルが互いに素**で、同一 Wave 内では同じファイルを触らない。

ファイル所有の原則：
- **共有される結合ファイル（`App.tsx`, `useGenerationPipeline.ts`, `Viewport.tsx`）は、その Wave でただ 1 タスクが所有する**
- 後続 Wave が拡張する見込みのモジュールは、**先行 Wave がシグネチャ付きスタブを作っておく**。後続はスタブの中身を差し替えるだけで、呼び出し側を編集しない
- 計測コード（`performance.mark`）は本番ファイルを触るので、専用タスクが所有する

凡例: `[P1]` Phase 1 / `[P2]` Phase 2 / `[P3]` Phase 3（`VITE_ENABLE_AR` 配下・Pages 非公開）

---

## Wave 1 — 土台（単独）

- [ ] **Task 1.1**: scaffold・共有型・Worker/Wasm 構成・ソーススタブ `[P1]`
  - What:
    - Vite + React + TS 初期化、Tailwind / Vitest / ESLint / Prettier
    - **`manifold-3d` を 3.5.1 で厳密固定**（lockfile 込み）
    - `vite.config.ts` に `base: '/ambiguous-3d-studio/'` と **`worker: { format: 'es' }`**（design.md「Deployment」の 3 点構成。ここを外すと本番のみ 404 になり、デプロイタスクでは直せない）
    - `src/geometry/types.ts` に `Contour` / `Silhouette` / `PreflightReport` / `GenerationResult` / `PreflightWarning`
    - `src/sources/text.ts` と `src/sources/svg.ts` を **`NotImplementedError` を投げるスタブ**として作成（Wave 6 が中身のみ差し替える。呼び出し側を後から編集させないため）
    - `VITE_ENABLE_AR` の型宣言
  - Files: `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `tailwind.config.js`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`(空), `src/index.css`, `src/vite-env.d.ts`, `src/geometry/types.ts`, `src/sources/text.ts`(stub), `src/sources/svg.ts`(stub)
  - Done when: `npm run build` `npm run test` `npm run lint` が通り、`vite.config.ts` に `worker.format === 'es'` と正しい `base` がある
  - Depends on: none

---

## Wave 2 — 純粋ロジック（並列 5 / ブラウザも Wasm も不要）

- [ ] **Task 2.1**: 輪郭の正規化 `[P1]`
  - What: 縦横比を保った共通高さ `H` へのフィット、bbox 中心の原点センタリング、符号付き面積による巻き方向判定（外輪郭 CCW / 穴 CW）、Y 反転ユーティリティ
  - Files: `src/geometry/normalize.ts`, `src/geometry/normalize.test.ts`
  - Done when: 縦長 / 横長 / 正方形で高さが `H` に揃い中心が原点。**Y 反転後**に巻き方向が再判定され、SVG 由来の穴が穴として残る
  - Depends on: 1.1

- [ ] **Task 2.2**: プリセット図形 `[P1]`
  - What: 円 / 正方形 / 正三角形 / ハート / 星 / 矢印 / 十字 を `Contour[]` で返す。円は分割数パラメータ付き。**矢印は左右非対称**にする（鏡像回帰テストの入力になる）
  - Files: `src/sources/presets.ts`, `src/sources/presets.test.ts`
  - Done when: 全図形が閉パスで符号付き面積が正（CCW）。矢印の x 反転が元と一致しないこと（非対称性の保証）
  - Depends on: 1.1

- [ ] **Task 2.3**: プリフライト判定 `[P1]`
  - What: 256 本の水平走査線で各シルエットの x 区間集合を求め、共通 Y 範囲・空帯・区間数の積・最小区間幅から `PreflightReport` を返す。**`EMPTY_INTERSECTION` / `EMPTY_BAND` は断定、`LIKELY_DISCONNECTED` / `THIN_NECK` は推定**として区別してフラグを立てる（design.md「厳密に言えること / 言えないこと」）
  - Files: `src/geometry/preflight.ts`, `src/geometry/preflight.test.ts`
  - Done when: (a) Y 範囲が重ならない組 → `EMPTY_INTERSECTION`、(b) `i` 型の空帯 → `EMPTY_BAND`、(c) 離れた 2 パーツ → `LIKELY_DISCONNECTED` が**推定フラグ付き**、(d) 正方形×円 → 警告なし
  - Depends on: 1.1

- [ ] **Task 2.4**: Manifold アダプタと MeshGL 変換 `[P1]`
  - What: `toPolygons.ts`（`Contour[]` → `[number,number][][]`、偶数長・3 頂点以上・有限値の検証付き）。`meshgl.ts`（`numProp=3` の MeshGL ⇄ `BufferGeometry`、インデックス範囲・有限値・面積ゼロ三角形の検証）
  - Files: `src/geometry/toPolygons.ts`, `src/geometry/toPolygons.test.ts`, `src/geometry/meshgl.ts`, `src/geometry/meshgl.test.ts`
  - Done when: 奇数長・2 頂点・NaN の各不正入力を `toPolygons` が例外で弾く。既知の四面体 MeshGL で頂点数・インデックス範囲・法線が期待どおり
  - Depends on: 1.1
  - Note: **`Contour` をそのまま `CrossSection` に渡すことはできない**（`Polygons = Vec2[][]`）。このアダプタが Manifold への唯一の入口

- [ ] **Task 2.5**: ストア・Worker プロトコル型・スケール換算 `[P1]`
  - What: `protocol.ts`（`CsgRequest` / `CsgResponse` / `CsgError`、実装は Wave 3）。`useStudioStore.ts`（入力・オプション・**FR-025 の状態機械** `loading-wasm | ready | generating | success | error | init-failed`・警告リスト・**リセットと直前入力の復帰**）。`scale.ts`（共通高さ mm ⇄ 作業座標。STL は mm、GLB/USDZ は **×0.001 で m**）
  - Files: `src/worker/protocol.ts`, `src/store/useStudioStore.ts`, `src/store/useStudioStore.test.ts`, `src/studio/scale.ts`, `src/studio/scale.test.ts`
  - Done when: 状態機械の全遷移がテストで通る。SVG 拒否時に直前の有効入力へ戻る。`scale` が STL と GLB で 1000 倍差を返す
  - Depends on: 1.1

---

## Wave 3 — CSG エンジン（並列 2）

- [ ] **Task 3.1**: CSG Worker 本体 `[P1]`
  - What:
    - `createManifold({ locateFile: () => manifoldWasmUrl })` と `manifold-3d/manifold.wasm?url` による初期化（1 回のみ）
    - `new CrossSection(toPolygons(contours), 'Positive')` → `.extrude(depth, 0, 0, [1,1], true)` → B は `.rotate([0, 90, 0])`
    - **メソッドチェーン禁止**。`sectionA/B` `rawA/rawB` `prismB` `solid` `parts[]` を個別変数で保持し、`finally` で**生成の逆順に全て `.delete()`**（`decompose()` の戻り配列の各要素も含む）
    - `status() !== 'NoError'` で破棄（**文字列リテラル比較**）。`decompose()` で連結成分数を確定
    - `getMesh()` の配列は**新規 typed array にコピーしてから** transfer
    - 生成/破棄カウンタを持ちリークテストに露出させる
  - Files: `src/worker/csg.worker.ts`, `src/worker/csg.integration.test.ts`
  - Done when: Node 上の Vitest で (a) 正方形×円 → 成分 1・`'NoError'`・体積が解析解の ±2%、(b) **手書きの穴あき多角形**（ドーナツ）× 円 → 穴が貫通、(c) 空交差 → `EMPTY_RESULT`、(d) 200 回連続生成後に**生存オブジェクト数がゼロ**（ヒープ容量の減少は見ない）
  - Depends on: 2.1, 2.2, 2.4, 2.5
  - Note: 文字を使った統合テストは Task 6.1 完了後（Wave 6）に置く。この Wave では `text.ts` がまだスタブ

- [ ] **Task 3.2**: Worker クライアント `[P1]`
  - What: `new Worker(new URL('./csg.worker.ts', import.meta.url), { type: 'module' })` による常設起動、起動時の Wasm 先読み、**10 秒タイムアウト**、120ms デバウンス、単調増加する世代 ID と stale 破棄、クラッシュ時の再生成＋1 回だけ再試行
  - Files: `src/worker/client.ts`, `src/worker/client.test.ts`
  - Done when: モック Worker で (a) 連続 10 リクエストのうち最後の 1 件のみ採用、(b) 古い世代を無視、(c) クラッシュ後に再試行、(d) 10 秒で `init-failed` に遷移
  - Depends on: 2.5

---

## Wave 4 — 結線（単独・ここが抜けると全部が繋がらない）

- [ ] **Task 4.1**: 生成パイプラインと App 合成 `[P1]`
  - What: 入力 → 正規化 → プリフライト → 押し出し深さ算出 → Worker リクエスト → MeshGL 変換 → ストア反映 → ジオメトリ公開、を 1 本に繋ぐ。`source.kind` の `switch` は**ここで全分岐を書き切る**（`preset` / `text` / `svg`。text と svg は Wave 1 のスタブを呼ぶ。Wave 6 はスタブの中身のみ差し替え、このファイルを編集しない）。FR-025 の状態機械を駆動。`App.tsx` にサイドバー枠とビューポート枠を配置
  - Files: `src/studio/useGenerationPipeline.ts`, `src/studio/useGenerationPipeline.test.ts`, `src/App.tsx`
  - Done when: モック Worker で「プリセット変更 → ストアに `success` とジオメトリが入る」が通る。`loading-wasm` から `ready` 到達時に初期入力で 1 回だけ生成が走る
  - Depends on: 3.1, 3.2
  - **Wave 2 のレビューで判明した注意点（ここを外すと再発する）**
    - **生成のゲートは `PreflightReport.ok` ではなく `EMPTY_INTERSECTION` の有無で判断する。** `ok` は「警告ゼロ」の意味であり、`EMPTY_BAND` が出ていても生成自体は実行する（US-001: 適格でない組み合わせも生成はして、欠落する帯を提示する）
    - **世代エポックを必ず突き合わせる。** ストアは入力変更のたびにエポックを進め、遅れて届いた旧世代のレスポンスを弾く。パイプライン側も同じエポックを Worker リクエストに載せ、**外部 ref のジオメトリを入力変更と同一トランザクションでクリアする**（ストアはジオメトリを持たないので、ref のクリアはここの責務。怠ると画面と export の中身がズレる）
    - **入力が正常に解析・正規化できた時点で**「有効入力」としてコミットする。設定した瞬間にスナップショットすると、非同期の拒否が返る前に別の編集が入った場合に無効な入力を復帰先として記録してしまう

---

## Wave 5 — シーンと UI（並列 4）

- [ ] **Task 5.1**: R3F ビューポート `[P1]`
  - What: R3F キャンバス、ライティング、グリッド床、OrbitControls（減衰付き）、`SolidMesh`。ジオメトリは React state でなく ref で保持。`<CameraRig/>` を子として描画する（実装は 5.4。props 契約は design.md に従い、**このタスクは CameraRig.tsx を編集しない**）
  - Files: `src/scene/Viewport.tsx`, `src/scene/SolidMesh.tsx`
  - Done when: ジオメトリが描画され、カメラ操作中に React の再レンダリングが発生しない
  - Depends on: 4.1

- [ ] **Task 5.2**: サイドバーと**全入力 UI** `[P1]`
  - What: 視点 A/B の入力種別タブ（プリセット / テキスト / SVG の**3 つとも**）、プリセット選択、テキスト入力欄、**SVG のファイル入力とドロップ領域**、オプション（仮想ミラー・台座・実寸 mm）、リセット、プリフライト警告表示。**警告は「エラー」ではなく「この組み合わせの性質」の文言にする**。断定フラグと推定フラグで文体を変える（「〜です」/「〜の可能性があります」）
  - Files: `src/ui/Sidebar.tsx`, `src/ui/SilhouettePicker.tsx`, `src/ui/StatusBanner.tsx`, `src/ui/SweetSpotIndicator.tsx`, `src/ui/SvgDropzone.tsx`
  - Done when: 3 タブすべてがストアに反映され再生成が走る。全 `PreflightWarning` に文言が存在する
  - Depends on: 4.1
  - Note: **入力 UI はここで全部作る**。Wave 6 の text/svg タスクは解析ロジックのみを担当し、UI を触らない（同一ファイルの奪い合いを避けるため）

- [ ] **Task 5.3**: バイナリ STL 出力と検証 `[P1]`
  - What: `STLExporter { binary: true }`、FR-029 のスケール適用（mm）、`componentCount > 1` の出力前警告、ダウンロード発火。**書き出したバイトを読み戻す検証ユーティリティ**
  - Files: `src/export/stl.ts`, `src/export/stl.test.ts`, `src/export/verifyStl.ts`, `src/export/verifyStl.test.ts`
  - Done when: 読み戻して (a) 全頂点が有限、(b) 全三角形の面積が正、(c) **全無向辺がちょうど 2 回・逆向きに出現**、(d) bbox が指定 mm と一致 — を検証できる。ヘッダ検査だけで完了としない
  - Depends on: 2.4, 2.5

- [ ] **Task 5.4**: カメラリグと Sweet Spot `[P2]`
  - What: 正面(+Z) / 側面(**+X**) / 俯瞰へのスナップ（400ms イージング、`prefers-reduced-motion` で即時切替）、スナップ完了時の正射影切替（見かけサイズを保つ zoom 合わせ）、`useFrame` 内の角度差算出と 3.5° 判定。**判定値が変化したフレームのみ**ストア更新
  - Files: `src/scene/CameraRig.tsx`, `src/scene/SweetSpot.ts`, `src/scene/SweetSpot.test.ts`
  - Done when: 角度差算出が単体テストで正しい。**側面カメラは +X 側**（−X に置くと B が左右反転する — design.md「軸の割り当てとカメラ規約」）
  - Depends on: 4.1

---

## Wave 6 — 入力の拡張と演出（並列 4）

- [ ] **Task 6.1**: テキスト入力 `[P2]`
  - What: Wave 1 のスタブ `src/sources/text.ts` の中身を実装。同梱フォント（CDN 不使用）からグリフ輪郭を抽出し、外輪郭と穴の入れ子を保つ。1〜8 文字。曲線は許容誤差付きでフラット化。**UI とパイプラインは触らない**
  - Files: `src/sources/text.ts`, `src/sources/text.test.ts`, `src/worker/text.integration.test.ts`, `public/fonts/`
  - Done when: `A` `B` `8` `O` のカウンターが `isHole: true` で抽出される。統合テストで文字 `A` × 円の交差に穴が貫通する
  - Depends on: 5.2

- [ ] **Task 6.2**: SVG インポート `[P2]`
  - What: スタブ `src/sources/svg.ts` の実装。**FR-005 のサポート部分集合に限定**し、範囲外は取得せず破棄。`fill-rule`（CSS と属性の両方）、transform、複合サブパス、**Y 下向き → Y 上向き変換とその後の巻き方向再判定**、頂点数上限 10,000 での単純化。`<image>` `<use href="http…">` `<script>` 外部 CSS / 外部フォントは**フェッチせずに**除去
  - Files: `src/sources/svg.ts`, `src/sources/svg.test.ts`
  - Done when: ドーナツで穴が穴として、evenodd の入れ子で塗り領域が正しい。閉パスなしの SVG が拒否される。**外部 URL を含む SVG を処理してもネットワークリクエストが 0 件**（NFR-030）
  - Depends on: 5.2

- [ ] **Task 6.3**: 仮想ミラー `[P2]`
  - What: 視点 B(+X) 方向の反射面、視点 A からの構図で本体と鏡像が同時成立。無効時はアンマウントして反射レンダーターゲットを解放。`Viewport.tsx` に組み込む（この Wave で `Viewport.tsx` を触るのはこのタスクのみ）
  - Files: `src/scene/VirtualMirror.tsx`, `src/scene/Viewport.tsx`
  - Done when: 有効時に鏡像が図形 B のシルエットとして見え、無効化で `dispose()` が呼ばれる
  - Depends on: 5.1, 5.4

- [ ] **Task 6.4**: 台座と GLB 出力 `[P2]`
  - What: 台座を **Worker 内**で `solid.add(plate)` として結合（フットプリント bbox×1.15、厚み既定 2.0mm、接触許容 0.1mm）。**結合後に再度 `decompose()`** し、1 パーツにならなければ「台座に接続されていないパーツがある」と警告。`glb.ts` は `GLTFExporter { binary: true }` と **×0.001 の m 換算**
  - Files: `src/export/glb.ts`, `src/export/glb.test.ts`, `src/worker/csg.worker.ts`（台座分岐の追加）
  - Done when: 台座付き出力が `'NoError'`。最小 Y に届かない成分を含む入力で警告が出る。GLB の bbox が STL の 1/1000
  - Depends on: 3.1, 5.3

---

## Wave 7 — レスポンシブ・a11y・計測（並列 2）

- [ ] **Task 7.1**: モバイルレイアウトとアクセシビリティ `[P1]`
  - What: 768px 未満でサイドバーをボトムシート化、3D ビューポートに画面の過半、44×44px 以上のタップ領域、セーフエリア回避、ビューポート上の 1 本指ドラッグでページスクロールさせない。全コントロールのラベル、キーボードでのスナップ/リセット/ズーム、Sweet Spot の**色以外**の提示、`aria-live` による状態通知、`prefers-reduced-motion`
  - Files: `src/ui/*`, `src/index.css`, `src/scene/Viewport.tsx`
  - Done when: 375×812 で操作可能。axe-core violations ゼロ。キーボードのみで視点スナップとリセットに到達できる
  - Depends on: 5.1, 5.2, 5.4, 6.3

- [ ] **Task 7.2**: 性能計測の埋め込み `[P1]`
  - What: `performance.mark` / `measure` を工程境界（輪郭抽出・正規化・プリフライト・postMessage 往復・CSG・メッシュ変換・描画）に埋め込み、開発時に内訳を出す。**本番パイプラインのファイルを編集するため専用タスクにしてある**
  - Files: `src/studio/useGenerationPipeline.ts`, `src/studio/perf.ts`, `src/worker/csg.worker.ts`, `src/worker/client.ts`
  - Done when: 1 回の生成で全工程の内訳が取得でき、合計が実測レイテンシと一致する
  - Depends on: 6.1, 6.2, 6.4

---

## Wave 8 — 公開（3）

- [ ] **Task 8.1**: 本番ビルド検証と Pages 公開 `[P1][P2]`
  - What: `actions/deploy-pages` で main への push 時にビルド・公開（`VITE_ENABLE_AR=false`）。**デプロイ前に**`dist/` を静的配信して Playwright で検証：Worker チャンクが読み込まれ、その Worker が参照する `.wasm` の URL が `/ambiguous-3d-studio/` を含み 200 を返す
  - Files: `.github/workflows/deploy.yml`, `e2e/production-build.spec.ts`, `playwright.config.ts`
  - Done when: ローカルの本番ビルド検証が通り、Pages の実 URL で立体が生成・描画され STL がダウンロードできる
  - Depends on: 7.1, 7.2（= Phase 1+2 の全タスク）

- [ ] **Task 8.2**: E2E と性能計測 `[P1][P2]`
  - What: 初期表示（`loading-wasm` → 描画）、レイテンシ（NFR-001 の条件で 147 サンプル、P95 < 300ms）、フレーム間隔（NFR-002）、STL ダウンロード＋読み戻し検証、モバイル 375×812、**外部参照 SVG でネットワーク 0 件**、鏡像回帰（非対称な矢印を B に入れ +X 正射影を参照画像と比較）
  - Files: `e2e/*.spec.ts`
  - Done when: 全シナリオが通り、P95 レイテンシが 300ms 以内
  - Depends on: 8.1

- [ ] **Task 8.3**: README 更新 `[P1][P2]`
  - What: 公開 URL、使い方、**「空の走査線」制約**と適格性の説明、台座が錯視を壊すこと、ローカル開発手順
  - Files: `README.md`
  - Depends on: 8.1

---

## Wave 9 — WebAR `[P3]`（ローカル限定・Pages 非公開）

- [ ] **Task 9.1**: GLB / USDZ 動的生成と AR 起動
  - What: `usdz.ts` と `<model-viewer>` 連携。**m 換算（×0.001）を適用**。`VITE_ENABLE_AR` が false のとき AR UI を描画せず、AR 関連は動的 import でバンドル分離
  - Files: `src/export/usdz.ts`, `src/ui/ArButton.tsx`
  - Done when: `VITE_ENABLE_AR=true` のローカルビルドで AR が起動。false のビルドで AR コードがバンドルに含まれない（bundle analyzer で確認）
  - Depends on: 6.4

- [ ] **Task 9.2**: iOS / Android 実機確認（手動）
  - What: iOS Safari の Quick Look、Android Chrome の Scene Viewer で **1:1 スケール**表示を確認（1000 倍事故の検出）
  - Done when: 両 OS で実寸表示され、周囲を歩いて錯視が確認できる
  - Depends on: 9.1

---

## Progress

| 区分 | Wave | タスク数 |
|---|---|---|
| 公開対象 | 1〜8 | 22 |
| ローカル限定 | 9 | 2 |
| **合計** | | **24** |

Completed: 0 | In Progress: 0

## codex レビューで潰した設計事故（着手前）

| # | 内容 | 直した場所 |
|---|---|---|
| 1 | `Contour` を `CrossSection` に直接渡せない（`Polygons = Vec2[][]`） | ADR-005 / Task 2.4 |
| 2 | 本番のみ Wasm 404（Worker アセット解決） | design.md Deployment / Task 1.1 |
| 3 | パイプラインを誰も所有していない | Task 4.1（新設） |
| 4 | 共通高さは適格性の十分条件ではない | US-001 適格性の定義 |
| 5 | `status()` は文字列ユニオン。`NoError` 識別子は存在しない | ADR-006 / Task 3.1 |
| 6 | 側面カメラの置き場所次第で B が鏡像になる | design.md カメラ規約 / Task 5.4 |
| 7 | 走査線から連結成分数は確定できない | FR-012 / Task 2.3 |
| 8 | メソッドチェーンで Wasm 中間オブジェクトが漏れる | Task 3.1 |
| 9 | 台座は錯視を壊し、1 パーツも保証しない | FR-015 / Task 6.4 |
| 10 | 同一 Wave で `App.tsx` / UI ファイルを奪い合う | 所有権の原則 / Wave 4・5 の再編 |
| 11 | 実寸 mm の意味が未定義。GLB は m なので 1000 倍事故 | FR-029 / Task 2.5 |
| 12 | Wasm 未準備時の初期表示が未定義 | FR-025 / 状態機械 |
| 13 | モバイルと a11y が宣言のみで未設計 | FR-026 / FR-027 / Task 7.1 |
| 14 | STL のヘッダ検査は要件を検証していない | Task 5.3 |
| 15 | Emscripten ヒープは縮まないのでリーク判定が偽陽性 | NFR-012 / Task 3.1 |
