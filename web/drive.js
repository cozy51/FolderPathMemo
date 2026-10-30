// Google Driveとの同期。以前は拡張機能の background.js で行っていた処理を、Webアプリ内で行う。
// Googleへの接続には Google Identity Services（index.html で読み込む gsi/client）のトークンを使う。
// 既存の共有フォルダーへ保存するため、drive.file ではなく drive スコープを使う
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_DRIVE_FOLDER_ID = '1u6N_eEqh7PDCpA4Fm8gqXYJmHMPl-SDv';
// バックアップを毎回増やさず、この1ファイルを最新版として上書きする
const DRIVE_SYNC_FILE_NAME = 'backup-ext_FolderPathMemo.json';
const NOT_CONNECTED = 'Google Driveに接続されていません';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const driveHandlers = {
  async drive_status() {
    const { folderPathDriveClientId: clientId = '', folderPathDriveAutoSync: autoSync = true, folderPathDriveToken: token } = await store.get(['folderPathDriveClientId', 'folderPathDriveAutoSync', 'folderPathDriveToken']);
    return { clientId, autoSync, fileName: DRIVE_SYNC_FILE_NAME, folderId: await getBackupFolderId(), origin: location.origin, connected: Boolean(token && token.expiresAt > Date.now()) };
  },
  async drive_save_folder({ folder }) {
    // フォルダーURL（…/folders/<ID>?usp=…）とIDのどちらでも受け付ける。空欄なら既定のフォルダーに戻す
    const text = String(folder ?? '').trim();
    const folderId = text.match(/folders\/([\w-]+)/)?.[1] ?? text.match(/[?&]id=([\w-]+)/)?.[1] ?? text;
    if (folderId && !/^[\w-]+$/.test(folderId)) throw new Error('フォルダーのURLまたはIDを確認してください');
    await store.set({ folderPathDriveFolderId: folderId });
    // 保存先が変わると同期ファイルも別物になるため、同期済みの記録を消す
    await store.remove(['folderPathDriveSyncedAt', 'folderPathDriveSyncState']);
    return { folderId: await getBackupFolderId() };
  },
  async drive_save_client_id({ clientId }) {
    const value = String(clientId ?? '').trim();
    await store.set({ folderPathDriveClientId: value });
    await store.remove('folderPathDriveToken');
    await setSyncStatus(value ? 'disconnected' : 'unconfigured');
    return {};
  },
  async drive_connect() {
    await getDriveToken({ forceInteractive: true });
    // 接続できたら、未保存の変更をすぐDriveへ送る
    autoSave().catch(() => {});
    return {};
  },
  async drive_disconnect() {
    const { folderPathDriveToken: token } = await store.get('folderPathDriveToken');
    await store.remove('folderPathDriveToken');
    await setSyncStatus('disconnected');
    if (token?.accessToken) globalThis.google?.accounts?.oauth2?.revoke(token.accessToken, () => {});
    return {};
  },
  async drive_set_auto_sync({ enabled }) {
    await store.set({ folderPathDriveAutoSync: Boolean(enabled) });
    return {};
  },
  async drive_sync_check({ silent = true } = {}) {
    const status = await syncCheck({ silent }).catch(async (error) => { await setSyncStatus('error', error.message); throw error; });
    await setSyncStatus(!status.connected ? 'disconnected' : status.remoteChanged && status.localChanged ? 'conflict' : status.remoteChanged || status.localChanged ? 'pending' : 'synced');
    return status;
  },
  async drive_save({ force = false, silent = false } = {}) {
    await setSyncStatus('syncing');
    try {
      const result = await saveToDrive({ force, silent });
      await setSyncStatus(result.conflict ? 'conflict' : 'synced');
      return result;
    } catch (error) {
      await setSyncStatus(error.message === NOT_CONNECTED ? 'disconnected' : 'error', error.message);
      throw error;
    }
  },
  async drive_load() {
    const file = await findSyncFile({});
    if (!file) throw new Error('Google Drive上に同期ファイルがありません。先に「Driveに保存」を実行してください。');
    const data = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
    return { data, modifiedTime: file.modifiedTime };
  },
  async drive_mark_synced({ modifiedTime }) {
    // 読み込んだ内容をページが保存した後に呼ばれる。保存済みの内容を同期済みとして記録する
    const signatures = makeSignatures(await store.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathBatchOpen']));
    await store.set({ folderPathDriveSyncedAt: modifiedTime, folderPathDriveSyncState: signatures, folderPathBackupState: signatures });
    await setSyncStatus('synced');
    return {};
  }
};

// 同期の状態はDriveボタンに表示するため保存しておく
async function setSyncStatus(state, message = '') {
  await store.set({ folderPathDriveSyncStatus: { state, message, at: Date.now() } });
}

// 登録内容が変わったら、自動同期が有効なときだけDriveの同期ファイルを上書きする
let autoSaveTimer;
onStoreChanged((changes) => {
  if (!(changes.folderPaths || changes.folderPathTagSortKeys || changes.folderPathBatchOpen)) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => autoSave().catch(() => {}), 2000);
});

