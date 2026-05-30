/**
 * FlutterDaemon — wraps a single `flutter run --machine` process.
 *
 * Wire format: each line is a JSON array.
 *   Events    → [{ "event": "app.start", "params": { ... } }]
 *   Responses → [{ "id": "1", "result": { ... } }]
 *              or [{ "id": "1", "error": { "code": -32000, "message": "..." } }]
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { buildSpawnEnv } from './env.js';

const LOG_RING_SIZE = 500;

export class FlutterDaemon extends EventEmitter {
  constructor(projectPath, extraArgs = []) {
    super();
    this.projectPath = projectPath;
    this._nextId = 1;
    this._pending = new Map();
    this._logRing = [];
    this._stderrRing = [];
    this._dead = false;
    this._exitCode = null;

    // On Windows `flutter` is flutter.bat; spawn needs a shell to launch
    // .bat/.cmd files (Node blocks direct .bat execution since CVE-2024-27980).
    this.proc = spawn('flutter', ['run', '--machine', ...extraArgs], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: buildSpawnEnv(),
    });

    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._handleLine(line));

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this._stderrRing.push(line);
          if (this._stderrRing.length > LOG_RING_SIZE) this._stderrRing.shift();
          this.emit('stderr', line);
        }
      }
    });

    this.proc.on('exit', (code) => {
      this._dead = true;
      this._exitCode = code;
      for (const p of this._pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Flutter process exited'));
      }
      this._pending.clear();
      this.emit('exit', code);
    });
  }

  get isAlive() { return !this._dead; }
  get exitCode() { return this._exitCode; }
  get pid() { return this.proc.pid; }
  get logs() { return [...this._logRing]; }
  get stderr() { return [...this._stderrRing]; }

  send(method, params = {}, timeoutMs = 60_000) {
    if (this._dead) return Promise.reject(new Error('Flutter process is not running'));

    return new Promise((resolve, reject) => {
      const id = String(this._nextId++);
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} [id=${id}]`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });
      const frame = JSON.stringify([{ id, method, params }]) + '\r\n';
      this.proc.stdin.write(frame);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this._dead) return;
    if (process.platform === 'win32' && this.proc.pid) {
      // this.proc is cmd.exe (shell:true) — kill the whole tree so the
      // underlying flutter/dart processes don't get orphaned.
      try {
        spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], {
          windowsHide: true,
        });
      } catch {
        this.proc.kill(signal);
      }
    } else {
      this.proc.kill(signal);
    }
  }

  _handleLine(raw) {
    const line = raw.trim();
    if (!line.startsWith('[')) {
      this.emit('rawLine', line);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('rawLine', line);
      return;
    }

    for (const msg of parsed) {
      if ('event' in msg) {
        if (msg.event === 'app.log') {
          const text = msg.params?.log ?? '';
          this._logRing.push(text);
          if (this._logRing.length > LOG_RING_SIZE) this._logRing.shift();
        }
        this.emit('event', msg);
        this.emit(`event:${msg.event}`, msg.params);
      } else if ('id' in msg) {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(`Daemon error [${msg.error.code}]: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    }
  }
}
