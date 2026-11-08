// A mock mobile operator exposing the CAMARA SIM Swap API (v1 shape):
//   POST /sim-swap/v1/check          { phoneNumber, maxAge } -> { swapped }
//   POST /sim-swap/v1/retrieve-date  { phoneNumber }         -> { latestSimChange, monitoredPeriod }
//
// Spec: https://github.com/camaraproject/SimSwap
//
// The numbers below are from Ofcom's range reserved for drama/fiction
// (+44 7700 900xxx), so they can never belong to a real subscriber.
//
// The core is a plain (Request) -> Response function, so the same mock runs
// as a standalone server, in-process inside the demo, or as a serverless function.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { serve } from './node-adapter.js';

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

/**
 * @param {Request} request
 * @param {{ action?: string, now?: () => number }} [opts]
 *   action: 'check' | 'retrieve-date'. Defaults to the last segment of the URL path.
 */
export async function handleSimSwap(request, { action, now = Date.now } = {}) {
  const correlator = request.headers.get('x-correlator');
  const reply = (status, body) => {
    const headers = { 'content-type': 'application/json' };
    if (correlator) headers['x-correlator'] = correlator;
    return new Response(JSON.stringify(body), { status, headers });
  };
  const error = (status, code, message) => reply(status, { status, code, message });

  action ??= new URL(request.url).pathname.split('/').pop();
  if (request.method !== 'POST' || !['check', 'retrieve-date'].includes(action)) {
    return error(404, 'NOT_FOUND', 'The specified resource is not found.');
  }
  // Real operators issue tokens via OAuth2 (CIBA or authorization code).
  // The mock only checks that one is present.
  if (!/^Bearer \S+/.test(request.headers.get('authorization') ?? '')) {
    return error(401, 'UNAUTHENTICATED', 'Request not authenticated due to missing, invalid, or expired credentials.');
  }

  let body;
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return error(400, 'INVALID_ARGUMENT', 'Request body is not valid JSON.');
  }

  const { phoneNumber, maxAge = 240 } = body ?? {};
  if (typeof phoneNumber !== 'string' || !E164.test(phoneNumber)) {
    return error(400, 'INVALID_ARGUMENT', 'phoneNumber must be in E.164 format, e.g. +447700900001.');
  }

  const sub = SUBSCRIBERS[phoneNumber];
  if (!sub) return error(404, 'IDENTIFIER_NOT_FOUND', 'Device identifier not found.');
  if (sub.outage) return error(503, 'UNAVAILABLE', 'Service unavailable.');

  const changedAt = sub.hoursAgo == null ? null : now() - sub.hoursAgo * HOUR;

  if (action === 'check') {
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 2400) {
      return error(400, 'OUT_OF_RANGE', 'maxAge must be an integer between 1 and 2400 hours.');
    }
    return reply(200, { swapped: changedAt != null && now() - changedAt <= maxAge * HOUR });
  }

  return reply(200, {
    latestSimChange: changedAt == null ? null : new Date(changedAt).toISOString(),
    monitoredPeriod: MONITORED_PERIOD_DAYS,
  });
}

/** A fetch() that answers from the mock without touching the network. */
export const mockFetch = async (url, init) => handleSimSwap(new Request(url, init));

/** The mock as a standalone HTTP server. */
export function createMockOperator(opts) {
  return http.createServer(serve((request) => handleSimSwap(request, opts)));
}

// `npm run mock` runs the operator on its own, so you can curl it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  createMockOperator().listen(port, () => {
    console.log(`Mock CAMARA operator on http://localhost:${port}/sim-swap/v1`);
    for (const [n, s] of Object.entries(SUBSCRIBERS)) console.log(`  ${n}  ${s.label}`);
  });
}
