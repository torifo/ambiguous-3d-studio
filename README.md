# Ambiguous 3D Studio

> ⚠️ 仮 README。実装はこれから（Phase 1 未着手）。

2〜3 方向からの投影シルエットを同時に満たす「錯視立体（両義立体）」を、ブラウザ上でリアルタイムに合成・体験・出力する Web アプリケーション。

正面から見れば「★」、側面から見れば「♥」——そんな立体を、シルエットを 2 つ選ぶだけで生成し、その場で回して確かめ、3D プリンタ用の STL として持ち出せる。

## コンセプト

射影幾何学 + CSG（Constructive Solid Geometry）演算。

各シルエットを視線ベクトル方向へ押し出した柱状体 `M_A`, `M_B` を作り、その共通集合を取る：

```
M = M_A ∩ M_B
```

これが「どちらの方向から見てもシルエットが成立する」立体になる。

## 機能（予定）

| 領域 | 内容 |
|---|---|
| 入力 | プリセット図形 / テキスト押し出し / SVG インポート、投影軸・角度設定 |
| 生成 | 2D パスの押し出し、ブール交差演算、3D プリント用台座付与 |
| ビューア | 自由視点操作、視点スナップ、Sweet Spot 検知（誤差 < 3.5°）、仮想ミラー |
| AR | GLB / USDZ 動的生成によるゼロインストール WebAR |
| 出力 | バイナリ STL / GLB ダウンロード |

すべてクライアントサイド完結。入力したテキストや SVG は一切外部へ送信しない。

## 技術スタック（予定）

- **フロントエンド**: Vite + React + TypeScript
- **3D レンダリング**: Three.js / React Three Fiber（`@react-three/fiber`, `@react-three/drei`）
- **幾何・CSG 演算**: manifold-3d (Wasm) または three-bvh-csg
- **UI**: Tailwind CSS + Lucide React
- **AR**: `@google/model-viewer`
- **エクスポート**: STLExporter / GLTFExporter

## ロードマップ

- **Phase 1 (MVP)** — プリセット図形同士の直交 CSG 交差パイプライン、R3F ビューポート、バイナリ STL ダウンロード
- **Phase 2 (UX・錯視演出)** — テキスト / SVG 入力、視点スナップ、Sweet Spot 判定、仮想ミラー
- **Phase 3 (WebAR・最適化)** — GLB / USDZ 動的生成と AR 起動、CSG 高速化（Web Worker / Wasm）

## ドキュメント

- [要件定義書](docs/requirements.md)

## ステータス

準備中 — リポジトリ初期化のみ。
