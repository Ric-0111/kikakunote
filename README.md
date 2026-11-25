# 企画ノート（Netlify版）セットアップ手順

公開ページと自分用ページは分かれていません。**同じURL**で、入力するパスワードによって
「編集モード」か「閲覧モード」かが決まります。データはNetlify上に保存されるので、
パソコンでもスマホでも同じ内容が見られます。

| パスワード | できること |
| --- | --- |
| 編集用（あなた） | 企画の追加・編集・削除 |
| 閲覧用（共有する人） | 読むだけ |

## 1. GitHubにアップロードする（ブラウザだけでOK）

1. zipを解凍する
2. GitHubで新しいリポジトリを作る（Privateでかまいません）
3. 「Add file」→「Upload files」を開き、解凍したフォルダの**中身すべて**
   （`public` フォルダ、`netlify` フォルダ、`netlify.toml`、`package.json`）をドラッグして「Commit changes」

## 2. Netlifyで公開する

1. Netlifyで「Add new site」→「Import an existing project」→ GitHub →さきほどのリポジトリを選ぶ
2. ビルド設定は何も変えずに「Deploy」（設定は `netlify.toml` に入っています）
3. 公開が終わったら「Site configuration」→「Environment variables」で、次の3つを追加する

| 名前 | 入れる値 |
| --- | --- |
| `EDIT_PASSWORD` | あなた用のパスワード |
| `VIEW_PASSWORD` | 共有する人用のパスワード（編集用と別のもの） |
| `TOKEN_SECRET` | ランダムな英数字40文字以上（ログインの署名用。どこにも入力しません） |

4. 「Deploys」→「Trigger deploy」→「Deploy site」でもう一度公開する（環境変数は再公開で反映されます）
5. 発行されたURLを開き、編集用パスワードでログインする

スマホでも同じURLを開いてパスワードを入れれば使えます。一度ログインした端末は30日間そのままです。

## パスワードを変えたいとき

環境変数を書き換えて、もう一度「Trigger deploy」します。
すでにログイン済みの端末を全部ログアウトさせたいときは、`TOKEN_SECRET` も書き換えてください。

## CLIで公開したい場合

```
npm install
npm install -g netlify-cli
netlify login
netlify init
netlify env:set EDIT_PASSWORD "..."
netlify env:set VIEW_PASSWORD "..."
netlify env:set TOKEN_SECRET "..."
netlify deploy --prod
```
