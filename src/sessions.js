/**
 * SessionManager — registry of active Flutter daemon sessions.
 * Keyed by normalised project path.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { FlutterDaemon } from './daemon.js';
import { VmServiceClient } from './vm-service.js';
import { buildSpawnEnv } from './env.js';

function normalisePath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

export class SessionManager {
  constructor() {
    this._sessions = new Map();
  }

  all() { return [...this._sessions.values()]; }

  get(projectPath) { return this._sessions.get(normalisePath(projectPath)); }

  resolve(projectPath) {
    if (projectPath) {
      const s = this.get(projectPath);
      if (!s) throw new Error(`No active session for project: ${projectPath}`);
      return s;
    }
    const alive = this.all().filter((s) => s.status !== 'stopped');
    if (alive.length === 0) throw new Error('No active Flutter session. Run flutter_start first.');
    if (alive.length > 1) {
      throw new Error(
        'Multiple active sessions — specify projectPath:\n' +
        alive.map((s) => `  ${s.projectPath}`).join('\n')
      );
    }
    return alive[0];
  }

  async start({ projectPath, device, additionalArgs, startTimeoutMs = 120_000 }) {
    const normPath = normalisePath(projectPath);

    if (!fs.existsSync(path.join(normPath, 'pubspec.yaml'))) {
      throw new Error(`Not a Flutter project (no pubspec.yaml): ${normPath}`);
    }

    const existing = this._sessions.get(normPath);
    if (existing && existing.status !== 'stopped') {
      await this._stopSession(existing);
    }

    const args = [];
    if (device) args.push('-d', device);
    if (additionalArgs) args.push(...additionalArgs);

    const daemon = new FlutterDaemon(normPath, args);
    const session = {
      id: normPath,
      projectPath: normPath,
      device: device ?? null,
      appId: null,
      wsUri: null,
      status: 'starting',
      startedAt: new Date(),
      lastReloadAt: null,
      lastRestartAt: null,
      daemon,
    };
    this._sessions.set(normPath, session);

    daemon.on('event:app.start', (params) => {
      session.appId = params?.appId ?? null;
      const deviceId = params?.deviceId ?? null;
      if (deviceId) session.device = deviceId;
    });

    daemon.on('event:app.debugPort', (params) => {
      session.wsUri = params?.wsUri ?? null;
    });

    daemon.on('event:app.started', () => { session.status = 'running'; });
    daemon.on('exit', () => { session.status = 'stopped'; });

    // Non-blocking: a cold build can exceed the MCP client's request timeout.
    // Wait only a brief grace period to surface immediate launch failures
    // (bad path, missing toolchain, env errors). If the build is still
    // running after the grace window, return status 'starting' and let the
    // caller poll flutter_status until it becomes 'running'.
    await this._waitForStartedOrSettle(session, Math.min(startTimeoutMs, 4000));
    return session;
  }

  async hotReload(projectPath, appExtPrefix) {
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
      });
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

  async hotRestart(projectPath, appExtPrefix) {
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
      }, 90_000);

      // A daemon hot restart re-runs main() in the SAME Dart VM/isolate, so
      // the VM service URI is unchanged and no new app.debugPort fires. Keep
      // the existing wsUri — nulling it and waiting for a new port just burns
      // the timeout and leaves us unable to schedule a frame.

      session.lastRestartAt = new Date();
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

  async stop(projectPath) {
    const session = this.resolve(projectPath);
    await this._stopSession(session);
  }

  async listDevices() {
    return new Promise((resolve, reject) => {
      let output = '';
      const proc = spawn('flutter', ['devices', '--machine'], {
        windowsHide: true,
        shell: process.platform === 'win32',
        env: buildSpawnEnv(),
      });
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => {
        if (code !== 0) { reject(new Error(`flutter devices exited with code ${code}`)); return; }
        try {
          resolve(JSON.parse(output.trim()));
        } catch {
          const jsonStart = output.indexOf('[');
          if (jsonStart >= 0) {
            try { resolve(JSON.parse(output.slice(jsonStart))); return; } catch { /* fall */ }
          }
          reject(new Error(`Could not parse flutter devices output: ${output.slice(0, 200)}`));
        }
      });
      proc.on('error', reject);
    });
  }

  /**
   * Resolve when the app starts running OR after a grace window elapses
   * (leaving status 'starting'). Reject only if the process exits early
   * (within the grace window) — that's a genuine launch failure worth
   * surfacing immediately. Long builds simply return 'starting'.
   */
  _waitForStartedOrSettle(session, graceMs) {
    if (session.status === 'running') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, graceMs);

      const onStarted = () => { cleanup(); resolve(); };
      const onExit = (code) => {
        cleanup();
        const stderr = session.daemon.stderr.slice(-20).join('\n');
        reject(new Error(`Flutter process exited (code ${code}) during launch.\n${stderr}`));
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

  async _scheduleFrame(session, appExtPrefix) {
    const wsUri = session.wsUri;
    if (!wsUri) return { frameScheduled: false, strategy: null };
    let vm = null;
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

  async _stopSession(session) {
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
