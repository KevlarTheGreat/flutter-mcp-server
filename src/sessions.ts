/**
 * SessionManager — registry of active Flutter daemon sessions.
 *
 * A session is created by `flutter_start` and lives until the process exits
 * or `flutter_stop` is called.  Keyed by normalized project path.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { FlutterDaemon } from './daemon.js';
import { VmServiceClient } from './vm-service.js';

export type SessionStatus =
  | 'starting'   // process launched, waiting for app.start
  | 'running'    // app.started received
  | 'reloading'  // hot reload in flight
  | 'restarting' // hot restart in flight
  | 'stopping'   // app.stop sent
  | 'stopped';   // process exited

export interface Session {
  id: string;           // == normalised projectPath
  projectPath: string;
  device: string | null;
  appId: string | null;
  wsUri: string | null;
  status: SessionStatus;
  startedAt: Date;
  lastReloadAt: Date | null;
  lastRestartAt: Date | null;
  daemon: FlutterDaemon;
}

export interface StartOptions {
  projectPath: string;
  device?: string;         // e.g. 'windows', 'chrome', '<deviceId>'
  additionalArgs?: string[]; // e.g. ['--flavor', 'dev']
  /** ms to wait for app.started before timing out. Default 120 000. */
  startTimeoutMs?: number;
}

export interface ReloadResult {
  code: number;
  message: string;
  durationMs: number;
  frameScheduled: boolean;
  frameStrategy: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalisePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

// ── SessionManager ────────────────────────────────────────────────────────────

export class SessionManager {
  private _sessions = new Map<string, Session>();

  // ── Session lookup ───────────────────────────────────────────────────────

  all(): Session[] {
    return [...this._sessions.values()];
  }

  get(projectPath: string): Session | undefined {
    return this._sessions.get(normalisePath(projectPath));
  }

  /** Resolve a session: by explicit path, or the only running session. */
  resolve(projectPath?: string): Session {
    if (projectPath) {
      const s = this.get(projectPath);
      if (!s) throw new Error(`No active session for project: ${projectPath}`);
      return s;
    }
    const alive = this.all().filter((s) => s.status !== 'stopped');
    if (alive.length === 0) throw new Error('No active Flutter session. Run flutter_start first.');
    if (alive.length > 1) {
      throw new Error(
        `Multiple active sessions — specify projectPath:\n` +
        alive.map((s) => `  ${s.projectPath}`).join('\n'),
      );
    }
    return alive[0];
  }

  // ── Start ────────────────────────────────────────────────────────────────

  async start(opts: StartOptions): Promise<Session> {
    const projectPath = normalisePath(opts.projectPath);

    if (!fs.existsSync(path.join(projectPath, 'pubspec.yaml'))) {
      throw new Error(`Not a Flutter project (no pubspec.yaml): ${projectPath}`);
    }

    // Terminate any existing session for this path
    const existing = this._sessions.get(projectPath);
    if (existing && existing.status !== 'stopped') {
      await this._stopSession(existing);
    }

    const args: string[] = [];
    if (opts.device) args.push('-d', opts.device);
    if (opts.additionalArgs) args.push(...opts.additionalArgs);

    const daemon = new FlutterDaemon(projectPath, args);

    const session: Session = {
      id: projectPath,
      projectPath,
      device: opts.device ?? null,
      appId: null,
      wsUri: null,
      status: 'starting',
      startedAt: new Date(),
      lastReloadAt: null,
      lastRestartAt: null,
      daemon,
    };
    this._sessions.set(projectPath, session);

    // Wire up daemon events
    daemon.on(`event:app.start`, (params: Record<string, unknown>) => {
      session.appId = (params?.appId as string) ?? null;
      const deviceId = (params?.deviceId as string) ?? null;
      if (deviceId) session.device = deviceId;
    });

    daemon.on(`event:app.debugPort`, (params: Record<string, unknown>) => {
      session.wsUri = (params?.wsUri as string) ?? null;
    });

    daemon.on(`event:app.started`, () => {
      session.status = 'running';
    });

    daemon.on('exit', () => {
      session.status = 'stopped';
    });

    // Wait for app.started (or timeout)
    await this._waitForStarted(session, opts.startTimeoutMs ?? 120_000);
    return session;
  }

  // ── Hot Reload ───────────────────────────────────────────────────────────

