const NATIVE_HOST = 'jp.folderpath.memo';
// 既存の共有フォルダーへ保存するため、drive.file ではなく drive スコープを使う
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_DRIVE_FOLDER_ID = '1u6N_eEqh7PDCpA4Fm8gqXYJmHMPl-SDv';
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
    const { folderPathDriveClientId: clientId = '' } = await chrome.storage.local.get('folderPathDriveClientId');
    const { folderPathDriveToken: token } = await chrome.storage.session.get('folderPathDriveToken');
    return { clientId, folderId: await getBackupFolderId(), redirectUrl: chrome.identity.getRedirectURL(), connected: Boolean(token && token.expiresAt > Date.now()) };
  },
  async drive_save_folder({ folder }) {
    // フォルダーURL（…/folders/<ID>?usp=…）とIDのどちらでも受け付ける。空欄なら既定のフォルダーに戻す
    const text = String(folder ?? '').trim();
    const folderId = text.match(/folders\/([\w-]+)/)?.[1] ?? text.match(/[?&]id=([\w-]+)/)?.[1] ?? text;
    if (folderId && !/^[\w-]+$/.test(folderId)) throw new Error('フォルダーのURLまたはIDを確認してください');
    await chrome.storage.local.set({ folderPathDriveFolderId: folderId });
    return { folderId: await getBackupFolderId() };
  },
  async drive_save_client_id({ clientId }) {
    await chrome.storage.local.set({ folderPathDriveClientId: String(clientId ?? '').trim() });
    await chrome.storage.session.remove('folderPathDriveToken');
    return {};
  },
  async drive_connect() {
    await getDriveToken({ forceInteractive: true });
    return {};
  },
  async drive_disconnect() {
    const { folderPathDriveToken: token } = await chrome.storage.session.get('folderPathDriveToken');
    await chrome.storage.session.remove('folderPathDriveToken');
    if (token?.accessToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`, { method: 'POST' }).catch(() => {});
    return {};
  },
  async drive_backup({ filename, content, signatures }) {
    const folderId = await getBackupFolderId();
    const boundary = `folderpathmemo-${crypto.randomUUID()}`;
    const metadata = { name: filename, mimeType: 'application/json', parents: [folderId] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    const file = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    // ポップアップが認証ウィンドウで閉じても変更件数がリセットされるよう、ここで保存する
    if (signatures) await chrome.storage.local.set({ folderPathBackupState: signatures });
    return { fileName: file.name };
  },
  async drive_list_backups() {
    const folderId = await getBackupFolderId();
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType = 'application/json'`);
    const result = await driveFetch(`${DRIVE_API}/files?q=${query}&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime%20desc&pageSize=30&fields=files(id,name,createdTime)`);
    return { files: result.files ?? [] };
  },
  async drive_download_backup({ fileId }) {
    const data = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    return { data };
  }
};

async function getBackupFolderId() {
  const { folderPathDriveFolderId: folderId } = await chrome.storage.local.get('folderPathDriveFolderId');
  return folderId || DEFAULT_DRIVE_FOLDER_ID;
}

async function driveFetch(url, options = {}, retried = false) {
  const token = await getDriveToken();
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 401 && !retried) {
    await chrome.storage.session.remove('folderPathDriveToken');
    return driveFetch(url, options, true);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`Google Driveでエラーが発生しました（${response.status}）${detail?.error?.message ? `: ${detail.error.message}` : ''}`);
  }
  return response.json();
}

async function getDriveToken({ forceInteractive = false } = {}) {
  if (!forceInteractive) {
    const { folderPathDriveToken: cached } = await chrome.storage.session.get('folderPathDriveToken');
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.accessToken;
  }
  const { folderPathDriveClientId: clientId } = await chrome.storage.local.get('folderPathDriveClientId');
  if (!clientId) throw new Error('Google DriveのクライアントIDが未設定です。Drive設定から登録してください。');
  let token = forceInteractive ? null : await authorize(clientId, false).catch(() => null);
  token ??= await authorize(clientId, true);
  await chrome.storage.session.set({ folderPathDriveToken: token });
  return token.accessToken;
}

async function authorize(clientId, interactive) {
  const params = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(), scope: DRIVE_SCOPE, include_granted_scopes: 'true' });
  if (!interactive) params.set('prompt', 'none');
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive });
  } catch (error) {
    throw new Error(`Googleへの接続がキャンセルされたか、失敗しました（${error.message}）`);
  }
  const result = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const accessToken = result.get('access_token');
  if (!accessToken) throw new Error(`Googleへの接続に失敗しました（${result.get('error') || '不明なエラー'}）`);
  return { accessToken, expiresAt: Date.now() + Number(result.get('expires_in') || 3600) * 1000 };
}
