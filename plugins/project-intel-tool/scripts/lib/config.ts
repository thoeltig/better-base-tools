export function parseConfigArg(argName: string, envName: string, defaultVal: string): string {
  const envVal = process.env[envName];
  if (envVal !== undefined && envVal !== '') return envVal;
  const prefix = `--${argName}=`;
  const exact = process.argv.find(a => a.startsWith(prefix));
  if (exact) return exact.slice(prefix.length);
  const idx = process.argv.indexOf(`--${argName}`);
  if (idx >= 0) {
    if (process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) return process.argv[idx + 1]!;
    return 'true';
  }
  return defaultVal;
}

export function parseConfigArgRecord(argName: string, envName: string): Record<string, unknown> {
  const raw = parseConfigArg(argName, envName, '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    console.error(`[config] ${envName}: expected a JSON object, ignoring`);
  } catch {
    console.error(`[config] ${envName}: invalid JSON, ignoring`);
  }
  return {};
}