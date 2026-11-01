// E2Eテスト用の中継（pom-bridge）で、Tauri の内部 API（window.__TAURI_INTERNALS__）の代役をする。
// @tauri-apps/api の invoke・listen が使う部分だけを用意し、HTTP（/invoke/<command>）と Server-Sent Events（/events）へ中継する。
(() => {
  'use strict';
  const callbacks = new Map();
  const listeners = [];
  let next = 1;
  const internals = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(path, protocol = 'asset') { return `${protocol}://localhost/${encodeURIComponent(path)}`; },
    async invoke(command, args = {}) {
      if (command === 'plugin:event|listen') { const eventId = next++; listeners.push({ event: args.event, handler: args.handler, eventId }); return eventId; }
      if (command === 'plugin:event|unlisten') { const index = listeners.findIndex(l => l.event === args.event && l.eventId === args.eventId); if (index >= 0) listeners.splice(index, 1); return null; }
      const response = await fetch(`/invoke/${encodeURIComponent(command)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const body = await response.json();
      if ('err' in body) throw body.err;
      return body.ok;
    },
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals });
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener(event, eventId) { const index = listeners.findIndex(l => l.event === event && l.eventId === eventId); if (index >= 0) listeners.splice(index, 1); } } });
  const source = new EventSource('/events');
  source.onmessage = message => {
    const { event, payload } = JSON.parse(message.data);
    for (const listener of [...listeners]) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: listener.eventId, payload });
  };
})();
