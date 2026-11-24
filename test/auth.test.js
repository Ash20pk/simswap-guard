// OAuth client credentials against a fake token server and a fake operator,
// the shape used by operator sandboxes such as the Orange Network APIs Playground.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSimSwapClient, createClientCredentialsTokenProvider, CamaraError } from '../src/camara-client.js';
import { operatorFromEnv, parseDemoNumbers } from '../src/bank.js';

let server, base;
const state = { tokensIssued: 0, valid: new Set(), lastTokenRequest: null };

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (req.url === '/token') {
      state.lastTokenRequest = { auth: req.headers.authorization, type: req.headers['content-type'], body };
      if (req.headers.authorization !== `Basic ${Buffer.from('id:secret').toString('base64')}`) {
        return json(401, { error: 'invalid_client', error_description: 'Bad client credentials' });
      }
      const token = `tok-${++state.tokensIssued}`;
      state.valid.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.url === '/sim-swap/v1/check') {
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (!state.valid.has(token)) return json(401, { status: 401, code: 'UNAUTHENTICATED', message: 'Bad token' });
      return json(200, { swapped: JSON.parse(body).phoneNumber.endsWith('2') });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const provider = (opts = {}) => createClientCredentialsTokenProvider({
  tokenUrl: `${base}/token`, clientId: 'id', clientSecret: 'secret', ...opts,
});

test('fetches a token with client credentials and calls the API with it', async () => {
  const client = createSimSwapClient({ baseUrl: `${base}/sim-swap/v1`, getAccessToken: provider() });
  assert.equal(await client.check('+10000000002', 24), true);
  assert.equal(state.lastTokenRequest.type, 'application/x-www-form-urlencoded');
  assert.equal(state.lastTokenRequest.body, 'grant_type=client_credentials');
});

test('a pre-encoded basic auth string works too, with or without the "Basic " prefix', async () => {
  const encoded = Buffer.from('id:secret').toString('base64');
  for (const basicAuth of [encoded, `Basic ${encoded}`]) {
    const client = createSimSwapClient({ baseUrl: `${base}/sim-swap/v1`, getAccessToken: provider({ clientId: undefined, clientSecret: undefined, basicAuth }) });
    assert.equal(await client.check('+10000000001', 24), false);
  }
});

test('caches the token and shares one request between concurrent callers', async () => {
  const before = state.tokensIssued;
  const client = createSimSwapClient({ baseUrl: `${base}/sim-swap/v1`, getAccessToken: provider() });
  await Promise.all([client.check('+10000000001'), client.check('+10000000002'), client.check('+10000000003')]);
  await client.check('+10000000001');
  assert.equal(state.tokensIssued - before, 1);
});

test('refreshes the token shortly before it expires', async () => {
  let clock = 0;
  const get = provider({ now: () => clock });
  const first = await get();
  clock = 3600_000 - 61_000;
  assert.equal(await get(), first);
  clock = 3600_000 - 59_000;
  assert.notEqual(await get(), first);
});

test('a revoked token is replaced once, then the call succeeds', async () => {
  const get = provider();
  const client = createSimSwapClient({ baseUrl: `${base}/sim-swap/v1`, getAccessToken: get });
  state.valid.delete(await get());
  assert.equal(await client.check('+10000000002'), true);
});

test('bad client credentials surface as a TOKEN_ERROR the policy can fall back on', async () => {
  const client = createSimSwapClient({ baseUrl: `${base}/sim-swap/v1`, getAccessToken: provider({ clientSecret: 'wrong' }) });
  await assert.rejects(client.check('+10000000001'), (e) => e instanceof CamaraError && e.code === 'TOKEN_ERROR' && e.status === 401);
});

test('operatorFromEnv picks mock, static token or client credentials', () => {
  assert.equal(operatorFromEnv({}).mock, true);
  assert.equal(operatorFromEnv({ CAMARA_BASE_URL: 'https://x', CAMARA_ACCESS_TOKEN: 't' }).auth, 'static token');
  const cc = operatorFromEnv({ CAMARA_BASE_URL: 'https://x', CAMARA_TOKEN_URL: 'https://x/token', CAMARA_BASIC_AUTH: 'abc' });
  assert.equal(cc.auth, 'client_credentials');
  assert.equal(typeof cc.getAccessToken, 'function');
  assert.throws(() => operatorFromEnv({ CAMARA_BASE_URL: 'https://x' }), /CAMARA_ACCESS_TOKEN/);
  assert.throws(() => operatorFromEnv({ CAMARA_BASE_URL: 'https://x', CAMARA_TOKEN_URL: 'https://x/token' }), /CLIENT_ID/);
});

test('parseDemoNumbers reads "number=label;number=label"', () => {
  assert.deepEqual(parseDemoNumbers(' +100=Swapped recently ; +200=Clean;+300 '), [
    { phoneNumber: '+100', label: 'Swapped recently' },
    { phoneNumber: '+200', label: 'Clean' },
    { phoneNumber: '+300', label: 'Sandbox test number' },
  ]);
  assert.deepEqual(parseDemoNumbers(undefined), []);
});
