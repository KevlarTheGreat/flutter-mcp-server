# flutter-mcp-server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for Flutter development. Gives AI agents (Claude, etc.) the ability to start Flutter apps, hot reload and restart them, stream logs, list devices, and call the Dart VM Service — all without leaving the chat.

**Zero external dependencies.** Runs directly with Node.js 22+. No `npm install`, no build step.

---

## Features

| Tool | Description |
|---|---|
| `flutter_start` | Launch `flutter run --machine` for any project. Returns immediately with a session ID while the build runs in the background. |
| `flutter_status` | Poll build progress and check when the app is `running`. Surfaces build output and errors. |
| `flutter_hot_reload` | Incremental reload in ~250ms — preserves app state. Triggers a render frame automatically. |
| `flutter_hot_restart` | Full restart in ~600ms — re-runs `main()`. No recompile needed. |
| `flutter_stop` | Graceful shutdown, cleans up the session. |
| `flutter_list_sessions` | List all active sessions (supports multiple projects simultaneously). |
| `flutter_get_logs` | Stream recent `debugPrint()` / `print()` output from the running app. |
| `flutter_list_devices` | List all Flutter-compatible devices and emulators. |
| `flutter_vm_call` | Call any Dart VM Service method or registered extension (e.g. `ext.flutter.debugPaint`, `evaluate`). |

---

## Requirements

- **Node.js 22+** (uses built-in `WebSocket` and `readline` — no npm packages needed)
- **Flutter SDK** in your `PATH`
- **Windows**: Visual Studio 2022 with C++ workload (for Windows desktop builds)

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/KevlarTheGreat/flutter-mcp-server.git
```

No `npm install` needed — there are no dependencies.

### 2. Add to your Claude Desktop config

Open `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "flutter": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\flutter-mcp-server\\src\\index.js"]
    }
  }
}
```

> **Windows tip:** Use the full path to `node.exe` (e.g. `C:\Program Files\nodejs\node.exe`) rather than just `"node"` — Claude Desktop launches servers with a stripped PATH that may not include it. Run `where node` in PowerShell to find the exact path on your machine.

### 3. Restart Claude Desktop

The `flutter` server will appear in your MCP servers list. No further setup needed.

---

## Usage

### Typical agent workflow

```
1. flutter_list_devices          → pick a device id
2. flutter_start                 → returns status "starting" immediately
3. flutter_status  (poll)        → repeat until status == "running"
4. [edit source files]
5. flutter_hot_reload            → for UI / logic changes (preserves state)
   OR flutter_hot_restart        → for structural changes (resets state)
6. flutter_stop                  → when done
```

### When to use hot reload vs hot restart

**Use `flutter_hot_reload` after:**
- Editing widget `build()` methods
- Changing styles, layouts, colours
- Updating business logic or service methods

**Use `flutter_hot_restart` after:**
- Adding new Riverpod providers, BLoCs, or `ChangeNotifier`s
- Modifying `initState()` / `dispose()`
- Changing `main()` or app-level setup
- Adding new routes
- When hot reload didn't produce the expected result

### Example — start ReMe on Windows and hot reload

```
flutter_start({
  "projectPath": "C:/Users/Brian/Documents/Claude/Projects/ReMe/reme",
  "device": "windows"
})
→ { "status": "starting", "appId": "abc123..." }

flutter_status()   ← poll until...
→ { "status": "running", "wsUri": "ws://127.0.0.1:56789/..." }

[make code changes]

flutter_hot_reload({ "appExtensionPrefix": "reme" })
→ { "status": "reloaded", "durationMs": 268, "frameScheduled": true }
```

### The `appExtensionPrefix` parameter

`flutter_hot_reload` and `flutter_hot_restart` accept an optional `appExtensionPrefix`. If your app registers a custom Dart VM extension named `ext.<prefix>.forceFrame`, the server will call it after reload to immediately schedule a render frame.

**Omit this for most projects** — the server falls back to Flutter's built-in `ext.flutter.reassemble` automatically, which works for any Flutter app.

If your app registers the extension (example for the ReMe app):

```dart
// In main.dart (debug mode only)
if (kDebugMode) {
  registerExtension('ext.reme.forceFrame', (method, parameters) async {
    SchedulerBinding.instance.scheduleFrame();
    return ServiceExtensionResponse.result(json.encode({'frameScheduled': true}));
  });
}
```

Then pass `"appExtensionPrefix": "reme"` when calling `flutter_hot_reload`.

### Multiple projects

The server manages multiple Flutter sessions simultaneously, keyed by project path. When more than one session is active, pass `projectPath` to any tool to target a specific one:

```
flutter_hot_reload({ "projectPath": "C:/projects/my-app" })
```

---

## How it works

- Spawns `flutter run --machine` as a child process and speaks the [Flutter daemon protocol](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/doc/daemon.md) (newline-delimited JSON arrays over stdin/stdout).
- Connects to the app's Dart VM Service via WebSocket (using Node.js 22's built-in `WebSocket`) to trigger frame scheduling after reload/restart.
- Implements the MCP stdio transport directly (newline-delimited JSON-RPC 2.0) — no MCP SDK dependency.
- On Windows, spawns flutter via `shell: true` (required for `.bat` files since Node.js CVE-2024-27980) and backfills `ProgramFiles(x86)` and related env vars that the Visual Studio / CMake toolchain needs but Claude Desktop's environment strips out.

---

## Tested on

- Windows 11 with Flutter 3.x, Visual Studio 2022, Node.js 26
- Claude Desktop (Epitaxy/FleetView)

macOS and Linux should work (no Windows-specific code paths are taken on those platforms) but haven't been tested yet. PRs welcome.

---

## License

MIT
