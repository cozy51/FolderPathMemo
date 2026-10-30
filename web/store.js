// 拡張機能の chrome.storage.local と同じ使い方ができる、localStorage の保存先。
// 変更は onStoreChanged で受け取れる（Driveの自動同期やボタン表示の更新に使う）。
const STORE_EVENT = 'folderpathmemo-store';
const store = {
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.flatMap((name) => {
      const text = localStorage.getItem(name);
      return text === null ? [] : [[name, JSON.parse(text)]];
    }));
  },
  async set(values) {
    const changes = Object.fromEntries(Object.entries(values).map(([name, value]) => {
      localStorage.setItem(name, JSON.stringify(value));
      return [name, { newValue: value }];
    }));
    window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: changes }));
  },
  async remove(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    names.forEach((name) => localStorage.removeItem(name));
    window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: Object.fromEntries(names.map((name) => [name, { newValue: undefined }])) }));
  }
};
function onStoreChanged(listener) {
  window.addEventListener(STORE_EVENT, (event) => listener(event.detail));
}
