// Local server for the demo: the pages, the bank API, and the mock operator,
// all on one port. On Vercel the same handlers run from /api instead.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { serve } from './node-adapter.js';
import { login, pay, demoNumbers, status, getPolicy, putPolicy, evaluatePolicy, operator, policyEngine } from './bank.js';
import { handleSimSwap } from './mock-operator.js';

const PORT = Number(process.env.PORT ?? 3000);

// The static pages, by URL. Same clean URLs as Vercel's cleanUrls.
const PAGES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/policy': ['policy.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
};

const routes = {
  'GET /api/demo-numbers': demoNumbers,
  'GET /api/status': status,
  'POST /api/login': login,
  'POST /api/pay': pay,
  'GET /api/policy': getPolicy,
  'PUT /api/policy': putPolicy,
  'POST /api/policy/evaluate': evaluatePolicy,
};

const server = http.createServer(serve(async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/sim-swap/v1/')) return handleSimSwap(request);
  const page = request.method === 'GET' && PAGES[pathname];
  if (page) {
    const [file, type] = page;
    return new Response(await readFile(new URL(`../public/${file}`, import.meta.url)), { headers: { 'content-type': type } });
  }
  const handler = routes[`${request.method} ${pathname}`];
  return handler ? handler(request) : Response.json({ error: 'Not found' }, { status: 404 });
}));

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  Port ${PORT} is already in use. Pick another one, e.g.\n\n    PORT=${PORT + 1} npm start\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  SIM swap guard demo  ->  http://localhost:${PORT}   (policy: http://localhost:${PORT}/policy)`);
  console.log(`  Operator: ${operator.mock ? `built-in mock (also at http://localhost:${PORT}/sim-swap/v1)` : `real (${operator.baseUrl}, ${operator.auth})`}`);
  console.log(`  Policy:   ${policyEngine.label}\n`);
});
