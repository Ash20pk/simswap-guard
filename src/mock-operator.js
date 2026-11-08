// A mock mobile operator exposing the CAMARA SIM Swap API (v1 shape):
//   POST /sim-swap/v1/check          { phoneNumber, maxAge } -> { swapped }
//   POST /sim-swap/v1/retrieve-date  { phoneNumber }         -> { latestSimChange, monitoredPeriod }
//
// Spec: https://github.com/camaraproject/SimSwap
//
// The numbers below are from Ofcom's range reserved for drama/fiction
// (+44 7700 900xxx), so they can never belong to a real subscriber.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOUR = 60 * 60 * 1000;
const MONITORED_PERIOD_DAYS = 120;

// hoursAgo: when the SIM was last changed. null = no change inside the monitored period.
export const SUBSCRIBERS = {
  '+447700900001': { hoursAgo: null, label: 'Clean: no SIM change on record' },
  '+447700900002': { hoursAgo: 2, label: 'SIM swapped 2 hours ago' },
  '+447700900003': { hoursAgo: 50, label: 'SIM swapped ~2 days ago' },
  '+447700900004': { hoursAgo: 24 * 30, label: 'SIM swapped 30 days ago (new phone)' },
  '+447700900009': { outage: true, label: 'Operator returns 503' },
};

const E164 = /^\+[1-9][0-9]{4,14}$/;

function error(res, status, code, message, correlator) {
  send(res, status, { status, code, message }, correlator);
}

function send(res, status, body, correlator) {
  const headers = { 'content-type': 'application/json' };
  if (correlator) headers['x-correlator'] = correlator;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createMockOperator({ now = () => Date.now() } = {}) {
  return http.createServer(async (req, res) => {
    const correlator = req.headers['x-correlator'];
    const route = req.url.split('?')[0];

    if (req.method !== 'POST' || !route.startsWith('/sim-swap/v1/')) {
      return error(res, 404, 'NOT_FOUND', 'The specified resource is not found.', correlator);
    }
    // Real operators issue tokens via OAuth2 (CIBA or authorization code).
    // The mock only checks that one is present.
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
      return error(res, 401, 'UNAUTHENTICATED', 'Request not authenticated due to missing, invalid, or expired credentials.', correlator);
    }

    let body;
    try {
      body = await readJson(req);
    } catch {
      return error(res, 400, 'INVALID_ARGUMENT', 'Request body is not valid JSON.', correlator);
    }

    const { phoneNumber, maxAge = 240 } = body;
    if (typeof phoneNumber !== 'string' || !E164.test(phoneNumber)) {
      return error(res, 400, 'INVALID_ARGUMENT', 'phoneNumber must be in E.164 format, e.g. +447700900001.', correlator);
    }

    const sub = SUBSCRIBERS[phoneNumber];
    if (!sub) {
      return error(res, 404, 'IDENTIFIER_NOT_FOUND', 'Device identifier not found.', correlator);
    }
    if (sub.outage) {
      return error(res, 503, 'UNAVAILABLE', 'Service unavailable.', correlator);
    }

    const changedAt = sub.hoursAgo == null ? null : new Date(now() - sub.hoursAgo * HOUR);

    if (route === '/sim-swap/v1/check') {
      if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 2400) {
        return error(res, 400, 'OUT_OF_RANGE', 'maxAge must be an integer between 1 and 2400 hours.', correlator);
      }
      const swapped = changedAt != null && now() - changedAt.getTime() <= maxAge * HOUR;
      return send(res, 200, { swapped }, correlator);
    }

    if (route === '/sim-swap/v1/retrieve-date') {
      return send(res, 200, {
        latestSimChange: changedAt ? changedAt.toISOString() : null,
        monitoredPeriod: MONITORED_PERIOD_DAYS,
      }, correlator);
    }

    return error(res, 404, 'NOT_FOUND', 'The specified resource is not found.', correlator);
  });
}

// `npm run mock` runs the operator on its own, so you can curl it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  createMockOperator().listen(port, () => {
    console.log(`Mock CAMARA operator on http://localhost:${port}/sim-swap/v1`);
    for (const [n, s] of Object.entries(SUBSCRIBERS)) console.log(`  ${n}  ${s.label}`);
  });
}
