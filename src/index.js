/**
 * flutter-mcp-server — zero external dependencies.
 * Requires Node.js 22+ (built-in WebSocket).
 *
 * MCP protocol implemented directly (newline-delimited JSON-RPC 2.0 over stdio).
 * No npm install needed — just: node src/index.js
 */

import { createInterface } from 'node:readline';
import { SessionManager } from './sessions.js';
import { VmServiceClient } from './vm-service.js';

// ── Startup check ─────────────────────────────────────────────────────────────

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`flutter-mcp-server requires Node.js 22+. You have ${process.versions.node}\n`);
  process.exit(1);
}

const sessions = new SessionManager();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'flutter_start',
    description: 'Start a Flutter app with `flutter run --machine`. Waits for the app to finish launching. Must be called before hot_reload/hot_restart.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the Flutter project (must contain pubspec.yaml).' },
        device: { type: 'string', description: 'Device/platform to target (e.g. "windows", "chrome", or a device ID from flutter_list_devices). Omit for Flutter default.' },
        additionalArgs: { type: 'array', items: { type: 'string' }, description: 'Extra args for flutter run, e.g. ["--flavor", "dev"].' },
        startTimeoutSeconds: { type: 'number', description: 'Seconds to wait for the app to start. Default: 120.' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'flutter_hot_reload',
    description: 'Hot reload (incremental, preserves state). Use after editing widget/build code. Automatically schedules a render frame.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        appExtensionPrefix: { type: 'string', description: 'App VM extension prefix for frame scheduling (e.g. "reme" → ext.reme.forceFrame). Falls back to ext.flutter.reassemble.' },
      },
    },
  },
  {
    name: 'flutter_hot_restart',
    description: 'Hot restart (full, resets state, re-runs main()). Use when structural changes need to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        appExtensionPrefix: { type: 'string', description: 'App VM extension prefix for frame scheduling.' },
      },
    },
  },
  {
    name: 'flutter_stop',
    description: 'Stop a running Flutter app and clean up its session.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
      },
    },
  },
  {
    name: 'flutter_status',
    description: 'Get the current status of a Flutter session (running, starting, stopped, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
      },
    },
  },
  {
    name: 'flutter_list_sessions',
    description: 'List all active Flutter sessions managed by this server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flutter_get_logs',
    description: 'Get recent log output from the running Flutter app.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        lines: { type: 'number', description: 'Lines to return (default 50, max 500).' },
        includeStderr: { type: 'boolean', description: 'Include flutter build/compile stderr. Default: false.' },
      },
    },
  },
  {
    name: 'flutter_list_devices',
    description: 'List Flutter-compatible devices and emulators on this machine.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flutter_vm_call',
    description: 'Call any Dart VM Service method or extension on the running app. isolateId auto-injected for ext.* calls.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        method: { type: 'string', description: 'VM Service method or extension RPC, e.g. "getVM", "ext.flutter.debugPaint".' },
        params: { type: 'object', description: 'Extra call parameters.' },
      },
      required: ['method'],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

function requireArg(args, key) {
  if (args[key] == null) throw new Error(`Missing required argument: ${key}`);
  return args[key];
}

