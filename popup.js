const storage = globalThis.chrome?.storage?.local ?? {
  async get(key) { return { [key]: JSON.parse(localStorage.getItem(key) || '[]') }; },
  async set(value) { Object.entries(value).forEach(([key, data]) => localStorage.setItem(key, JSON.stringify(data))); }
};

const state = { items: [], query: '', view: 'all', tag: '' };
const $ = (selector) => document.querySelector(selector);
const list = $('#list');
const dialog = $('#pathDialog');

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
  $('#statusText').textContent = 'すべての変更を保存しました';
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

  const visible = state.items
    .filter((item) => state.view === 'all' || item.favorite)
    .filter((item) => !state.tag || item.tags.includes(state.tag))
    .filter((item) => fuzzyMatch([item.name, item.memo ?? '', item.path, ...item.tags].join(' '), state.query))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);

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
  const favorite = card.querySelector('.favorite-button');
  favorite.classList.toggle('active', item.favorite);
  card.querySelector('.card-tags').replaceChildren(...item.tags.slice(0, 3).map((tag) => { const el = document.createElement('span'); el.textContent = tag; return el; }));
  favorite.onclick = async () => { item.favorite = !item.favorite; item.updatedAt = Date.now(); await persist(); render(); };
  const copy = async () => { await navigator.clipboard.writeText(item.path); showToast('パスをコピーしました'); };
  card.querySelector('.copy-button').onclick = copy;
  card.querySelector('.path-value').onclick = copy;
  card.querySelector('.open-button').onclick = () => openFolder(item.path);
  card.querySelector('.more-button').onclick = (event) => { event.stopPropagation(); card.querySelector('.card-menu').classList.toggle('open'); };
  card.querySelector('.edit-button').onclick = () => openEditor(item);
  card.querySelector('.delete-button').onclick = async () => {
    if (!confirm(`「${item.name}」を削除しますか？`)) return;
    state.items = state.items.filter(({ id }) => id !== item.id); await persist(); render(); showToast('削除しました');
  };
  return card;
}

async function openFolder(path) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'open_folder', path });
    if (!response?.ok) throw new Error(response?.error || 'ネイティブホストを起動できません。');
    showToast('デスクトップ版エクスプローラーで開きました');
  } catch (error) {
    await navigator.clipboard.writeText(path);
    showToast('連携機能が未設定です。パスをコピーしました');
    console.warn('FolderPath native host:', error);
  }
}

function openEditor(item) {
  $('#dialogTitle').textContent = item ? 'フォルダーを編集' : 'フォルダーを登録';
  $('#itemId').value = item?.id ?? '';
  $('#nameInput').value = item?.name ?? '';
  $('#pathInput').value = item?.path ?? '';
  $('#memoInput').value = item?.memo ?? '';
  $('#tagsInput').value = item?.tags.join(', ') ?? '';
  $('#favoriteInput').checked = item?.favorite ?? false;
  dialog.showModal();
  $('#nameInput').focus();
}

$('#pathForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#itemId').value;
  const existing = state.items.find((item) => item.id === id);
  const path = $('#pathInput').value.trim();
  const derivedName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  const item = {
    id: id || crypto.randomUUID(), name: $('#nameInput').value.trim() || derivedName, path,
    memo: $('#memoInput').value.trim(),
    tags: [...new Set($('#tagsInput').value.split(',').map((tag) => tag.trim()).filter(Boolean))],
    favorite: $('#favoriteInput').checked, updatedAt: Date.now()
  };
  if (existing) Object.assign(existing, item); else state.items.push(item);
  await persist(); dialog.close(); render(); showToast(existing ? '更新しました' : '登録しました');
});

$('#addButton').onclick = () => openEditor();
$('#closeDialog').onclick = $('#cancelButton').onclick = () => dialog.close();
$('#searchInput').oninput = (event) => { state.query = event.target.value; render(); };
document.querySelectorAll('.view-tab').forEach((button) => button.onclick = () => {
  state.view = button.dataset.view; document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab === button)); render();
});
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });
document.addEventListener('click', () => document.querySelectorAll('.card-menu.open').forEach((menu) => menu.classList.remove('open')));

$('#exportButton').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `folderpath-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('バックアップを作成しました');
};
$('#importButton').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (event) => {
  try {
    const data = JSON.parse(await event.target.files[0].text());
    if (!Array.isArray(data.items) || data.items.some((item) => typeof item.name !== 'string' || typeof item.path !== 'string')) throw new Error('invalid');
    state.items = data.items.map((item) => ({ id: item.id || crypto.randomUUID(), name: item.name, path: item.path, memo: typeof item.memo === 'string' ? item.memo : '', tags: Array.isArray(item.tags) ? item.tags : [], favorite: Boolean(item.favorite), updatedAt: Number(item.updatedAt) || Date.now() }));
    await persist(); render(); showToast(`${state.items.length}件を復元しました`);
  } catch { showToast('バックアップファイルを読み込めませんでした'); }
  event.target.value = '';
};

(async () => { const saved = await storage.get('folderPaths'); state.items = Array.isArray(saved.folderPaths) ? saved.folderPaths : []; render(); })();
