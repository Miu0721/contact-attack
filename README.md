# contact-attack-bot 仕様書

このリポジトリは、企業サイトの問い合わせフォームを探索し、自動入力するための Playwright ベースのスクリプト群です。シート/Notion から送信者情報や文面を取得し、OpenAI でフォーム構造を推定して入力します。送信は安全のためデフォルトで行いません。

## 全体構成
- `src/main.mjs`  
  単発実行エントリーポイント。`COMPANY_TOP_URL`（`src/config/sender.mjs` か環境変数）と、シートがあればシート設定を使ってフォームを探索・自動入力する。
- `src/run-from-sheet.mjs`  
  Google Sheets の Contacts タブを走査し、各行の企業に対して問い合わせフォーム探索/入力を行い、結果をシートに書き戻すバッチ。reCAPTCHA 検出や失敗理由をロギング。
- `src/url-discovery.mjs`  
  企業トップから問い合わせページ候補を探索。AI にリンクリストを渡して問い合わせっぽい URL を選択する。必要に応じてルールベース探索も切替可能。
- `src/contact-form-analyzer.mjs`  
  ページ（iframe も再帰的に探索）からフォーム HTML を抽出し、OpenAI に role 付きフィールド一覧 JSON を生成させる。
- `src/contact-form-filler.mjs`  
  解析結果に基づきフォームへ自動入力。role→値の割り当て、セレクタ解決、checkbox/radio/select/textarea への入力、reCAPTCHA・画像認証検知を行い、入力サマリを返す。
- `src/config/sender-from-sheet.mjs`  
  Sender シートから送信者情報・固定文面・デフォルト URL を取得。`mergeSenderInfo` でローカル設定（`src/config/sender.mjs`）とマージ。フォーム質問ログを FormLogs タブへ追記。
- `src/config/sender.mjs`  
  デフォルトの送信者情報と固定メッセージ、企業トップ URL のサンプル定義。
- `src/lib/ai-response.mjs`  
  OpenAI Responses API からテキスト抽出/JSON パースを行う共通ユーティリティ。
- `src/lib/openai.mjs`  
  OpenAI クライアント生成。`OPENAI_API_KEY` を利用。
- `src/lib/google/contactsRepo.mjs`  
  Contacts シートの読み書き・行色変更ユーティリティ。
- `src/lib/notion/*`  
  Notion DB から会社情報を取得し、テンプレートに差し込むサンプル。
- `src/fill-nexx.mjs`  
  Nexx サイトへのサンプル自動入力（Notion 情報を利用）。
- `src/test-contacts.mjs`, `src/playwright-test.mjs`  
  動作テスト用のシンプルなスクリプト。

## 必要な環境変数・ファイル
- `.env`
  - `OPENAI_API_KEY` : OpenAI API キー
  - `SHEET_ID` : Google Sheets のスプレッドシート ID（Contacts/Sender/FormLogs 用）
  - `FORM_LOG_SHEET_NAME` : (任意) FormLogs のシート名を上書き
  - `NOTION_TOKEN` / `NOTION_DB_ID` : Notion 連携に使用（サンプル用）
  - `COMPANY_TOP_URL` : (任意) 企業トップ URL を外部指定
- `service-account.json` : Google サービスアカウントの認証情報（Sheets 用）

## 主要フロー
1) 送信者情報ロード  
   - Sender シートがあれば読み込み、ローカル設定とマージ。固定文面や問い合わせプロンプトも取得。
2) 問い合わせページ探索（`findContactPageCandidates`）  
   - 企業トップへアクセスし、ページ内リンクを AI でスコアリングして問い合わせ候補 URL を返す。
3) フォーム解析（`analyzeContactFormWithAI`）  
   - ページ/iframe から form または input/textarea/select の HTML を収集し、OpenAI に role 付きフィールド JSON を生成させる。
4) 自動入力（`fillContactForm`）  
   - role から値を決定し、checkbox/radio/select/textarea/input へ入力。reCAPTCHA/画像認証は検知のみで値は入れず、サマリに記録。
5) ロギング  
   - 入力サマリとフォームスキーマを FormLogs シートに追記（設定がある場合）。実際の送信はデフォルトで行わない。

## コマンド例
- 単発実行（ローカル設定優先、シートがあれば上書き）  
  ```bash
  node src/main.mjs
  ```
- Contacts シートを一括処理  
  ```bash
  node src/run-from-sheet.mjs
  ```
- テスト用  
  ```bash
  node src/playwright-test.mjs
  node src/test-contacts.mjs
  ```

## 注意事項
- 送信ボタンは無効化しており自動送信しません。実運用で送信する場合は慎重に有効化してください。
- reCAPTCHA/画像認証を検出した場合は入力を中断し、ログのみ残します（手動対応前提）。
- ネットワーク先サイトの利用規約・robots を尊重し、適切な間隔で実行してください。
