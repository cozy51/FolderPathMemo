// Webアプリのページと拡張機能をつなぐコンテンツスクリプト。
// ページからは window.postMessage で依頼を受け、background.js へ渡して結果を返す。
// ページより先に待ち受けるよう document_start で読み込む。
// manifest からの自動挿入に加え、Chrome起動時・拡張機能の更新時に background.js からも挿入し直すため、
// 同じページで二重に動かないようにする
(() => {
  // 同じ拡張機能の中で、すでに中継スクリプトが動いている
  if (globalThis.__folderPathMemoBridge) return;
  globalThis.__folderPathMemoBridge = true;

  const RELAYED_TYPES = ['open_folder', 'open_folders', 'legacy_data'];
  const RELOAD_MESSAGE = '拡張機能が更新されたため、このページを再読み込みしてください';
  const REPLACED_EVENT = 'folderpathmemo-bridge-replaced';

  // 拡張機能の更新・再読み込みで切り離された古い中継スクリプトは、新しく挿入されたものに役目を譲る
  document.dispatchEvent(new CustomEvent(REPLACED_EVENT));
  document.addEventListener(REPLACED_EVENT, () => window.removeEventListener('message', onMessage), { once: true });

  window.addEventListener('message', onMessage);
  async function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'folderpathmemo-app') return;
    const { id, type, path, paths, newWindow } = event.data;
    let response;
    try {
      // 拡張機能を更新・再読み込みすると、開いたままのページのスクリプトは拡張機能から切り離される
      if (!chrome.runtime?.id) throw new Error('Extension context invalidated.');
      if (type === 'ping') response = { ok: true, version: chrome.runtime.getManifest().version };
      else if (RELAYED_TYPES.includes(type)) response = await chrome.runtime.sendMessage({ type, path, paths, newWindow });
      else response = { ok: false, error: `未対応の依頼です（${type}）` };
    } catch (error) {
      const invalidated = /context invalidated/i.test(error?.message ?? '');
      response = invalidated ? { ok: false, reloadRequired: true, error: RELOAD_MESSAGE } : { ok: false, error: error?.message ?? String(error) };
    }
    window.postMessage({ source: 'folderpathmemo-extension', id, response }, location.origin);
  }
})();
