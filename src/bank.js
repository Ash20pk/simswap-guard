// The demo bank's API: login and payment, both gated on the SIM swap check.
// Each handler is (Request) -> Response, shared by the local server and the
// Vercel functions in /api.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSimSwapClient } from './camara-client.js';
import { mockFetch, SUBSCRIBERS } from './mock-operator.js';
import { assess } from './policy.js';

const DEMO_PASSWORD = 'demo';
const SESSION_TTL_MS = 30 * 60 * 1000;

// Real operator if configured, otherwise the mock answers in-process.
const useMock = !process.env.CAMARA_BASE_URL;
if (!useMock && !process.env.CAMARA_ACCESS_TOKEN) {
  throw new Error('CAMARA_BASE_URL is set but CAMARA_ACCESS_TOKEN is not.');
}
export const operator = useMock
  ? { mock: true, baseUrl: 'http://mock.invalid/sim-swap/v1', accessToken: 'mock-token', fetchImpl: mockFetch }
  : { mock: false, baseUrl: process.env.CAMARA_BASE_URL, accessToken: process.env.CAMARA_ACCESS_TOKEN };

const simSwap = createSimSwapClient(operator);

// Stateless sessions: a signed token, so any serverless instance can verify it.
const SECRET = process.env.SESSION_SECRET ?? 'local-dev-only-secret';
const sign = (data) => createHmac('sha256', SECRET).update(data).digest('base64url');

function issueToken(phoneNumber) {
  const payload = Buffer.from(JSON.stringify({ phoneNumber, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(header) {
  const [payload, sig] = (header ?? '').replace(/^Bearer /, '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const { phoneNumber, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return exp > Date.now() ? phoneNumber : null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function log(action, phoneNumber, { decision, reason }, extra = '') {
  console.log(`[${action}] ${phoneNumber} ${extra}=> ${decision.toUpperCase()} (${reason})`);
}

export function demoNumbers() {
  return Response.json(useMock
    ? Object.entries(SUBSCRIBERS).map(([phoneNumber, s]) => ({ phoneNumber, label: s.label }))
    : []);
}

export async function login(request) {
  const { phoneNumber, password } = await readJson(request);
  if (password !== DEMO_PASSWORD) return Response.json({ error: 'Wrong password (it is "demo").' }, { status: 401 });

  const result = await assess(simSwap, { action: 'login', phoneNumber });
  log('login', phoneNumber, result);
  if (result.decision === 'block') return Response.json(result, { status: 403 });
  return Response.json({ ...result, token: issueToken(phoneNumber) });
}

export async function pay(request) {
  const phoneNumber = readToken(request.headers.get('authorization'));
  if (!phoneNumber) return Response.json({ error: 'Log in first.' }, { status: 401 });

  const { amount, payee } = await readJson(request);
  const value = Number(amount);
  if (!(value > 0)) return Response.json({ error: 'Amount must be a positive number.' }, { status: 400 });

  const result = await assess(simSwap, { action: 'payment', phoneNumber, amount: value });
  log('payment', phoneNumber, result, `${value} -> ${payee || 'unknown payee'} `);
  return Response.json(result, { status: result.decision === 'block' ? 403 : 200 });
}