  async hotReload(projectPath?: string, appExtPrefix?: string): Promise<ReloadResult> {
    const session = this.resolve(projectPath);
    if (!session.appId) throw new Error('Session has no appId yet — app may still be starting.');
    if (session.status !== 'running') throw new Error(`Cannot reload in state: ${session.status}`);

    session.status = 'reloading';
    const t0 = Date.now();
    try {
      const result = await session.daemon.send('app.restart', {
        appId: session.appId,
        fullRestart: false,
        reason: 'manual',
        pause: false,
      }) as { code: number; message: string } | null;

      session.lastReloadAt = new Date();
      session.status = 'running';

      const durationMs = Date.now() - t0;
      const { frameScheduled, strategy } = await this._scheduleFrame(session, appExtPrefix);

      return {
        code: result?.code ?? 0,
        message: result?.message ?? 'Hot reload complete',
        durationMs,
        frameScheduled,
        frameStrategy: strategy,
      };
    } catch (e) {
      session.status = 'running';
      throw e;
    }
  }

  // ── Hot Restart ──────────────────────────────────────────────────────────

  async hotRestart(projectPath?: string, appExtPrefix?: string): Promise<ReloadResult> {
    const session = this.resolve(projectPath);
    if (!session.appId) throw new Error('Session has no appId yet.');
    if (session.status !== 'running') throw new Error(`Cannot restart in state: ${session.status}`);

    session.status = 'restarting';
    const t0 = Date.now();
    try {
      const result = await session.daemon.send('app.restart', {
        appId: session.appId,
        fullRestart: true,
        reason: 'manual',
        pause: false,
      }, 90_000) as { code: number; message: string } | null;

      session.lastRestartAt = new Date();

      // After full restart the Dart VM gets a new debug port — invalidate and wait
      session.wsUri = null;
      await this._waitForDebugPort(session, 15_000);

      session.status = 'running';

      const durationMs = Date.now() - t0;
      const { frameScheduled, strategy } = await this._scheduleFrame(session, appExtPrefix);

      return {
        code: result?.code ?? 0,
        message: result?.message ?? 'Hot restart complete',
        durationMs,
        frameScheduled,
        frameStrategy: strategy,
      };
    } catch (e) {
      session.status = 'running';
      throw e;
    }
  }

  // ── Stop ─────────────────────────────────────────────────────────────────

  async stop(projectPath?: string): Promise<void> {
    const session = this.resolve(projectPath);
    await this._stopSession(session);
  }

  // ── List devices ─────────────────────────────────────────────────────────

  async listDevices(): Promise<object[]> {
    return new Promise((resolve, reject) => {
      let output = '';
      const proc = spawn('flutter', ['devices', '--machine'], {
        windowsHide: true,
      });
      proc.stdout.on('data', (d: Buffer) => (output += d.toString()));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`flutter devices exited with code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(output.trim()) as object[]);
        } catch {
          // flutter devices output sometimes has log lines before the JSON
          const jsonStart = output.indexOf('[');
          if (jsonStart >= 0) {
            try {
              resolve(JSON.parse(output.slice(jsonStart)) as object[]);
              return;
            } catch { /* fall through */ }
          }
          reject(new Error(`Could not parse flutter devices output: ${output.slice(0, 200)}`));
        }
      });
      proc.on('error', reject);
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _waitForStarted(session: Session, timeoutMs: number): Promise<void> {
    if (session.status === 'running') return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`flutter_start timed out after ${timeoutMs}ms. Check pubspec / device selection.`));
      }, timeoutMs);

      const onStarted = () => { cleanup(); resolve(); };
      const onExit = (code: number | null) => {
        cleanup();
        const stderr = session.daemon.stderr.slice(-20).join('\n');
        reject(new Error(`Flutter process exited (code ${code}) before app started.\n${stderr}`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.daemon.off('event:app.started', onStarted);
        session.daemon.off('exit', onExit);
      };

      session.daemon.once('event:app.started', onStarted);
      session.daemon.once('exit', onExit);
    });
  }

  private _waitForDebugPort(session: Session, timeoutMs: number): Promise<void> {
    if (session.wsUri) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs); // resolve anyway on timeout
      const handler = () => { clearTimeout(timer); resolve(); };
      session.daemon.once('event:app.debugPort', handler);
    });
  }

  private async _scheduleFrame(
    session: Session,
    appExtPrefix?: string,
  ): Promise<{ frameScheduled: boolean; strategy: string | null }> {
    const wsUri = session.wsUri;
    if (!wsUri) return { frameScheduled: false, strategy: null };

    let vm: VmServiceClient | null = null;
    try {
      vm = await VmServiceClient.connect(wsUri, 3_000);
      const strategy = await vm.forceFrame(appExtPrefix);
      return { frameScheduled: strategy !== null, strategy };
    } catch {
      return { frameScheduled: false, strategy: null };
    } finally {
      vm?.close();
    }
  }

  private async _stopSession(session: Session): Promise<void> {
    if (session.status === 'stopped') return;
    session.status = 'stopping';
    try {
      if (session.appId) {
        await session.daemon.send('app.stop', { appId: session.appId }, 5_000).catch(() => null);
      }
    } finally {
      session.daemon.kill();
      session.status = 'stopped';
    }
  }
}