async function callTool(name, args) {
  switch (name) {

    case 'flutter_start': {
      const session = await sessions.start({
        projectPath: requireArg(args, 'projectPath'),
        device: args.device,
        additionalArgs: args.additionalArgs,
        startTimeoutMs: (args.startTimeoutSeconds ?? 120) * 1000,
      });
      return { status: session.status, projectPath: session.projectPath, device: session.device, appId: session.appId, wsUri: session.wsUri, startedAt: session.startedAt };
    }

    case 'flutter_hot_reload': {
      const result = await sessions.hotReload(args.projectPath, args.appExtensionPrefix);
      return { status: 'reloaded', ...result };
    }

    case 'flutter_hot_restart': {
      const result = await sessions.hotRestart(args.projectPath, args.appExtensionPrefix);
      return { status: 'restarted', ...result };
    }

    case 'flutter_stop': {
      await sessions.stop(args.projectPath);
      return { status: 'stopped' };
    }

    case 'flutter_status': {
      let session;
      try { session = sessions.resolve(args.projectPath); }
      catch (e) { return { status: 'no_session', message: e.message }; }
      const out = {
        status: session.status, projectPath: session.projectPath, device: session.device,
        appId: session.appId, wsUri: session.wsUri, startedAt: session.startedAt,
        lastReloadAt: session.lastReloadAt, lastRestartAt: session.lastRestartAt,
        uptimeSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
      };
      // While building or after an early exit, surface recent output so the
      // caller polling flutter_status can see progress or the failure reason.
      if (session.status !== 'running') {
        out.recentOutput = session.daemon.stderr.slice(-8);
      }
      return out;
    }

    case 'flutter_list_sessions': {
      const all = sessions.all();
      return { sessions: all.map((s) => ({ status: s.status, projectPath: s.projectPath, device: s.device, appId: s.appId, startedAt: s.startedAt, lastReloadAt: s.lastReloadAt })) };
    }

    case 'flutter_get_logs': {
      const session = sessions.resolve(args.projectPath);
      const lines = Math.min(args.lines ?? 50, 500);
      const result = { appLogs: session.daemon.logs.slice(-lines) };
      if (args.includeStderr) result.stderrLines = session.daemon.stderr.slice(-lines);
      return result;
    }

    case 'flutter_list_devices': {
      return { devices: await sessions.listDevices() };
    }

    case 'flutter_vm_call': {
      const session = sessions.resolve(args.projectPath);
      if (!session.wsUri) throw new Error('No VM service URI yet — app may still be starting.');
      const method = requireArg(args, 'method');
      const vm = await VmServiceClient.connect(session.wsUri, 5_000);
      try {
        let params = { ...(args.params ?? {}) };
        if (method.startsWith('ext.') && !params.isolateId) {
          const isolateId = await vm.mainIsolateId();
          if (isolateId) params = { isolateId, ...params };
        }
        return { result: await vm.call(method, params) };
      } finally { vm.close(); }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP stdio transport (newline-delimited JSON-RPC 2.0) ─────────────────────
//
// The MCP stdio transport frames each JSON-RPC message as a single line
// terminated by '\n'. Messages must not contain embedded newlines, which
// JSON.stringify guarantees (it escapes them inside strings).

function sendMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  sendMsg({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMsg({ jsonrpc: '2.0', id, error: { code, message } });
}

const SUPPORTED_PROTOCOL = '2024-11-05';

function log(msg) {
  process.stderr.write(`[flutter-mcp] ${msg}\n`);
}

async function dispatch(msg) {
  const { id, method, params = {} } = msg;
  const hasId = id !== undefined && id !== null;

  // Notifications (no id) — acknowledge silently, never respond
  if (!hasId) return;

  if (method === 'initialize') {
    // Echo back the client's protocol version when provided, so newer
    // clients (e.g. claude-ai 2025-xx) accept the handshake.
    const clientVersion = params?.protocolVersion;
    return sendResult(id, {
      protocolVersion: clientVersion ?? SUPPORTED_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'flutter-mcp-server', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return sendResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments ?? {};
    try {
      const data = await callTool(toolName, toolArgs);
      return sendResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    } catch (err) {
      return sendResult(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  if (method === 'ping') {
    return sendResult(id, {});
  }

  // Unknown method
  sendError(id, -32601, `Method not found: ${method}`);
}

// Line-delimited JSON over stdin via readline (robust against chunk splits).
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`ignoring non-JSON line: ${trimmed.slice(0, 120)}`);
    return;
  }
  Promise.resolve(dispatch(msg)).catch((err) => log(`dispatch error: ${err?.stack ?? err}`));
});

process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.stack ?? err}`));

log(`running on Node.js ${process.versions.node} (zero deps)`);
