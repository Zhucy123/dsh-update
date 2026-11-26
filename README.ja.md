<div align="center">

<img src="icon.svg" width="96" height="96" alt="dsh-update">

# dsh-update

**DeepSeek Harness ウェブ版（web）のアップデートプラグインです。**

サイドバーのボタンを 1 回押すだけで DSH をアップグレードできます。git や pnpm のコマンドを手打ちする必要はもうありません。

[![Version](https://img.shields.io/badge/version-2.0.0-4f8cff)](CHANGELOG.ja.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4f8cff)](#互換性)
[![DSH](https://img.shields.io/badge/DSH-plugin%20%C2%B7%20web-blue)](#インストール)

</div>

<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a> · <b>日本語</b></p>

**目次** · [何を解決するのか](#何を解決するのか) · [どんな見た目か](#どんな見た目か) · [機能](#機能) · [インストール](#インストール) · [設定](#設定) · [動作の仕組み](#動作の仕組み) · [互換性](#互換性) · [トラブルシューティング](#トラブルシューティング) · [開発](#開発)

---

## 何を解決するのか

ソースから起動している DSH web をアップグレードするには、これまで長いコマンド列を手で叩く必要がありました。tag を取得し、サービスを止め、checkout、install、clean、build、そしてまたサービスを起動し直す——途中のどの手順でも失敗する可能性があり、最後には自分でサービスを戻さなければなりませんでした。

プラグインを入れると、サイドバーの下部に「アップデートを確認」ボタンが増えます。新しいバージョンがあるかを確認し、あなたが押して初めて更新が始まります。ビルドが終われば自動で再起動し、ページもひとりでに戻ってきます。途中で失敗すれば元のバージョンへ戻ります。あなたが判断するのは**確認**の 1 点だけです。それ以外（取得、ローカル変更の退避、リビルド、ロールバック）はすべてプラグインが処理します。

## どんな見た目か

### サイドバーのボタン

ボタンはサイドバーの下部にあり、**幅は文字の長さに合わせて決まり**、行いっぱいには広がりません。同じ行の兄弟ボタンは高さが近ければ横に並び、差が大きければそれぞれ 1 行を占めます。下の図では Remote が 42px、このプラグインが 32px なので、それぞれ別の行になっています。

<p align="left"><img src="docs/images/sidebar-layout-ja.png" width="258" alt="サイドバー下部：Remote と「アップデートを確認」は高さが違うため、それぞれ 1 行を占めている"></p>

### アップデート確認パネル

クリックするとボタンに貼り付くようにポップオーバーが開きます。全画面のオーバーレイではありません。`body` に portal され固定配置されるため、サイドバーを折りたたんで細い帯にしても切れません。

<table>
<tr>
<td><img src="docs/images/panel-ja.png" width="300" alt="アップデート確認パネル：ネットワーク経路、自動チェック、バージョン比較、他のバージョンへの切り替え"></td>
<td><img src="docs/images/panel-en.png" width="300" alt="英語 UI"></td>
</tr>
<tr>
<td align="center"><sub>日本語</sub></td>
<td align="center"><sub>English</sub></td>
</tr>
</table>

### 実行中のプログレスバー

更新を開始するとパネルは畳まれ、ボタン自体がプログレスバーになります。ボタンの背面にある淡いトラックが溝で、濃い部分が完了した割合を表します。

<p align="left"><img src="docs/images/button-progress-ja.png" width="155" alt="更新実行中のボタン：左半分が 52% まで塗られ、ラベルは「インストール 52%」"></p>

## 機能

### バージョン比較

`git ls-remote` で origin 上の `dsh-v*` リリースタグを読み、ローカルと比較します。終始読み取りのみで、リポジトリには手を加えません。新しいバージョンを見つけても勝手には動かず、ボタンを「新しいバージョンあり」に変えて赤い点を付けるだけなので、押されるのを待ちます。

### 3種類のネットワーク経路

パネル上部で経路をその場で切り替えられ、選択は `localStorage` に保存されます。

| 経路 | 動作 |
|---|---|
| **自動**（デフォルト） | まず GitHub へ直接接続し、タイムアウト（8 秒）後はミラー一覧の順に再試行します。最初に成功したものを記憶します |
| **公式** | GitHub 直結のみ。ローカルプロキシのポート（Clash / V2Ray の 7890 など）を指定できます |
| **ミラー** | `gh-proxy.com` / `ghproxy.net` / `ghfast.top` のいずれかを指定 |

プロキシポートが空なら直接接続です。更新の実行時も選択した経路を使います。

### 自動チェック

デフォルトで有効、6 時間ごとに確認し、1 / 6 / 12 / 24 時間から選べます。`dsh web` の起動時にも毎回 1 回確認します。バックグラウンドで新バージョンを見つけてもボタンの見た目が変わるだけで、ダイアログも出さず作業も中断しません。失敗した場合は黙ってミラーを切り替えて再試行します。

### ワンストップ更新

```
git fetch --tags
  ↓ 取得した tag から対象を再計算（古い一覧で判断しない）
必須パスの確認 → peer 競合の確認
  ↓
git stash push -u    （未コミットの変更を退避。未追跡ファイルも含む）
git checkout <tag>
  ↓ 消えたパッケージの残留 lib/ を削除
pnpm install → pnpm run clean → pnpm run build
  ↓ 3 つすべて通って初めて完了
自動再起動 → 新プロセスの起動待ち → ページ自動更新 → 起動ログを観測
  ↓ ログが不健全ならロールバック
```

全体が `text/event-stream` でストリーミング返却され、各ステップの出力がリアルタイムに表示されます。

### 自動再起動とページの自動復帰

ビルドが成功すると dsh は自動で再起動します（完了メッセージのカウントダウンは実際の残り時間で、約 2 秒）。ページを手動で再読み込みする必要も、ターミナルを見張る必要もありません。

プラグインはまず現在のプロセスの `boot` id を記録し、それから 1.5 秒ごとに `/api/dsh-update/ping` を叩きます。`boot` が変わっていれば新しいプロセスがポートを掴んだ証拠なので、その時点で初めて `location.reload()` します。

そのままリロードしないのは、旧プロセスが終了してから新プロセスがポートを待ち受けるまでの間に空白時間があり、すぐリロードすると「このサイトにアクセスできません」に当たるからです。新プロセスの準備完了を確認してからリロードするので、ページはそのまま通常の画面に戻ります。

- ポーリングはデフォルトで 90 秒。バックグラウンド分離モードではより長い猶予が渡されます
- 猶予を超えたら待つのをやめ、制御をあなたに返します。無限ループに閉じ込めることはしません
- 自動再起動が効かない場合（設定で無効になっているなど）は、完了パネルに「再起動に失敗しました。手動で再起動してください」と表示され、隣の「今すぐ再起動」で 1 回だけやり直せます
- systemd などの supervisor 管理下であること、または `allowRestart: false` が設定されていることを検出した場合は自動再起動を行わず、ポーリングもしません

### 4つのセーフティゲート

アップデートで最も危険なのは「取得できないこと」ではなく「取得したものを使えないこと」です。次の 4 つのチェックは、4 種類の実際の障害に対応しています。

| ゲート | 何を止めるか | 解除方法 |
|---|---|---|
| **必須パス** | 対象 tag に `packages/client/ui-context-menu/package.json`（`contextMenus` を提供）が無い——チェックアウトすると Web UI が `Failed to load plugins` で止まる | パネルの「それでもチェックアウト」を押す、`allowMissingRequiredPaths: true` を設定する、または `requiredPaths: []` でチェック自体を無効化 |
| **Peer 競合** | 導入済みプラグインの harness / dsh `peerDependencies` が対象バージョンをカバーできない（WorkBuddy のようにバージョンを固定するもの） | デフォルトでは一覧を出して確認を求めます。`block` / `ignore` に変更できます |
| **残留 lib/** | 旧バージョンで gitignore されていた `lib/` が、パッケージディレクトリごと新 tag に消された後もディスクに残る（典型例：古い `ui-context-menu/lib` が `contextMenus` を注入し続ける） | 自動処理：ホワイトリストのルート（`packages/`、`apps/`）配下で「旧ツリーにあり新ツリーに無い」パッケージの `lib/` だけを削除 |
| **起動ログ** | ビルドは成功したのに、再起動後のログに `did not activate` / `Failed to load plugins` が出る | 自動ロールバック。手を出す必要はありません |

`pnpm run clean` の失敗も同じく中断・ロールバックします。警告扱いにしてビルドを続けることはありません。ビルドの終了コードが 0 でも成功とはみなしません。起動ログが観測ウィンドウ（デフォルト 15 秒）の間クリーンであり続けて初めて完了です。

### バージョン切り戻し

戻したいときは「他のバージョンに切り替え」から過去の `dsh-v*` tag を選びます。同じドロップダウン、同じ流れを使い、ボタンの文言はバージョンの上下で自動的に変わります。

```
現在より新しい → このバージョンへ更新
現在より古い   → このバージョンへ切り戻し
どちらも同じ安全チェックを通ります
```

切り戻しに成功した場合も同様に自動再起動し、ページも自動で更新されるので手動操作は不要です。

切り戻しがブロックされたとき（ローカル変更の衝突、対象バージョンに必須パスが無い、peer が非互換など）は、パネルに理由がそのまま並びます。どのファイルが衝突したか、どのプラグインが非互換か、どのパスが欠けているか、そしてどうすればよいかまで示されます。

### ローカルの変更は失われない

- 更新前に `git stash push -u`（未追跡ファイルを含む）し、成功後にそのまま `stash apply` で戻します
- 新バージョンが同じファイルに触れて衝突した場合、変更は**stash に安全に残ります**。パネルには「失われていません。リポジトリのディレクトリで手動で `git stash apply` できます」と明示されます
- パネルには「自動で stash して更新を続行 / 切り戻す」ボタンがあるので、自分でターミナルを開く必要はありません
- ロールバックの前にも再度 `stash push -u` するので、ロールバックでユーザーの変更が消えることはありません

### 失敗時の自動ロールバック

新しいバージョンへ切り替えた後、install / clean / build のいずれかが失敗した場合、または再起動後の起動ログが不健全な場合は、自動で `git checkout` により元のバージョンへ戻してリビルドします。ロールバック中に pnpm がまた失敗しても、成功したふりはせず「ローカルの変更は git stash に安全に保存されています」と明確に伝えます。その時点の作業ツリーの状態は不確定なので、自動で冒険するより手動で処理してもらうほうが確実だからです。

### 3言語インターフェース

中国語 / English / 日本語。言語は `ctx.locale`（DSH の LocaleRuntime）、`<html lang>`、`navigator.language` の順に決定し、`<html lang>` の変化を監視してリロードなしに即座に切り替えます。それ以外の言語は一律英語にフォールバックし、中途半端な翻訳は出しません。

### 同時実行と安全境界

- 同時に実行できる更新タスクは 1 つだけ。重複して起動すると 409 を返します
- 5 つの API ルートはいずれもローカルからのリクエストだけを受け付け、LAN やスマートフォンからのアクセスは一律 403 です
- `/restart` はさらに厳格で、`x-forwarded-for` などのプロキシヘッダーを拒否し、Origin は Host と完全一致していなければなりません
- すべての git 呼び出しで `GIT_TERMINAL_PROMPT=0` を強制し、対話的に認証情報を求めることは決してありません
- 切り戻し先は `dsh-v*` プレフィックスに限定し、任意の ref は拒否します

## インストール

> 本プラグインは **Profile Bundle** です。`package.json` が `dsh.bundle` を宣言し、`cordis.patch.yml` を同梱しています。そのため `dsh plugin add` の **1 コマンドでインストールと同時に自動有効化**され、設定ファイルを手で書き換える必要はありません。

### npm から

```bash
dsh plugin --profile web add @zhucy123/dsh-update
dsh web
```

### GitHub から

```bash
dsh plugin --profile web add git+https://github.com/Zhucy123/dsh-update.git
dsh web
```

### ローカルソースから

開発用です。`link:` は `node_modules` にソースディレクトリを指すシンボリックリンクを作るので、コードを変えても再インストールは不要です。

```bash
dsh plugin --profile web add link:<ソースディレクトリの絶対パス>
dsh web
```

```powershell
# Windows PowerShell での記述例
dsh plugin --profile web add link:C:\Users\me\workspace\dsh-update
```

> **インストール後は `dsh web` を完全に再起動してください。** ページの再読み込みでは駄目ですし、別のターミナルでもう一度実行することでもありません。旧プロセスを止めてから起動し直す必要があります。

> プラグイン ID とルートのプレフィックスはいずれも `dsh-update` です。npm 上のベア名 `dsh-update` は第三者が 1.3KB のプレースホルダー（中身のないパッケージ）として登録済みのため、scoped 名で公開しています。インストール後の見え方は変わりません。

## 設定

すべて任意です。profile の `cordis.patch.yml` ユーザーパッチ層に書きます。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
plugins:
  '@zhucy123/dsh-update':
    peerConflictPolicy: confirm
    bootHealthWindowMs: 20000
```

| フィールド | 環境変数 | 説明 | デフォルト |
|---|---|---|---|
| `repoDir` | `DSH_UPDATE_REPO_DIR` | 更新対象リポジトリのルート（git checkout であること） | `process.cwd()` から上へ辿り、最初に見つかった `.git` を含むディレクトリ |
| `gitProxy` | `DSH_UPDATE_GIT_PROXY` | 直結に失敗したときのミラープレフィックス。`""` でミラーへのフォールバックを無効化 | `https://gh-proxy.com/` |
| `allowRestart` | — | 自己再起動を許可するか。systemd などの supervisor を検出すると自動で無効化 | `true` |
| `autoRestart` | — | 更新 / 切り戻しの成功後に約 2 秒で自動再起動し、新プロセスの準備完了を待ってからページを更新するか | `true` |
| `windowsDetachedUpdate` | — | Windows でのバックグラウンド分離更新。後述 | `false` |
| `requiredPaths` | `DSH_UPDATE_REQUIRED_PATHS` | チェックアウト前にターゲット tag へ存在していなければならない相対パス。空配列 = チェック無効 | `["packages/client/ui-context-menu/package.json"]` |
| `allowMissingRequiredPaths` | — | `true` ならパス欠落は警告のみで、そのままチェックアウトする | `false` |
| `orphanLibRoots` | — | 残留 `lib/` の掃除を許可するリポジトリ直下のディレクトリ | `["packages", "apps"]` |
| `peerConflictPolicy` | — | `confirm`（一覧を出して確認）/ `block`（即座に拒否）/ `ignore`（ログのみ） | `confirm` |
| `profilesDir` | `DSH_UPDATE_PROFILES_DIR` | プラグインの peer を走査する profile のルート | `~/.dsh/profiles` |
| `bootHealthWindowMs` | — | ポートが上がった後に起動ログを観測し続けるミリ秒数（0–120000）。自動再起動が無効ならこのチェックは行わない | `15000` |

### Windows でのバックグラウンド分離更新

Windows で動いている `dsh` は古い `node_modules` のファイルハンドルを掴んでいることがあり、プロセス内の `pnpm install` ではロックされたパッケージを削除できず（`[WARN] Failed to remove ...`）、そのままロールバックが走ってしまいます。

`windowsDetachedUpdate: true` を設定すると、更新は git ステップの完了後に detached なバックグラウンドプロセスへ引き継がれます。本プロセスが終了してハンドルを解放し、バックグラウンドプロセスはポートが解放されるのを待ってから install → stash apply → clean → build を実行します。成功すれば自動再起動、失敗すればロールバックし、ログを `%TEMP%\dsh-update-apply-*.log` に書き出します。

**代償として、引き継ぎの瞬間にページの接続が切れます。** バックグラウンドプロセスも完了後に自動再起動して復帰を待ちますが、引き継ぎの間に接続が切れているため、ページは自分で開き直す必要があります。そのためこの項目はデフォルトで無効です。プロセス内の経路なら全体が見えたままページも自動更新されます。本当にファイルロックに当たったときだけ有効にする価値があります。

## 動作の仕組み

```mermaid
flowchart TD
    A[アップデートを確認を押す] --> B[/status でバージョン比較/]
    B --> C{新しい tag あり?}
    C -- いいえ --> D[最新です]
    C -- はい --> E[差分を表示]
    E --> F[fetch --tags<br/>対象を再計算]
    F --> G{必須パスが揃っている?}
    G -- いいえ --> H[チェックアウトを拒否]
    G -- はい --> I{peer 競合あり?}
    I -- はい --> J[確認を待つ]
    I -- いいえ --> K[stash push -u]
    J --> K
    K --> L[checkout tag<br/>残留 lib/ を掃除]
    L --> M[install / clean / build]
    M --> N{すべて成功?}
    N -- いいえ --> O[元のバージョンへ<br/>リビルド]
    N -- はい --> P[自動再起動<br/>新プロセスを待つ]
    P --> PR[ページ自動更新<br/>起動ログを観測]
    PR --> Q{ログはクリーン?}
    Q -- いいえ --> O
    Q -- はい --> R[stash を復元<br/>完了]
```

### API ルート

| ルート | メソッド | 説明 |
|---|---|---|
| `/api/dsh-update/status` | GET | バージョン比較 + ローカル履歴 tag の一覧。`?source=&mirror=&proxyPort=` で現在のネットワーク経路に切り替えて再問い合わせできる |
| `/api/dsh-update/ping` | GET | 極めて軽量な生存確認。`boot` / `pid` / `inFlight` を返し、再起動ポーリング専用（git も読まず profile も走査しない） |
| `/api/dsh-update/release-notes?tag=` | GET | 指定したバージョンの GitHub Releases の説明 |
| `/api/dsh-update/run` | POST | 更新 / 切り戻しをストリーミング実行（`text/event-stream`） |
| `/api/dsh-update/restart` | POST | 元の起動コマンドで新しいプロセスを立ち上げる |

## 互換性

| プラットフォーム | 状態 | 説明 |
|---|---|---|
| Windows | ✅ | `pnpm` はシェル経由で `.cmd` shim を実行。再起動は PowerShell の `-WindowStyle Hidden` + `windowsHide` で静かに起動 |
| Linux | ✅ | pnpm が無い場合は自動で `corepack pnpm` にフォールバック |
| macOS | ✅ | Linux と同じ |

- パスはすべて `node:path` を経由し、区切り文字をハードコードしません
- POSIX の再起動は `detached: true` で新プロセスを独立セッションにするため、起動元のターミナルを閉じてもサービスは止まりません。出力は tmpdir のログへリダイレクトされます
- systemd 管理下では自己再起動を自動で無効化（起動は supervisor が担当）。launchd など未検出のケースはデフォルトで許可

**要件**：

- DSH がソース方式で動作していること——clone した deepseek-harness リポジトリで、origin に `dsh-v*` リリースタグがあること
- Node.js ≥ 18、git、pnpm

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| インストールしてもボタンが出ない | 99% は**完全に再起動**していない（ページを更新しただけ）。古い `dsh web` プロセスを止めてから起動し直してください |
| パネルが「バージョンを確認しています…」のまま | ネットワークの問題です。「ミラー」経路に切り替えて再試行してください。確認に失敗した場合は、直結とミラーそれぞれのエラーがメッセージに表示されます |
| 「既に更新が実行中です」(409) と出る | 同時実行の保護です。現在のタスクが終わるのを待ってください |
| 必須パスが欠けていると表示される | 対象 tag は Web UI を壊します（典型的には `ui-context-menu` の欠落）。別のバージョンに変えるか、リスクを確認したうえで「それでもチェックアウト」を押してください |
| WorkBuddy などの peer 競合が一覧表示される | 導入済みプラグインが harness / dsh パッケージを旧バージョンに固定しています。確認すれば続行できますし、`peerConflictPolicy` の変更でも対処できます |
| 更新後に `MISSING_EXPORT` / 開けない | 残留した古い `lib/` が削除済みのエクスポートを参照しています。プラグインは自動で `pnpm run clean` を実行し、消えたパッケージの `lib/` を掃除します。手動で行う場合は `pnpm run clean && pnpm run build` を忘れずに |
| 起動ログに `Failed to load plugins` / `did not activate` が出る | プラグインが既に自動ロールバックしています。ページが戻ってからパネルを開き直すと、ロールバックの結果を確認できます |
| 更新後も「更新あり」と表示される | 更新成功時はページが自動で更新されるので、更新後はこの問題は起きません。別タブの場合や、更新前に開いていたパネルは古い表示のまま残るので、「再確認」を押してください |
| ボタンが緑のチェックマークのままで押せない | v1.9.0 で修正済みです。`done` / `error` 状態でクリックすると `idle` に戻って再確認します |
| 更新後にページが自動で戻ってこない | 自動再起動が効いていません。パネルに「再起動に失敗しました。手動で再起動してください」と出るので、隣の「今すぐ再起動」を押してください。F5 の後に手動で dsh を起動してもかまいません。ポーリングはデフォルトで 90 秒待ち、タイムアウトすると制御を返します |

### インストールの確認

```powershell
# 1. 依存関係が記録されている
Get-Content $HOME\.dsh\profiles\web\package.json | Select-String dsh-update

# 2. 依存関係が配置済み（link: の場合は Junction）
Get-Item $HOME\.dsh\profiles\web\node_modules\@zhucy123\dsh-update
```

そのあと `dsh web` を再起動すると、サイドバーの下部に「アップデートを確認」ボタンが現れます。

## 開発

```bash
git clone https://github.com/Zhucy123/dsh-update.git
cd dsh-update
node --test test/*.test.mjs
dsh plugin --profile web add link:$(pwd)
```

```
lib/index.js                2328 行  host 側：API ルート、更新／切り戻しのパイプライン、stash、起動ヘルスチェック
lib/client.js               2250 行  ブラウザ側：サイドバーのボタン、ポップオーバー、i18n（classic script、ビルド無し）
lib/safety.js                592 行  純粋関数：tag 比較、peer 競合、パスのホワイトリスト、環境のクリーンアップ
test/update-safety.test.mjs  477 行  20 件のテスト
icon.svg                      18 行  プラグインアイコン（128 グリッド）
```

```bash
node --test test/*.test.mjs
# ℹ tests 20 · pass 19 · fail 0 · skip 1
```

唯一 skip されるのはシンボリックリンクの作成が必要なケースです。Windows で開発者モードが有効になっていないと `symlinkSync` が EPERM を投げるため、機能検出してから skip するように変更してあり、壊れているわけではありません。

20 件のうち 6 件は**実行時の挙動テスト**（実際に git の子プロセスを起動し、必ず失敗するロールバックを本当に 1 回走らせる）で、ソースの正規表現ではありません。

```
runUpdateStreaming resolves and closes the stream on a non-git directory
buildDoneEvent keeps autoRestart honest for both modes
createProcessRunners streams a real git command and reports its exit code
performRollback reports failure instead of throwing when it cannot restore
sanitizeGitEnv strips every malformed GIT_CONFIG_* shape git rejects
a git call survives a poisoned GIT_CONFIG_* environment
```

### コード変更前に必読のハード制約

1. **`lib/client.js` にビルド手順はありません**——classic script で、`window.__ModuleLoader__.load({ id, factory })` により登録され、内部で `require("react")` してプラットフォームのモジュールを取得します。ESM/TS に変えることはできず、裸の import もバンドラーも使えません。
2. **`lib/client.js` は CRLF + タブインデント**で、約 185 個の `tr("中文原文")` 辞書項目を含みます。変更するときは完全一致（`\r\n` を含む）で行う必要があります。
3. **React は `useState / useEffect / useRef / useCallback` + `createElement`（別名 `h`）だけ**を使い、JSX は使いません。
4. **host 側のルートはすべて loopback-only**です。これは意図的な安全境界なので、「テストしやすいから」といって緩めてはいけません。

### 2種類の変更と2通りの反映方法

| 変更したもの | 反映方法 |
|---|---|
| `lib/client.js` | ページをハードリロードすれば反映（`link:` でインストールした場合） |
| `lib/index.js` / `lib/safety.js` / `package.json` | `dsh web` の再起動が必須 |

### 改行コードと `.gitattributes`

リポジトリは `* text=auto eol=crlf` で統一しています。リポジトリ内は LF で保存し、作業ツリーへのチェックアウト時に CRLF になります。これによりシステムレベルの `core.autocrlf=true` が上書きされ、コミットのたびに `LF will be replaced by CRLF` が出るのを避けられます。

> `.gitattributes` を追加したのに警告が消えない場合は、まず `git ls-files --eol` に `-text` が付いているファイルが無いか確認してください。多くの場合、そのファイルに裸の CR（`\r` の直後が `\n` でないもの）が紛れ込んでおり、git がバイナリと判定して属性が効かなくなっています。

## バージョン履歴

現在 **v2.0.0**。バージョンごとの完全な記録は [CHANGELOG.ja.md](CHANGELOG.ja.md) を参照してください。

## プライバシー

**本リポジトリにはユーザーのローカルデータは一切含まれません。** ソースに登場するのは公開製品名 `deepseek-harness` と DSH のデフォルトポート `3080` だけで、ユーザー名、絶対作業ディレクトリ、認証情報、トークンは含みません。リポジトリに含まれるのは `lib/`、`test/`、`docs/`、`package.json`、`cordis.patch.yml`、`icon.svg`、`README.md` / `README.en.md` / `README.ja.md`、`CHANGELOG.md` / `CHANGELOG.en.md` / `CHANGELOG.ja.md`、`LICENSE` のみです。

## License

MIT © Zhucy123
