// ポップアップと一覧画面で共通のGoogle Drive設定ダイアログ。
// Drive APIの呼び出しは、ポップアップが認証ウィンドウで閉じても続くよう background.js で行う。
function setupDriveDialog({ buildBackup, markBackedUp, applyBackup, showToast }) {
  const dialog = document.querySelector('#driveDialog');
  const clientIdInput = document.querySelector('#driveClientIdInput');
  const backupSelect = document.querySelector('#driveBackupSelect');
  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || 'Google Driveとの通信に失敗しました');
    return response;
  });
  const run = async (button, task) => {
    button.disabled = true;
    try { await task(); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
  };

  async function refresh() {
    const status = await send('drive_status');
    clientIdInput.value = status.clientId;
    document.querySelector('#driveFolderInput').value = status.folderId;
    document.querySelector('#driveFolderLink').href = `https://drive.google.com/drive/folders/${encodeURIComponent(status.folderId)}`;
    document.querySelector('#driveRedirectUrl').textContent = status.redirectUrl;
    document.querySelector('#driveStatus').textContent = !status.clientId ? 'クライアントID未設定' : status.connected ? '接続済み' : '未接続（保存時にGoogleのログイン画面が開きます）';
    document.querySelector('#driveStatus').classList.toggle('connected', status.connected);
    backupSelect.replaceChildren(new Option('（一覧を読み込むと選択できます）', ''));
  }

  document.querySelector('#driveButton').onclick = async () => {
    try { await refresh(); } catch (error) { showToast(error.message); }
    dialog.showModal();
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
  document.querySelector('#driveBackupButton').onclick = (event) => run(event.currentTarget, async () => {
    const { filename, content, signatures } = buildBackup();
    const result = await send('drive_backup', { filename, content, signatures });
    await markBackedUp(signatures);
    showToast(`Google Driveに保存しました（${result.fileName}）`);
  });
  document.querySelector('#loadDriveBackups').onclick = (event) => run(event.currentTarget, async () => {
    const { files } = await send('drive_list_backups');
    backupSelect.replaceChildren(...(files.length ? files.map((file) => new Option(`${file.name}（${new Date(file.createdTime).toLocaleString()}）`, file.id)) : [new Option('Drive上にバックアップがありません', '')]));
  });
  document.querySelector('#driveRestoreButton').onclick = (event) => run(event.currentTarget, async () => {
    if (!backupSelect.value) { showToast('復元するバックアップを選択してください'); return; }
    if (!confirm('現在の登録内容を、選択したバックアップの内容で置き換えます。よろしいですか？')) return;
    const { data } = await send('drive_download_backup', { fileId: backupSelect.value });
    await applyBackup(data);
    dialog.close();
  });
}
