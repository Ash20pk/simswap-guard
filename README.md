# SIM Swap Guard

**Stop account takeovers that start with a hijacked phone number.** A small, dependency-free Node app that checks the [CAMARA SIM Swap API](https://github.com/camaraproject/SimSwap) before it trusts a login or a payment. It runs against a built-in mock operator, so you can try it in under five minutes with no telco account.

```
git clone https://github.com/Ash20pk/simswap-guard && cd simswap-guard && npm start
```

Then open http://localhost:3000.

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

Open **http://localhost:3000** and try these numbers (password: `demo`):

| Number | What the mock operator says | Login | Pay 750 |
|---|---|---|---|
| `+447700900001` | No SIM change on record | ✅ allow | ✅ allow |
| `+447700900002` | SIM swapped **2 hours ago** | ⚠️ step up | ⛔ block |
| `+447700900003` | SIM swapped **~2 days ago** | ✅ allow | ⛔ block |
| `+447700900004` | SIM swapped 30 days ago (new phone) | ✅ allow | ✅ allow |
| `+447700900009` | Operator is down (503) | ✅ allow (fail open) | 🕓 review (fail closed) |

The numbers come from Ofcom's range reserved for TV and film, so none of them can belong to a real person.

Port taken? Run `PORT=3001 npm start` (and `MOCK_PORT=4011` if 4010 is busy too).

Run the tests:

```bash
npm test
```

## How it works

```
 Browser ──► demo app (:3000) ──► policy.js ──► camara-client.js ──► operator (:4010)
                                     │                                  │
                         allow / step_up / block / review     POST /sim-swap/v1/check
                                                              { phoneNumber, maxAge }
                                                              → { swapped: true|false }
```

| File | What it is |
|---|---|
| [`src/policy.js`](src/policy.js) | **The part to copy.** Turns "SIM swapped?" into allow / step up / block / review. |
| [`src/camara-client.js`](src/camara-client.js) | ~50-line client for `/check` and `/retrieve-date`. |
| [`src/mock-operator.js`](src/mock-operator.js) | Mock operator with the CAMARA request, response and error shapes. |
| [`src/server.js`](src/server.js) | The demo bank: login and payment endpoints. |

### The policy

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

## Try the API directly

Run the mock operator on its own:

```bash
npm run mock
```

```bash
curl -s localhost:4010/sim-swap/v1/check \
  -H 'authorization: Bearer any' -H 'content-type: application/json' \
  -d '{"phoneNumber":"+447700900002","maxAge":24}'
# {"swapped":true}

curl -s localhost:4010/sim-swap/v1/retrieve-date \
  -H 'authorization: Bearer any' -H 'content-type: application/json' \
  -d '{"phoneNumber":"+447700900002"}'
# {"latestSimChange":"2026-11-09T08:14:03.120Z","monitoredPeriod":120}
```

Errors use the CAMARA shape, `{ "status": 404, "code": "IDENTIFIER_NOT_FOUND", "message": "..." }`.

## Point it at a real operator

The client only needs a base URL and an access token:

```bash
CAMARA_BASE_URL=https://<provider>/sim-swap/v1 \
CAMARA_ACCESS_TOKEN=<token> \
npm start
```

When `CAMARA_BASE_URL` is set, the mock is not started. How you get the token depends on the provider. CAMARA uses OAuth 2.0 (CIBA or authorization code flow), and access usually comes through an operator's developer portal or an aggregator such as GSMA Open Gateway partners. Check that your provider serves the `v1` path, and adjust the base URL if it doesn't.

## Use it in your own app

```js
import { createSimSwapClient } from './src/camara-client.js';
import { assess } from './src/policy.js';

const simSwap = createSimSwapClient({ baseUrl, accessToken });

const { decision, reason } = await assess(simSwap, {
  action: 'payment',
  phoneNumber: '+447700900003',
  amount: 750,
});
// decision: 'allow' | 'step_up' | 'block' | 'review'
```

To change the windows, thresholds or fail-open behaviour, pass your own policy object as the third argument to `assess()`.

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
