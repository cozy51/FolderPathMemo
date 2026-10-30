// 拡張機能はWebアプリからの「開く」依頼をNative Messagingホストへ中継するだけにする。
// 登録・検索・編集・Google Drive同期はすべてWebアプリ（web/）側で行う。
const NATIVE_HOST = 'jp.folderpath.memo';
// WebアプリのURLは manifest.json の host_permissions（content_scripts の matches と同じ値）から取る
const WEB_APP_URL = chrome.runtime.getManifest().host_permissions[0].replace(/\*$/, '');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Webアプリのページに入れたコンテンツスクリプト（web-bridge.js）からの依頼だけを受け付ける
  if (!sender.tab) return false;
  if (message?.type === 'open_folder') {
    if (typeof message.path !== 'string' || !message.path.trim()) {
      sendResponse({ ok: false, error: 'フォルダーパスが空です。' });
      return false;
    }
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open', path: message.path }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        sendResponse({ ok: false, error: error.message });
        return;
      }
      sendResponse(response ?? { ok: false, error: 'ネイティブホストから応答がありません。' });
    });
    return true;
  }
  if (message?.type === 'open_folders') {
    // まとめて開く：ネイティブホストが上から順にタブで開く
    const paths = Array.isArray(message.paths) ? message.paths.filter((path) => typeof path === 'string' && path.trim()) : [];
    if (!paths.length) {
      sendResponse({ ok: false, error: 'フォルダーパスが空です。' });
      return false;
    }
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open_many', paths, newWindow: Boolean(message.newWindow) }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        sendResponse({ ok: false, error: error.message });
        return;
      }
      sendResponse(response ?? { ok: false, error: 'ネイティブホストから応答がありません。' });
    });
    return true;
  }
  if (message?.type === 'legacy_data') {
    // 以前の拡張機能の画面で登録したデータを、Webアプリへ引き継ぐために渡す
    chrome.storage.local.get(null).then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

// アイコン（Alt+Shift+F）でWebアプリを開く。すでに開いていればそのタブへ切り替える
chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ url: `${WEB_APP_URL}*` });
  if (!tab) return chrome.tabs.create({ url: WEB_APP_URL });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});
