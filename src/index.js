/**
 * flutter-mcp-server — generic Flutter development MCP server.
 *
 * Exposes hot reload, hot restart, logging, device management, and raw
 * VM Service calls as AI-callable tools via the Model Context Protocol.
 *
 * No build step required — runs directly with Node.js:
 *   node src/index.js
 *
 * Claude Desktop config entry:
 *   "flutter": {
 *     "command": "node",
 *     "args": ["C:/path/to/flutter-mcp-server/src/index.js"]
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { SessionManager } from './sessions.js';
import { VmServiceClient } from './vm-service.js';

const sessions = new SessionManager();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'flutter_start',
    description:
      'Start a Flutter app with `flutter run --machine`. ' +
      'Waits for the app to finish launching. Must be called before hot_reload/hot_restart.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the Flutter project (must contain pubspec.yaml).' },
        device: { type: 'string', description: 'Device/platform to target (e.g. "windows", "chrome", device ID from flutter_list_devices). Omit for Flutter default.' },
        additionalArgs: { type: 'array', items: { type: 'string' }, description: 'Extra args passed to flutter run, e.g. ["--flavor", "dev"].' },
        startTimeoutSeconds: { type: 'number', description: 'Seconds to wait for the app to start. Default: 120.' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'flutter_hot_reload',
    description:
      'Perform a Flutter hot reload (incremental, preserves state). ' +
      'Use after editing widget/build code. Automatically schedules a render frame.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        appExtensionPrefix: { type: 'string', description: 'App-specific VM extension prefix for custom frame scheduling (e.g. "reme" uses ext.reme.forceFrame). Falls back to ext.flutter.reassemble.' },
      },
    },
  },
  {
    name: 'flutter_hot_restart',
    description:
      'Perform a Flutter hot restart (full, resets state, re-runs main()). ' +
      'Use when structural changes need to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        appExtensionPrefix: { type: 'string', description: 'VM extension prefix for custom frame scheduling (see flutter_hot_reload).' },
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
    description: 'Get the current status of a Flutter session.',
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
        lines: { type: 'number', description: 'Number of most-recent lines to return. Default: 50, max: 500.' },
        includeStderr: { type: 'boolean', description: 'Include flutter build/compile output (stderr). Default: false.' },
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
    description:
      'Call any Dart VM Service method or registered extension on the running app. ' +
      'isolateId is injected automatically for ext.* calls.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project path. Optional when only one session is running.' },
        method: { type: 'string', description: 'VM Service method or extension RPC, e.g. "getVM", "ext.flutter.debugPaint".' },
        params: { type: 'object', description: 'Extra parameters for the call.' },
      },
      required: ['method'],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

async function callTool(name, args) {
  switch (name) {

    case 'flutter_start': {
      const session = await sessions.start({
        projectPath: requireArg(args, 'projectPath'),
        device: args.device,
        additionalArgs: args.additionalArgs,
        startTimeoutMs: ((args.startTimeoutSeconds ?? 120)) * 1000,
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
      return {
        status: session.status,
        projectPath: session.projectPath,
        device: session.device,
        appId: session.appId,
        wsUri: session.wsUri,
        startedAt: session.startedAt,
        lastReloadAt: session.lastReloadAt,
        lastRestartAt: session.lastRestartAt,
        uptimeSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
      };
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
      const devices = await sessions.listDevices();
      return { devices };
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
        const result = await vm.call(method, params);
        return { result };
      } finally {
        vm.close();
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function requireArg(args, key) {
  if (args[key] === undefined || args[key] === null) throw new Error(`Missing required argument: ${key}`);
  return args[key];
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'flutter-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const data = await callTool(name, args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('flutter-mcp-server running (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
