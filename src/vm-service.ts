/**
 * VmServiceClient — lightweight Dart VM Service WebSocket client.
 *
 * Used after a hot reload/restart to:
 *   1. Wake the Flutter rendering thread (scheduleFrame)
 *   2. Call project-specific VM service extensions
 *   3. Introspect isolates, call evaluate(), etc.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket.
 */

import WebSocket from 'ws';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface VmInfo {
  isolates: Array<{ id: string; name: string }>;
}

export class VmServiceClient {
  private ws: WebSocket;
  private _nextId = 1;
  private _pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private _ready: Promise<void>;

  constructor(wsUri: string) {
    this.ws = new WebSocket(wsUri);

    this._ready = new Promise<void>((resolve, reject) => {
      const openHandler = () => { cleanup(); resolve(); };
      const errorHandler = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        this.ws.removeListener('open', openHandler);
        this.ws.removeListener('error', errorHandler);
      };
      this.ws.once('open', openHandler);
      this.ws.once('error', errorHandler);
    });

    this.ws.on('message', (raw) => {
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(raw.toString()) as JsonRpcResponse; } catch { return; }
      if (msg.id === undefined) return;

      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);

      if (msg.error) {
        p.reject(new Error(`VM service error [${msg.error.code}]: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    });
  }

  /** Send a JSON-RPC 2.0 call and return the result. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    await this._ready;
    return new Promise<T>((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`VM service timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);

      this._pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Returns the first (main) isolate ID. */
  async mainIsolateId(): Promise<string | null> {
    try {
      const vm = await this.call<VmInfo>('getVM');
      return vm.isolates[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Force the Flutter rendering engine to schedule a new frame.
   * Tries multiple strategies from most- to least-preferred:
   *
   *  1. ext.<appPrefix>.forceFrame  — app-specific registered extension
   *  2. ext.flutter.reassemble      — Flutter built-in, triggers full rebuild
   *  3. evaluate scheduleFrame()    — direct Dart expression eval
   *
   * Returns the name of the strategy that worked, or null if all failed.
   */
  async forceFrame(appExtensionPrefix?: string): Promise<string | null> {
    const isolateId = await this.mainIsolateId();
    if (!isolateId) return null;

    // Strategy 1 — app-specific extension (e.g. ext.reme.forceFrame)
    if (appExtensionPrefix) {
      try {
        await this.call(`ext.${appExtensionPrefix}.forceFrame`, { isolateId }, 5_000);
        return `ext.${appExtensionPrefix}.forceFrame`;
      } catch { /* try next */ }
    }

    // Strategy 2 — Flutter built-in reassemble
    try {
      await this.call('ext.flutter.reassemble', { isolateId }, 5_000);
      return 'ext.flutter.reassemble';
    } catch { /* try next */ }

    // Strategy 3 — evaluate() to call scheduleFrame directly
    try {
      await this.call('evaluate', {
        isolateId,
        expression: 'WidgetsBinding.instance.scheduleFrame()',
      }, 5_000);
      return 'evaluate:scheduleFrame';
    } catch { /* all failed */ }

    return null;
  }

  /** Call any VM service extension by full name (e.g. 'ext.flutter.debugPaint'). */
  async callExtension(extensionRpc: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const isolateId = await this.mainIsolateId();
    if (!isolateId) throw new Error('Could not determine main isolate ID');
    return this.call(extensionRpc, { isolateId, ...params });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }

  static async connect(wsUri: string, timeoutMs = 5_000): Promise<VmServiceClient> {
    const client = new VmServiceClient(wsUri);
    await Promise.race([
      client._ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`VM service connect timeout (${timeoutMs}ms): ${wsUri}`)), timeoutMs),
      ),
    ]);
    return client;
  }
}
