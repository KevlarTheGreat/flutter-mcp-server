/**
 * buildSpawnEnv — returns a copy of process.env with standard Windows
 * environment variables backfilled.
 *
 * When Claude Desktop (or any MCP host) spawns this server, it may pass a
 * stripped-down environment that omits variables the Flutter Windows build
 * toolchain (Visual Studio / CMake) relies on — notably ProgramFiles(x86).
 * Their absence makes `flutter run -d windows` fail with errors like:
 *   "%PROGRAMFILES(X86)% environment variable not found."
 *
 * Windows env var access via process.env is case-insensitive in Node, so we
 * only need to check/set each logical name once.
 */
export function buildSpawnEnv() {
  const env = { ...process.env };

  if (process.platform === 'win32') {
    const systemDrive = env.SystemDrive || 'C:';
    const defaults = {
      'ProgramFiles': `${systemDrive}\\Program Files`,
      'ProgramFiles(x86)': `${systemDrive}\\Program Files (x86)`,
      'ProgramW6432': `${systemDrive}\\Program Files`,
      'ProgramData': `${systemDrive}\\ProgramData`,
      'SystemRoot': env.SystemRoot || env.windir || 'C:\\Windows',
      'windir': env.windir || env.SystemRoot || 'C:\\Windows',
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!env[key]) env[key] = value;
    }
  }

  return env;
}
