# SIM Swap Guard

**Stop account takeovers that start with a hijacked phone number.** A small, dependency-free Node app that checks the [CAMARA SIM Swap API](https://github.com/camaraproject/SimSwap) before it trusts a login or a payment, and leaves the decision to a [Rego](https://www.openpolicyagent.org/docs/policy-language) policy you can run in [Open Policy Agent](https://www.openpolicyagent.org). It runs against a built-in mock operator, so you can try it in under five minutes with no telco account and no OPA.

**▶ Live demo: [simswap-guard.vercel.app](https://simswap-guard.vercel.app)** (password `demo`)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAsh20pk%2Fsimswap-guard&env=SESSION_SECRET&envDescription=Any%20long%20random%20string%2C%20used%20to%20sign%20demo%20login%20tokens)

Or run it locally:

```
git clone https://github.com/Ash20pk/simswap-guard && cd simswap-guard && npm start
```

Then open http://localhost:3000 for the console and http://localhost:3000/policy for the policy page.

---

## Why this matters

In a SIM swap attack, a fraudster talks a mobile operator into moving your number onto their SIM. From then on, every SMS one-time code your bank sends goes to them. The password reset works and the payment confirmation works, because the second factor now belongs to the attacker.

Your app can't see this happen. **The mobile network can.** CAMARA, a Linux Foundation project backed by GSMA operators, standardises an API that lets you ask the operator one question: *has the SIM behind this number changed in the last N hours?*

This repo shows one way to turn that answer into a decision.

## Quickstart (under 5 minutes)

**Requirements:** Node.js 18 or newer. There is nothing to `npm install`.

```bash
git clone https://github.com/Ash20pk/simswap-guard
cd simswap-guard
npm start
```

Open **http://localhost:3000** (or the [live demo](https://simswap-guard.vercel.app)) and try these numbers (password: `demo`):

| Number | What the mock operator says | Login | Pay 750 |
|---|---|---|---|
| `+447700900001` | No SIM change on record | ✅ allow | ✅ allow |
| `+447700900002` | SIM swapped **2 hours ago** | ⚠️ step up | ⛔ block |
| `+447700900003` | SIM swapped **~2 days ago** | ✅ allow | ⛔ block |
| `+447700900004` | SIM swapped 30 days ago (new phone) | ✅ allow | ✅ allow |
| `+447700900009` | Operator is down (503) | ✅ allow (fail open) | 🕓 review (fail closed) |

The numbers come from Ofcom's range reserved for TV and film, so none of them can belong to a real person.

Port taken? Run `PORT=3001 npm start`.

Run the tests:

```bash
npm test
```

## How it works

Every login and payment makes three calls:

```
 Browser ──► demo bank (bank.js)
               1. policy:   window_hours for this action?            ──► OPA or built-in   → 24
               2. operator: SIM changed in the last 24h?             ──► mock or real      → { swapped: true }
               3. policy:   decision for { action, amount, signal }? ──► OPA or built-in   → { result: "step_up", ... }
```

The decision comes back structured, not as a bare string:

```json
{
  "result": "step_up",
  "rule": "swap_step_up",
  "reason": "SIM changed in the last 24h. An SMS code to this number proves nothing.",
  "obligations": ["no_sms_otp", "require_passkey"],
  "window_hours": 24
}
```

`obligations` tell the app what it must do next, so the policy can tighten a flow without an app change.

The console's **Bank server** panel shows each of those calls as it happened: the policy queries, the token request (body never shown), the operator request and response, and the decision.

| File | What it is |
|---|---|
| [`policy/guard.rego`](policy/guard.rego) | **The part to copy.** The decision rules, in Rego. |
| [`policy/data.json`](policy/data.json) | The thresholds: windows, block amount, what to do when the operator is down. |
| [`policy/guard_test.rego`](policy/guard_test.rego) | Rego unit tests (`npm run test:opa`). |
| [`src/policy.js`](src/policy.js) | The two engines: OPA over REST, and a built-in JavaScript copy of `guard.rego`. |
| [`src/camara-client.js`](src/camara-client.js) | Client for `/check` and `/retrieve-date`, with OAuth client credentials. |
| [`src/mock-operator.js`](src/mock-operator.js) | Mock operator with the CAMARA request, response and error shapes. |
| [`src/bank.js`](src/bank.js) | The demo bank's API: login, payment and the policy page, as `(Request) → Response` handlers. |
| [`src/trace.js`](src/trace.js) | Records the calls made during a request, for the console. |
| [`public/`](public) | The console (`index.html`) and the policy page (`policy.html`). |
| [`src/dev-server.js`](src/dev-server.js) | Local server for `npm start`: the pages, the API and the mock on one port. |
| [`api/`](api) | The same handlers as Vercel functions. |

### The policy

These are the defaults in [`policy/data.json`](policy/data.json). The policy page changes them.

| Action | Window | SIM changed within window | Operator unavailable |
|---|---|---|---|
| Login | 24h | **Step up**, never by SMS | Allow and log it (fail open) |
| Payment ≤ 500 | 72h | **Step up** | Hold for review (fail closed) |
| Payment > 500 | 72h | **Block** and alert by email or in the app | Hold for review (fail closed) |

The details that are easy to get wrong:

- **Never step up with SMS.** If the SIM has just changed, an SMS OTP goes to the attacker. Use a passkey, an app push or an ID check.
- **Fail differently per action.** An operator outage shouldn't lock every customer out, but it shouldn't wave money through either.
- **A swap is not proof of fraud.** People buy new phones. That's why a 30-day-old swap passes and the window is short.
- **"Number not found" is not "safe".** It means the operator has no signal for you, often because the number belongs to another network. Treat it like an outage.

## The policy engine (OPA)

The rules live in [`policy/guard.rego`](policy/guard.rego). Two engines can evaluate them:

- **Built-in** (the default): a JavaScript copy of `guard.rego` in [`src/policy.js`](src/policy.js). The demo then needs no other service, and this is what the Vercel deployment uses. A test runs both engines on the same 48 cases, so a change to one without the other fails CI.
- **OPA**: set `OPA_URL` and the app sends every policy query to Open Policy Agent over its REST API.

To run with OPA locally ([install OPA](https://www.openpolicyagent.org/docs#running-opa) first):

```bash
npm run demo
```

That starts OPA on :8181 with `guard.rego` and this deployment's thresholds loaded, then the app pointed at it, and Ctrl+C stops both. It reads `.env` if there is one, so with operator credentials and `POLICY_CONFIG` there (see below) it is the whole sandbox demo in one command. `OPA_PORT` moves OPA if 8181 is taken. Without the `opa` binary it says so and runs the built-in engine. It needs Node 22.9 or newer.

Or run the two yourself:

```bash
npm run opa                                  # OPA on :8181 with guard.rego and data.json loaded
OPA_URL=http://localhost:8181 npm start      # in another terminal
```

If OPA stops answering, decisions fall back to the built-in copy with its default thresholds. The console's trace says when that happens.

**The policy page** (`/policy`) shows the Rego and the thresholds. Change a threshold and **Try it** evaluates a real request, operator call included, against the draft before anything is published. **Publish** writes the thresholds to `data.simswap.config` and bumps `data.simswap.meta.rev`. The rules themselves are not editable there. They change through code review.

Publishing changes decisions for everyone, so:

- **locally**, it is open;
- **on a deployment**, it is off unless you set `POLICY_ADMIN_TOKEN`, and then the page asks for that token.

With the built-in engine, published thresholds live in memory: they reset on restart, and on Vercel each function instance keeps its own. Use OPA when they need to stick.

**The Orange sandbox needs longer windows.** Orange's sandbox dates every recent swap exactly 168 hours back, and a 168h window does not include that instant, so with the default 24h and 72h windows Orange answers `swapped: false` for every number and everything is allowed. Set the windows for that deployment with `POLICY_CONFIG`, which lays any part of `data.json`'s config over the file:

```bash
POLICY_CONFIG='{"windows":{"login":192,"payment":192}}' npm run sandbox
```

Or put the same line in `.env`, where `npm run sandbox` and `npm run demo` pick it up. It is checked at startup, and a bad value stops the server rather than skewing decisions. It sets the built-in engine's starting thresholds and OPA's fallback. `npm run demo` also loads it into the OPA it starts; an OPA you run yourself reads its own `data.json`.

## Try the API directly

The mock operator is served alongside the demo, both locally and on the [live site](https://simswap-guard.vercel.app). Swap `localhost:3000` for `https://simswap-guard.vercel.app` to try it without cloning anything:

```bash
curl -s localhost:3000/sim-swap/v1/check \
  -H 'authorization: Bearer any' -H 'content-type: application/json' \
  -d '{"phoneNumber":"+447700900002","maxAge":24}'
# {"swapped":true}

curl -s localhost:3000/sim-swap/v1/retrieve-date \
  -H 'authorization: Bearer any' -H 'content-type: application/json' \
  -d '{"phoneNumber":"+447700900002"}'
# {"latestSimChange":"2026-11-09T08:14:03.120Z","monitoredPeriod":120}
```

Errors use the CAMARA shape, `{ "status": 404, "code": "IDENTIFIER_NOT_FOUND", "message": "..." }`.

`npm run mock` also runs the mock on its own, on port 4010.

## Point it at a real operator

When `CAMARA_BASE_URL` is set, the demo uses it instead of the mock. Nothing else in the app changes: same client, same policy.

**Operator sandboxes (OAuth client credentials).** Most sandboxes hand you a client ID and secret. The client fetches a token, caches it and refreshes it before it expires:

```bash
CAMARA_BASE_URL=https://<provider>/sim-swap/v1 \
CAMARA_TOKEN_URL=https://<provider>/token \
CAMARA_CLIENT_ID=<id> CAMARA_CLIENT_SECRET=<secret> \
CAMARA_DEMO_NUMBERS='<test number>=<what it returns>;<test number>=<what it returns>' \
npm start
```

If your console gives you a pre-encoded Basic auth string instead of an ID and secret, set `CAMARA_BASIC_AUTH` in their place. `CAMARA_SCOPE` is optional. `CAMARA_DEMO_NUMBERS` fills the page's number picker with the sandbox's own test numbers. Our Ofcom numbers mean nothing to another operator's sandbox.

For example, the [Orange Network APIs Playground](https://docs.developer.orange.com/network-apis/practical-guides/try-it-for-free/overview) is free with instant access. Its token endpoint is `https://api.orange.com/openidconnect/playground/v1.0/token`. Check its SIM Swap getting-started page for the current API base URL and the test numbers. Sandboxes return test data, not live network data.

**A token you already have:**

```bash
CAMARA_BASE_URL=https://<provider>/sim-swap/v1 CAMARA_ACCESS_TOKEN=<token> npm start
```

On Vercel, add the same variables plus `SESSION_SECRET` (any long random string) to sign login tokens.

**Production** SIM Swap at most operators uses a three-legged OAuth flow (CIBA or authorization code) with the subscriber's consent, and access comes through an operator or an aggregator. That flow is out of scope for this demo. Check that your provider serves the `v1` path, and adjust the base URL if it doesn't.

## Deploy your own

Click **Deploy with Vercel** above, or with the CLI:

```bash
vercel env add SESSION_SECRET production   # any long random string
vercel deploy --prod
```

Everything runs on the free tier: two static pages plus a few small functions in [`api/`](api). There's no build step and nothing to install. The deployment uses the built-in policy engine unless you set `OPA_URL` to an OPA the functions can reach. To allow publishing from the policy page, also set `POLICY_ADMIN_TOKEN`. Pointing it at an operator sandbox? Set `POLICY_CONFIG` too (see the Orange note above).

## Use it in your own app

Load [`policy/`](policy) into your OPA, then per request:

```js
import { createSimSwapClient, CamaraError } from './src/camara-client.js';

const simSwap = createSimSwapClient({ baseUrl, accessToken });
const opa = (input) => fetch(`${OPA_URL}/v1/data/simswap/guard`, {
  method: 'POST', body: JSON.stringify({ input }),
}).then((r) => r.json()).then((r) => r.result);

const { window_hours } = await opa({ action: 'payment' });

let signal;
try {
  signal = { status: 200, swapped: await simSwap.check(phoneNumber, window_hours) };
} catch (err) {
  if (!(err instanceof CamaraError)) throw err;
  signal = { status: err.status, code: err.code };   // the policy decides what an outage means
}

const { decision } = await opa({ action: 'payment', amount: 750, phone_number: phoneNumber, signal });
// decision.result: 'allow' | 'step_up' | 'block' | 'review', plus rule, reason, obligations
```

No OPA? [`src/bank.js`](src/bank.js) `decide()` does the same with either engine.

## Ideas for contributions

- A Python (FastAPI) port
- Add [Number Verification](https://github.com/camaraproject/NumberVerification) to replace SMS OTP at sign-up
- Add [KYC Match](https://github.com/camaraproject/KnowYourCustomer) for onboarding
- Use `retrieve-date` to score risk by how recent the swap is, instead of a single yes/no window
- An OAuth client-credentials helper for a specific aggregator

Issues and PRs are welcome.

## Disclaimer

This is a demo. The mock follows the shape of the CAMARA SIM Swap `v1` spec but isn't a conformance-tested implementation. The policy thresholds are examples, not advice. Check the [official spec](https://github.com/camaraproject/SimSwap) and your provider's docs before using this in production.

## License

[MIT](LICENSE)
