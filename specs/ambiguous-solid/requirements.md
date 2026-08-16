# Ambiguous Solid Generator — Requirements

## Overview

2 つの 2D シルエット（プリセット図形 / 文字 / SVG）を入力として受け取り、それぞれを自身の視線軸に沿って押し出した角柱の**ブール交差**を求めることで、正面から見ると図形 A、側面から見ると図形 B に見える「錯視立体（両義立体）」を生成する。生成物はブラウザ上でリアルタイムに描画・回転でき、3D プリンタ用のバイナリ STL として書き出せる。

数学的中核は `M = M_A ∩ M_B`。M_A は A を Z 軸方向、M_B は B を X 軸方向に押し出した角柱。

**リリーススコープ**
- Phase 1 + Phase 2 → GitHub Pages で公開
- Phase 3（WebAR）→ 実装するが `VITE_ENABLE_AR` フラグ配下。公開ビルドでは無効

---

## User Stories

### US-001: 2 つのシルエットから錯視立体を得る
**As a** 錯視立体を作ってみたい人 **I want to** 図形を 2 つ選ぶだけで **So that** 幾何学の知識なしに両義立体を手に入れられる

**Acceptance Criteria:**
- WHEN ユーザーが視点 A と視点 B のプリセット図形を選択する THE SYSTEM SHALL 両シルエットの交差立体を 1 つの `BufferGeometry` として生成し 3D ビューポートに描画する
- IF 組み合わせが**適格**（下記定義）である THEN THE SYSTEM SHALL 視点 A の正射影シルエットを、図形 A の輪郭に対して IoU 0.98 以上で一致させる
- IF 組み合わせが適格でない THEN THE SYSTEM SHALL 生成は行うが、どの高さ帯のシルエットが欠落するかを事前に提示する
- IF 選択された 2 図形の交差が空集合になる THEN THE SYSTEM SHALL 立体を描画せず「この組み合わせは交差しません」と理由を明示する
- WHEN 入力を変更する THE SYSTEM SHALL 直前の生成結果を破棄し、最新の入力に対応するメッシュのみを描画する

> **用語の区別**
> - **1 メッシュ** = 1 個の `BufferGeometry`。常にこの形で返る。
> - **1 パーツ** = 連結成分 1 個。印刷して 1 個の物体になる状態。適格な組み合わせでも保証されない（FR-014）。
> この 2 つは別物として扱う。

> **適格性（Eligibility）の定義**
> 高さ `y` におけるシルエット A の被覆を `A_y`、B の被覆を `B_y` とするとき、
> ```
> ∀y:  A_y ≠ ∅  ⟺  B_y ≠ ∅
> ```
> を満たす組み合わせを**適格**と呼ぶ。共通高さに正規化しても、片方だけ被覆が空になる高さ帯があれば適格ではなく、その帯のシルエットは**原理的に**再現できない（FR-012 参照）。バウンディングボックスの高さ一致は必要条件であって十分条件ではない。

### US-002: 文字・SVG を投影シルエットにする
**As a** 名前やロゴで錯視立体を作りたい人 **I want to** 任意の文字列や手持ちの SVG をシルエットとして使う **So that** 自分だけの錯視立体を作れる

**Acceptance Criteria:**
- WHEN ユーザーが英数字 1〜8 文字を入力する THE SYSTEM SHALL フォントのアウトラインパス（穴を含む）からシルエットを構成する
- WHEN ユーザーが SVG ファイルをアップロードする THE SYSTEM SHALL 閉じたパスのみを抽出し、`fill-rule` に従って塗り領域を決定する
- IF SVG に閉じたパスが 1 つも含まれない THEN THE SYSTEM SHALL アップロードを拒否し理由を表示する
- WHEN SVG の頂点数が上限（10,000）を超える THE SYSTEM SHALL 許容誤差付きで単純化し、単純化した旨を表示する
- THE SYSTEM SHALL アップロードされた SVG およびテキストを一切ネットワーク送信しない

### US-003: 錯視が成立する視点を自力で探す
**As a** 錯視を体験したい人 **I want to** 自分でカメラを回して「見え方が切り替わる瞬間」を探す **So that** 錯視の成立条件を体感できる

**Acceptance Criteria:**
- WHILE ユーザーがカメラをドラッグしている THE SYSTEM SHALL カメラ視線と目標視線の角度差をリアルタイムに表示する
- WHEN 角度差が 3.5° 未満になる THE SYSTEM SHALL 「シルエット合致」インジケーターを点灯させる
- WHEN ユーザーが視点スナップボタン（正面 / 側面 / 俯瞰）を押す THE SYSTEM SHALL 対応するアングルへカメラをアニメーション付きで移動させる
- WHILE カメラが操作されている THE SYSTEM SHALL 60fps を維持する

