// The demo bank's API: login and payment, both gated on the SIM swap check,
// plus the policy page's endpoints. Each handler is (Request) -> Response,
// shared by the local server and the Vercel functions in /api.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSimSwapClient, createClientCredentialsTokenProvider, CamaraError } from './camara-client.js';
import { mockFetch, SUBSCRIBERS } from './mock-operator.js';
import { ACTIONS, DEFAULT_CONFIG, REGO_SOURCE, createBuiltinEngine, createOpaEngine, evaluateGuard, validateConfig } from './policy.js';
import { note, tracedFetch, withTrace } from './trace.js';

const DEMO_PASSWORD = 'demo';
const SESSION_TTL_MS = 30 * 60 * 1000;

// Real operator if configured, otherwise the mock answers in-process.
//   CAMARA_BASE_URL       e.g. https://<provider>/sim-swap/v1
//   then either CAMARA_ACCESS_TOKEN (a static token)
//   or CAMARA_TOKEN_URL + CAMARA_CLIENT_ID + CAMARA_CLIENT_SECRET (or CAMARA_BASIC_AUTH), optional CAMARA_SCOPE
//   CAMARA_DEMO_NUMBERS   optional, the sandbox's test numbers for the page: "<number>=<label>;<number>=<label>"
export function operatorFromEnv(env = process.env) {
  if (!env.CAMARA_BASE_URL) {
    return { mock: true, baseUrl: 'http://mock.invalid/sim-swap/v1', accessToken: 'mock-token', fetchImpl: mockFetch };
  }
  const base = { mock: false, baseUrl: env.CAMARA_BASE_URL };
  if (env.CAMARA_TOKEN_URL) {
    const hasPair = env.CAMARA_CLIENT_ID && env.CAMARA_CLIENT_SECRET;
    if (!hasPair && !env.CAMARA_BASIC_AUTH) {
      throw new Error('CAMARA_TOKEN_URL is set: also set CAMARA_CLIENT_ID and CAMARA_CLIENT_SECRET, or CAMARA_BASIC_AUTH.');
    }
    return {
      ...base,
      auth: 'client_credentials',
      getAccessToken: createClientCredentialsTokenProvider({
        tokenUrl: env.CAMARA_TOKEN_URL,
        clientId: env.CAMARA_CLIENT_ID,
        clientSecret: env.CAMARA_CLIENT_SECRET,
        basicAuth: env.CAMARA_BASIC_AUTH,
        scope: env.CAMARA_SCOPE,
        // Recorded in the trace, but never with bodies: the response carries the token.
        fetchImpl: tracedFetch(globalThis.fetch, 'token', { redact: true }),
      }),
    };
  }
  if (!env.CAMARA_ACCESS_TOKEN) {
    throw new Error('CAMARA_BASE_URL is set: also set CAMARA_ACCESS_TOKEN, or CAMARA_TOKEN_URL with client credentials.');
  }
  return { ...base, auth: 'static token', accessToken: env.CAMARA_ACCESS_TOKEN };
}

export function parseDemoNumbers(value = '') {
  return value.split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [phoneNumber, ...label] = entry.split('=');
    return { phoneNumber: phoneNumber.trim(), label: label.join('=').trim() || 'Sandbox test number' };
  });
}

export const operator = operatorFromEnv();
const sandboxNumbers = parseDemoNumbers(process.env.CAMARA_DEMO_NUMBERS);
const simSwap = createSimSwapClient({ ...operator, fetchImpl: tracedFetch(operator.fetchImpl ?? globalThis.fetch, 'operator') });

// OPA if configured, otherwise the built-in copy of guard.rego.
export const policyEngine = process.env.OPA_URL
  ? createOpaEngine({ url: process.env.OPA_URL, fetchImpl: tracedFetch(globalThis.fetch, 'opa') })
  : createBuiltinEngine();

function operatorName() {
  if (operator.mock) return 'Built-in mock operator';
  const host = new URL(operator.baseUrl).host;
  return host === 'api.orange.com' ? 'Orange Network APIs Playground' : host;
}

// ---------------------------------------------------------------------------
// The decision: ask the policy for the window, ask the operator, ask the policy again.

async function evaluate(input, draft) {
  try {
    const doc = await policyEngine.evaluate(input, draft);
    if (!doc?.decision || doc.window_hours === undefined) throw new Error('the policy returned no decision');
    return doc;
  } catch (err) {
    if (policyEngine.kind === 'builtin') throw err;
    // OPA unreachable or misconfigured: decide with the built-in copy and say so.
    note('policy', `OPA failed (${err.message}). Using the built-in copy of guard.rego with its default thresholds.`);
    return evaluateGuard(input, draft ?? DEFAULT_CONFIG);
  }
}

/**
 * @param {{ action: 'login'|'payment', phoneNumber: string, amount?: number }} req
 * @param {object} [draft]  an unpublished config to evaluate against instead of the live one
 */
export async function decide({ action, phoneNumber, amount }, draft) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  const { window_hours: windowHours } = await evaluate({ action }, draft);
  note('policy', `window_hours = ${windowHours}`);

  let signal;
  try {
    signal = { status: 200, swapped: await simSwap.check(phoneNumber, windowHours) };
  } catch (err) {
    if (!(err instanceof CamaraError)) throw err;
    signal = { status: err.status, code: err.code };
  }

  const input = { action, phone_number: phoneNumber, signal };
  if (action === 'payment') input.amount = amount;
  const doc = await evaluate(input, draft);
  const { cfg, decision, ...rules } = doc;
  note('decision', `${decision.result} (${decision.rule})`);
  return { input, rules, decision: { ...decision, window_hours: windowHours } };
}

