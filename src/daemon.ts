/**
 * FlutterDaemon — wraps a single `flutter run --machine` process.
 *
 * Wire format:  each line is a JSON array.
 *   Events   → [{ "event": "app.start", "params": { ... } }]
 *   Responses → [{ "id": "1", "result": { ... } }]
 *              or [{ "id": "1", "error": { "code": -32000, "message": "..." } }]
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export interface DaemonEvent {
  event: string;
  params?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/** Maximum lines kept in the in-memory log ring buffer. */
const LOG_RING_SIZE = 500;

export class FlutterDaemon extends EventEmitter {
  private proc: ChildProcess;
  private _nextId = 1;
  private _pending = new Map<string, Pending>();
  private _logRing: string[] = [];
  private _stderrRing: string[] = [];
  private _dead = false;
  private _exitCode: number | null = null;

  constructor(
    public readonly projectPath: string,
    extraArgs: string[] = [],
  ) {
    super();

    this.proc = spawn('flutter', ['run', '--machine', ...extraArgs], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // ── stdout — daemon wire protocol ──────────────────────────────────────
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this._handleLine(line));

    // ── stderr — app debug output / progress messages ──────────────────────
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this._stderrRing.push(line);
          if (this._stderrRing.length > LOG_RING_SIZE) this._stderrRing.shift();
          this.emit('stderr', line);
        }
      }
    });

    // ── process exit ────────────────────────────────────────────────────────
    this.proc.on('exit', (code) => {
      this._dead = true;
      this._exitCode = code;
      // Reject any outstanding requests
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Flutter process exited'));
      }
      this._pending.clear();
      this.emit('exit', code);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isAlive() { return !this._dead; }
  get exitCode() { return this._exitCode; }
  get pid() { return this.proc.pid; }

  /** Logs captured from app.log daemon events. */
  get logs() { return [...this._logRing]; }

  /** Raw stderr (flutter build output, compilation errors, etc.). */
  get stderr() { return [...this._stderrRing]; }

  /**
   * Send a daemon method call and wait for the response.
   * Rejects after `timeoutMs` (default 60 s).
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    if (this._dead) return Promise.reject(new Error('Flutter process is not running'));

    return new Promise((resolve, reject) => {
      const id = String(this._nextId++);
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} [id=${id}]`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      const frame = JSON.stringify([{ id, method, params }]) + '\r\n';
      this.proc.stdin!.write(frame);
    });
  }

  /** Kill the flutter process immediately. */
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (!this._dead) this.proc.kill(signal);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _handleLine(raw: string) {
    const line = raw.trim();
    if (!line.startsWith('[')) {
      // Not a daemon protocol line — could be startup/build output
      this.emit('rawLine', line);
      return;
    }

    let parsed: Array<DaemonEvent | DaemonResponse>;
    try {
      parsed = JSON.parse(line) as Array<DaemonEvent | DaemonResponse>;
    } catch {
      this.emit('rawLine', line);
      return;
    }

    for (const msg of parsed) {
      if ('event' in msg) {
        const ev = msg as DaemonEvent;

        // Capture app.log entries into ring buffer
        if (ev.event === 'app.log') {
          const text = (ev.params?.log as string | undefined) ?? '';
          this._logRing.push(text);
          if (this._logRing.length > LOG_RING_SIZE) this._logRing.shift();
        }

        this.emit('event', ev);
        this.emit(`event:${ev.event}`, ev.params);
      } else if ('id' in msg) {
        const res = msg as DaemonResponse;
        const pending = this._pending.get(res.id);
        if (pending) {
          this._pending.delete(res.id);
          clearTimeout(pending.timer);
          if (res.error) {
            pending.reject(new Error(`Daemon error [${res.error.code}]: ${res.error.message}`));
          } else {
            pending.resolve(res.result);
          }
        }
      }
    }
  }
}
