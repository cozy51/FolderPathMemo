// Webアプリのページと拡張機能をつなぐコンテンツスクリプト。
// ページからは window.postMessage で依頼を受け、background.js へ渡して結果を返す。
// ページより先に待ち受けるよう document_start で読み込む。
const RELAYED_TYPES = ['open_folder', 'open_folders', 'legacy_data'];

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'folderpathmemo-app') return;
  const { id, type, path, paths, newWindow } = event.data;
  let response;
  if (type === 'ping') response = { ok: true, version: chrome.runtime.getManifest().version };
  else if (RELAYED_TYPES.includes(type)) response = await chrome.runtime.sendMessage({ type, path, paths, newWindow }).catch((error) => ({ ok: false, error: error.message }));
  else response = { ok: false, error: `未対応の依頼です（${type}）` };
  window.postMessage({ source: 'folderpathmemo-extension', id, response }, location.origin);
});
