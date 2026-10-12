// Keep recovery outside main: import and WebGL constructor failures must leave
// a usable page, without reading or replacing the world save.
const panel = document.getElementById('launch-status')!;
function showStartupError(reason: unknown) {
  panel.hidden = false;
  panel.dataset.phase = 'error';
  document.getElementById('launch-title')!.textContent = 'Pokemon demo 未能正常启动。';
  document.getElementById('launch-message')!.textContent = '请确认本地服务仍在运行，然后重新加载。浏览器里的探索存档不会因此被清除。';
  document.getElementById('launch-error')!.textContent = reason instanceof Error ? reason.message : String(reason ?? '未知加载错误');
  document.getElementById('launch-details')!.hidden = false;
  document.getElementById('launch-retry')!.hidden = false;
}

if (location.protocol !== 'file:') {
  let failed = false;
  const fail = (reason: unknown) => { failed = true; showStartupError(reason); };
  window.addEventListener('error', event => { if (event.error) fail(event.error); });
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  void import('./main').then(() => {
    if (!failed) { panel.dataset.phase = 'ready'; panel.hidden = true; }
  }).catch(fail);
}

export {};
