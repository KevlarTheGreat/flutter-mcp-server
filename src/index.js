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

// ── Workflow documentation embedded in the server description ────────────────
//
// Typical session for an agent:
//   1. flutter_list_devices          — pick a device id
//   2. flutter_start                 — returns immediately with status "starting"
//   3. flutter_status (poll)         — repeat until status == "running"
//   4. edit source files
//   5. flutter_hot_reload            — for UI/logic changes (preserves state)
//      OR flutter_hot_restart        — for structural changes (resets state)
//   6. flutter_stop when done
//
// Multiple projects can run simultaneously; pass projectPath to disambiguate.

const TOOLS = [
  {
    name: 'flutter_start',
    description:
      'Launch a Flutter app with `flutter run --machine` and return immediately. ' +
      'IMPORTANT: returns status "starting" while the app is still building — ' +
      'call flutter_status in a loop until status is "running" before attempting ' +
      'hot_reload or hot_restart. A cold Windows build typically takes 30-90 seconds; ' +
      'subsequent builds are faster because artifacts are cached. ' +
      'Returns an appId immediately (even while building) which identifies the session. ' +
      'Call flutter_list_devices first to find valid device ids.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the Flutter project root directory (the folder that contains pubspec.yaml).' },
        device: { type: 'string', description: 'Device or platform to run on. Use "windows" for a Windows desktop app, "chrome" for web, or a device id returned by flutter_list_devices (e.g. a connected Android phone). Omit to let Flutter choose.' },
        additionalArgs: { type: 'array', items: { type: 'string' }, description: 'Extra arguments passed to flutter run, e.g. ["--flavor", "staging"] or ["--dart-define", "API_URL=https://example.com"].' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'flutter_hot_reload',
    description:
      'Apply code changes to a running Flutter app without restarting it (incremental reload). ' +
      'Preserves the current app state (navigation stack, filled forms, scroll position). ' +
      'Use this after editing widget build() methods, styles, layouts, or business logic. ' +
      'Automatically triggers a render frame so visual changes appear immediately. ' +
      'Do NOT use for: adding new providers/blocs, changing initState, modifying main(), ' +
      'adding new routes, or changing app-level config — use flutter_hot_restart instead. ' +
      'Requires the session to be in "running" state (check flutter_status first). ' +
      'Returns durationMs and frameScheduled to confirm success.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
        appExtensionPrefix: { type: 'string', description: 'Optional. App-specific Dart VM extension prefix for forcing a render frame. Only set this if the app registers a custom ext.<prefix>.forceFrame extension (e.g. "reme" for the ReMe app). Omit for standard Flutter projects — the server falls back to ext.flutter.reassemble automatically.' },
      },
    },
  },
  {
    name: 'flutter_hot_restart',
    description:
      'Fully restart a running Flutter app — re-runs main() and rebuilds the entire widget tree. ' +
      'Resets all app state (navigation, forms, providers, etc.) back to the initial state. ' +
      'Use this after: adding new Riverpod providers or BLoCs, changing initState/dispose, ' +
      'modifying main() or app-level setup, adding new routes, changing theme, or when a ' +
      'hot reload did not produce the expected result. ' +
      'Does NOT require a full rebuild — the Dart VM stays alive so restart is fast (~1-2s). ' +
      'Requires the session to be in "running" state. ' +
      'Returns durationMs and frameScheduled to confirm success.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
        appExtensionPrefix: { type: 'string', description: 'Optional. Same as flutter_hot_reload. Omit for standard Flutter projects.' },
      },
    },
  },
  {
    name: 'flutter_stop',
    description:
      'Stop a running Flutter app, terminate the flutter process, and remove the session. ' +
      'Call this when you are done with a development session to free resources. ' +
      'Safe to call even if the app is still in "starting" state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
      },
    },
  },
  {
    name: 'flutter_status',
    description:
      'Get the current status and details of a Flutter session. ' +
      'Possible status values: ' +
      '"starting" = app is building or launching (poll until "running" before hot reload/restart); ' +
      '"running" = app is live and accepting hot reload/restart; ' +
      '"reloading" = hot reload in progress; ' +
      '"restarting" = hot restart in progress; ' +
      '"stopped" = process exited. ' +
      'When status is not "running", the response includes recentOutput (last 8 lines of build ' +
      'output) so you can monitor build progress or diagnose a failed launch. ' +
      'Also returns wsUri (Dart VM Service WebSocket URL) once running, useful for flutter_vm_call.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
      },
    },
  },
  {
    name: 'flutter_list_sessions',
    description:
      'List all Flutter sessions currently managed by this server, including their status, ' +
      'project path, device, and last reload/restart time. ' +
      'Use this to see what is running before calling other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flutter_get_logs',
    description:
      'Retrieve recent log output from a running Flutter app. ' +
      'App logs come from debugPrint() and print() calls in Dart code. ' +
      'Set includeStderr:true to also see flutter build/compile output (useful for ' +
      'diagnosing crashes or build errors).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
        lines: { type: 'number', description: 'Number of most-recent lines to return. Default: 50, max: 500.' },
        includeStderr: { type: 'boolean', description: 'Also return flutter build/compile output (stderr). Default: false.' },
      },
    },
  },
  {
    name: 'flutter_list_devices',
    description:
      'List all Flutter-compatible devices and emulators available on this machine. ' +
      'Returns name, id, platform, and capabilities for each device. ' +
      'Use the "id" field as the "device" parameter in flutter_start. ' +
      'Common values: "windows" (Windows desktop), "chrome" (web), or a device serial for ' +
      'connected Android/iOS devices.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flutter_vm_call',
    description:
      'Call any method on the Dart VM Service of a running Flutter app. ' +
      'This is an advanced/debugging tool. ' +
      'For ext.* extension calls, the isolateId is injected automatically. ' +
      'Useful examples: ' +
      '"getVM" — inspect the running Dart VM and its isolates; ' +
      '"ext.flutter.debugPaint" — toggle debug paint overlay; ' +
      '"ext.flutter.debugDumpLayerTree" — dump the layer tree; ' +
      '"evaluate" — evaluate a Dart expression in the running app (pass isolateId and expression). ' +
      'Requires the session to be in "running" state and wsUri to be available (check flutter_status).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Can be omitted when only one session is active.' },
        method: { type: 'string', description: 'VM Service RPC method name, e.g. "getVM", "ext.flutter.debugPaint", "evaluate".' },
        params: { type: 'object', description: 'Parameters for the call. For ext.* calls, isolateId is injected automatically and does not need to be provided.' },
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
