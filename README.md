# VOICE LAB — 声質診断システム

マイクで声を録音するだけで、音響特性を計測し、248名の声データベースからあなたの声に近い声優・歌手・俳優・アナウンサーをマッチングするWebアプリケーションです。

🔗 **公開URL**: `https://<your-username>.github.io/<repo-name>/`

---

## ファイル構成

```
/
├── index.html                    # メインHTML
├── style.css                     # スタイルシート（Nordic Warm Darkテーマ）
├── app.js                        # 音響解析エンジン・声DB・UIロジック
├── .nojekyll                     # Jekyll処理をスキップ（必須）
├── README.md                     # このファイル
└── .github/
    └── workflows/
        └── deploy.yml            # GitHub Actionsデプロイ設定
```

---

## GitHub Pages 公開手順

### 1. リポジトリ設定

1. GitHubでこのリポジトリを開く
2. **Settings** → **Pages** を選択
3. **Source** を **"GitHub Actions"** に変更して保存

### 2. デプロイ

`main` ブランチにファイルをpushすると、自動でGitHub Actionsが起動し公開されます。

**Actions** タブでデプロイの進行状況を確認できます。

---

## 機能概要

| 機能 | 内容 |
|------|------|
| 事前アンケート | 目的・ジャンル好みを7問で把握し結果をカスタマイズ |
| 30秒録音 | REC START → 読み上げ → SUBMIT で完了 |
| 音域3点計測 | 最低・平均・最高周波数を個別に可視化 |
| 声質スコア | 男性的ないい声 / 女性的ないい声 を0〜100点で表示 |
| DBマッチング | 248名の声優・歌手・俳優・ナレーターから類似声をランキング |
| 改善フィードバック | 強み・伸びしろ・次のステップを提示 |

---

## 技術仕様

- **依存関係**: なし（Vanilla JS）
- **外部リソース**: Google Fonts のみ
- **音声処理**: Web Audio API（ブラウザ内完結・サーバー送信なし）
- **HTTPS必須**: マイクAPIの制約のため（GitHub Pagesは自動でHTTPS対応）

---

## ブラウザ対応

| ブラウザ | 状況 |
|----------|------|
| Chrome / Edge 最新 | ✅ |
| Firefox 最新 | ✅ |
| Safari (iOS 14.5+) | ✅ |
| Safari (macOS 14+) | ✅ |
