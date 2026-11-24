// Keeps the built-in JavaScript evaluator in step with policy/guard.rego, and
// exercises the OPA engine against a real OPA server. Both need the `opa`
// binary (https://www.openpolicyagent.org/docs#running-opa) and are skipped
// without it; CI installs it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DEFAULT_CONFIG, evaluateGuard, createOpaEngine } from '../src/policy.js';

let hasOpa = true;
try { execFileSync('opa', ['version'], { stdio: 'ignore' }); } catch { hasOpa = false; }
const skip = hasOpa ? false : 'opa binary not installed';

const configs = [
  DEFAULT_CONFIG,
  { windows: { login: 12, payment: 168 }, block_above: 1000, on_error: { login: 'step_up', payment: 'block' } },
];
const signals = [
  undefined,
  { status: 200, swapped: false },
  { status: 200, swapped: true },
  { status: 503, code: 'UNAVAILABLE' },
  { status: 404, code: 'IDENTIFIER_NOT_FOUND' },
  { status: 0, code: 'NETWORK_ERROR' },
];
const requests = [{ action: 'login' }, { action: 'payment', amount: 100 }, { action: 'payment', amount: 750 }, { action: 'payment', amount: 5000 }];

const cases = [];
for (const config of configs) for (const signal of signals) for (const req of requests) {
  cases.push({ config, input: signal ? { ...req, phone_number: '+447700900001', signal } : req });
}

test('the built-in evaluator matches guard.rego on every case', { skip }, () => {
  // Bind each case's parts to locals first: `with ... as c.input` inside the comprehension does not take effect.
  const query = '[x | some c in input.cases; cc := c.config; ii := c.input; x := data.simswap.guard with data.simswap.config as cc with input as ii]';
  const out = execFileSync('opa', ['eval', '--format', 'json', '--stdin-input', '--data', 'policy/guard.rego', '--data', 'policy/data.json', query], {
    input: JSON.stringify({ cases }),
  });
  const fromOpa = JSON.parse(out).result[0].expressions[0].value;
  assert.equal(fromOpa.length, cases.length);
  cases.forEach((c, i) => {
    assert.deepEqual(evaluateGuard(c.input, c.config), fromOpa[i], `case ${i}: ${JSON.stringify(c.input)} with ${JSON.stringify(c.config)}`);
  });
});

test('opa test policy/ passes', { skip }, () => {
  execFileSync('opa', ['test', 'policy/'], { stdio: 'pipe' });
});

// ---------------------------------------------------------------------------

let opa, engine;

const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

before(async () => {
  if (!hasOpa) return;
  const port = await freePort();
  opa = spawn('opa', ['run', '--server', '--addr', `127.0.0.1:${port}`, 'policy/guard.rego', 'policy/data.json'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  engine = createOpaEngine({ url });
});
after(() => opa?.kill());

test('OPA engine: evaluates live, evaluates a draft, publishes', { skip }, async () => {
  const input = { action: 'payment', amount: 750, signal: { status: 200, swapped: true } };

  const live = await engine.evaluate(input);
  assert.equal(live.window_hours, 72);
  assert.equal(live.decision.rule, 'swap_large_payment');

  const draftCfg = { ...DEFAULT_CONFIG, windows: { login: 24, payment: 168 }, block_above: 1000 };
  const draft = await engine.evaluate(input, draftCfg);
  assert.equal(draft.window_hours, 168);
  assert.equal(draft.decision.result, 'step_up');
  assert.equal((await engine.evaluate(input)).decision.result, 'block', 'a draft must not change the live policy');

  assert.deepEqual(await engine.getConfig(), { config: DEFAULT_CONFIG, rev: 1 });
  assert.equal((await engine.setConfig(draftCfg)).rev, 2);
  assert.equal((await engine.evaluate(input)).decision.result, 'step_up');
  assert.deepEqual(await engine.getConfig(), { config: draftCfg, rev: 2 });

  await assert.rejects(engine.setConfig({ ...draftCfg, windows: { login: 0, payment: 72 } }), /windows.login/);
});