### US-004: 二面同時成立を鏡で確認する
**As a** 錯視立体の面白さを人に見せたい人 **I want to** 本体と鏡像を同時に見る **So that** 一画面で両方のシルエットが成立していることを示せる

**Acceptance Criteria:**
- WHEN 仮想ミラーを有効にする THE SYSTEM SHALL 立体の背後に反射面を配置し、視点 A から本体と鏡像の両シルエットが同時に見える構図を提示する
- WHEN 仮想ミラーを無効にする THE SYSTEM SHALL 反射面とその描画コストを完全に除去する

### US-005: 3D プリント用に書き出す
**As a** 3D プリンタ所有者 **I want to** スライサーがエラーを出さないファイルを得る **So that** そのまま印刷できる

**Acceptance Criteria:**
- WHEN ユーザーが STL 出力を押す THE SYSTEM SHALL バイナリ形式の `.stl` をブラウザのダウンロードとして提供する
- THE SYSTEM SHALL 出力メッシュを穴・裏返り面のない 2-manifold として保証する
- IF 生成結果が複数の非連結パーツに分離している THEN THE SYSTEM SHALL 出力前にパーツ数を警告として表示する
- WHEN 台座オプションが有効な状態で出力する THE SYSTEM SHALL 底面にフラット台座をブール和で結合した単一パーツを出力する

### US-006: AR で実物大を確認する（Phase 3 / ローカル限定）
**As a** 印刷前に大きさを確かめたい人 **I want to** スマホで実寸の立体を机に置く **So that** 印刷して失敗する前に判断できる

**Acceptance Criteria:**
- WHILE `VITE_ENABLE_AR` が false THE SYSTEM SHALL AR 起動 UI を一切描画しない
- WHEN AR を起動する THE SYSTEM SHALL 生成済みジオメトリから GLB / USDZ を生成し、専用アプリのインストールなしで AR セッションを開始する

---

## Functional Requirements

### 入力 (Input)

#### FR-001: プリセット図形選択
**Priority:** P0
WHEN ユーザーがプリセット一覧から図形を選択する THE SYSTEM SHALL 円 / 正方形 / 正三角形 / ハート / 星 / 矢印 / 十字 のいずれかの閉輪郭を返す
**Rationale:** ゼロ入力で成功体験に到達させる。初期状態は正方形 × 円。

#### FR-002: テキストのアウトライン抽出
**Priority:** P1
WHEN ユーザーが英数字を入力する THE SYSTEM SHALL フォントのグリフ輪郭を外輪郭と穴輪郭の入れ子として抽出する
**Rationale:** `A` `B` `8` のカウンター（穴）を潰すと文字として読めない。

#### FR-003: SVG インポート
**Priority:** P1
WHEN ユーザーが SVG を投入する THE SYSTEM SHALL Y 下向き座標系を Y 上向きに変換し、変換後に巻き方向を再判定する
**Rationale:** SVG は Y 下向き。単純に読み込むと上下反転かつ巻き方向が逆転し、穴が外輪郭として扱われる。

#### FR-004: 投影軸設定
**Priority:** P2
WHEN ユーザーが視点 B の軸を切り替える THE SYSTEM SHALL 直交（X 軸）または斜交（XZ 平面内の任意角）で押し出し方向を再構成する
**Rationale:** 直交が基本形。斜交は表現の幅。

#### FR-005: SVG のサポート範囲と外部参照の遮断
**Priority:** P1
THE SYSTEM SHALL 対応 SVG を以下の部分集合に限定し、範囲外の要素を**取得せずに**無視または拒否する

| 要素・属性 | 扱い |
|---|---|
| `<path>` `<polygon>` `<rect>` `<circle>` `<ellipse>` の閉じた形状 | 採用 |
| `transform`（`matrix` / `translate` / `scale` / `rotate`） | 適用する |
| `fill-rule` / `clip-rule`（`nonzero` / `evenodd`）、CSS と presentation attribute の両方 | 適用する |
| 複合サブパス（1 つの `d` に複数の `M`） | 入れ子として解釈する |
| `fill="none"` の要素 | 無視する |
| ストロークのみの線 | 無視する（面がないため） |
| `<image>` `<use xlink:href="http...">` `<script>` 外部 CSS / 外部フォント | **取得せず**破棄する |
| `clipPath` `mask` `filter` | 無視する（適用しない旨を警告） |

