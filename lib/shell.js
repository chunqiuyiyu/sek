import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const truncateSuffix = '\n...[truncated]';

export async function execute(config, command) {
  // Guard: if config is undefined or null, provide sensible defaults
  const cfg = config || {};
  const cwd = cfg.cwd || process.cwd();
  const maxObservationBytes = cfg.maxObservationBytes ?? 8192;

  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  let stdout = '';
  let stderr = '';

  try {
    const result = await execFileAsync(shell, args, {
      cwd,
      maxBuffer: Math.max(maxObservationBytes + 4096, 1024 * 1024),
      windowsHide: true,
    });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? String(error.message || error);
  }

  const combined = [stdout, stderr].filter((part) => part.length > 0).join('\n') || '(no output)';
  return truncate(combined, maxObservationBytes);
}

export function truncate(text, maxBytes) {
  if (maxBytes === 0 || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (maxBytes <= truncateSuffix.length) {
    const keep = Math.max(0, maxBytes - 5);
    return `${Buffer.from(text).subarray(0, keep).toString()}${truncateSuffix}`;
  }
  const keep = maxBytes - truncateSuffix.length;
  return `${Buffer.from(text).subarray(0, keep).toString()}${truncateSuffix}`;
}
