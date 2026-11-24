// The decision policy lives in policy/guard.rego and its thresholds in
// policy/data.json. Two engines evaluate it:
//
//   OPA       when OPA_URL is set: the real Open Policy Agent, over its REST API.
//   built-in  otherwise: a line-for-line JavaScript copy of guard.rego, so the
//             demo runs with no extra service (and on Vercel). A parity test
//             runs both on the same inputs to keep them in step.
//
// Both return the whole package document, as OPA does for data.simswap.guard:
//   { window_hours, operator_down?, recent_swap?, large_payment?, decision, cfg }
// Rules that are false are absent, as in OPA.

import { readFileSync } from 'node:fs';

export const REGO_SOURCE = readFileSync(new URL('../policy/guard.rego', import.meta.url), 'utf8');
export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL('../policy/data.json', import.meta.url), 'utf8')).simswap.config;

export const ACTIONS = ['login', 'payment'];
const RESULTS = ['allow', 'step_up', 'review', 'block'];

/** Checks a config edited on the policy page and returns a clean copy. Throws with a readable message. */
export function validateConfig(c) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { code: 'INVALID_CONFIG' }); };
  const hours = (v, name) => (Number.isInteger(v) && v >= 1 && v <= 2400 ? v : fail(`${name} must be a whole number of hours, 1 to 2400.`));
  const result = (v, name) => (RESULTS.includes(v) ? v : fail(`${name} must be one of ${RESULTS.join(', ')}.`));
  if (!c || typeof c !== 'object') fail('Config must be an object.');
  const blockAbove = c.block_above;
  if (typeof blockAbove !== 'number' || !Number.isInteger(blockAbove) || blockAbove < 0) fail('block_above must be a whole, non-negative amount.');
  return {
    windows: { login: hours(c.windows?.login, 'windows.login'), payment: hours(c.windows?.payment, 'windows.payment') },
    block_above: blockAbove,
    on_error: { login: result(c.on_error?.login, 'on_error.login'), payment: result(c.on_error?.payment, 'on_error.payment') },
  };
}

/** JavaScript copy of policy/guard.rego. Keep the two in step: test/opa.test.js checks it. */
export function evaluateGuard(input, cfg) {
  const doc = { cfg };
  const signal = input.signal;
  const windowHours = cfg.windows[input.action];
  if (windowHours !== undefined) doc.window_hours = windowHours;

  const operatorDown = signal?.status !== undefined && signal.status !== 200;
  const recentSwap = !operatorDown && signal?.swapped === true;
  const largePayment = input.action === 'payment' && typeof input.amount === 'number' && input.amount > cfg.block_above;
  if (operatorDown) doc.operator_down = true;
  if (recentSwap) doc.recent_swap = true;
  if (largePayment) doc.large_payment = true;

  const onError = cfg.on_error[input.action];
  if (operatorDown && onError !== undefined) {
    doc.decision = {
      result: onError, rule: 'operator_down',
      reason: `No SIM swap signal (${signal.code ?? 'error'}). Falling back to ${onError}.`,
      obligations: ['log_for_review'],
    };
  } else if (recentSwap && largePayment) {
    doc.decision = {
      result: 'block', rule: 'swap_large_payment',
      reason: `SIM changed in the last ${windowHours}h and the amount is over ${cfg.block_above}.`,
      obligations: ['notify_out_of_band'],
    };
  } else if (recentSwap) {
    doc.decision = {
      result: 'step_up', rule: 'swap_step_up',
      reason: `SIM changed in the last ${windowHours}h. An SMS code to this number proves nothing.`,
      obligations: ['no_sms_otp', 'require_passkey'],
    };
  } else {
    doc.decision = { result: 'allow', rule: 'no_recent_swap', reason: 'No SIM change inside the window.', obligations: [] };
  }
  return doc;
}

export function createBuiltinEngine({ config = DEFAULT_CONFIG } = {}) {
  let live = structuredClone(config);
  let rev = 1;
  return {
    kind: 'builtin',
    label: 'Built-in copy of guard.rego',
    async evaluate(input, draft) {
      return evaluateGuard(input, draft ?? live);
    },
    async getConfig() {
      return { config: live, rev };
    },
    async setConfig(next) {
      live = validateConfig(next);
      rev += 1;
      return { config: live, rev };
    },
  };
}

/**
 * Open Policy Agent over its REST API. Expects guard.rego and data.json
 * already loaded, e.g. `opa run --server policy/guard.rego policy/data.json`.
 * Publishing writes data.simswap.config and bumps data.simswap.meta.rev.
 */
export function createOpaEngine({ url, fetchImpl = fetch, timeoutMs = 2000 }) {
  const root = url.replace(/\/$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OPA ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    kind: 'opa',
    label: `OPA at ${new URL(root).host}`,
    async evaluate(input, draft) {
      if (!draft) return (await call('POST', '/v1/data/simswap/guard', { input })).result ?? {};
      // An unpublished config: swap it in for this one query only.
      const { result } = await call('POST', '/v1/query', {
        query: 'cfg := input.config; req := input.request; x := data.simswap.guard with data.simswap.config as cfg with input as req',
        input: { request: input, config: draft },
      });
      return result?.[0]?.x ?? {};
    },
    async getConfig() {
      const { result } = await call('GET', '/v1/data/simswap');
      if (!result?.config) throw new Error('OPA has no data.simswap.config. Load policy/data.json into it.');
      return { config: result.config, rev: result.meta?.rev ?? 1 };
    },
    async setConfig(next) {
      const config = validateConfig(next);
      const { rev } = await this.getConfig();
      await call('PUT', '/v1/data/simswap/config', config);
      await call('PUT', '/v1/data/simswap/meta', { rev: rev + 1 });
      return { config, rev: rev + 1 };
    },
  };
}
