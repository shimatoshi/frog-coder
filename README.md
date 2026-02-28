# ai-coder

Termux 上で動作するゼロ依存のコーディングエージェント。

## 概要

Google Gemini API を使った自律的なコーディングエージェント。Termux (Android) 環境でNode.js のみで動作し、外部パッケージ不要。

### 主な機能

- **Google OAuth 2.0 (PKCE)** による認証
- **Gemini Code Assist API** / **標準 Gemini API** の両方に対応
- ファイル読み書き、コマンド実行、ディレクトリ操作等の**ツール呼び出し**
- バッチファイル書き込みによるAPI コール削減
- 429 レート制限の自動ハンドリング（60秒クールダウン）
- Web UI サポート

## ファイル構成

| ファイル | 説明 |
|---|---|
| `agent.mjs` | メインエージェント（Node.js / Gemini API） |
| `agent.py` | Python 版ベースエージェントクラス（Think→Act→Observe ループ） |
| `test-agent.mjs` | Gemini Code Assist API のテスト用スクリプト |
| `gemini_proxy.py` | Gemini アクセス用 HTTP プロキシサーバー |

## セットアップ

### 前提条件

- Node.js 18+
- Python 3.10+（Python 版を使う場合）

### 実行

```bash
# OAuth 認証で起動（初回はブラウザ認証が開く）
node agent.mjs

# API キーで起動
GEMINI_API_KEY=your_key node agent.mjs

# モデルを指定
AGENT_MODEL=gemini-2.5-pro node agent.mjs
```

### プロキシ経由

```bash
python gemini_proxy.py  # localhost:8080 で起動
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | (なし) | Gemini API キー（OAuth 未使用時） |
| `AGENT_MODEL` | `gemini-2.5-flash` | 使用するモデル名 |

## ライセンス

MIT
