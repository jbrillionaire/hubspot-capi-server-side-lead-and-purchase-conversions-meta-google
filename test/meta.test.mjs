/**
 * meta.test.mjs -- meta/meta-purchase-action.js and meta/meta-lead-action.js
 * Author: Jibril Sulaiman · Created: 2026-09-28 · Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction, session, stripeSessionList, hubspotPatch, metaOk, META_ENV, STRIPE_ENV, sha, nowSec } from './helpers.mjs';

const PURCHASE = 'meta/meta-purchase-action.js';
const LEAD = 'meta/meta-lead-action.js';
const env = { ...META_ENV, ...STRIPE_ENV };

test('purchase: one Purchase with the charged amount, pi_ as event_id, hashed identifiers, then the guard', async () => {
  const { out, find } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1', externalId: '501' }, env,
    handlers: [stripeSessionList(session()), metaOk, hubspotPatch()],
  });
  assert.equal(out.capi_result, 'sent');
  assert.equal(out.capi_value, 297);
  const [meta] = find('graph.facebook.com');
  assert.match(meta.url, /\/v\d+\.\d+\/1234567890\/events\?access_token=EAAtest/);
  const ev = meta.body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'pi_1');
  assert.equal(ev.custom_data.order_id, 'pi_1');
  assert.equal(ev.action_source, 'system_generated');
  assert.equal(ev.event_source_url, 'https://www.example.com/thank-you', 'query string stripped');
  assert.deepEqual(ev.user_data.em, [sha('buyer@example.com')]);
  assert.deepEqual(ev.user_data.ph, [sha('14045550123')]);
  assert.deepEqual(ev.user_data.st, [sha('ga')], 'Georgia -> ga, never "ge"');
  assert.deepEqual(ev.user_data.zp, [sha('30305')]);
  assert.deepEqual(ev.user_data.external_id, [sha('501')]);
  assert.equal(ev.custom_data.contents[0].item_price, 148.5, 'unit price, not the line total');
  assert.equal(meta.body.test_event_code, undefined);
  const [guard] = find('/crm/v3/objects/2-00000000/9001', 'PATCH');
  assert.ok(guard.body.properties.meta_capi_purchase_sent_at);
});

test('purchase: the guard short-circuits a re-enrollment without calling Stripe or Meta', async () => {
  const { out, calls } = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1', metaCapiSentAt: '2026-09-27T10:00:00Z' }, env });
  assert.equal(out.capi_result, 'skipped_already_sent');
  assert.equal(calls.length, 0);
});

test('purchase: refunded, unpaid, $0 and stale payments are skipped, never sent', async () => {
  const cases = [
    [session({ payment_intent: { latest_charge: { amount: 29700, amount_refunded: 29700, refunded: true } } }), 'skipped_refunded'],
    [session({ payment_status: 'unpaid' }), 'skipped_not_succeeded'],
    [session({ amount_total: 0 }), 'skipped_no_amount'],
    [session({ created: nowSec - 8 * 86400 }), 'skipped_too_old'],
  ];
  for (const [s, expected] of cases) {
    const { out, find } = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1' }, env, handlers: [stripeSessionList(s), metaOk] });
    assert.equal(out.capi_result, expected);
    assert.equal(find('graph.facebook.com').length, 0);
  }
});

test('purchase: a test-mode payment reached with a live key is classified, not thrown', async () => {
  const { out } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_test' }, env,
    handlers: [stripeSessionList(null), ['/v1/payment_intents/', () => [404, { error: { message: "No such payment_intent: 'pi_test'; a similar object exists in test mode, but a live mode key was used to make this request." } }]]],
  });
  assert.equal(out.capi_result, 'skipped_test_mode');
});

test('purchase: a Meta error returns "error" and leaves the guard blank for the retry workflow', async () => {
  const { out, find } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1' }, env,
    handlers: [stripeSessionList(session()), ['graph.facebook.com', () => [400, { error: { code: 100, message: 'Invalid parameter' } }]], hubspotPatch()],
  });
  assert.equal(out.capi_result, 'error');
  assert.match(out.capi_error, /Invalid parameter/);
  assert.equal(find('/crm/v3/objects/', 'PATCH').length, 0);
});

test('purchase: fbc/fbp pass through raw; a cut-off click id is dropped, not sent', async () => {
  const good = 'fb.1.1788000000000.IwZXh0bgNhZW0BMABhZGlkAasdasdasdasdasdasdasdasdasdasd';
  const ok = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1', fbc: good, fbp: 'fb.1.1783296616379.123456789' }, env, handlers: [stripeSessionList(session()), metaOk, hubspotPatch()] });
  const ud = ok.find('graph.facebook.com')[0].body.data[0].user_data;
  assert.equal(ud.fbc, good);
  assert.equal(ok.out.capi_fbc_source, 'url_fbc');
  const cut = 'fb.1.1788000000000.' + 'x'.repeat(100 - 19);   // exactly 100 characters
  const bad = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1', fbc: cut }, env, handlers: [stripeSessionList(session()), metaOk, hubspotPatch()] });
  assert.equal(bad.find('graph.facebook.com')[0].body.data[0].user_data.fbc, undefined);
  assert.equal(bad.out.capi_fbc_source, 'truncated');
});

test('purchase: the test event code is attached only when its secret is', async () => {
  const { find } = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1' }, env: { ...env, META_CAPI_TEST_CODE: 'TEST123' }, handlers: [stripeSessionList(session()), metaOk, hubspotPatch()] });
  assert.equal(find('graph.facebook.com')[0].body.test_event_code, 'TEST123');
});

test('lead: one Lead keyed on the record id, with the offer and the contact as external_id', async () => {
  const { out, find } = await runAction(LEAD, {
    objectId: '7001', env,
    inputs: { email: 'Lead@Example.com', leadAt: String((nowSec - 600) * 1000), phone: '404-555-0199', offerName: 'Retirement Webinar', offerDate: '2026-10-06', externalId: '501', firstName: 'Sam', lastName: 'Lee' },
    handlers: [metaOk, hubspotPatch()],
  });
  assert.equal(out.capi_result, 'sent');
  const ev = find('graph.facebook.com')[0].body.data[0];
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.event_id, '7001');
  assert.equal(ev.event_time, nowSec - 600);
  assert.equal(ev.custom_data.content_name, 'Retirement Webinar');
  assert.equal(ev.custom_data.content_category, 'lead');
  assert.equal(ev.custom_data.offer_date, '2026-10-06');
  assert.deepEqual(ev.user_data.external_id, [sha('501')]);
  assert.deepEqual(ev.user_data.em, [sha('lead@example.com')]);
  assert.ok(find('/crm/v3/objects/2-00000000/7001', 'PATCH')[0].body.properties.meta_capi_lead_sent_at);
});

test('lead: already sent, no identifiers, and too old are all skipped', async () => {
  const sent = await runAction(LEAD, { env, inputs: { email: 'a@example.com', leadAt: String(NOWms()), metaCapiLeadSentAt: '1790000000000' } });
  assert.equal(sent.out.capi_result, 'skipped_already_sent');
  const none = await runAction(LEAD, { env, inputs: { leadAt: String(NOWms()) }, handlers: [metaOk] });
  assert.equal(none.out.capi_result, 'skipped_no_identifier');
  const old = await runAction(LEAD, { env, inputs: { email: 'a@example.com', leadAt: String((nowSec - 8 * 86400) * 1000) }, handlers: [metaOk] });
  assert.equal(old.out.capi_result, 'skipped_too_old');
});

test('lead: a date-only guard property still gets stamped (midnight fallback)', async () => {
  let patches = 0;
  const { find } = await runAction(LEAD, {
    env, inputs: { email: 'a@example.com', leadAt: String(NOWms()) },
    handlers: [metaOk, [(u, o) => o.method === 'PATCH', () => (++patches === 1 ? [400, { message: 'INVALID_DATE' }] : [200, {}])]],
  });
  const p = find('/crm/v3/objects/', 'PATCH');
  assert.equal(p.length, 2);
  assert.match(String(p[1].body.properties.meta_capi_lead_sent_at), /^\d+$/);
});

function NOWms() { return nowSec * 1000; }
