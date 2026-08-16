# Ambiguous 3D Studio

**https://torifo.github.io/ambiguous-3d-studio/**

正面から見ると「★」、側面から見ると「♥」——2 つの投影シルエットを同時に満たす錯視立体（両義立体）を、ブラウザ上で生成・体験・出力する Web アプリケーション。

図形を 2 つ選ぶだけで立体が生成され、その場で回して錯視が成立する角度を探し、3D プリンタ用のバイナリ STL として持ち出せる。すべてクライアントサイドで完結し、入力したテキストや SVG は一切外部へ送信しない。

## 仕組み

各シルエットを自身の視線軸に沿って押し出した角柱の、ブール交差を取る。

```
M = M_A ∩ M_B
```

`M_A` はシルエット A を Z 軸方向へ、`M_B` はシルエット B を X 軸方向へ押し出した角柱。この共通部分は、正面（+Z）から見れば A の輪郭を、側面（+X）から見れば B の輪郭を持つ。

CSG 演算には [manifold-3d](https://github.com/elalish/manifold)（WebAssembly）を使い、2D 輪郭を `CrossSection` に渡して直接押し出す。Three.js の `ExtrudeGeometry` を経由しないのは、その出力が非多様体の三角形スープになり、3D プリンタのスライサーが受け付ける保証が崩れるため。

## できること

- **入力** — プリセット図形（円 / 正方形 / 正三角形 / ハート / 星 / 矢印 / 十字）、英数字 1〜8 文字、SVG ファイル
- **ビューア** — 自由視点操作、視点スナップ（正面 / 側面 / 俯瞰）、Sweet Spot 検知（誤差 3.5° 未満）、仮想ミラー
- **出力** — バイナリ STL（ミリメートル単位、スライサーへ直接）、GLB（メートル単位、Blender や Web 共有向け）
- **3D プリント補助** — 分離パーツの検出、細いくびれの警告、台座の付与

## 知っておくとよいこと

### すべての図形の組み合わせが作れるわけではない

高さ `y` における交差のスライスは、**A のその高さの被覆と B のその高さの被覆の直積**になる。したがって片方でも被覆が空になる高さ帯があると、交差はそこで必ず途切れる。

小文字の `i`（点と本体が離れている）、間の空いた 2 文字、複数パーツからなる SVG では、これが必ず起きる。**実装の不具合ではなく数学的な必然**なので、アプリは生成前にその高さ帯を検出して提示する。

同じ理由で、走査線の解析から「何個のパーツに分かれるか」を確定することはできない。ある高さで分かれた島が別の高さで合流しうるため、パーツ数は生成後の連結成分分解でのみ確定する。UI は断定できる警告と推定にとどまる警告を、文体とバッジで区別している。

### 台座は錯視を壊す

底面に付ける台座は、視点 A・B の**両方**のシルエットに矩形として現れる。両視点から見える位置に材料を足す以上、これは実装で回避できない。印刷の安定と引き換えのオプションであり、既定では無効。

### 単位

実寸は「共通シルエット高さのミリメートル値」ただ 1 つで定義される（既定 60mm）。STL はミリメートル、GLB / USDZ はメートル（glTF の慣例）で書き出す。

## 技術スタック

| 領域 | 採用技術 |
|---|---|
| フロントエンド | Vite + React + TypeScript |
| 3D 描画 | Three.js / React Three Fiber |
| CSG 演算 | manifold-3d 3.5.1（WebAssembly、Web Worker 上） |
| 状態管理 | Zustand |
| UI | Tailwind CSS |
| 出力 | STLExporter / GLTFExporter |

CSG は専用 Worker 内のシングルスレッド Wasm で動く。GitHub Pages は COOP/COEP ヘッダを設定できず cross-origin isolation が得られないため、`SharedArrayBuffer` とマルチスレッド Wasm には依存していない。

## 性能

入力変更からメッシュ描画完了までの実測 P95 は **149.9ms**（147 サンプル、Apple Silicon / Chrome）。内訳の 81% は打鍵合流のためのデバウンス 120ms で、CSG 本体は 4.3ms。

## ローカル開発

```bash
npm install
npm run dev        # http://localhost:5173/ambiguous-3d-studio/
```

```bash
npm run test       # Vitest（幾何ロジックと CSG 統合テストはブラウザ不要）
npm run build      # tsc -b && vite build
npm run lint
```

WebAR（Phase 3）は `VITE_ENABLE_AR=true` のローカルビルドでのみ有効。公開ビルドでは無効。

## ドキュメント

- [要件定義書（当初のブリーフ）](docs/requirements.md)
- [EARS 記法の要件](specs/ambiguous-solid/requirements.md)
- [技術設計・ADR・性能実測](specs/ambiguous-solid/design.md)
- [タスクグラフ](specs/ambiguous-solid/tasks.md)

## ライセンス

同梱フォントは [Inter](https://github.com/rsms/inter)（SIL Open Font License 1.1、[全文](public/fonts/OFL.txt)）。
