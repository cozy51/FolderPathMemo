const storage = globalThis.chrome?.storage?.local ?? {
  async get(key) { const keys = Array.isArray(key) ? key : [key]; return Object.fromEntries(keys.map((name) => [name, JSON.parse(localStorage.getItem(name) || (name === 'folderPaths' ? '[]' : '{}'))])); },
  async set(value) { Object.entries(value).forEach(([key, data]) => localStorage.setItem(key, JSON.stringify(data))); }
};

const state = { items: [], query: '', view: 'all', tag: '', backupSignatures: {} };
const $ = (selector) => document.querySelector(selector);
const list = $('#list');
const dialog = $('#pathDialog');
let nameAutoFill = true;

function deriveFolderName(path) {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || path.trim();
}

function syncNameFromPath() {
  if (!nameAutoFill) return;
  $('#nameInput').value = deriveFolderName($('#pathInput').value);
}

function fuzzyMatch(text, query) {
  const source = text.toLocaleLowerCase();
  const target = query.trim().toLocaleLowerCase();
  let index = 0;
  for (const char of target) {
    index = source.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

async function persist() {
  await storage.set({ folderPaths: state.items });
  updateBackupCount();
  $('#statusText').textContent = 'すべての変更を保存しました';
}

function makeSignatures() { return Object.fromEntries(state.items.map((item) => [item.id, JSON.stringify(item)])); }
function updateBackupCount() {
  const current = makeSignatures();
  const ids = new Set([...Object.keys(current), ...Object.keys(state.backupSignatures)]);
  const count = [...ids].filter((id) => current[id] !== state.backupSignatures[id]).length;
  const badge = $('#backupChangeCount'); badge.textContent = count; badge.classList.toggle('clean', count === 0); badge.title = `前回バックアップから ${count} 件変更`;
}
function normalizeFiles(files) { return Array.isArray(files) ? files.map((file) => ({ name: String(file.name ?? '').trim(), memo: String(file.memo ?? '').trim() })).filter((file) => file.name || file.memo) : []; }
function fileSearchText(item) { return normalizeFiles(item.files).flatMap((file) => [file.name, file.memo]).join(' '); }
function readFileRows() { return [...document.querySelectorAll('#fileRows .file-row')].map((row) => ({ name: row.querySelector('.file-name-input').value.trim(), memo: row.querySelector('.file-memo-input').value.trim() })).filter((file) => file.name || file.memo); }
function addFileRow(file = {}) { const row = document.createElement('div'); row.className = 'file-row'; row.innerHTML = '<input class="file-name-input" maxlength="160" placeholder="ファイル名" /><input class="file-memo-input" maxlength="240" placeholder="ファイルメモ" /><button class="remove-file-button" type="button" aria-label="ファイル行を削除">×</button>'; row.querySelector('.file-name-input').value = file.name ?? ''; row.querySelector('.file-memo-input').value = file.memo ?? ''; row.querySelector('.remove-file-button').onclick = () => row.remove(); $('#fileRows').append(row); }
function renderFileRows(files = []) { $('#fileRows').replaceChildren(); const normalized = normalizeFiles(files); (normalized.length ? normalized : [{}]).forEach(addFileRow); }
function createFileList(item) { const files = normalizeFiles(item.files); const wrap = document.createElement('div'); wrap.className = 'folder-file-list'; if (!files.length) { wrap.innerHTML = '<p class="file-list-empty">登録されたファイルはありません。編集画面からファイルリストを追加できます。</p>'; return wrap; } files.forEach((file) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'file-list-item'; const name = document.createElement('span'); name.className = 'file-list-name'; name.textContent = file.name || '（ファイル名なし）'; const memo = document.createElement('span'); memo.className = 'file-list-memo'; memo.textContent = file.memo; button.append(name, memo); button.onclick = async (event) => { event.stopPropagation(); await navigator.clipboard.writeText(file.name); showToast('ファイル名をコピーしました'); }; wrap.append(button); }); return wrap; }
function backupFilename(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `backup-ext_FolderPathMemo_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function render() {
  const tags = [...new Set(state.items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, 'ja'));
  $('#tagFilters').replaceChildren(...tags.map((tag) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-chip${state.tag === tag ? ' active' : ''}`;
    button.textContent = `# ${tag}`;
    button.onclick = () => { state.tag = state.tag === tag ? '' : tag; render(); };
    return button;
  }));
  $('#allCount').textContent = state.items.length;
  $('#favoriteCount').textContent = state.items.filter((item) => item.favorite).length;
  $('#historyCount').textContent = state.items.filter((item) => item.lastOpenedAt).length;

  const visible = state.items
    .filter((item) => state.view === 'all' || (state.view === 'favorite' && item.favorite) || (state.view === 'history' && item.lastOpenedAt))
    .filter((item) => !state.tag || item.tags.includes(state.tag))
    .filter((item) => fuzzyMatch([item.name, item.memo ?? '', item.path, ...item.tags, fileSearchText(item)].join(' '), state.query))
    .sort((a, b) => state.view === 'history'
      ? b.lastOpenedAt - a.lastOpenedAt
      : Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);

  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="empty-icon">📁</div><h2>${state.items.length ? '条件に合うフォルダーがありません' : '最初のフォルダーを登録しましょう'}</h2><p>${state.items.length ? '検索条件やタグを変更してみてください。' : 'よく使うパスをまとめて、探す時間を短縮できます。'}</p>`;
    if (!state.items.length) {
      const button = document.createElement('button'); button.className = 'primary-button'; button.textContent = '＋ フォルダーを登録'; button.onclick = () => openEditor(); empty.append(button);
    }
    list.append(empty); return;
  }
  visible.forEach((item) => list.append(createCard(item)));
}

function createCard(item) {
  const card = $('#itemTemplate').content.firstElementChild.cloneNode(true);
  card.querySelector('h3').textContent = item.name;
  card.querySelector('.path-value').textContent = item.path;
  card.querySelector('.path-memo').textContent = item.memo ?? '';
  card.querySelector('.path-main').append(createFileList(item));
  const favorite = card.querySelector('.favorite-button');
  favorite.classList.toggle('active', item.favorite);
  card.querySelector('.card-tags').replaceChildren(...item.tags.slice(0, 3).map((tag) => { const el = document.createElement('span'); el.textContent = tag; return el; }));
  favorite.onclick = async () => { item.favorite = !item.favorite; item.updatedAt = Date.now(); await persist(); render(); };
  const copy = async () => { await navigator.clipboard.writeText(item.path); showToast('パスをコピーしました'); };
  card.querySelector('.copy-button').onclick = copy;
  card.querySelector('.path-value').onclick = copy;
  card.querySelector('.open-button').onclick = (event) => { event.stopPropagation(); openFolder(item); };
  card.querySelector('.more-button').onclick = (event) => { event.stopPropagation(); card.querySelector('.card-menu').classList.toggle('open'); };
  card.querySelector('.edit-button').onclick = () => openEditor(item);
  card.querySelector('.delete-button').onclick = async () => {
    if (!confirm(`「${item.name}」を削除しますか？`)) return;
    state.items = state.items.filter(({ id }) => id !== item.id); await persist(); render(); showToast('削除しました');
  };
  card.onclick = (event) => {
    if (event.target.closest('button, .card-menu')) return;
    card.classList.toggle('show-files');
  };
  card.ondblclick = (event) => {
    if (event.target.closest('button, .card-menu')) return;
    event.preventDefault();
    clearTimeout(card.openTimer);
    openEditor(item);
  };
  card.onkeydown = (event) => {
    if (event.key === 'Enter') card.classList.toggle('show-files');
  };
  return card;
}

async function openFolder(item) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'open_folder', path: item.path });
    if (!response?.ok) throw new Error(response?.error || 'ネイティブホストを起動できません。');
    item.lastOpenedAt = Date.now();
    item.openCount = (item.openCount ?? 0) + 1;
    await persist();
    render();
    showToast(response.openedInTab ? 'エクスプローラーの新しいタブで開きました' : 'エクスプローラーで開きました');
  } catch (error) {
    await navigator.clipboard.writeText(item.path);
    showToast('パスをコピーしました。連携設定を確認してください');
    $('#setupDialog').showModal();
    console.warn('FolderPath native host:', error);
  }
}

function openEditor(item) {
  $('#dialogTitle').textContent = item ? 'フォルダーを編集' : 'フォルダーを登録';
  $('#itemId').value = item?.id ?? '';
  nameAutoFill = !item;
  $('#nameInput').value = item?.name ?? '';
  $('#pathInput').value = item?.path ?? '';
  $('#memoInput').value = item?.memo ?? '';
  $('#tagsInput').value = item?.tags.join(', ') ?? '';
  $('#favoriteInput').checked = item?.favorite ?? false;
  renderFileRows(item?.files);
  syncNameFromPath();
  dialog.showModal();
  (item ? $('#nameInput') : $('#pathInput')).focus();
}

$('#pathForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#itemId').value;
  const existing = state.items.find((item) => item.id === id);
  const path = $('#pathInput').value.trim();
  const derivedName = deriveFolderName(path);
  const item = {
    id: id || crypto.randomUUID(), name: $('#nameInput').value.trim() || derivedName, path,
    memo: $('#memoInput').value.trim(),
    tags: [...new Set($('#tagsInput').value.split(',').map((tag) => tag.trim()).filter(Boolean))],
    favorite: $('#favoriteInput').checked, files: readFileRows(), updatedAt: Date.now()
  };
  if (existing) Object.assign(existing, item); else state.items.push(item);
  await persist(); dialog.close(); render(); showToast(existing ? '更新しました' : '登録しました');
});

$('#addButton').onclick = () => openEditor(); $('#addFileButton').onclick = () => addFileRow();
$('#nameInput').oninput = () => { nameAutoFill = $('#nameInput').value.trim() === deriveFolderName($('#pathInput').value); };
$('#pathInput').oninput = syncNameFromPath;
$('#libraryButton').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
$('#closeDialog').onclick = $('#cancelButton').onclick = () => dialog.close();
$('#searchInput').oninput = (event) => { state.query = event.target.value; render(); };
document.querySelectorAll('.view-tab').forEach((button) => button.onclick = () => {
  state.view = button.dataset.view; document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab === button)); render();
});
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });
document.addEventListener('click', () => document.querySelectorAll('.card-menu.open').forEach((menu) => menu.classList.remove('open')));
$('#closeSetupDialog').onclick = () => $('#setupDialog').close();
$('#copySetupCommand').onclick = async () => {
  const command = `powershell -ExecutionPolicy Bypass -File .\\native-host\\install.ps1 -ExtensionId ${chrome.runtime.id}`;
  await navigator.clipboard.writeText(command);
  showToast('セットアップコマンドをコピーしました');
};

$('#exportButton').onclick = async () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = backupFilename(); link.click(); URL.revokeObjectURL(link.href);
  state.backupSignatures = makeSignatures(); await storage.set({ folderPathBackupState: state.backupSignatures }); updateBackupCount(); showToast('バックアップを作成しました');
};
$('#importButton').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (event) => {
  try {
    const data = JSON.parse(await event.target.files[0].text());
    if (!Array.isArray(data.items) || data.items.some((item) => typeof item.name !== 'string' || typeof item.path !== 'string')) throw new Error('invalid');
    state.items = data.items.map((item) => ({ id: item.id || crypto.randomUUID(), name: item.name, path: item.path, memo: typeof item.memo === 'string' ? item.memo : '', tags: Array.isArray(item.tags) ? item.tags : [], favorite: Boolean(item.favorite), updatedAt: Number(item.updatedAt) || Date.now(), files: normalizeFiles(item.files), lastOpenedAt: Number(item.lastOpenedAt) || 0, openCount: Number(item.openCount) || 0 }));
    await persist(); render(); showToast(`${state.items.length}件を復元しました`);
  } catch { showToast('バックアップファイルを読み込めませんでした'); }
  event.target.value = '';
};

(async () => { const saved = await storage.get(['folderPaths', 'folderPathBackupState']); state.items = Array.isArray(saved.folderPaths) ? saved.folderPaths : []; state.backupSignatures = saved.folderPathBackupState && typeof saved.folderPathBackupState === 'object' ? saved.folderPathBackupState : {}; render(); updateBackupCount(); })();
