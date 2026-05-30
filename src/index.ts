/**
 * flutter-mcp-server
 *
 * A generic Model Context Protocol server for Flutter development.
 * Exposes hot reload, hot restart, logging, and device management to AI tools.
 *
 * Usage (stdio transport):
 *   node dist/index.js
 *
 * Add to Claude Code config:
 *   {
 *     "mcpServers": {
 *       "flutter": {
 *         "command": "node",
 *         "args": ["/path/to/flutter-mcp-server/dist/index.js"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { SessionManager } from './sessions.js';
import { VmServiceClient } from './vm-service.js';

// ── Globals ───────────────────────────────────────────────────────────────────

const sessions = new SessionManager();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'flutter_start',
    description:
      'Start a Flutter app with `flutter run --machine`. ' +
      'Waits for the app to finish launching and returns the session details. ' +
      'Must be called before hot_reload/hot_restart.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Absolute path to the Flutter project directory (must contain pubspec.yaml).',
        },
        device: {
          type: 'string',
          description:
            'Device or platform to target (e.g. "windows", "chrome", "ios", or a device ID from flutter_list_devices). ' +
            'Omit to use the Flutter default.',
        },
        additionalArgs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra args passed to flutter run, e.g. ["--flavor", "dev", "--dart-define", "API_URL=http://..."].',
        },
        startTimeoutSeconds: {
          type: 'number',
          description: 'Seconds to wait for the app to start before giving up. Default: 120.',
        },
      },
      required: ['projectPath'],
    },
  },

  {
    name: 'flutter_hot_reload',
    description:
      'Perform a Flutter hot reload (incremental — preserves app state). ' +
      'Use after editing widget/build code. ' +
      'Automatically schedules a new render frame to make visual changes appear immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            'Project path. Required if more than one session is active; optional when only one session is running.',
        },
        appExtensionPrefix: {
          type: 'string',
          description:
            'Optional app-specific VM service extension prefix for custom frame scheduling ' +
            '(e.g. "reme" uses ext.reme.forceFrame). Falls back to ext.flutter.reassemble automatically.',
        },
      },
    },
  },

  {
    name: 'flutter_hot_restart',
    description:
      'Perform a Flutter hot restart (full — resets app state, re-runs main()). ' +
      'Use when structural changes (new providers, route changes, initState) need to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path. Optional when only one session is running.',
        },
        appExtensionPrefix: {
          type: 'string',
          description: 'Optional VM extension prefix for custom frame scheduling (see flutter_hot_reload).',
        },
      },
    },
  },

  {
    name: 'flutter_stop',
    description: 'Stop a running Flutter app and clean up its session.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path. Optional when only one session is running.',
        },
      },
    },
  },

  {
    name: 'flutter_status',
    description: 'Get the current status of a Flutter session (running, starting, stopped, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path. Optional when only one session is running.',
        },
      },
    },
  },

  {
    name: 'flutter_list_sessions',
    description: 'List all active Flutter sessions managed by this server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'flutter_get_logs',
    description:
      'Get recent log output from the running Flutter app ' +
      '(app.log daemon events + stderr build output).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path. Optional when only one session is running.',
        },
        lines: {
          type: 'number',
          description: 'Number of most-recent lines to return. Default: 50, max: 500.',
        },
        includeStderr: {
          type: 'boolean',
          description: 'Include flutter build/compile output (stderr). Default: false.',
        },
      },
    },
  },

  {
    name: 'flutter_list_devices',
    description:
      'List Flutter-compatible devices and emulators available on this machine. ' +
      'Use the returned "id" field as the "device" parameter in flutter_start.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'flutter_vm_call',
    description:
      'Call any Dart VM Service method or registered extension on the running app. ' +
      'Useful for inspecting state, calling flutter/dart extensions, or forcing custom behaviour. ' +
      'The isolateId is resolved automatically if not provided.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path. Optional when only one session is running.',
        },
        method: {
          type: 'string',
          description:
            'VM Service method or extension RPC name, e.g. "getVM", "ext.flutter.debugPaint", "ext.reme.forceFrame".',
        },
        params: {
          type: 'object',
          description:
            'Extra parameters for the call. isolateId is injected automatically for extension calls (ext.*).',
        },
      },
      required: ['method'],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {

    // ── flutter_start ───────────────────────────────────────────────────────
    case 'flutter_start': {
      const projectPath = arg<string>(args, 'projectPath');
      const device = args.device as string | undefined;
      const additionalArgs = args.additionalArgs as string[] | undefined;
      const timeoutSec = (args.startTimeoutSeconds as number | undefined) ?? 120;

      const session = await sessions.start({
        projectPath,
        device,
        additionalArgs,
        startTimeoutMs: timeoutSec * 1000,
      });

      return json({
        status: session.status,
        projectPath: session.projectPath,
        device: session.device,
        appId: session.appId,
        wsUri: session.wsUri,
        startedAt: session.startedAt.toISOString(),
      });
    }

    // ── flutter_hot_reload ──────────────────────────────────────────────────
    case 'flutter_hot_reload': {
      const projectPath = args.projectPath as string | undefined;
      const prefix = args.appExtensionPrefix as string | undefined;
      const result = await sessions.hotReload(projectPath, prefix);

      return json({
        status: 'reloaded',
        message: result.message,
        durationMs: result.durationMs,
        frameScheduled: result.frameScheduled,
        frameStrategy: result.frameStrategy,
      });
    }

    // ── flutter_hot_restart ─────────────────────────────────────────────────
    case 'flutter_hot_restart': {
      const projectPath = args.projectPath as string | undefined;
      const prefix = args.appExtensionPrefix as string | undefined;
      const result = await sessions.hotRestart(projectPath, prefix);

      return json({
        status: 'restarted',
        message: result.message,
        durationMs: result.durationMs,
        frameScheduled: result.frameScheduled,
        frameStrategy: result.frameStrategy,
      });
    }

    // ── flutter_stop ────────────────────────────────────────────────────────
    case 'flutter_stop': {
      const projectPath = args.projectPath as string | undefined;
      await sessions.stop(projectPath);
      return json({ status: 'stopped' });
    }

    // ── flutter_status ──────────────────────────────────────────────────────
    case 'flutter_status': {
      const projectPath = args.projectPath as string | undefined;
      let session;
      try {
        session = sessions.resolve(projectPath);
      } catch (e) {
        return json({ status: 'no_session', message: (e as Error).message });
      }

      return json({
        status: session.status,
        projectPath: session.projectPath,
        device: session.device,
        appId: session.appId,
        wsUri: session.wsUri,
        startedAt: session.startedAt.toISOString(),
        lastReloadAt: session.lastReloadAt?.toISOString() ?? null,
        lastRestartAt: session.lastRestartAt?.toISOString() ?? null,
        uptimeSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
      });
    }

    // ── flutter_list_sessions ───────────────────────────────────────────────
    case 'flutter_list_sessions': {
      const all = sessions.all();
      if (all.length === 0) return json({ sessions: [], message: 'No active sessions.' });

      return json({
        sessions: all.map((s) => ({
          status: s.status,
          projectPath: s.projectPath,
          device: s.device,
          appId: s.appId,
          startedAt: s.startedAt.toISOString(),
          lastReloadAt: s.lastReloadAt?.toISOString() ?? null,
          lastRestartAt: s.lastRestartAt?.toISOString() ?? null,
        })),
      });
    }

    // ── flutter_get_logs ────────────────────────────────────────────────────
    case 'flutter_get_logs': {
      const projectPath = args.projectPath as string | undefined;
      const session = sessions.resolve(projectPath);
      const lines = Math.min((args.lines as number | undefined) ?? 50, 500);
      const includeStderr = (args.includeStderr as boolean | undefined) ?? false;

      const appLogs = session.daemon.logs.slice(-lines);
      const result: Record<string, unknown> = { appLogs };

      if (includeStderr) {
        result.stderrLines = session.daemon.stderr.slice(-lines);
      }

      return json(result);
    }

    // ── flutter_list_devices ────────────────────────────────────────────────
    case 'flutter_list_devices': {
      const devices = await sessions.listDevices();
      return json({ devices });
    }

    // ── flutter_vm_call ─────────────────────────────────────────────────────
    case 'flutter_vm_call': {
      const projectPath = args.projectPath as string | undefined;
      const method = arg<string>(args, 'method');
      const params = (args.params as Record<string, unknown> | undefined) ?? {};

      const session = sessions.resolve(projectPath);
      if (!session.wsUri) throw new Error('No VM service URI yet — app may still be starting.');

      const vm = await VmServiceClient.connect(session.wsUri, 5_000);
      try {
        let callParams = { ...params };
        // Auto-inject isolateId for extension calls
        if (method.startsWith('ext.') && !callParams.isolateId) {
          const isolateId = await vm.mainIsolateId();
          if (isolateId) callParams = { isolateId, ...callParams };
        }
        const result = await vm.call(method, callParams);
        return json({ result });
      } finally {
        vm.close();
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function arg<T>(args: Record<string, unknown>, key: string): T {
  if (args[key] === undefined || args[key] === null) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return args[key] as T;
}

function json(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

// ── MCP Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'flutter-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const content = await callTool(name, args as Record<string, unknown>);
    return { content: [{ type: 'text', text: content }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate over stdio — don't write to stdout
  process.stderr.write('flutter-mcp-server running (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
