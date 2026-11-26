// One command for the full demo: Open Policy Agent plus the app, with this
// deployment's thresholds (policy/data.json with POLICY_CONFIG laid over it)
// loaded into OPA, so OPA and the built-in fallback agree.
//
//   npm run demo                 # reads .env if there is one
//   OPA_PORT=8282 npm run demo   # if 8181 is taken
//
// Without the `opa` binary it says so and runs the built-in engine instead.
// Ctrl+C stops both.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './policy.js'; // data.json + POLICY_CONFIG, validated

const OPA_PORT = Number(process.env.OPA_PORT ?? 8181);
const OPA_URL = `http://localhost:${OPA_PORT}`;
const REGO = fileURLToPath(new URL('../policy/guard.rego', import.meta.url));

async function opaHealthy() {
  try {
    return (await fetch(`${OPA_URL}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

async function startOpa() {
  if (spawnSync('opa', ['version'], { stdio: 'ignore' }).error) {
    console.warn('\n  opa not found, so decisions use the built-in copy of guard.rego.');
    console.warn('  Install it to run the real thing: https://www.openpolicyagent.org/docs#running-opa');
    return null;
  }
  if (await opaHealthy()) {
    console.error(`\n  Something is already serving on ${OPA_URL}. Stop it, or pick another port:\n\n    OPA_PORT=${OPA_PORT + 1} npm run demo\n`);
    process.exit(1);
  }

  // OPA reads its thresholds from a data file, not from POLICY_CONFIG, so hand it the merged config.
  const dir = mkdtempSync(join(tmpdir(), 'simswap-opa-'));
  const data = join(dir, 'data.json');
  writeFileSync(data, JSON.stringify({ simswap: { config: DEFAULT_CONFIG } }, null, 2));

  tmpDir = dir;
  const opa = spawn('opa', ['run', '--server', '--log-level', 'error', '--addr', `localhost:${OPA_PORT}`, REGO, data], { stdio: ['ignore', 'ignore', 'inherit'] });
  opa.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`\n  OPA exited (${signal ?? `code ${code}`}). Decisions now fall back to the built-in copy of guard.rego.\n`);
    }
  });

  for (let i = 0; i < 40; i++) {
    if (await opaHealthy()) return opa;
    if (opa.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  opa.kill();
  console.error(`\n  OPA did not come up on ${OPA_URL}.\n`);
  process.exit(1);
}

let stopping = false;
let tmpDir = null; // holds OPA's data file; removed on exit
process.on('exit', () => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

const opa = await startOpa();
if (opa) {
  const stop = () => {
    stopping = true;
    opa.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => opa.kill());
  process.env.OPA_URL = OPA_URL;
}

const w = DEFAULT_CONFIG.windows;
console.log(`\n  Thresholds: login ${w.login}h, payment ${w.payment}h, block above ${DEFAULT_CONFIG.block_above}` +
  (process.env.POLICY_CONFIG ? '  (POLICY_CONFIG applied)' : ''));

// bank.js reads OPA_URL when it loads, so load the app only now.
await import('./dev-server.js');
