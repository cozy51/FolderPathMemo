// Google Drive設定ダイアログ。Drive APIの呼び出しは drive.js の driveHandlers で行う。
// Driveには1つの同期ファイルだけを置き、保存のたびに上書きする。
function setupDriveDialog({ applyBackup, onBackupStateChanged, showToast }) {
  const dialog = document.querySelector('#driveDialog');
  const clientIdInput = document.querySelector('#driveClientIdInput');
  const autoSyncInput = document.querySelector('#driveAutoSync');
  const send = (type, payload = {}) => driveHandlers[type](payload);
  const run = async (button, task) => {
    button.disabled = true;
    try { await task(); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
  };
  const formatTime = (time) => time ? new Date(time).toLocaleString() : '';
  const driveButton = document.querySelector('#driveButton');
  const buttonLabel = driveButton.textContent.trim();
  const syncStates = {
    unconfigured: { label: '未設定', title: 'Google Driveの接続設定がまだです。クリックして設定してください' },
    disconnected: { label: '未接続', title: 'Google Driveに接続されていません。クリックすると接続します' },
    syncing: { label: '同期中', title: 'Google Driveと同期しています' },
    pending: { label: '未同期', title: 'Google Driveにまだ反映されていない変更があります' },
    synced: { label: '同期済み', title: 'Google Driveと同期済みです' },
    conflict: { label: '要確認', title: 'Driveとこの端末の両方に変更があります。クリックして保存か読み込みを選んでください' },
    error: { label: 'エラー', title: 'Google Driveとの同期に失敗しました' }
  };
  let syncState = 'unconfigured';

  // Driveボタン自体に接続・同期の状態を表示する
  function renderSyncState(state, message = '') {
    syncState = syncStates[state] ? state : 'error';
    const info = syncStates[syncState];
    const dot = document.createElement('span');
    dot.className = 'drive-dot';
    driveButton.replaceChildren(dot, document.createTextNode(`${buttonLabel} ${info.label}`));
    driveButton.dataset.syncState = syncState;
    driveButton.title = message ? `${info.title}（${message}）` : info.title;
  }

  // Driveでの保存やバックグラウンドの自動保存で、変更件数バッジを更新する
  onStoreChanged((changes) => {
    if (changes.folderPathBackupState) onBackupStateChanged(changes.folderPathBackupState.newValue ?? {});
    if (changes.folderPathDriveSyncStatus?.newValue) renderSyncState(changes.folderPathDriveSyncStatus.newValue.state, changes.folderPathDriveSyncStatus.newValue.message);
    else if ((changes.folderPaths || changes.folderPathTagSortKeys) && syncState === 'synced') renderSyncState('pending');
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
    document.querySelector('#driveOrigin').textContent = status.origin;
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
    } else if (sync.localChanged) {
      await saveToDrive({ silent: true });
    }
  }

  async function openDialog() {
    dialog.showModal();
    try { await refresh(); } catch (error) { showToast(error.message); }
  }
  driveButton.onclick = async () => {
    if (syncState !== 'disconnected') return openDialog();
    // 未接続のときは、ボタン1回でGoogleに接続して同期する
    showToast('Google Driveに接続しています…');
    try {
      await send('drive_connect');
      showToast('Google Driveに接続しました');
      await syncOnOpen();
    } catch (error) {
      showToast(error.message);
      openDialog();
    }
  };
  document.querySelector('#closeDriveDialog').onclick = () => dialog.close();
  document.querySelector('#copyDriveOrigin').onclick = async () => {
    await navigator.clipboard.writeText(document.querySelector('#driveOrigin').textContent);
    showToast('JavaScript生成元をコピーしました');
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

  (async () => {
    const saved = await store.get(['folderPathDriveClientId', 'folderPathDriveSyncStatus']);
    if (!saved.folderPathDriveClientId) return renderSyncState('unconfigured');
    renderSyncState(saved.folderPathDriveSyncStatus?.state ?? 'disconnected', saved.folderPathDriveSyncStatus?.message);
    await syncOnOpen();
  })().catch(() => {});
}