async function decideTraced(req, draft) {
  const { result, events } = await withTrace(() => decide(req, draft));
  return { ...result, trace: events };
}

// ---------------------------------------------------------------------------
// Sessions: a signed token, so any serverless instance can verify it.

const SECRET = process.env.SESSION_SECRET ?? 'local-dev-only-secret';
const sign = (data) => createHmac('sha256', SECRET).update(data).digest('base64url');

function issueToken(phoneNumber) {
  const payload = Buffer.from(JSON.stringify({ phoneNumber, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readToken(header) {
  const [payload, sig] = (header ?? '').replace(/^Bearer /, '').split('.');
  if (!payload || !sig || !safeEqual(sign(payload), sig)) return null;
  const { phoneNumber, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return exp > Date.now() ? phoneNumber : null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function log(action, phoneNumber, { decision }, extra = '') {
  console.log(`[${action}] ${phoneNumber} ${extra}=> ${decision.result.toUpperCase()} (${decision.rule}: ${decision.reason})`);
}

// Flat fields for simple clients, the structured decision and trace for the console.
function body({ decision, ...rest }, extra = {}) {
  return {
    decision: decision.result, reason: decision.reason, rule: decision.rule, obligations: decision.obligations,
    structured: decision, ...rest, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Bank endpoints

export function demoNumbers() {
  return Response.json(operator.mock
    ? Object.entries(SUBSCRIBERS).map(([phoneNumber, s]) => ({ phoneNumber, label: s.label }))
    : sandboxNumbers);
}

export async function status() {
  const { rev } = await policyEngine.getConfig().catch(() => ({ rev: null }));
  return Response.json({
    operator: { mock: operator.mock, name: operatorName(), auth: operator.mock ? null : operator.auth },
    policy: { engine: policyEngine.kind, label: policyEngine.label, rev },
  });
}

export async function login(request) {
  const { phoneNumber, password } = await readJson(request);
  if (password !== DEMO_PASSWORD) return Response.json({ error: 'Wrong password (it is "demo").' }, { status: 401 });

  const outcome = await decideTraced({ action: 'login', phoneNumber });
  log('login', phoneNumber, outcome);
  if (outcome.decision.result === 'block') return Response.json(body(outcome), { status: 403 });
  return Response.json(body(outcome, { token: issueToken(phoneNumber) }));
}

export async function pay(request) {
  const phoneNumber = readToken(request.headers.get('authorization'));
  if (!phoneNumber) return Response.json({ error: 'Log in first.' }, { status: 401 });

  const { amount, payee } = await readJson(request);
  const value = Number(amount);
  if (!(value > 0)) return Response.json({ error: 'Amount must be a positive number.' }, { status: 400 });

  const outcome = await decideTraced({ action: 'payment', phoneNumber, amount: value });
  log('payment', phoneNumber, outcome, `${value} -> ${payee || 'unknown payee'} `);
  return Response.json(body(outcome), { status: outcome.decision.result === 'block' ? 403 : 200 });
}

// ---------------------------------------------------------------------------
// Policy page endpoints

// Publishing changes the policy for everyone, so a deployment needs a token for it.
// Locally it is open; on Vercel it is closed unless POLICY_ADMIN_TOKEN is set and sent.
function publishAllowed(request) {
  const required = process.env.POLICY_ADMIN_TOKEN;
  if (required) return safeEqual(request.headers.get('x-admin-token') ?? '', required);
  return !process.env.VERCEL;
}

export async function getPolicy() {
  let live, engineError;
  try {
    live = await policyEngine.getConfig();
  } catch (err) {
    // OPA unreachable: show the defaults the fallback would use, and say why.
    live = { config: DEFAULT_CONFIG, rev: null };
    engineError = `${err.message}. Decisions fall back to the built-in copy of guard.rego until it is back.`;
  }
  return Response.json({
    engine: policyEngine.kind, label: policyEngine.label,
    rego: REGO_SOURCE, defaults: DEFAULT_CONFIG,
    publishNeedsToken: Boolean(process.env.POLICY_ADMIN_TOKEN) || Boolean(process.env.VERCEL),
    engineError,
    ...live,
  });
}

export async function putPolicy(request) {
  if (!publishAllowed(request)) {
    const msg = process.env.POLICY_ADMIN_TOKEN ? 'Wrong or missing admin token.' : 'Publishing is off on this deployment. Set POLICY_ADMIN_TOKEN to turn it on.';
    return Response.json({ error: msg }, { status: 403 });
  }
  const { config } = await readJson(request);
  try {
    const live = await policyEngine.setConfig(config);
    console.log(`[policy] published rev ${live.rev}: ${JSON.stringify(live.config)}`);
    return Response.json(live);
  } catch (err) {
    if (err.code === 'INVALID_CONFIG') return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

/** The policy page's "Try it": a real operator call and a real policy evaluation, against a draft config if given. */
export async function evaluatePolicy(request) {
  const { action, phoneNumber, amount, config } = await readJson(request);
  if (!ACTIONS.includes(action)) return Response.json({ error: 'action must be login or payment.' }, { status: 400 });
  if (typeof phoneNumber !== 'string' || !phoneNumber) return Response.json({ error: 'phoneNumber is required.' }, { status: 400 });
  let draft;
  try {
    draft = config ? validateConfig(config) : undefined;
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const outcome = await decideTraced({ action, phoneNumber, amount: Number(amount) || 0 }, draft);
  return Response.json(body(outcome, { draft: Boolean(draft) }));
}
