// Per-request trace of what the bank's server did: which policy queries ran,
// which operator calls went out and what came back. The console shows it in
// the "Bank server" panel. Outside a traced request everything here is a no-op.

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** Runs fn and returns its result together with the events recorded meanwhile. */
export async function withTrace(fn) {
  const ctx = { t0: performance.now(), events: [] };
  const result = await store.run(ctx, fn);
  return { result, events: ctx.events };
}

const since = (ctx) => Math.round(performance.now() - ctx.t0);

/** Records a plain note, e.g. a policy value or a fallback. */
export function note(kind, text) {
  const ctx = store.getStore();
  if (ctx) ctx.events.push({ at: since(ctx), kind, text });
}

/**
 * Wraps a fetch so each call made during a traced request is recorded.
 * `redact` drops request and response bodies: use it for token endpoints,
 * whose responses carry credentials.
 */
export function tracedFetch(baseFetch, label, { redact = false } = {}) {
  return async (url, init = {}) => {
    const ctx = store.getStore();
    if (!ctx) return baseFetch(url, init);
    const at = since(ctx);
    const start = performance.now();
    const event = { at, kind: 'http', label, method: init.method ?? 'GET', url: shortUrl(url) };
    if (!redact && typeof init.body === 'string') event.request = init.body;
    ctx.events.push(event);
    try {
      const res = await baseFetch(url, init);
      event.status = res.status;
      event.ms = Math.round(performance.now() - start);
      if (!redact) event.response = (await res.clone().text().catch(() => '')).slice(0, 2000);
      return res;
    } catch (err) {
      event.status = 0;
      event.ms = Math.round(performance.now() - start);
      event.error = err.message;
      throw err;
    }
  };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host === 'mock.invalid' ? `mock${u.pathname}` : `${u.host}${u.pathname}`;
  } catch {
    return String(url);
  }
}