**Rationale:** 「`fill-rule` に従う」だけでは範囲が定まらず、実装が任意 SVG を解釈しに行く。特に外部参照を素通しすると、ブラウザが画像やフォントを取りに行き **NFR-030（外部送信ゼロ）が破れる**。これは設定漏れではなく、パーサが取得可能な参照を残すこと自体が違反になる。

#### FR-006: 入力のリセットと復帰
**Priority:** P1
WHEN ユーザーが「形状をリセット」を実行する THE SYSTEM SHALL 視点 A/B を初期値（正方形 × 円）に戻す
WHEN ユーザーが「視点をリセット」を実行する THE SYSTEM SHALL カメラを初期の俯瞰アングルに戻す
IF SVG のアップロードが拒否される THEN THE SYSTEM SHALL 直前の有効な入力を保持し、その状態に復帰する
**Rationale:** 全ての編集が直前の結果を即座に破棄するため、不正な SVG やタイプミスから戻る手段が必要。多段 undo はスコープ外とし、1 段の復帰のみを保証する。

### 生成 (Generation)

#### FR-010: 輪郭の正規化
**Priority:** P0
WHEN シルエットが確定する THE SYSTEM SHALL 各輪郭を縦横比を保ったまま共通の高さ（Y 範囲）に合わせ、バウンディングボックス中心を原点に置く
**Rationale:** 両シルエットの Y 範囲が一致しなければ、はみ出した高さ帯は必ず削り落とされ、その視点の形が成立しない。X/Z を独立に引き伸ばすと形が崩れる。

#### FR-011: 押し出しと交差
**Priority:** P0
WHEN 正規化済み輪郭が 2 つ揃う THE SYSTEM SHALL 各輪郭を相手のシルエットの全範囲＋余白を覆う深さで原点対称に押し出し、両者のブール交差を算出する
**Rationale:** 押し出しが浅いと交差が相手の形を切り落とす。深さは相手の bbox 幅＋マージンで決まる。

#### FR-012: 生成前プリフライト判定（ヒューリスティック）
**Priority:** P0
WHEN 生成を実行する前 THE SYSTEM SHALL 両シルエットの被覆を解析し、適格性（US-001 の定義）を満たさない高さ帯・分離リスク・細すぎる首を**推定**して提示する
THE SYSTEM SHALL プリフライトの結果を「リスク信号」として提示し、確定した事実として提示しない
**Rationale:** 高さ y におけるスライスは `A_y × B_y` の直積であり、これは厳密。したがって片方が空なら交差もそこで空になる、も厳密。

一方で**連結成分数の判定は厳密にできない**：ある高さで m×n 個の島に分かれていても、別の高さで合流しうる。走査線サンプリングでは狭い空帯・首・位相変化を取りこぼす。よってプリフライトは警告のみを担い、**確定した連結成分数は生成後の `decompose()` を唯一の根拠とする**（FR-014）。

空帯そのものは実装の不具合ではなく数学的必然（`i` の点、離れた 2 文字、複数パーツの SVG で必ず起きる）なので、UI ではエラーではなく「この組み合わせの性質」として提示する。

#### FR-013: マニホールド保証
**Priority:** P0
THE SYSTEM SHALL 交差演算の結果が 2-manifold であることを演算エンジンのステータスで検証し、非マニホールドを検出した場合は出力を拒否する
**Rationale:** スライサーがエラーを出す状態でファイルを渡さない。

#### FR-014: 分離パーツ検出
**Priority:** P1
WHEN 交差演算が完了する THE SYSTEM SHALL `decompose()` により連結成分数を確定し、2 以上ならユーザーに提示する
**Rationale:** 3 パーツに割れた立体は印刷しても組み立てられない。プリフライトの推定ではなく演算結果を根拠とする。

#### FR-015: 台座の結合（錯視を壊すオプション）
**Priority:** P2
WHEN 台座オプションが有効 THE SYSTEM SHALL 立体の最小 Y に接するフラット台座をブール和で結合し、**両シルエットに台座の輪郭が加算される**旨を明示する
IF 台座結合後も連結成分が 2 以上残る THEN THE SYSTEM SHALL 台座に接していない成分が存在することを警告する
THE SYSTEM SHALL 台座を出力専用オプションとして扱い、既定で無効とする

