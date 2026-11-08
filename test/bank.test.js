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
