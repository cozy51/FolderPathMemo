# FolderPath Memo

Microsoft Edge 向けの、フォルダーパスを素早く見つけて再利用するための Manifest V3 拡張機能です。データはブラウザーのローカルストレージに保存され、外部サーバーには送信されません。

## 主な機能

- ⭐ よく使うパスをお気に入りに固定
- 🕘 最近エクスプローラーで開いたフォルダーを履歴タブに表示
- 🔍 フォルダ名・メモ・パス・タグを対象にしたあいまい検索
- 📋 パスをワンクリックでクリップボードへコピー
- 📂 Windows 11では起動済みエクスプローラーの新しいタブでフォルダーを開く
- 📝 フォルダ名とは別に、用途などを記録できるメモ
- 🏷 カンマ区切りのタグ登録とタグ絞り込み
- 💾 JSON ファイルへのバックアップと復元

## Edge へのインストール

1. Edge で `edge://extensions` を開きます。
2. **開発者モード**を有効にします。
3. **展開して読み込み**を選び、このリポジトリのフォルダーを指定します。
4. ツールバーの「FolderPath Memo」を開きます。

### Edgeが読み込むファイル

展開して読み込むフォルダーには、少なくとも次のファイルを同じ構成で配置してください。フォルダーを丸ごと入れ替えた後は、`edge://extensions`でFolderPath Memoの**再読み込み**ボタンを押します。

```text
FolderPathMemo\
├─ manifest.json
├─ background.js
├─ popup.html
├─ popup.js
├─ styles.css
├─ icons\icon.svg
└─ native-host\
   ├─ FolderPathNativeHost.cs
   └─ install.ps1
```

上段の6ファイルは拡張機能の起動に必要です。`native-host`内の2ファイルはExplorer連携のインストール・診断に必要です。

## エクスプローラー連携のセットアップ（Windows）

ブラウザー拡張機能はWindowsのプログラムを直接起動できないため、「開く」ボタンには同梱のNative Messagingホストが必要です。次の操作は初回だけ行います。

1. `edge://extensions` に表示されるFolderPath Memoの**ID**をコピーします。
2. PowerShellを開き、リポジトリのフォルダーへ移動します。
3. 次のコマンドを実行します（`<拡張機能ID>`をコピーしたIDに置き換えます）。

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -ExtensionId <拡張機能ID>
   ```

4. Edgeを再起動します。以降は「開く」で`explorer.exe`が起動します。

Windows 11（ビルド22621以降）でエクスプローラーがすでに起動している場合は、そのウィンドウへ新しいタブを追加します。対応するウィンドウがない場合やWindows 10では、新しいエクスプローラーウィンドウを開きます。

ホストはユーザー単位で`%LOCALAPPDATA%\FolderPathMemo`へインストールされるため、管理者権限は不要です。ホストが未設定、または起動できない場合は安全策としてパスをコピーします。

「連携設定を確認してください」と表示される場合は、拡張機能を再読み込みしたことでIDが変わっていないか確認し、現在のIDでもう一度インストールコマンドを実行してください。インストーラーはWindows PowerShell標準のC#コンパイラーで動作する互換構文を使用しています。

すべてのファイルを入れ替えた後は、最初に次のコマンドでインストーラーが存在することを確認してください。

```powershell
Test-Path .\native-host\install.ps1
```

`True`と表示されたら、現在の拡張機能IDで上記の`install.ps1`を実行してください。インストーラー自身が、実行ファイル、Native MessagingのJSON、Edgeレジストリ、`allowed_origins`のID一致まで検証します。`False`の場合は、ローカルのフォルダーが最新版ではないため、`native-host\install.ps1`と`native-host\FolderPathNativeHost.cs`を配置してから実行します。

## データ形式

バックアップは `version`、`exportedAt`、`items` を含む JSON ファイルです。インポートすると現在の登録内容はバックアップの内容で置き換わります。
