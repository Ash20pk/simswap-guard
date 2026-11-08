// Minimal client for the CAMARA SIM Swap API. Works against the mock or a
// real operator/aggregator: only the base URL and access token change.

import { randomUUID } from 'node:crypto';

export class CamaraError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

// fetchImpl lets you swap the transport, e.g. the in-process mock.
export function createSimSwapClient({ baseUrl, accessToken, timeoutMs = 3000, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, '');

  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          'x-correlator': randomUUID(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CamaraError(0, 'NETWORK_ERROR', err.message);
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