// 一時的なエラーで同期できなかった変更を、15分ごとに送り直す
setInterval(async () => {
  const { folderPathDriveSyncStatus: status } = await store.get('folderPathDriveSyncStatus');
  if (status && status.state !== 'synced' && status.state !== 'unconfigured') autoSave().catch(() => {});
}, 15 * 60 * 1000);

async function autoSave() {
  const { folderPathDriveAutoSync: enabled, folderPathDriveClientId: clientId } = await store.get(['folderPathDriveAutoSync', 'folderPathDriveClientId']);
  if (enabled === false || !clientId) return;
  await setSyncStatus('syncing');
  try {
    const status = await syncCheck({ silent: true });
    if (!status.connected) return setSyncStatus('disconnected');
    // 他の端末がDriveを更新していたら上書きせず、利用者に選んでもらう
    if (status.remoteChanged) return setSyncStatus(status.localChanged ? 'conflict' : 'pending');
    if (status.localChanged) await saveToDrive({ silent: true });
    await setSyncStatus('synced');
  } catch (error) {
    await setSyncStatus('error', error.message);
  }
}

function makeSignatures({ folderPaths, folderPathTagSortKeys, folderPathBatchOpen }) {
  const items = Array.isArray(folderPaths) ? folderPaths : [];
  const signatures = Object.fromEntries(items.map((item) => [item.id, JSON.stringify(item)]));
  if (folderPathTagSortKeys && Object.keys(folderPathTagSortKeys).length) signatures.__tagSortKeys = JSON.stringify(folderPathTagSortKeys);
  if (Array.isArray(folderPathBatchOpen) && folderPathBatchOpen.length) signatures.__batchOpen = JSON.stringify(folderPathBatchOpen);
  return signatures;
}

function sameSignatures(a = {}, b = {}) {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].every((id) => a[id] === b[id]);
}

async function syncCheck({ silent }) {
  const saved = await store.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathBatchOpen', 'folderPathDriveAutoSync', 'folderPathDriveSyncedAt', 'folderPathDriveSyncState']);
  let file;
  try {
    file = await findSyncFile({ silent });
  } catch (error) {
    if (silent && error.message === NOT_CONNECTED) return { connected: false, autoSync: saved.folderPathDriveAutoSync !== false };
    throw error;
  }
  return {
    connected: true,
    autoSync: saved.folderPathDriveAutoSync !== false,
    exists: Boolean(file),
    modifiedTime: file?.modifiedTime ?? '',
    remoteChanged: Boolean(file) && file.modifiedTime !== saved.folderPathDriveSyncedAt,
    localChanged: !sameSignatures(makeSignatures(saved), saved.folderPathDriveSyncState)
  };
}

