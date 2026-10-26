// ポップアップと一覧画面で共通のGoogle Drive設定ダイアログ。
// Drive APIの呼び出しは、ポップアップが認証ウィンドウで閉じても続くよう background.js で行う。
// Driveには1つの同期ファイルだけを置き、保存のたびに上書きする。
function setupDriveDialog({ applyBackup, onBackupStateChanged, showToast }) {
  const dialog = document.querySelector('#driveDialog');
  const clientIdInput = document.querySelector('#driveClientIdInput');
  const autoSyncInput = document.querySelector('#driveAutoSync');
  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || 'Google Driveとの通信に失敗しました');
    return response;
  });
  const run = async (button, task) => {
    button.disabled = true;
    try { await task(); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
  };
  const formatTime = (time) => time ? new Date(time).toLocaleString() : '';

  // Driveでの保存やバックグラウンドの自動保存で、変更件数バッジを更新する
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.folderPathBackupState) onBackupStateChanged(changes.folderPathBackupState.newValue ?? {});
  });

  async function loadFromDrive() {
    const { data, modifiedTime } = await send('drive_load');
    await applyBackup(data);
    await send('drive_mark_synced', { modifiedTime });
  }

  async function saveToDrive({ silent = false } = {}) {
    let result = await send('drive_save', { silent });
    if (result.conflict) {
      if (silent || !confirm(`Google Driveには、ほかの端末で保存された新しい版があります（${formatTime(result.modifiedTime)}）。この端末の内容で上書きしますか？`)) return false;
      result = await send('drive_save', { force: true });
    }
    return true;
  }

  async function refresh() {
    const status = await send('drive_status');
    clientIdInput.value = status.clientId;
    autoSyncInput.checked = status.autoSync;
    document.querySelector('#driveFileName').textContent = status.fileName;
    document.querySelector('#driveFolderInput').value = status.folderId;
    document.querySelector('#driveFolderLink').href = `https://drive.google.com/drive/folders/${encodeURIComponent(status.folderId)}`;
    document.querySelector('#driveRedirectUrl').textContent = status.redirectUrl;
    const statusText = document.querySelector('#driveStatus');
    statusText.textContent = !status.clientId ? 'クライアントID未設定' : status.connected ? '接続済み' : '未接続（保存時にGoogleのログイン画面が開きます）';
    statusText.classList.toggle('connected', status.connected);
    const remoteInfo = document.querySelector('#driveRemoteInfo');
    remoteInfo.textContent = '';
    if (!status.clientId) return;
    const sync = await send('drive_sync_check').catch(() => null);
    if (!sync?.connected) return;
    statusText.textContent = '接続済み';
    statusText.classList.add('connected');
    remoteInfo.textContent = !sync.exists ? 'Drive上の最新版: まだありません'
      : `Drive上の最新版: ${formatTime(sync.modifiedTime)}${sync.remoteChanged ? '（ほかの端末で更新されています）' : ''}${sync.localChanged ? ' ／ この端末に未保存の変更があります' : ''}`;
  }

  // 自動同期が有効なら、画面を開いたときにDriveとこの端末のどちらが新しいかを確かめる
  async function syncOnOpen() {
    const sync = await send('drive_sync_check').catch(() => null);
    if (!sync?.connected || !sync.autoSync) return;
    if (sync.remoteChanged && !sync.localChanged) {
      await loadFromDrive();
      showToast('Google Driveの最新版を読み込みました');
    } else if (sync.remoteChanged) {
      showToast('Driveとこの端末の両方に変更があります。Driveボタンから保存か読み込みを選んでください');
    } else if (sync.localChanged && await saveToDrive({ silent: true })) {
      showToast('Google Driveに最新版を保存しました');
    }
  }

  document.querySelector('#driveButton').onclick = async () => {
    dialog.showModal();
    try { await refresh(); } catch (error) { showToast(error.message); }
  };
  document.querySelector('#closeDriveDialog').onclick = () => dialog.close();
  document.querySelector('#copyDriveRedirectUrl').onclick = async () => {
    await navigator.clipboard.writeText(document.querySelector('#driveRedirectUrl').textContent);
    showToast('リダイレクトURIをコピーしました');
  };
  document.querySelector('#saveDriveClientId').onclick = (event) => run(event.currentTarget, async () => {
    await send('drive_save_client_id', { clientId: clientIdInput.value });
    await refresh();
    showToast('クライアントIDを保存しました');
  });
  document.querySelector('#saveDriveFolder').onclick = (event) => run(event.currentTarget, async () => {
    await send('drive_save_folder', { folder: document.querySelector('#driveFolderInput').value });
    await refresh();
    showToast('保存先フォルダーを保存しました');
  });
  document.querySelector('#connectDrive').onclick = (event) => run(event.currentTarget, async () => {
    await send('drive_connect');
    await refresh();
    showToast('Google Driveに接続しました');
  });
  document.querySelector('#disconnectDrive').onclick = (event) => run(event.currentTarget, async () => {
    await send('drive_disconnect');
    await refresh();
    showToast('Google Driveとの接続を解除しました');
  });
  document.querySelector('#driveSaveButton').onclick = (event) => run(event.currentTarget, async () => {
    if (!await saveToDrive()) return;
    await refresh();
    showToast('Google Driveに最新版を保存しました');
  });
  document.querySelector('#driveLoadButton').onclick = (event) => run(event.currentTarget, async () => {
    if (!confirm('現在の登録内容を、Google Driveの最新版で置き換えます。よろしいですか？')) return;
    await loadFromDrive();
    await refresh();
  });
  autoSyncInput.onchange = () => run(autoSyncInput, async () => {
    await send('drive_set_auto_sync', { enabled: autoSyncInput.checked });
    if (autoSyncInput.checked) await syncOnOpen();
    await refresh();
  });

  syncOnOpen().catch(() => {});
}
