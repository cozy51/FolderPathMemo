const state = { items: [], query: '', view: 'all', tag: '', sort: 'registered-desc', tagSortKeys: {}, backupSignatures: {} };
const $ = (selector) => document.querySelector(selector);
const dialog = $('#pathDialog');
let nameAutoFill = true;
let editingTags = new Set();
function deriveFolderName(path) { const normalized = path.trim().replace(/[\\/]+$/, ''); return normalized.split(/[\\/]/).filter(Boolean).pop() || path.trim(); }
function syncNameFromPath() { if (nameAutoFill) $('#nameInput').value = deriveFolderName($('#pathInput').value); }

function fuzzyMatch(text, query) {
  const source = text.toLocaleLowerCase(); let index = 0;
  for (const char of query.trim().toLocaleLowerCase()) { index = source.indexOf(char, index); if (index < 0) return false; index += 1; }
  return true;
}
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600); }
async function persist() { await chrome.storage.local.set({ folderPaths: state.items, folderPathTagSortKeys: state.tagSortKeys }); updateBackupCount(); }
function makeSignatures() { const signatures = Object.fromEntries(state.items.map((item) => [item.id, JSON.stringify(item)])); if (Object.keys(state.tagSortKeys).length) signatures.__tagSortKeys = JSON.stringify(state.tagSortKeys); return signatures; }
function updateBackupCount() { const current = makeSignatures(); const ids = new Set([...Object.keys(current), ...Object.keys(state.backupSignatures)]); const count = [...ids].filter((id) => current[id] !== state.backupSignatures[id]).length; const badge = $('#backupChangeCount'); badge.textContent = count; badge.classList.toggle('clean', count === 0); badge.title = `前回バックアップから ${count} 件変更`; }
function normalizeFiles(files) { return Array.isArray(files) ? files.map((file) => ({ name: String(file.name ?? '').trim(), memo: String(file.memo ?? '').trim() })).filter((file) => file.name || file.memo) : []; }
function fileTypeInfo(filename) {
  const extension = filename.split('.').pop()?.toLocaleLowerCase() ?? '';
  if (['xlsx', 'xls', 'xlsm', 'csv'].includes(extension)) return { type: 'sheet', label: 'X', title: '表計算ファイル' };
  if (['pptx', 'ppt'].includes(extension)) return { type: 'slides', label: 'P', title: 'プレゼンテーション' };
  if (extension === 'pdf') return { type: 'pdf', label: 'PDF', title: 'PDFファイル' };
  if (['docx', 'doc', 'rtf'].includes(extension)) return { type: 'document', label: 'W', title: '文書ファイル' };
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(extension)) return { type: 'image', label: 'IMG', title: '画像ファイル' };
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)) return { type: 'archive', label: 'ZIP', title: '圧縮ファイル' };
  if (['txt', 'md', 'log'].includes(extension)) return { type: 'text', label: 'TXT', title: 'テキストファイル' };
  return { type: 'other', label: 'FILE', title: extension ? `${extension.toUpperCase()}ファイル` : 'ファイル' };
}
function fileSearchText(item) { return normalizeFiles(item.files).flatMap((file) => [file.name, file.memo]).join(' '); }
function getFileRows() { return [...document.querySelectorAll('#fileRows .file-row')]; }
function updateFileOrderOptions() { const rows = getFileRows(); rows.forEach((row, index) => { const select = row.querySelector('.file-order-select'); const current = String(index + 1); select.replaceChildren(...rows.map((_, optionIndex) => { const option = document.createElement('option'); option.value = String(optionIndex + 1); option.textContent = String(optionIndex + 1); return option; })); select.value = current; }); }
function moveFileRow(row, targetIndex) { const rows = getFileRows(); const currentIndex = rows.indexOf(row); if (currentIndex < 0 || targetIndex < 0 || targetIndex >= rows.length || currentIndex === targetIndex) return; row.remove(); const orderedRows = getFileRows(); $('#fileRows').insertBefore(row, orderedRows[targetIndex] ?? null); updateFileOrderOptions(); }
function readFileRows() { return getFileRows().map((row) => ({ name: row.querySelector('.file-name-input').value.trim(), memo: row.querySelector('.file-memo-input').value.trim() })).filter((file) => file.name || file.memo); }
function addFileRow(file = {}) { const row = document.createElement('div'); row.className = 'file-row'; row.draggable = true; row.innerHTML = '<select class="file-order-select" aria-label="No"></select><input class="file-name-input" maxlength="160" placeholder="ファイル名" /><input class="file-memo-input" maxlength="240" placeholder="ファイルメモ" /><button class="remove-file-button" type="button" aria-label="ファイル行を削除">×</button>'; row.querySelector('.file-name-input').value = file.name ?? ''; row.querySelector('.file-memo-input').value = file.memo ?? ''; row.querySelector('.file-order-select').onchange = (event) => moveFileRow(row, Number(event.target.value) - 1); row.querySelector('.remove-file-button').onclick = () => { row.remove(); updateFileOrderOptions(); }; row.ondragstart = (event) => { row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(getFileRows().indexOf(row))); }; row.ondragend = () => row.classList.remove('dragging'); row.ondragover = (event) => event.preventDefault(); row.ondrop = (event) => { event.preventDefault(); const source = getFileRows()[Number(event.dataTransfer.getData('text/plain'))]; if (source && source !== row) moveFileRow(source, getFileRows().indexOf(row)); }; $('#fileRows').append(row); updateFileOrderOptions(); }
function renderFileRows(files = []) { $('#fileRows').replaceChildren(); const normalized = normalizeFiles(files); (normalized.length ? normalized : [{}]).forEach(addFileRow); updateFileOrderOptions(); }
function createFileList(item) { const files = normalizeFiles(item.files); const wrap = document.createElement('div'); wrap.className = 'folder-file-list'; if (!files.length) { wrap.innerHTML = '<p class="file-list-empty">登録されたファイルはありません。編集画面からファイルリストを追加できます。</p>'; return wrap; } files.forEach((file, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'file-list-item'; const no = document.createElement('span'); no.className = 'file-list-no'; no.textContent = String(index + 1); const name = document.createElement('span'); name.className = 'file-list-name'; const typeInfo = fileTypeInfo(file.name); const icon = document.createElement('span'); icon.className = `file-type-icon ${typeInfo.type}`; icon.textContent = typeInfo.label; icon.title = typeInfo.title; name.append(icon, document.createTextNode(file.name || '（ファイル名なし）')); const memo = document.createElement('span'); memo.className = 'file-list-memo'; memo.textContent = file.memo; button.append(no, name, memo); button.onclick = async (event) => { event.stopPropagation(); await navigator.clipboard.writeText(file.name); showToast('ファイル名をコピーしました'); }; wrap.append(button); }); return wrap; }
function backupFilename(now = new Date()) { const pad = (value) => String(value).padStart(2, '0'); return `backup-ext_FolderPathMemo_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.json`; }

