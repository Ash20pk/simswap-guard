// Minimal client for the CAMARA SIM Swap API. Works against the mock or a
// real operator/aggregator: only the base URL and credentials change.

import { randomUUID } from 'node:crypto';

export class CamaraError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/**
 * OAuth 2.0 client credentials (two-legged), as used by operator sandboxes such
 * as the Orange Network APIs Playground. Caches the token and refreshes it a
 * minute before it expires; concurrent callers share one in-flight request.
 *
 * Pass either `clientId` + `clientSecret`, or `basicAuth` (the pre-encoded
 * base64 "id:secret" string some developer consoles hand out).
 *
 * Production SIM Swap at most operators uses a three-legged flow (CIBA or
 * authorization code) with the subscriber's consent. That is out of scope here.
 */
export function createClientCredentialsTokenProvider({
  tokenUrl, clientId, clientSecret, basicAuth, scope, timeoutMs = 5000, fetchImpl = fetch, now = Date.now,
}) {
  const credentials = basicAuth ?? Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let cached = null; // { token, expiresAt }
  let inFlight = null;

  async function fetchToken() {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) body.set('scope', scope);
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials.replace(/^Basic /, '')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CamaraError(0, 'TOKEN_NETWORK_ERROR', err.message);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new CamaraError(res.status, 'TOKEN_ERROR', data.error_description ?? data.error ?? res.statusText);
    }
    const ttlMs = (Number(data.expires_in) || 3600) * 1000;
    cached = { token: data.access_token, expiresAt: now() + ttlMs - Math.min(60_000, ttlMs / 2) };
    return cached.token;
  }

  async function getToken() {
    if (cached && now() < cached.expiresAt) return cached.token;
    inFlight ??= fetchToken().finally(() => { inFlight = null; });
    return inFlight;
  }
  getToken.invalidate = () => { cached = null; };
  return getToken;
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.accessToken]  a static bearer token, or
 * @param {() => Promise<string>} [opts.getAccessToken]  a token provider (see above)
 * @param {typeof fetch} [opts.fetchImpl]  swap the transport, e.g. the in-process mock
 */
export function createSimSwapClient({ baseUrl, accessToken, getAccessToken, timeoutMs = 3000, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, '');
  const tokenFor = getAccessToken ?? (async () => accessToken);

  async function send(path, body, token) {
    try {
      return await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-correlator': randomUUID(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CamaraError(0, 'NETWORK_ERROR', err.message);
    }
  }

  async function post(path, body) {
    let res = await send(path, body, await tokenFor());
    // A cached token can be revoked or expire early: fetch a fresh one once.
    if (res.status === 401 && getAccessToken?.invalidate) {
      getAccessToken.invalidate();
      res = await send(path, body, await tokenFor());
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CamaraError(res.status, data.code ?? 'UNKNOWN', data.message ?? res.statusText);
    return data;
  }

  return {
    /** Has the SIM changed within the last `maxAge` hours (1–2400)? */
    async check(phoneNumber, maxAge = 240) {
      const { swapped } = await post('/check', { phoneNumber, maxAge });
      return swapped;
    },
    /** When did the SIM last change? null if not within the operator's monitored period. */
    async retrieveDate(phoneNumber) {
      const { latestSimChange } = await post('/retrieve-date', { phoneNumber });
      return latestSimChange ? new Date(latestSimChange) : null;
    },
  };
}
