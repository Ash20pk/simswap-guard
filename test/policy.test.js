import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOperator } from '../src/mock-operator.js';
import { createSimSwapClient, CamaraError } from '../src/camara-client.js';
import { assess } from '../src/policy.js';

let server, client;

before(async () => {
  server = createMockOperator();
  await new Promise((r) => server.listen(0, r));
  client = createSimSwapClient({ baseUrl: `http://localhost:${server.address().port}/sim-swap/v1`, accessToken: 't' });
});
after(() => server.close());

test('check honours maxAge', async () => {
  assert.equal(await client.check('+447700900003', 24), false); // swapped 50h ago
  assert.equal(await client.check('+447700900003', 72), true);
  assert.equal(await client.check('+447700900001', 2400), false);
});

test('retrieve-date returns a date or null', async () => {
  assert.equal(await client.retrieveDate('+447700900001'), null);
  const d = await client.retrieveDate('+447700900002');
  assert.ok(Date.now() - d.getTime() < 3 * 3600_000);
});

test('errors follow the CAMARA error shape', async () => {
  await assert.rejects(client.check('12345'), (e) => e instanceof CamaraError && e.code === 'INVALID_ARGUMENT');
  await assert.rejects(client.check('+447700900001', 0), (e) => e.code === 'OUT_OF_RANGE');
  await assert.rejects(client.check('+15555550100'), (e) => e.status === 404 && e.code === 'IDENTIFIER_NOT_FOUND');
});

test('missing token is rejected', async () => {
  const anon = createSimSwapClient({ baseUrl: `http://localhost:${server.address().port}/sim-swap/v1`, accessToken: '' });
  await assert.rejects(anon.check('+447700900001'), (e) => e.code === 'UNAUTHENTICATED');
});

const cases = [
  ['clean login', { action: 'login', phoneNumber: '+447700900001' }, 'allow'],
  ['fresh swap login', { action: 'login', phoneNumber: '+447700900002' }, 'step_up'],
  ['2-day-old swap login', { action: 'login', phoneNumber: '+447700900003' }, 'allow'],
  ['2-day-old swap, small payment', { action: 'payment', phoneNumber: '+447700900003', amount: 100 }, 'step_up'],
  ['2-day-old swap, large payment', { action: 'payment', phoneNumber: '+447700900003', amount: 750 }, 'block'],
  ['30-day-old swap, large payment', { action: 'payment', phoneNumber: '+447700900004', amount: 750 }, 'allow'],
  ['operator outage, login fails open', { action: 'login', phoneNumber: '+447700900009' }, 'allow'],
  ['operator outage, payment fails closed', { action: 'payment', phoneNumber: '+447700900009', amount: 10 }, 'review'],
  ['unknown number, payment', { action: 'payment', phoneNumber: '+15555550100', amount: 10 }, 'review'],
];

for (const [name, input, expected] of cases) {
  test(`policy: ${name} -> ${expected}`, async () => {
    assert.equal((await assess(client, input)).decision, expected);
  });
}
