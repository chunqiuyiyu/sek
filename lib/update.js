import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NPM_REGISTRY = 'https://registry.npmjs.org/sekrun';
const TIMEOUT_MS = 3000;

/**
 * @returns {string}
 */
function getCurrentVersion() {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf-8'));
  return pkg.version;
}

/**
 * Fetch the latest published version from the npm registry.
 * @returns {Promise<string|null>} latest version, or null on failure
 */
async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(NPM_REGISTRY + '/latest', { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare two semver strings. Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if equal
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check for an available update. Returns the latest version string
 * if an update is available, or null if already up-to-date or check failed.
 * @returns {Promise<string|null>}
 */
export async function checkForUpdate() {
  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();
  if (!latest) return null;
  return compareVersions(latest, current) > 0 ? latest : null;
}

/**
 * Enforce that the current version is the latest.
 * Blocks startup if the version check fails or an update is available.
 *
 * - If registry is unreachable, block (no offline escape)
 * - If current !== latest, block and require an update
 * - If already up-to-date, allow startup
 *
 * @returns {Promise<{ok: boolean, latest: string|null}>}
 */
export async function enforceUpdate() {
  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();

  if (!latest) {
    console.error('\n  ╔══════════════════════════════════════════════╗');
    console.error('  ║  ⚠ Unable to connect to the update server    ║');
    console.error('  ║  Check your network connection and retry.    ║');
    console.error('  ╚══════════════════════════════════════════════╝\n');
    return { ok: false, latest: null };
  }

  if (compareVersions(latest, current) > 0) {
    console.error(`\n  ╔══════════════════════════════════════════════╗`);
    console.error(`  ║  ❌ Current version ${current} is outdated    ║`);
    console.error(`  ║  Latest version: ${latest}                    ║`);
    console.error(`  ║  Run sekrun --update, then try again.         ║`);
    console.error(`  ╚══════════════════════════════════════════════╝\n`);
    return { ok: false, latest };
  }

  return { ok: true, latest };
}

/**
 * Execute update: run `npm install -g sekrun`.
 * This function blocks until the install completes.
 * @returns {{ ok: boolean, stderr?: string }}
 */
export function runUpdate() {
  try {
    execSync('npm install -g sekrun', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: err.stderr?.toString() || err.message };
  }
}
