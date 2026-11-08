// Local server for the demo: the page, the bank API, and the mock operator,
// all on one port. On Vercel the same handlers run from /api instead.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { serve } from './node-adapter.js';
import { login, pay, demoNumbers, operator } from './bank.js';
import { handleSimSwap } from './mock-operator.js';

const PORT = Number(process.env.PORT ?? 3000);

const routes = {
  'GET /': async () => new Response(await readFile(new URL('../public/index.html', import.meta.url)), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }),
  'GET /api/demo-numbers': demoNumbers,
  'POST /api/login': login,
  'POST /api/pay': pay,
};

const server = http.createServer(serve((request) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/sim-swap/v1/')) return handleSimSwap(request);
  const handler = routes[`${request.method} ${pathname}`];
  return handler ? handler(request) : Response.json({ error: 'Not found' }, { status: 404 });
}));

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  Port ${PORT} is already in use. Pick another one, e.g.\n\n    PORT=${PORT + 1} npm start\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  SIM swap guard demo  ->  http://localhost:${PORT}`);
  console.log(`  Operator: ${operator.mock ? `built-in mock (also at http://localhost:${PORT}/sim-swap/v1)` : `real (${operator.baseUrl})`}\n`);
});
