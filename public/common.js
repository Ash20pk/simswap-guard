// Small helpers shared by the console and the policy page.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Builds an element: h('div', { class: 'x', onclick }, child, 'text', ...). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `Unexpected response (${res.status}).` }));
  return { ok: res.ok, status: res.status, data };
}

export const RESULT_LABEL = { allow: 'Allow', step_up: 'Step up', block: 'Block', review: 'Review' };

export const NEXT_STEP = {
  allow: 'Proceed as normal.',
  step_up: 'Re-verify with a passkey or an in-app approval. Do not send an SMS code.',
  block: 'Refuse, and tell the customer by email or in the app, not by phone.',
  review: 'Hold for a person, or retry once the operator is back.',
};

/** Fills the header's operator and policy status from /api/status. */
export async function loadStatus() {
  const { ok, data } = await api('/api/status');
  if (!ok) return null;
  const op = $('#operator');
  if (op) {
    op.replaceChildren(h('span', { class: `dot${data.operator.name.startsWith('Orange') ? ' orange' : ''}`, 'aria-hidden': 'true' }),
      data.operator.mock ? data.operator.name : `${data.operator.name} · sandbox`);
  }
  const pol = $('#policy-status');
  if (pol) {
    pol.replaceChildren(h('span', { class: `dot ${data.policy.engine === 'opa' ? 'ok' : ''}`, 'aria-hidden': 'true' }),
      `${data.policy.label}${data.policy.rev ? ` · rev ${data.policy.rev}` : ''}`);
  }
  return data;
}
