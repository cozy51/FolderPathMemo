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

// 拡張機能が入っていないときに「開く」で長く待たせないよう、応答があるかを確かめる。
// ページを開いた直後に確認できなかったとき（拡張機能をあとから有効にした、読み込みが遅れた等）でも
// 「開く」のたびに確かめ直し、一度見つかったら以降はその結果を使う
let extensionReady = pingExtension();
function pingExtension() {
  return callExtension('ping', {}, 1500).then((response) => {
    if (response?.ok) return true;
    // 拡張機能の更新・再読み込みで古い中継スクリプトが切り離されている
    if (response?.reloadRequired) throw new Error(response.error);
    return false;
  }, () => false);
}
async function isExtensionReady() {
  if (await extensionReady.catch(() => false)) return true;
  extensionReady = pingExtension();
  return extensionReady;
}
// 拡張機能につながらないときに、利用者に伝える説明
async function extensionUnavailableMessage() {
  try {
    if (await isExtensionReady()) return '';
  } catch (error) {
    return error.message;
  }
  return '拡張機能が見つかりません。Chromeの拡張機能ページでFolderPath Memoが有効か確認し、このページを再読み込みしてください';
}

// Explorerの操作には時間がかかることがあるため、開く依頼だけは長めに待つ
async function openFolderWithExtension(path) {
  if (!await isExtensionReady()) throw new Error('FolderPath Memo拡張機能が見つかりません');
  const response = await callExtension('open_folder', { path }, 30000);
  if (!response?.ok) throw new Error(response?.error || 'フォルダーを開けませんでした');
  return response;
}

async function loadLegacyExtensionData() {
  if (!await isExtensionReady().catch(() => false)) return null;
  const response = await callExtension('legacy_data', {}, 5000).catch(() => null);
  return response?.ok ? response.data : null;
}

// 複数のフォルダーを1回の依頼で、上から順にタブで開く。
// newWindow: true なら新しいウィンドウで最初のフォルダーを開き、残りをそのウィンドウのタブに追加する。
// まとめて開けない以前のネイティブホスト（1.4.0未満）では、1件ずつ既存のエクスプローラーへ開く
const BATCH_HOST_VERSION = '1.4.0';
async function openFoldersWithExtension(paths, { newWindow = false } = {}) {
  if (!await isExtensionReady()) throw new Error('FolderPath Memo拡張機能が見つかりません');
  const response = await callExtension('open_folders', { paths, newWindow }, 30000 + paths.length * 15000);
  if (response?.ok) return response;
  if (response && response.version && compareVersions(response.version, BATCH_HOST_VERSION) >= 0) throw new Error(response.missing?.length ? `フォルダーが見つかりません：${response.missing.join('、')}` : response.error || 'フォルダーを開けませんでした');
  const opened = [];
  for (const path of paths) {
    await openFolderWithExtension(path);
    opened.push(path);
  }
  return { ok: true, opened, missing: [] };
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number); const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}