async function openFolder(item) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'open_folder', path: item.path });
    if (!response?.ok) throw new Error(response?.error);
    item.lastOpenedAt = Date.now(); item.openCount = (item.openCount ?? 0) + 1; await persist(); render();
    const hostVersion = response.version ?? '1.3.25以前';
    if (hostVersion !== chrome.runtime.getManifest().version) showToast(`連携ホストが古いままです（${hostVersion}）。install.ps1 を実行し直してください`);
    else showToast(response.openedInTab ? '新しいタブで開きました' : 'エクスプローラーで開きました');
  } catch { await navigator.clipboard.writeText(item.path); showToast('連携できないためパスをコピーしました'); }
}
function openEditor(item) {
  $('#dialogTitle').textContent = item ? 'フォルダーを編集' : 'フォルダーを登録';
  nameAutoFill = !item;
  $('#itemId').value = item?.id ?? ''; $('#nameInput').value = item?.name ?? ''; $('#pathInput').value = item?.path ?? '';
  $('#memoInput').value = item?.memo ?? ''; editingTags = new Set(item?.tags ?? []); $('#tagsInput').value = ''; renderTagChoices(); $('#favoriteInput').checked = item?.favorite ?? false;
  renderFileRows(item?.files);
  syncNameFromPath();
  dialog.showModal(); (item ? $('#nameInput') : $('#pathInput')).focus();
}
function cell(className, text = '') { const element = document.createElement('td'); element.className = className; element.textContent = text; return element; }
function tagSortValue(tag) { return (state.tagSortKeys[tag] || tag).trim(); }
function compareTags(a, b) { return tagSortValue(a).localeCompare(tagSortValue(b), 'ja', { numeric: true, sensitivity: 'base' }) || a.localeCompare(b, 'ja'); }
function renderTagChoices() {
  const tags = [...new Set(state.items.flatMap((item) => item.tags ?? []))].sort(compareTags);
  $('#tagChoices').replaceChildren(...tags.map((tag) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `tag-choice${editingTags.has(tag) ? ' selected' : ''}`; button.textContent = `# ${tag}`; decorateTag(button, tag);
    button.onclick = () => { if (editingTags.has(tag)) editingTags.delete(tag); else editingTags.add(tag); renderTagChoices(); }; return button;
  }));
}
function collectEditorTags() {
  const existingTags = [...new Set(state.items.flatMap((item) => item.tags ?? []))];
  const enteredTags = $('#tagsInput').value.split(',').map((tag) => tag.trim()).filter(Boolean).map((tag) => existingTags.find((existing) => existing.localeCompare(tag, 'ja', { sensitivity: 'base' }) === 0) ?? tag);
  return [...new Set([...editingTags, ...enteredTags])];
}
function decorateTag(element, tag) {
  const reading = String(state.tagSortKeys[tag] ?? '').trim();
  element.classList.toggle('has-reading', Boolean(reading));
  element.title = reading ? `よみ：${reading}` : `タグ名：${tag}`;
}
function openTagEditor() {
  const allTags = [...new Set(state.items.flatMap((item) => item.tags ?? []))].sort(compareTags);
  $('#tagRows').replaceChildren(...allTags.map((tag) => {
    const row = document.createElement('div'); row.className = 'tag-edit-row'; row.dataset.originalTag = tag;
    const name = document.createElement('input'); name.className = 'tag-name-input'; name.value = tag; name.maxLength = 50; name.required = true;
    const reading = document.createElement('input'); reading.className = 'tag-reading-input'; reading.value = state.tagSortKeys[tag] ?? ''; reading.maxLength = 80; reading.placeholder = '例：せいぞう / せ';
    const count = document.createElement('span'); count.className = 'tag-use-count'; count.textContent = `${state.items.filter((item) => item.tags?.includes(tag)).length} 件`;
    row.append(name, reading, count); return row;
  }));
  $('#tagDialog').showModal();
}
function registeredAt(item) { return Number(item.createdAt) || Number(item.updatedAt) || 0; }
function compareItems(a, b) {
  if (state.view === 'history') return b.lastOpenedAt - a.lastOpenedAt;
  if (state.sort === 'path-asc') return a.path.localeCompare(b.path, 'ja', { numeric: true, sensitivity: 'base' }) || registeredAt(b) - registeredAt(a);
  if (state.sort === 'name-asc') return a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }) || registeredAt(b) - registeredAt(a);
  return registeredAt(b) - registeredAt(a) || a.name.localeCompare(b.name, 'ja');
}