**台座パラメータ**
- 底面フットプリント: 立体の XZ バウンディングボックス × 1.15
- 厚み: 実寸 2.0mm 相当（既定値、0.5〜5.0mm で調整可）
- 接触判定許容: 立体の最小 Y から 0.1mm 以内

**Rationale:** 台座は錯視の成立と両立しない。シルエット A / B の下端に台座の矩形が必ず現れる。「印刷のために錯視を一部犠牲にする」という**トレードオフの明示**が要件であって、こっそり足すのは要件違反。また最小 Y に届かない成分は台座に接続されないため、台座を付けても 1 パーツになるとは限らない。

### ビューア (Viewer)

#### FR-020: 自由視点操作
**Priority:** P0
WHILE ビューポートにフォーカスがある THE SYSTEM SHALL 減衰付きの回転・パン・ズーム操作を提供する

#### FR-021: Sweet Spot 検知
**Priority:** P1
WHILE カメラが動いている THE SYSTEM SHALL カメラ視線ベクトルと各目標視線ベクトルの角度差を毎フレーム算出し、3.5° 未満で合致状態を通知する
**Rationale:** 3.5°（約 0.061 rad）は、正射影に近い見え方が保たれる実用上の閾値。

#### FR-022: 視点スナップ
**Priority:** P1
WHEN スナップボタンが押される THE SYSTEM SHALL 対象アングルへ 400ms 以内のイージング付き遷移を行う

#### FR-023: 正射影切替
**Priority:** P1
WHEN 視点 A または B にスナップする THE SYSTEM SHALL 投影を正射影に切り替える
**Rationale:** 透視投影ではシルエットが正確に一致しない。錯視の「正解」は正射影で定義される。

#### FR-024: 仮想ミラー
**Priority:** P2
WHEN 仮想ミラーが有効 THE SYSTEM SHALL 視点 B の方向に反射面を配置し、視点 A からの構図で本体と鏡像を同時に成立させる

#### FR-025: 起動シーケンスと未準備状態
**Priority:** P0
WHILE Wasm の初期化が完了していない THE SYSTEM SHALL 「準備中」を明示し、出力ボタンを無効化し、選択済みの入力を保持する
WHEN Wasm の初期化が完了する THE SYSTEM SHALL 保持していた初期入力（正方形 × 円）で生成を 1 回実行する
IF 初期化が 10 秒以内に完了しない、または失敗する THEN THE SYSTEM SHALL 失敗として提示し再試行手段を提供する
THE SYSTEM SHALL 未準備状態をエラーとして提示しない
**Rationale:** Wasm 初期化は非同期で 100〜300ms かかる。何も出ていない黒いビューポートは「壊れている」と読まれる。状態機械は `loading-wasm → ready → generating → success | error` とし、`loading-wasm` は正常系。

#### FR-026: モバイルレイアウト
**Priority:** P1
WHILE ビューポート幅が 768px 未満 THE SYSTEM SHALL サイドバーを下端のボトムシートに切り替え、3D ビューポートに画面の過半を割り当てる
THE SYSTEM SHALL 全ての操作対象を 44×44 CSS px 以上のタップ領域として提供する
THE SYSTEM SHALL セーフエリア（ノッチ・ホームインジケータ）を避けて操作 UI を配置する
WHILE ユーザーが 3D ビューポート上で 1 本指ドラッグしている THE SYSTEM SHALL カメラを回転させ、ページスクロールを発生させない
**Rationale:** 320px 固定サイドバーは小型端末のビューポートをほぼ占有する。NFR-021 で iOS Safari / Android Chrome 対応を宣言しながらレイアウトが設計されていない状態は、宣言と実体の不一致。

#### FR-027: アクセシビリティ
**Priority:** P1
THE SYSTEM SHALL 全てのコントロールにラベルを与え、キーボードで視点スナップ・リセット・ズームを操作可能にする
THE SYSTEM SHALL Sweet Spot の合致状態を色**以外**の手段（テキストと形状）でも提示する
THE SYSTEM SHALL 生成ステータスと警告を `aria-live` で通知する
THE SYSTEM SHALL SVG のドロップ領域と同等の機能を持つ `<input type="file">` を提供する
WHILE `prefers-reduced-motion` が有効 THE SYSTEM SHALL カメラのスナップ遷移を即時切替に置き換える
**Rationale:** ドラッグ操作・色インジケーター・ファイルドロップ・canvas 直接描画はいずれも支援技術から不可視になりやすい。

### 出力 (Export)

