# frog

Termux (Android) で動くゼロ依存コーディングエージェント。
外部パッケージ不要。Google Gemini API でコードの読み書き・実行・デバッグを自律的に行う。

## 特徴

- **ゼロ依存** — Node.js 組み込みモジュールのみ。npm install 不要
- **Google OAuth (PKCE)** — Gemini Code Assist API で1000回/日の無料枠
- **API キー対応** — OAuth なしでも標準 Gemini API で利用可能
- **モデル自動フォールバック** — 429/404 で代替モデルに即切り替え、チェイン付き
- **サブエージェント** — 調査タスクを別コンテキストに委任（メイン履歴を汚さない）
- **ループ検出 / 探索予算** — 同一ツール呼び出しの繰り返しや無限探索を自動ブロック
- **Hooks システム** — [japanese-developer](https://github.com/shimatoshi/japanese-developer) 互換のフック基盤
- **ターミナルタイトル連動** — thinking / tool実行 / done の状態がタブに表示される
- **Ctrl+C 中断** — エージェントのターンを中断してもセッション継続

## 対応モデル

| モデル | 備考 |
|--------|------|
| `gemini-3-flash-preview` | デフォルト。高速 |
| `gemini-3.1-pro-preview` | 高精度。CodeAssist で未提供の場合は自動フォールバック |
| `gemini-3-pro-preview` | 3/9 廃止予定 |
| `gemini-2.5-pro` | 安定版 |
| `gemini-2.5-flash` | 最終フォールバック先 |

## インストール

### 前提条件

- **Node.js 18+**（Termux: `pkg install nodejs`）
- **git**（Termux: `pkg install git`）

### 手順

```bash
# クローン
git clone https://github.com/shimatoshi/frog-coder.git
cd frog-coder

# インストール（~/.local/bin にシンボリックリンクを作成）
bash install.sh

# PATH が通っていない場合（.bashrc に追加）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

これで任意のディレクトリから `frog` コマンドで起動できる。

## 初期設定

### OAuth 認証（推奨）

```bash
frog
# 起動後に /login と入力
> /login
# ブラウザが開くのでGoogleアカウントでログイン
# 認証情報は ~/.frog/auth.json に保存される
```

OAuth を使うと **Gemini Code Assist API**（1000回/日の無料枠）が利用できる。

### API キー認証

```bash
# .env ファイルを作成（リポジトリルートに配置）
echo 'GEMINI_API_KEY=your_api_key_here' > .env
frog
```

または環境変数で直接指定：

```bash
GEMINI_API_KEY=your_key frog
```

### モデル指定

```bash
# 環境変数で起動時に指定
AGENT_MODEL=gemini-2.5-pro frog

# 起動中に切り替え
> /model pro        # 部分一致で切り替え
> /model            # 一覧から番号選択
```

## 操作ガイド

### 基本操作

| 操作 | 説明 |
|------|------|
| `Enter` | 改行（複数行入力） |
| `Enter` x 2 | 送信 |
| `Ctrl+D` | 送信（代替） |
| `Ctrl+C` x 2 | 終了 |
| `Ctrl+C`（応答中） | 現在のターンを中断 |
| `Ctrl+A` / `Ctrl+E` | 行頭 / 行末に移動 |
| `Ctrl+U` | カーソルから行頭まで削除 |

### コマンド

| コマンド | 説明 |
|----------|------|
| `/login` | Google OAuth 認証 |
| `/logout` | 認証情報を削除 |
| `/status` | 認証状態の表示 |
| `/model` | モデル切り替え |
| `/safety` | 安全モード切替（off / confirm / blocklist） |
| `/clear` | 会話履歴クリア |
| `/compact` | 履歴を圧縮（トークン節約） |
| `/history` | 履歴の状態表示 |
| `/help` | ヘルプ表示 |

### 安全モード

| モード | 動作 |
|--------|------|
| `blocklist`（デフォルト） | 危険なコマンド（rm -rf 等）のみ確認 |
| `confirm` | 全てのコマンド・ファイル書き込みを確認 |
| `off` | 全許可 |

### ツール

frog は以下のツールを自律的に使い分ける：

- `read_file` — ファイル読み取り
- `write_file` / `write_files` — ファイル作成（複数一括対応）
- `edit_file` — 既存ファイルの部分編集
- `execute_command` — シェルコマンド実行
- `list_directory` — ディレクトリ一覧
- `find_files` — ファイル名パターン検索
- `search_text` — テキスト検索（grep）
- `spawn_agent` — サブエージェントに調査を委任

## ターミナルタイトル

Termux のタブやタスクスイッチャーでセッション状態がわかる：

| 状態 | タイトル |
|------|---------|
| 入力待ち | `frog [model] /path` |
| 思考中 | `frog ⟳ thinking...` |
| ツール実行中 | `frog ⚡ tool_name` |
| 完了 | `frog ✓ done` |

## Hooks（japanese-developer 連携）

[japanese-developer](https://github.com/shimatoshi/japanese-developer) をインストールすると、以下のフックが自動で有効になる：

- **enforce-japanese** — 全出力を日本語に強制
- **interactive-guard** — 対話型コマンドを検知してブロック
- **auto-worklog** — git commit 後に作業ログを自動記録
- **syntax-check** — ファイル書き込み後に構文エラーを自動チェック

```bash
# japanese-developer のインストール
pip install git+https://github.com/shimatoshi/japanese-developer.git
japanese-developer setup

# frog は ~/.gemini/settings.json のフック設定を自動で読み込む
```

## ファイル構成

```
frog-pkg/
├── bin/frog          エントリーポイント（コマンドディスパッチ）
├── src/
│   ├── state.js      共有ミュータブル状態
│   ├── config.js     定数・.env・システムプロンプト
│   ├── net.js        sleep・fetchWithTimeout・レート制限
│   ├── ui.js         スピナー・ターミナルタイトル
│   ├── input.js      文字幅・入力処理
│   ├── auth.js       OAuth / トークン管理
│   ├── hooks.js      フックシステム
│   ├── fallback.js   フォールバックチェーン・エラー分類
│   ├── tools.js      ツール定義・実装
│   ├── api.js        API呼び出し・リトライ・履歴管理
│   └── agent.js      エージェントターン・サブエージェント
├── package.json
└── .env → ../.env    （シンボリックリンク）
install.sh            インストーラ（~/.local/bin にリンク作成）
.env                  API キー等の環境変数（任意）
~/.frog/auth.json     OAuth 認証情報（自動生成）
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `GEMINI_API_KEY` | — | Gemini API キー（OAuth 未使用時） |
| `AGENT_MODEL` | `gemini-3-flash-preview` | 使用するモデル名 |
| `OAUTH_CLIENT_ID` | — | OAuth クライアントID（.env で設定） |
| `OAUTH_CLIENT_SECRET` | — | OAuth クライアントシークレット（.env で設定） |

## ライセンス

MIT
