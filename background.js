const NATIVE_HOST = 'jp.folderpath.memo';
// 既存の共有フォルダーへ保存するため、drive.file ではなく drive スコープを使う
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_DRIVE_FOLDER_ID = '1u6N_eEqh7PDCpA4Fm8gqXYJmHMPl-SDv';
// バックアップを毎回増やさず、この1ファイルを最新版として上書きする
const DRIVE_SYNC_FILE_NAME = 'backup-ext_FolderPathMemo.json';
const NOT_CONNECTED = 'Google Driveに接続されていません';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'open_folder') {
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

  const handler = driveHandlers[message?.type];
  if (!handler) return false;
  handler(message).then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

const driveHandlers = {
  async drive_status() {
    const { folderPathDriveClientId: clientId = '', folderPathDriveAutoSync: autoSync = true } = await chrome.storage.local.get(['folderPathDriveClientId', 'folderPathDriveAutoSync']);
    const { folderPathDriveToken: token } = await chrome.storage.session.get('folderPathDriveToken');
    return { clientId, autoSync, fileName: DRIVE_SYNC_FILE_NAME, folderId: await getBackupFolderId(), redirectUrl: chrome.identity.getRedirectURL(), connected: Boolean(token && token.expiresAt > Date.now()) };
  },
  async drive_save_folder({ folder }) {
    // フォルダーURL（…/folders/<ID>?usp=…）とIDのどちらでも受け付ける。空欄なら既定のフォルダーに戻す
    const text = String(folder ?? '').trim();
    const folderId = text.match(/folders\/([\w-]+)/)?.[1] ?? text.match(/[?&]id=([\w-]+)/)?.[1] ?? text;
    if (folderId && !/^[\w-]+$/.test(folderId)) throw new Error('フォルダーのURLまたはIDを確認してください');
    await chrome.storage.local.set({ folderPathDriveFolderId: folderId });
    // 保存先が変わると同期ファイルも別物になるため、同期済みの記録を消す
    await chrome.storage.local.remove(['folderPathDriveSyncedAt', 'folderPathDriveSyncState']);
    return { folderId: await getBackupFolderId() };
  },
  async drive_save_client_id({ clientId }) {
    const value = String(clientId ?? '').trim();
    await chrome.storage.local.set({ folderPathDriveClientId: value });
    await chrome.storage.session.remove('folderPathDriveToken');
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
    const { folderPathDriveToken: token } = await chrome.storage.session.get('folderPathDriveToken');
    await chrome.storage.session.remove('folderPathDriveToken');
    await setSyncStatus('disconnected');
    if (token?.accessToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`, { method: 'POST' }).catch(() => {});
    return {};
  },
  async drive_set_auto_sync({ enabled }) {
    await chrome.storage.local.set({ folderPathDriveAutoSync: Boolean(enabled) });
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
    const signatures = makeSignatures(await chrome.storage.local.get(['folderPaths', 'folderPathTagSortKeys']));
    await chrome.storage.local.set({ folderPathDriveSyncedAt: modifiedTime, folderPathDriveSyncState: signatures, folderPathBackupState: signatures });
    await setSyncStatus('synced');
    return {};
  }
};

// 同期の状態はページのDriveボタンに表示するため storage.local に置く
async function setSyncStatus(state, message = '') {
  await chrome.storage.local.set({ folderPathDriveSyncStatus: { state, message, at: Date.now() } });
}

// 登録内容が変わったら、自動同期が有効なときだけDriveの同期ファイルを上書きする
let autoSaveTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.folderPaths || changes.folderPathTagSortKeys)) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => autoSave().catch(() => {}), 2000);
});

// 一時的なエラーや期限切れで同期できなかった変更を、15分ごとに送り直す
chrome.alarms.create('folderPathDriveRetry', { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'folderPathDriveRetry') return;
  const { folderPathDriveSyncStatus: status } = await chrome.storage.local.get('folderPathDriveSyncStatus');
  if (status && status.state !== 'synced' && status.state !== 'unconfigured') autoSave().catch(() => {});
});

async function autoSave() {
  const { folderPathDriveAutoSync: enabled, folderPathDriveClientId: clientId } = await chrome.storage.local.get(['folderPathDriveAutoSync', 'folderPathDriveClientId']);
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

function makeSignatures({ folderPaths, folderPathTagSortKeys }) {
  const items = Array.isArray(folderPaths) ? folderPaths : [];
  const signatures = Object.fromEntries(items.map((item) => [item.id, JSON.stringify(item)]));
  if (folderPathTagSortKeys && Object.keys(folderPathTagSortKeys).length) signatures.__tagSortKeys = JSON.stringify(folderPathTagSortKeys);
  return signatures;
}

function sameSignatures(a = {}, b = {}) {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].every((id) => a[id] === b[id]);
}

async function syncCheck({ silent }) {
  const saved = await chrome.storage.local.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathDriveAutoSync', 'folderPathDriveSyncedAt', 'folderPathDriveSyncState']);
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
  const saved = await chrome.storage.local.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathDriveSyncedAt']);
  const remote = await findSyncFile({ silent });
  if (!force && remote && remote.modifiedTime !== saved.folderPathDriveSyncedAt) return { conflict: true, modifiedTime: remote.modifiedTime };
  const items = Array.isArray(saved.folderPaths) ? saved.folderPaths : [];
  const tagSortKeys = saved.folderPathTagSortKeys && typeof saved.folderPathTagSortKeys === 'object' ? saved.folderPathTagSortKeys : {};
  const content = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items, tagSortKeys }, null, 2);
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
  // ポップアップが認証ウィンドウで閉じても同期状態と変更件数が更新されるよう、ここで保存する
  const signatures = makeSignatures(saved);
  await chrome.storage.local.set({ folderPathDriveSyncedAt: file.modifiedTime, folderPathDriveSyncState: signatures, folderPathBackupState: signatures });
  return { fileName: file.name, modifiedTime: file.modifiedTime };
}

async function findSyncFile({ silent = false }) {
  const folderId = await getBackupFolderId();
  const query = encodeURIComponent(`'${folderId}' in parents and name = '${DRIVE_SYNC_FILE_NAME}' and trashed = false`);
  const result = await driveFetch(`${DRIVE_API}/files?q=${query}&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime%20desc&fields=files(id,modifiedTime)`, {}, { silent });
  return result.files?.[0] ?? null;
}

async function getBackupFolderId() {
  const { folderPathDriveFolderId: folderId } = await chrome.storage.local.get('folderPathDriveFolderId');
  return folderId || DEFAULT_DRIVE_FOLDER_ID;
}

async function driveFetch(url, options = {}, { silent = false, retried = false } = {}) {
  const token = await getDriveToken({ silent });
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 401 && !retried) {
    await chrome.storage.session.remove('folderPathDriveToken');
    return driveFetch(url, options, { silent, retried: true });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`Google Driveでエラーが発生しました（${response.status}）${detail?.error?.message ? `: ${detail.error.message}` : ''}`);
  }
  return response.json();
}

let pendingAuth = null;

// silent: ログイン画面を出さずに取得できるときだけトークンを返す（自動同期用）
async function getDriveToken({ forceInteractive = false, silent = false } = {}) {
  if (!forceInteractive) {
    const { folderPathDriveToken: cached } = await chrome.storage.session.get('folderPathDriveToken');
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.accessToken;
  }
  // launchWebAuthFlowは同時に1つしか動かせないため、進行中の認証があればその結果を待つ
  if (pendingAuth) {
    const accessToken = await pendingAuth.catch(() => null);
    if (accessToken) return accessToken;
    if (silent) throw new Error(NOT_CONNECTED);
  }
  pendingAuth ??= (async () => {
    const { folderPathDriveClientId: clientId } = await chrome.storage.local.get('folderPathDriveClientId');
    if (!clientId) throw new Error(silent ? NOT_CONNECTED : 'Google DriveのクライアントIDが未設定です。Drive設定から登録してください。');
    let token = forceInteractive ? null : await authorize(clientId, false).catch(() => null);
    if (!token && silent) throw new Error(NOT_CONNECTED);
    token ??= await authorize(clientId, true);
    await chrome.storage.session.set({ folderPathDriveToken: token });
    return token.accessToken;
  })().finally(() => { pendingAuth = null; });
  return pendingAuth;
}

async function authorize(clientId, interactive) {
  const params = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(), scope: DRIVE_SCOPE, include_granted_scopes: 'true' });
  if (!interactive) params.set('prompt', 'none');
  let responseUrl;
  try {
    // ログイン画面なしの再接続では、Googleのリダイレクトが終わるまで最大10秒待つ
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive, ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 }) });
  } catch (error) {
    if (/only one web auth flow/i.test(error.message)) throw new Error('Googleのログイン画面が開いたままです。その画面を閉じてから、もう一度お試しください。');
    throw new Error(`Googleへの接続がキャンセルされたか、失敗しました（${error.message}）`);
  }
  const result = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const accessToken = result.get('access_token');
  if (!accessToken) throw new Error(`Googleへの接続に失敗しました（${result.get('error') || '不明なエラー'}）`);
  return { accessToken, expiresAt: Date.now() + Number(result.get('expires_in') || 3600) * 1000 };
}