function render() {
  const allTags = [...new Set(state.items.flatMap((item) => item.tags ?? []))].sort(compareTags);
  const editTags = document.createElement('button'); editTags.type = 'button'; editTags.className = 'tag-edit-button'; editTags.textContent = '⚙ タグ設定'; editTags.title = 'タグ名・よみがなを編集'; editTags.onclick = openTagEditor;
  $('#tagFilters').replaceChildren(editTags, ...allTags.map((tag) => { const button = document.createElement('button'); button.type = 'button'; button.className = `tag-chip${state.tag === tag ? ' active' : ''}`; button.textContent = `# ${tag}`; decorateTag(button, tag); button.onclick = () => { state.tag = state.tag === tag ? '' : tag; render(); }; return button; }));
  $('#allCount').textContent = state.items.length; $('#favoriteCount').textContent = state.items.filter((item) => item.favorite).length; $('#historyCount').textContent = state.items.filter((item) => item.lastOpenedAt).length;
  const visible = state.items.filter((item) => state.view === 'all' || (state.view === 'favorite' && item.favorite) || (state.view === 'history' && item.lastOpenedAt))
    .filter((item) => !state.tag || item.tags?.includes(state.tag))
    .filter((item) => fuzzyMatch([item.name, item.memo ?? '', item.path, ...(item.tags ?? []), fileSearchText(item)].join(' '), state.query))
    .sort(compareItems);
  $('#tableBody').replaceChildren(); $('#emptyState').hidden = visible.length > 0;
  visible.forEach((item) => {
    const row = document.createElement('tr'); row.tabIndex = 0;
    const star = cell('star', item.favorite ? '★' : '☆'); star.onclick = async (event) => { event.stopPropagation(); item.favorite = !item.favorite; item.updatedAt = Date.now(); await persist(); render(); }; row.append(star);
    const info = cell('info'); const titleLine = document.createElement('div'); titleLine.className = 'folder-title-line'; const name = document.createElement('div'); name.className = 'folder-name'; name.textContent = item.name; titleLine.append(name); const fileTotal = normalizeFiles(item.files).length; if (fileTotal > 0) { const fileCount = document.createElement('span'); fileCount.className = 'file-count-badge'; fileCount.textContent = `ファイル ${fileTotal}件`; fileCount.title = `登録ファイル数：${fileTotal}件`; titleLine.append(fileCount); } info.append(titleLine);
    if (item.memo) { const memo = document.createElement('div'); memo.className = 'memo'; memo.textContent = item.memo; info.append(memo); } row.append(info);
    const tags = cell('tags'); (item.tags ?? []).forEach((tag) => { const badge = document.createElement('button'); badge.type = 'button'; badge.className = `tag${state.tag === tag ? ' active' : ''}`; badge.textContent = tag; decorateTag(badge, tag); badge.onclick = (event) => { event.stopPropagation(); state.tag = state.tag === tag ? '' : tag; render(); }; tags.append(badge); }); row.append(tags);
    row.append(cell('path', item.path));
    const actions = cell('actions');
    const copy = document.createElement('button'); copy.textContent = 'コピー'; copy.onclick = async (event) => { event.stopPropagation(); await navigator.clipboard.writeText(item.path); showToast('コピーしました'); };
    const open = document.createElement('button'); open.className = 'open'; open.textContent = '開く'; open.onclick = (event) => { event.stopPropagation(); openFolder(item); };
    const edit = document.createElement('button'); edit.className = 'edit'; edit.textContent = '編集'; edit.onclick = (event) => { event.stopPropagation(); openEditor(item); };
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '削除'; remove.onclick = async (event) => { event.stopPropagation(); if (!confirm(`「${item.name}」を削除しますか？`)) return; state.items = state.items.filter(({ id }) => id !== item.id); await persist(); render(); showToast('削除しました'); };
    actions.append(copy, open, edit, remove); row.append(actions);
    row.title = fileTotal > 0 ? 'クリックでファイルリスト表示・ダブルクリックで編集' : 'ファイルは未登録です・ダブルクリックで編集';
    row.onclick = (event) => { if (event.target.closest('button')) return; if (fileTotal === 0) { showToast('ファイルは登録されていません'); return; } row.classList.toggle('show-files'); };
    row.ondblclick = (event) => { if (event.target.closest('button')) return; event.preventDefault(); clearTimeout(row.openTimer); openEditor(item); };
    row.onkeydown = (event) => { if (event.key !== 'Enter') return; if (fileTotal === 0) { showToast('ファイルは登録されていません'); return; } row.classList.toggle('show-files'); }; $('#tableBody').append(row); if (fileTotal > 0) { const fileRow = document.createElement('tr'); fileRow.className = 'file-list-row'; const fileCell = document.createElement('td'); fileCell.colSpan = 5; fileCell.append(createFileList(item)); fileRow.append(fileCell); $('#tableBody').append(fileRow); }
  });
}

