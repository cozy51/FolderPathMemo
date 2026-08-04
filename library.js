const state = { items: [], query: '', view: 'all', tag: '' };
const $ = (selector) => document.querySelector(selector);
const dialog = $('#pathDialog');

function fuzzyMatch(text, query) {
  const source = text.toLocaleLowerCase(); let index = 0;
  for (const char of query.trim().toLocaleLowerCase()) { index = source.indexOf(char, index); if (index < 0) return false; index += 1; }
  return true;
}
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600); }
async function persist() { await chrome.storage.local.set({ folderPaths: state.items }); }

async function openFolder(item) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'open_folder', path: item.path });
    if (!response?.ok) throw new Error(response?.error);
    item.lastOpenedAt = Date.now(); item.openCount = (item.openCount ?? 0) + 1; await persist(); render();
    showToast(response.openedInTab ? '新しいタブで開きました' : 'エクスプローラーで開きました');
  } catch { await navigator.clipboard.writeText(item.path); showToast('連携できないためパスをコピーしました'); }
}
function openEditor(item) {
  $('#dialogTitle').textContent = item ? 'フォルダーを編集' : 'フォルダーを登録';
  $('#itemId').value = item?.id ?? ''; $('#nameInput').value = item?.name ?? ''; $('#pathInput').value = item?.path ?? '';
  $('#memoInput').value = item?.memo ?? ''; $('#tagsInput').value = item?.tags?.join(', ') ?? ''; $('#favoriteInput').checked = item?.favorite ?? false;
  dialog.showModal(); $('#nameInput').focus();
}
function cell(className, text = '') { const element = document.createElement('td'); element.className = className; element.textContent = text; return element; }

function render() {
  const allTags = [...new Set(state.items.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b, 'ja'));
  $('#tagFilters').replaceChildren(...allTags.map((tag) => { const button = document.createElement('button'); button.type = 'button'; button.className = `tag-chip${state.tag === tag ? ' active' : ''}`; button.textContent = `# ${tag}`; button.onclick = () => { state.tag = state.tag === tag ? '' : tag; render(); }; return button; }));
  $('#allCount').textContent = state.items.length; $('#favoriteCount').textContent = state.items.filter((item) => item.favorite).length; $('#historyCount').textContent = state.items.filter((item) => item.lastOpenedAt).length;
  const visible = state.items.filter((item) => state.view === 'all' || (state.view === 'favorite' && item.favorite) || (state.view === 'history' && item.lastOpenedAt))
    .filter((item) => !state.tag || item.tags?.includes(state.tag))
    .filter((item) => fuzzyMatch([item.name, item.memo ?? '', item.path, ...(item.tags ?? [])].join(' '), state.query))
    .sort((a, b) => state.view === 'history' ? b.lastOpenedAt - a.lastOpenedAt : Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'ja'));
  $('#tableBody').replaceChildren(); $('#emptyState').hidden = visible.length > 0;
  visible.forEach((item) => {
    const row = document.createElement('tr'); row.tabIndex = 0; row.title = 'クリックで開く・ダブルクリックで編集';
    const star = cell('star', item.favorite ? '★' : '☆'); star.onclick = async (event) => { event.stopPropagation(); item.favorite = !item.favorite; item.updatedAt = Date.now(); await persist(); render(); }; row.append(star);
    const info = cell('info'); const name = document.createElement('div'); name.className = 'folder-name'; name.textContent = item.name; info.append(name);
    if (item.memo) { const memo = document.createElement('div'); memo.className = 'memo'; memo.textContent = item.memo; info.append(memo); } row.append(info);
    const tags = cell('tags'); (item.tags ?? []).forEach((tag) => { const badge = document.createElement('span'); badge.className = 'tag'; badge.textContent = tag; tags.append(badge); }); row.append(tags);
    row.append(cell('path', item.path));
    const actions = cell('actions');
    const copy = document.createElement('button'); copy.textContent = 'コピー'; copy.onclick = async (event) => { event.stopPropagation(); await navigator.clipboard.writeText(item.path); showToast('コピーしました'); };
    const open = document.createElement('button'); open.className = 'open'; open.textContent = '開く'; open.onclick = (event) => { event.stopPropagation(); openFolder(item); };
    const edit = document.createElement('button'); edit.className = 'edit'; edit.textContent = '編集'; edit.onclick = (event) => { event.stopPropagation(); openEditor(item); };
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '削除'; remove.onclick = async (event) => { event.stopPropagation(); if (!confirm(`「${item.name}」を削除しますか？`)) return; state.items = state.items.filter(({ id }) => id !== item.id); await persist(); render(); showToast('削除しました'); };
    actions.append(copy, open, edit, remove); row.append(actions);
    row.onclick = (event) => { if (event.target.closest('button')) return; clearTimeout(row.openTimer); row.openTimer = setTimeout(() => openFolder(item), 400); };
    row.ondblclick = (event) => { if (event.target.closest('button')) return; event.preventDefault(); clearTimeout(row.openTimer); openEditor(item); };
    row.onkeydown = (event) => { if (event.key === 'Enter') openFolder(item); }; $('#tableBody').append(row);
  });
}

$('#pathForm').onsubmit = async (event) => {
  event.preventDefault(); const id = $('#itemId').value; const existing = state.items.find((item) => item.id === id); const path = $('#pathInput').value.trim(); const derivedName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  const item = { id: id || crypto.randomUUID(), name: $('#nameInput').value.trim() || derivedName, path, memo: $('#memoInput').value.trim(), tags: [...new Set($('#tagsInput').value.split(',').map((tag) => tag.trim()).filter(Boolean))], favorite: $('#favoriteInput').checked, updatedAt: Date.now(), lastOpenedAt: existing?.lastOpenedAt ?? 0, openCount: existing?.openCount ?? 0 };
  if (existing) Object.assign(existing, item); else state.items.push(item); await persist(); dialog.close(); render(); showToast(existing ? '更新しました' : '登録しました');
};
$('#addButton').onclick = () => openEditor(); $('#closeDialog').onclick = $('#cancelButton').onclick = () => dialog.close();
$('#searchInput').oninput = (event) => { state.query = event.target.value; render(); };
document.querySelectorAll('.view-tab').forEach((button) => button.onclick = () => { state.view = button.dataset.view; document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab === button)); render(); });
$('#exportButton').onclick = () => { const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `folderpath-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('バックアップを作成しました'); };
$('#importButton').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (event) => { try { const data = JSON.parse(await event.target.files[0].text()); if (!Array.isArray(data.items) || data.items.some((item) => typeof item.name !== 'string' || typeof item.path !== 'string')) throw new Error(); state.items = data.items.map((item) => ({ id: item.id || crypto.randomUUID(), name: item.name, path: item.path, memo: typeof item.memo === 'string' ? item.memo : '', tags: Array.isArray(item.tags) ? item.tags : [], favorite: Boolean(item.favorite), updatedAt: Number(item.updatedAt) || Date.now(), lastOpenedAt: Number(item.lastOpenedAt) || 0, openCount: Number(item.openCount) || 0 })); await persist(); render(); showToast(`${state.items.length}件を復元しました`); } catch { showToast('バックアップを読み込めませんでした'); } event.target.value = ''; };
(async () => { const saved = await chrome.storage.local.get('folderPaths'); state.items = Array.isArray(saved.folderPaths) ? saved.folderPaths : []; render(); })();
