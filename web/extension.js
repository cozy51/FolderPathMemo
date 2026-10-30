// FolderPath Memo拡張機能（Explorer連携）との通信。
// 拡張機能のコンテンツスクリプト（web-bridge.js）が window.postMessage を background.js へ中継する。
function callExtension(type, payload = {}, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('拡張機能から応答がありません')); }, timeout);
    function onMessage(event) {
      if (event.source !== window || event.data?.source !== 'folderpathmemo-extension' || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data.response);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'folderpathmemo-app', id, type, ...payload }, location.origin);
  });
}

// 拡張機能が入っていないときに「開く」で長く待たせないよう、最初に1回だけ確かめる
const extensionReady = callExtension('ping').then((response) => Boolean(response?.ok), () => false);

// Explorerの操作には時間がかかることがあるため、開く依頼だけは長めに待つ
async function openFolderWithExtension(path) {
  if (!await extensionReady) throw new Error('FolderPath Memo拡張機能が見つかりません');
  const response = await callExtension('open_folder', { path }, 30000);
  if (!response?.ok) throw new Error(response?.error || 'フォルダーを開けませんでした');
  return response;
}

async function loadLegacyExtensionData() {
  if (!await extensionReady) return null;
  const response = await callExtension('legacy_data', {}, 5000).catch(() => null);
  return response?.ok ? response.data : null;
}
