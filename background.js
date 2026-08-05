const NATIVE_HOST = 'jp.folderpath.memo';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'open_folder') return false;

  chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open', path: message.path }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      sendResponse({ ok: false, error: error.message });
      return;
    }
    sendResponse(response ?? { ok: false, error: 'ネイティブホストから応答がありません。' });
  });
  return true;
});