$('#pathForm').onsubmit = async (event) => {
  event.preventDefault(); const id = $('#itemId').value; const existing = state.items.find((item) => item.id === id); const path = $('#pathInput').value.trim(); const derivedName = deriveFolderName(path);
  const now = Date.now();
  const item = { id: id || crypto.randomUUID(), name: $('#nameInput').value.trim() || derivedName, path, memo: $('#memoInput').value.trim(), tags: collectEditorTags(), favorite: $('#favoriteInput').checked, files: readFileRows(), createdAt: existing?.createdAt ?? existing?.updatedAt ?? now, updatedAt: now, lastOpenedAt: existing?.lastOpenedAt ?? 0, openCount: existing?.openCount ?? 0 };
  if (existing) Object.assign(existing, item); else state.items.push(item); await persist(); dialog.close(); render(); showToast(existing ? '更新しました' : '登録しました');
};
$('#addButton').onclick = () => openEditor(); $('#addFileButton').onclick = () => addFileRow(); $('#nameInput').oninput = () => { nameAutoFill = $('#nameInput').value.trim() === deriveFolderName($('#pathInput').value); }; $('#pathInput').oninput = syncNameFromPath; $('#closeDialog').onclick = $('#cancelButton').onclick = () => dialog.close();
$('#searchInput').oninput = (event) => { state.query = event.target.value; render(); };
$('#sortSelect').onchange = (event) => { state.sort = event.target.value; render(); };
$('#closeTagDialog').onclick = $('#cancelTagButton').onclick = () => $('#tagDialog').close();
$('#tagForm').onsubmit = async (event) => {
  event.preventDefault(); const rows = [...document.querySelectorAll('#tagRows .tag-edit-row')];
  const edits = rows.map((row) => ({ oldTag: row.dataset.originalTag, tag: row.querySelector('.tag-name-input').value.trim(), reading: row.querySelector('.tag-reading-input').value.trim() }));
  if (new Set(edits.map(({ tag }) => tag)).size !== edits.length) { showToast('同じタグ名が複数あります'); return; }
  const renamed = Object.fromEntries(edits.map(({ oldTag, tag }) => [oldTag, tag]));
  state.items.forEach((item) => { item.tags = [...new Set((item.tags ?? []).map((tag) => renamed[tag] ?? tag))]; });
  state.tagSortKeys = Object.fromEntries(edits.filter(({ reading }) => reading).map(({ tag, reading }) => [tag, reading]));
  if (state.tag) state.tag = renamed[state.tag] ?? state.tag; await persist(); $('#tagDialog').close(); render(); showToast('タグを更新しました');
};
document.querySelectorAll('.view-tab').forEach((button) => button.onclick = () => { state.view = button.dataset.view; document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab === button)); render(); });
function buildBackup() { return { filename: backupFilename(), content: JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items: state.items, tagSortKeys: state.tagSortKeys }, null, 2), signatures: makeSignatures() }; }
async function markBackedUp(signatures) { state.backupSignatures = signatures; await chrome.storage.local.set({ folderPathBackupState: state.backupSignatures }); updateBackupCount(); }
async function applyBackup(data) { if (!Array.isArray(data?.items) || data.items.some((item) => typeof item.name !== 'string' || typeof item.path !== 'string')) throw new Error('バックアップを読み込めませんでした'); state.items = data.items.map((item) => { const updatedAt = Number(item.updatedAt) || Date.now(); return { id: item.id || crypto.randomUUID(), name: item.name, path: item.path, memo: typeof item.memo === 'string' ? item.memo : '', tags: Array.isArray(item.tags) ? item.tags : [], favorite: Boolean(item.favorite), createdAt: Number(item.createdAt) || updatedAt, updatedAt, files: normalizeFiles(item.files), lastOpenedAt: Number(item.lastOpenedAt) || 0, openCount: Number(item.openCount) || 0 }; }); state.tagSortKeys = data.tagSortKeys && typeof data.tagSortKeys === 'object' ? data.tagSortKeys : {}; await persist(); render(); showToast(`${state.items.length}件を復元しました`); }
$('#exportButton').onclick = async () => { const { filename, content, signatures } = buildBackup(); const blob = new Blob([content], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href); await markBackedUp(signatures); showToast('バックアップを作成しました'); };
$('#importButton').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (event) => { try { await applyBackup(JSON.parse(await event.target.files[0].text())); } catch { showToast('バックアップを読み込めませんでした'); } event.target.value = ''; };
setupDriveDialog({ applyBackup, onBackupStateChanged: (signatures) => { state.backupSignatures = signatures; updateBackupCount(); }, showToast });
(async () => { const saved = await chrome.storage.local.get(['folderPaths', 'folderPathTagSortKeys', 'folderPathBackupState']); state.items = Array.isArray(saved.folderPaths) ? saved.folderPaths : []; state.tagSortKeys = saved.folderPathTagSortKeys && typeof saved.folderPathTagSortKeys === 'object' ? saved.folderPathTagSortKeys : {}; state.backupSignatures = saved.folderPathBackupState && typeof saved.folderPathBackupState === 'object' ? saved.folderPathBackupState : {}; render(); updateBackupCount(); })();

$('#appVersion').textContent = `v${chrome.runtime.getManifest().version}`;
