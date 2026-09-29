/**
 * helpers.mjs -- run a HubSpot custom code action against fake Stripe/Meta/Google/HubSpot
 * ---------------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 * Deploy:  Local only. npm test
 * What:    Loads an action file unchanged (CommonJS, like HubSpot's Node 20 runtime),
 *          answers its fetch() calls from per-test handlers, and records every request.
 * Why:     These actions run unattended on every sale and every lead. What goes wrong is
 *          silent: a double count, a wrong hash, a lost event. Each is pinned by a test.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const sha = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
export const NOW = Date.parse('2026-09-28T16:00:00Z');
export const nowSec = Math.floor(NOW / 1000);

const reply = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * handlers: array of [predicate(url, opts) | substring, (url, opts, body) => [status, body]]
 */
export async function runAction(file, { inputs = {}, env = {}, objectId = '9001', handlers = [] }) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    let body = null;
    if (opts.body) {
      const raw = typeof opts.body === 'string' ? opts.body : String(opts.body);
      try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
    for (const [match, fn] of handlers) {
      const hit = typeof match === 'function' ? match(url, opts) : url.includes(match);
      if (hit) { const [status, payload] = fn(url, opts, body); return reply(status, payload); }
    }
    throw new Error(`unexpected fetch ${opts.method || 'GET'} ${url}`);
  };
  const module = { exports: {} };
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [NOW])); }
    static now() { return NOW; }
  }
  const ctx = {
    module, exports: module.exports, require, fetch, URL, URLSearchParams, Date: FixedDate,
    console: { log: () => {} }, setTimeout: (fn) => fn(), process: { env },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
  const out = await new Promise((resolve, reject) => {
    Promise.resolve(module.exports.main({ object: { objectId }, inputFields: inputs }, resolve)).catch(reject);
  });
  const find = (sub, method) => calls.filter((c) => c.url.includes(sub) && (!method || c.method === method));
  return { out: out.outputFields, calls, find };
}

// ---- canned Stripe objects ------------------------------------------------------
export const session = (over = {}) => ({
  id: 'cs_live_1',
  created: nowSec - 3600,
  currency: 'usd',
  amount_total: 29700,
  payment_status: 'paid',
  success_url: 'https://www.example.com/thank-you?utm_source=fb&utm_campaign=Fall-Launch',
  customer_details: {
    email: 'Buyer@Example.com', phone: '+1 (404) 555-0123', name: 'Alex Rivera',
    address: { city: 'Atlanta', state: 'Georgia', postal_code: '30305-1234', country: 'US' },
  },
  line_items: { data: [{ description: 'Annual Pass', quantity: 2, amount_total: 29700, price: { id: 'price_1' } }] },
  payment_intent: { id: 'pi_1', latest_charge: { amount: 29700, amount_refunded: 0, refunded: false } },
  ...over,
});

export const stripeSessionList = (s) => ['api.stripe.com/v1/checkout/sessions?', () => [200, { data: s ? [s] : [] }]];
export const hubspotPatch = (status = 200) => [(u, o) => u.startsWith('https://api.hubapi.com/crm/v3/objects/') && o.method === 'PATCH', () => [status, status < 300 ? {} : { message: 'bad' }]];
export const metaOk = ['graph.facebook.com', () => [200, { events_received: 1, fbtrace_id: 'TRACE' }]];
export const googleToken = ['oauth2.googleapis.com/token', () => [200, { access_token: 'ya29.test' }]];
export const googleOk = ['datamanager.googleapis.com/v1/events:ingest', () => [200, { requestId: 'req-1' }]];

export const META_ENV = { META_CAPI_ACCESS_TOKEN: 'EAAtest', META_CAPI_DATASET_ID: '1234567890', CAPI_GUARD_WRITE_TOKEN: 'pat-test' };
export const STRIPE_ENV = { STRIPE_READ_KEY: 'rk_live_test' };
export const GOOGLE_ENV = {
  GOOGLE_ADS_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_ADS_CLIENT_SECRET: 'secret',
  GOOGLE_ADS_REFRESH_TOKEN: '1//refresh', GOOGLE_ADS_CUSTOMER_ID: '1234567890', CAPI_GUARD_WRITE_TOKEN: 'pat-test',
};

/** Load an action with its placeholder CONVERSION_ACTION_ID filled in, for tests. */
export function withConversionId(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace("'REPLACE_WITH_CONVERSION_ACTION_ID'", "'555000111'");
  const tmp = path.join(ROOT, 'test', `.tmp-${path.basename(file)}`);
  fs.writeFileSync(tmp, src);
  return path.relative(ROOT, tmp);
}
