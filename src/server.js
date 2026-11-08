// Demo app: a mock bank with a login and a payment form, both gated on the
// CAMARA SIM Swap API. With no env vars set it starts the mock operator too.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSimSwapClient } from './camara-client.js';
import { createMockOperator, SUBSCRIBERS } from './mock-operator.js';
import { assess } from './policy.js';

const PORT = Number(process.env.PORT ?? 3000);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4010);
const DEMO_PASSWORD = 'demo';

async function resolveOperator() {
  if (process.env.CAMARA_BASE_URL) {
    if (!process.env.CAMARA_ACCESS_TOKEN) throw new Error('CAMARA_BASE_URL is set but CAMARA_ACCESS_TOKEN is not.');
    return { baseUrl: process.env.CAMARA_BASE_URL, accessToken: process.env.CAMARA_ACCESS_TOKEN, mock: false };
  }
  await new Promise((resolve) => createMockOperator().listen(MOCK_PORT, resolve));
  return { baseUrl: `http://localhost:${MOCK_PORT}/sim-swap/v1`, accessToken: 'mock-token', mock: true };
}

const operator = await resolveOperator();
const simSwap = createSimSwapClient(operator);
const sessions = new Map(); // token -> phoneNumber

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const routes = {
  'GET /': async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(new URL('../public/index.html', import.meta.url)));
  },

  'GET /api/test-numbers': (req, res) => json(res, 200, operator.mock
    ? Object.entries(SUBSCRIBERS).map(([phoneNumber, s]) => ({ phoneNumber, label: s.label }))
    : []),

  'POST /api/login': async (req, res) => {
    const { phoneNumber, password } = await body(req);
    if (password !== DEMO_PASSWORD) return json(res, 401, { error: 'Wrong password (it is "demo").' });

    const result = await assess(simSwap, { action: 'login', phoneNumber });
    log('login', phoneNumber, result);
    if (result.decision === 'block') return json(res, 403, result);

    const token = randomUUID();
    sessions.set(token, phoneNumber);
    json(res, 200, { ...result, token });
  },

  'POST /api/pay': async (req, res) => {
    const phoneNumber = sessions.get(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!phoneNumber) return json(res, 401, { error: 'Log in first.' });

    const { amount, payee } = await body(req);
    const value = Number(amount);
    if (!(value > 0)) return json(res, 400, { error: 'Amount must be a positive number.' });

    const result = await assess(simSwap, { action: 'payment', phoneNumber, amount: value });
    log('payment', phoneNumber, result, `${value} -> ${payee || 'unknown payee'}`);
    json(res, result.decision === 'block' ? 403 : 200, result);
  },
};

function log(action, phoneNumber, { decision, reason }, extra = '') {
  console.log(`[${action}] ${phoneNumber} ${extra} => ${decision.toUpperCase()} (${reason})`);
}

http.createServer(async (req, res) => {
  const handler = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!handler) return json(res, 404, { error: 'Not found' });
  try {
    await handler(req, res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Internal error' });
  }
}).listen(PORT, () => {
  console.log(`\n  SIM swap guard demo  ->  http://localhost:${PORT}`);
  console.log(`  Operator: ${operator.mock ? 'built-in mock' : 'real'} (${operator.baseUrl})\n`);
});