#### FR-029: 実寸スケールの定義
**Priority:** P0
THE SYSTEM SHALL 実寸指定を「**共通シルエット高さ（正規化された Y 範囲）のミリメートル値**」ただ 1 つの物理量として定義する
- 既定値 60mm、範囲 10〜300mm、刻み 1mm
- 台座の厚みはこの高さに**含めない**（台座は下方向に追加される）
THE SYSTEM SHALL 指定値から導かれる X / Y / Z の実寸を UI に表示する
THE SYSTEM SHALL STL の座標をミリメートル単位で書き出す
THE SYSTEM SHALL GLB / USDZ の座標をメートル単位に変換して書き出す（mm → m、係数 0.001）
**Rationale:** STL には単位のメタデータがない。「実寸 mm」が高さなのか最大寸法なのか倍率なのかを決めないと、実装ごとに解釈が割れる。さらに glTF / USDZ はメートルが慣例なので、同じ座標をそのまま流すと **AR で 1000 倍の大きさ**になる。

#### FR-030: バイナリ STL 出力
**Priority:** P0
WHEN STL 出力が要求される THE SYSTEM SHALL FR-029 のスケールを適用したバイナリ STL を生成しダウンロードさせる

#### FR-031: GLB 出力
**Priority:** P2
WHEN GLB 出力が要求される THE SYSTEM SHALL マテリアル情報付き `.glb` を生成しダウンロードさせる

#### FR-040: WebAR 起動（Phase 3 / フラグ配下）
**Priority:** P3
WHEN AR が要求され `VITE_ENABLE_AR` が true THE SYSTEM SHALL GLB（Android）および USDZ（iOS）を動的生成し AR セッションを開始する

---

## Non-Functional Requirements

### 性能
- **NFR-001**: 入力変更からメッシュ描画完了までの P95 レイテンシは **300ms 以内**
  - 測定条件: プリセット図形同士の 7×7 全組み合わせを各 3 回、ウォームアップ 5 回の後に計測（計 147 サンプル）。基準機は開発機（Apple Silicon / Chrome 最新版）
  - `performance.mark` による工程別内訳を計測に含める
  - 初回の Wasm 初期化時間は除外（NFR-003）
- **NFR-002**: カメラ操作中のフレームレートは **60fps** を維持する。CSG 演算はメインスレッドをブロックしない
  - 測定条件: 基準機で 10 秒間の連続カメラ回転中、フレーム間隔の P95 が 16.7ms 以内、かつ 50ms を超えるロングタスクがゼロ
- **NFR-003**: Wasm モジュールはアプリ起動時に先読みし、初回生成のレイテンシ計測から除外する
- **NFR-004**: 連続入力（テキスト打鍵など）は合流させ、最新の 1 件のみ演算する。古い結果は世代 ID で破棄する

### 幾何学的堅牢性
- **NFR-010**: 出力メッシュは穴・裏返り面のない **2-manifold**
- **NFR-011**: 全ての頂点座標は有限値。面積ゼロの三角形を含まない
- **NFR-012**: 演算エンジンのメモリは生成ごとに解放する
  - 判定は **生存 Manifold / CrossSection オブジェクト数** で行い、1 リクエスト完了時にゼロへ戻ること
  - 補助指標として、ウォームアップ 20 回の後の 200 回連続生成でヒープ最高水位が**頭打ちになる**こと
  - **ヒープ容量そのものの減少を期待しない**。Emscripten のヒープは `.delete()` 後も縮まないため、容量を見るリーク判定は必ず偽陽性になる

### 互換性
- **NFR-020**: Chrome / Safari / Firefox / Edge 各最新版（WebGL 2.0 対応環境）で動作する
- **NFR-021**: iOS Safari 15 以上、Android Chrome で動作する
- **NFR-022**: `SharedArrayBuffer` / Wasm threads / COOP・COEP による cross-origin isolation を必要としない
  - **Rationale:** GitHub Pages は COOP/COEP ヘッダを設定できない。マルチスレッド Wasm を前提にすると公開先で動かない

### セキュリティ・プライバシー
- **NFR-030**: ユーザーが入力したテキスト・アップロードした SVG・生成物を一切外部送信しない。解析・計測を含むネットワークリクエストを行わない

### 配信
- **NFR-040**: GitHub Pages のサブパス（`/ambiguous-3d-studio/`）配下で、アセット・Wasm・フォントの全てが解決される
- **NFR-041**: 公開ビルドで `VITE_ENABLE_AR` が false のとき、AR 関連コードはバンドルから除外される