async function saveToDrive({ force, silent }) {
  const saved = await store.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathBatchOpen', 'folderPathDriveSyncedAt']);
  const remote = await findSyncFile({ silent });
  if (!force && remote && remote.modifiedTime !== saved.folderPathDriveSyncedAt) return { conflict: true, modifiedTime: remote.modifiedTime };
  const items = Array.isArray(saved.folderPaths) ? saved.folderPaths : [];
  const tagSortKeys = saved.folderPathTagSortKeys && typeof saved.folderPathTagSortKeys === 'object' ? saved.folderPathTagSortKeys : {};
  const batchOpen = Array.isArray(saved.folderPathBatchOpen) ? saved.folderPathBatchOpen : [];
  const content = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items, tagSortKeys, batchOpen }, null, 2);
  const fields = 'fields=id,name,modifiedTime&supportsAllDrives=true';
  let file;
  if (remote) {
    file = await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(remote.id)}?uploadType=media&${fields}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: content }, { silent });
  } else {
    const boundary = `folderpathmemo-${crypto.randomUUID()}`;
    const metadata = { name: DRIVE_SYNC_FILE_NAME, mimeType: 'application/json', parents: [await getBackupFolderId()] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    file = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&${fields}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, { silent });
  }
  const signatures = makeSignatures(saved);
  await store.set({ folderPathDriveSyncedAt: file.modifiedTime, folderPathDriveSyncState: signatures, folderPathBackupState: signatures });
  return { fileName: file.name, modifiedTime: file.modifiedTime };
}

async function findSyncFile({ silent = false }) {
  const folderId = await getBackupFolderId();
  const query = encodeURIComponent(`'${folderId}' in parents and name = '${DRIVE_SYNC_FILE_NAME}' and trashed = false`);
  const result = await driveFetch(`${DRIVE_API}/files?q=${query}&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime%20desc&fields=files(id,modifiedTime)`, {}, { silent });
  return result.files?.[0] ?? null;
}

async function getBackupFolderId() {
  const { folderPathDriveFolderId: folderId } = await store.get('folderPathDriveFolderId');
  return folderId || DEFAULT_DRIVE_FOLDER_ID;
}

async function driveFetch(url, options = {}, { silent = false, retried = false } = {}) {
  const token = await getDriveToken({ silent });
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 401 && !retried) {
    await store.remove('folderPathDriveToken');
    return driveFetch(url, options, { silent, retried: true });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`Google Driveでエラーが発生しました（${response.status}）${detail?.error?.message ? `: ${detail.error.message}` : ''}`);
  }
  return response.json();
}

let pendingAuth = null;

// silent: ログイン画面を出さずに使えるトークンがあるときだけ返す（自動同期用）。
// ブラウザーはクリックなどの操作なしにGoogleのログイン画面を開けないため、期限切れなら「未接続」にする
async function getDriveToken({ forceInteractive = false, silent = false } = {}) {
  if (!forceInteractive) {
    const { folderPathDriveToken: cached } = await store.get('folderPathDriveToken');
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.accessToken;
    if (silent) throw new Error(NOT_CONNECTED);
  }
  pendingAuth ??= (async () => {
    const { folderPathDriveClientId: clientId } = await store.get('folderPathDriveClientId');
    if (!clientId) throw new Error('Google DriveのクライアントIDが未設定です。Drive設定から登録してください。');
    const token = await requestDriveToken(clientId);
    await store.set({ folderPathDriveToken: token });
    return token.accessToken;
  })().finally(() => { pendingAuth = null; });
  return pendingAuth;
}

function requestDriveToken(clientId) {
  return new Promise((resolve, reject) => {
    const oauth2 = globalThis.google?.accounts?.oauth2;
    if (!oauth2) return reject(new Error('Googleのログイン機能を読み込めませんでした。ネットワークを確認して、ページを再読み込みしてください。'));
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      // 同じクライアントIDで過去に許可した別スコープ（youtube.readonly など）を混ぜると
      // 「同時に要求できないスコープ」としてGoogleが400 invalid_requestで拒否するため、含めない
      include_granted_scopes: false,
      callback: (result) => {
        if (!result.access_token) return reject(new Error(`Googleへの接続に失敗しました（${result.error_description || result.error || '不明なエラー'}）`));
        resolve({ accessToken: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 });
      },
      error_callback: (error) => {
        if (error.type === 'popup_failed_to_open') reject(new Error('Googleのログイン画面を開けませんでした。このサイトのポップアップを許可してください。'));
        else if (error.type === 'popup_closed') reject(new Error('Googleへの接続がキャンセルされました'));
        else reject(new Error(`Googleへの接続に失敗しました（${error.message || error.type}）`));
      }
    });
    // 一度許可していれば、同意画面を出さずにトークンを受け取る
    client.requestAccessToken({ prompt: '' });
  });
}
