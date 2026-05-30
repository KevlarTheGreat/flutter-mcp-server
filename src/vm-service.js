/**
 * VmServiceClient — Dart VM Service WebSocket client.
 * Uses Node.js 22+ built-in WebSocket (no external packages).
 */

export class VmServiceClient {
  constructor(wsUri) {
    this._nextId = 1;
    this._pending = new Map();
    this.ws = new WebSocket(wsUri); // Node.js 22+ built-in

    this._ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (ev) => reject(new Error(`WS error: ${ev.message ?? wsUri}`));
    });

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === undefined) return;
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`VM [${msg.error.code}]: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    };
  }

  async call(method, params = {}, timeoutMs = 10_000) {
    await this._ready;
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`VM timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async mainIsolateId() {
    try {
      const vm = await this.call('getVM');
      return vm.isolates?.[0]?.id ?? null;
    } catch { return null; }
  }

  async forceFrame(appExtensionPrefix) {
    const isolateId = await this.mainIsolateId();
    if (!isolateId) return null;

    if (appExtensionPrefix) {
      try {
        await this.call(`ext.${appExtensionPrefix}.forceFrame`, { isolateId }, 5_000);
        return `ext.${appExtensionPrefix}.forceFrame`;
      } catch { /* try next */ }
    }
    try {
      await this.call('ext.flutter.reassemble', { isolateId }, 5_000);
      return 'ext.flutter.reassemble';
    } catch { /* try next */ }
    try {
      await this.call('evaluate', { isolateId, expression: 'WidgetsBinding.instance.scheduleFrame()' }, 5_000);
      return 'evaluate:scheduleFrame';
    } catch { /* all failed */ }
    return null;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }

  static async connect(wsUri, timeoutMs = 5_000) {
    const client = new VmServiceClient(wsUri);
    await Promise.race([
      client._ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`VM connect timeout: ${wsUri}`)), timeoutMs)
      ),
    ]);
    return client;
  }
}
