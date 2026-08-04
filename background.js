const NATIVE_HOST = 'jp.folderpath.memo';

function createActionIcon(size) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  const scale = size / 128;
  context.scale(scale, scale);

  context.fillStyle = '#2764e7';
  context.beginPath();
  context.roundRect(8, 8, 112, 112, 30);
  context.fill();
  context.fillStyle = '#ffbe3d';
  context.beginPath();
  context.arc(101, 27, 10, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#fff';
  context.lineWidth = 7;
  context.lineJoin = 'round';
  context.strokeRect(27, 48, 74, 51);
  context.fillStyle = '#fff';
  context.font = 'bold 46px Arial';
  context.fillText('F', 45, 89);
  return context.getImageData(0, 0, size, size);
}

async function applyActionIcon() {
  try {
    await chrome.action.setIcon({ imageData: { 16: createActionIcon(16), 32: createActionIcon(32) } });
  } catch (error) {
    console.warn('FolderPath action icon:', error);
  }
}

chrome.runtime.onInstalled.addListener(applyActionIcon);
chrome.runtime.onStartup.addListener(applyActionIcon);
applyActionIcon();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'open_folder') return false;

  chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open', path: message.path }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      sendResponse({ ok: false, error: error.message });
      return;
    }
    sendResponse(response ?? { ok: false, error: 'ネイティブホストから応答がありません。' });
  });
  return true;
});
