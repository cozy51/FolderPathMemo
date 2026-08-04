const state = { items: [], query: '', view: 'all' };
const $ = (selector) => document.querySelector(selector);

function fuzzyMatch(text, query) {
  const source = text.toLocaleLowerCase();
  let index = 0;
  for (const char of query.trim().toLocaleLowerCase()) {
    index = source.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
}

async function persist() { await chrome.storage.local.set({ folderPaths: state.items }); }

async function openFolder(item) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'open_folder', path: item.path });
    if (!response?.ok) throw new Error(response?.error);
    item.lastOpenedAt = Date.now(); item.openCount = (item.openCount ?? 0) + 1; await persist(); render();
    showToast(response.openedInTab ? '新しいタブで開きました' : 'エクスプローラーで開きました');
  } catch {
    await navigator.clipboard.writeText(item.path); showToast('連携できないためパスをコピーしました');
  }
}

function cell(className, text = '') { const element = document.createElement('td'); element.className = className; element.textContent = text; return element; }

function render() {
  const visible = state.items.filter((item) => state.view === 'all' || (state.view === 'favorite' && item.favorite) || (state.view === 'history' && item.lastOpenedAt))
    .filter((item) => fuzzyMatch([item.name, item.memo ?? '', item.path, ...(item.tags ?? [])].join(' '), state.query))
    .sort((a, b) => state.view === 'history' ? b.lastOpenedAt - a.lastOpenedAt : Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'ja'));
  $('#visibleCount').textContent = visible.length; $('#tableBody').replaceChildren(); $('#emptyState').hidden = visible.length > 0;
  visible.forEach((item) => {
    const row = document.createElement('tr'); row.title = 'クリックで開く';
    row.append(cell('star', item.favorite ? '★' : ''));
    const info = cell('info'); const name = document.createElement('div'); name.className = 'folder-name'; name.textContent = item.name; info.append(name);
    if (item.memo) { const memo = document.createElement('div'); memo.className = 'memo'; memo.textContent = item.memo; info.append(memo); } row.append(info);
    const tags = cell('tags'); (item.tags ?? []).slice(0, 4).forEach((tag) => { const badge = document.createElement('span'); badge.className = 'tag'; badge.textContent = tag; tags.append(badge); }); row.append(tags);
    row.append(cell('path', item.path));
    const actions = cell('actions'); const copy = document.createElement('button'); copy.textContent = 'コピー'; copy.onclick = async (event) => { event.stopPropagation(); await navigator.clipboard.writeText(item.path); showToast('コピーしました'); };
    const open = document.createElement('button'); open.className = 'open'; open.textContent = '開く'; open.onclick = (event) => { event.stopPropagation(); openFolder(item); }; actions.append(copy, open); row.append(actions);
    row.onclick = () => openFolder(item); $('#tableBody').append(row);
  });
}

$('#searchInput').oninput = (event) => { state.query = event.target.value; render(); };
$('#viewSelect').onchange = (event) => { state.view = event.target.value; render(); };
(async () => { const saved = await chrome.storage.local.get('folderPaths'); state.items = Array.isArray(saved.folderPaths) ? saved.folderPaths : []; render(); })();
