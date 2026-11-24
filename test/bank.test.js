import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, pay, demoNumbers } from '../src/bank.js';
import { handleSimSwap } from '../src/mock-operator.js';

const post = (path, body, headers = {}) => new Request(`http://x${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function loginAs(phoneNumber) {
  const res = await login(post('/api/login', { phoneNumber, password: 'demo' }));
  return { status: res.status, ...(await res.json()) };
}

test('lists the demo numbers', async () => {
  assert.equal((await demoNumbers().json()).length, 5);
});

test('wrong password is rejected', async () => {
  const res = await login(post('/api/login', { phoneNumber: '+447700900001', password: 'x' }));
  assert.equal(res.status, 401);
});

test('login then a large payment on a recently swapped SIM is blocked', async () => {
  const { token, decision } = await loginAs('+447700900003');
  assert.equal(decision, 'allow');
  const res = await pay(post('/api/pay', { amount: 750 }, { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).decision, 'block');
});

test('payment needs a valid session token', async () => {
  assert.equal((await pay(post('/api/pay', { amount: 5 }))).status, 401);
  // A token re-signed for a different number must not verify.
  const { token } = await loginAs('+447700900001');
  const [, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ phoneNumber: '+447700900004', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal((await pay(post('/api/pay', { amount: 5 }, { authorization: `Bearer ${forged}.${sig}` }))).status, 401);
});

test('mock operator works as a plain Request handler', async () => {
  const res = await handleSimSwap(post('/sim-swap/v1/check', { phoneNumber: '+447700900002', maxAge: 24 }, { authorization: 'Bearer t', 'x-correlator': 'abc' }));
  assert.deepEqual(await res.json(), { swapped: true });
  assert.equal(res.headers.get('x-correlator'), 'abc');
});

// ---------------------------------------------------------------------------
// Structured decisions, the trace, and the policy page's endpoints.

import { getPolicy, putPolicy, evaluatePolicy, status } from '../src/bank.js';
import { DEFAULT_CONFIG } from '../src/policy.js';

const put = (body, headers = {}) => new Request('http://x/api/policy', {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('login returns the structured decision and a trace of the calls made', async () => {
  const res = await loginAs('+447700900002');
  assert.equal(res.decision, 'step_up');
  assert.deepEqual(res.structured, {
    result: 'step_up', rule: 'swap_step_up', window_hours: 24,
    reason: 'SIM changed in the last 24h. An SMS code to this number proves nothing.',
    obligations: ['no_sms_otp', 'require_passkey'],
  });
  assert.deepEqual(res.input, { action: 'login', phone_number: '+447700900002', signal: { status: 200, swapped: true } });
  const call = res.trace.find((e) => e.kind === 'http');
  assert.equal(call.label, 'operator');
  assert.equal(call.url, 'mock/sim-swap/v1/check');
  assert.deepEqual(JSON.parse(call.request), { phoneNumber: '+447700900002', maxAge: 24 });
  assert.equal(call.response, '{"swapped":true}');
});

test('an operator outage reaches the policy as a signal, not an exception', async () => {
  const res = await loginAs('+447700900009');
  assert.equal(res.rule, 'operator_down');
  assert.deepEqual(res.input.signal, { status: 503, code: 'UNAVAILABLE' });
});

test('policy page: read, evaluate a draft, publish', async () => {
  const policy = await (await getPolicy()).json();
  assert.equal(policy.engine, 'builtin');
  assert.match(policy.rego, /package simswap\.guard/);
  assert.deepEqual(policy.config, DEFAULT_CONFIG);

  // Swapped 50h ago: outside the 24h login window, inside a 72h one.
  const draft = { ...DEFAULT_CONFIG, windows: { login: 72, payment: 72 } };
  const tried = await (await evaluatePolicy(post('/api/policy/evaluate', { action: 'login', phoneNumber: '+447700900003', config: draft }))).json();
  assert.equal(tried.decision, 'step_up');
  assert.equal(tried.draft, true);
  assert.equal((await loginAs('+447700900003')).decision, 'allow', 'a draft must not change live decisions');

  const bad = await putPolicy(put({ config: { ...draft, block_above: -1 } }));
  assert.equal(bad.status, 400);

  const published = await (await putPolicy(put({ config: draft }))).json();
  assert.equal(published.rev, policy.rev + 1);
  assert.equal((await loginAs('+447700900003')).decision, 'step_up');
  assert.equal((await (await status()).json()).policy.rev, published.rev);

  await putPolicy(put({ config: DEFAULT_CONFIG })); // leave it as found
});

test('publishing needs the admin token when one is set', async () => {
  process.env.POLICY_ADMIN_TOKEN = 'sesame';
  try {
    assert.equal((await putPolicy(put({ config: DEFAULT_CONFIG }))).status, 403);
    assert.equal((await putPolicy(put({ config: DEFAULT_CONFIG }, { 'x-admin-token': 'wrong' }))).status, 403);
    assert.equal((await putPolicy(put({ config: DEFAULT_CONFIG }, { 'x-admin-token': 'sesame' }))).status, 200);
  } finally {
    delete process.env.POLICY_ADMIN_TOKEN;
  }
});
