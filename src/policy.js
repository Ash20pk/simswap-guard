// The part you'd actually copy into your own app: turn a SIM swap signal into
// a decision. Tune the windows and thresholds to your own risk appetite.

export const POLICY = {
  login: {
    maxAgeHours: 24,
    // If the operator can't answer, let the login through but log it.
    // Blocking every login during an operator outage is worse than the risk.
    onError: 'allow',
  },
  payment: {
    maxAgeHours: 72,
    blockAboveAmount: 500,
    // Money moving is different: hold it rather than guess.
    onError: 'review',
  },
};

/**
 * @returns {Promise<{ decision: 'allow'|'step_up'|'block'|'review', reason: string }>}
 *   allow   - proceed as normal
 *   step_up - re-verify the user on a channel that is NOT SMS (app push, passkey, ID check)
 *   block   - refuse and alert the customer through a channel other than the phone
 *   review  - hold for a human / retry later
 */
export async function assess(client, { action, phoneNumber, amount = 0 }, policy = POLICY) {
  const rule = policy[action];
  if (!rule) throw new Error(`Unknown action: ${action}`);

  let swapped;
  try {
    swapped = await client.check(phoneNumber, rule.maxAgeHours);
  } catch (err) {
    if (err.code === 'IDENTIFIER_NOT_FOUND') {
      // Not this operator's subscriber, or not a mobile number. No signal either way.
      return { decision: rule.onError, reason: 'Number not known to the operator, no SIM swap signal available.' };
    }
    return { decision: rule.onError, reason: `SIM swap check failed (${err.code}), falling back to "${rule.onError}".` };
  }

  if (!swapped) {
    return { decision: 'allow', reason: `No SIM change in the last ${rule.maxAgeHours}h.` };
  }

  if (action === 'payment' && amount > rule.blockAboveAmount) {
    return { decision: 'block', reason: `SIM changed in the last ${rule.maxAgeHours}h and amount exceeds ${rule.blockAboveAmount}.` };
  }
  return { decision: 'step_up', reason: `SIM changed in the last ${rule.maxAgeHours}h. SMS OTP to this number is not trustworthy.` };
}
