/**
 * google.test.mjs -- google/google-purchase-action.js and google/google-lead-action.js
 * Author: Jibril Sulaiman · Created: 2026-09-28 · Run: npm test
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAction, session, stripeSessionList, hubspotPatch, googleToken, googleOk, GOOGLE_ENV, STRIPE_ENV, sha, nowSec, withConversionId } from './helpers.mjs';

const PURCHASE = withConversionId('google/google-purchase-action.js');
const LEAD = withConversionId('google/google-lead-action.js');
after(() => { for (const f of [PURCHASE, LEAD]) fs.rmSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', f), { force: true }); });
const env = { ...GOOGLE_ENV, ...STRIPE_ENV };

test('both actions refuse to run until CONVERSION_ACTION_ID is set', async () => {
  await assert.rejects(runAction('google/google-purchase-action.js', { env, inputs: { paymentIntentId: 'pi_1' } }), /CONVERSION_ACTION_ID/);
  await assert.rejects(runAction('google/google-lead-action.js', { env, inputs: { email: 'a@example.com', leadAt: String(nowSec * 1000) } }), /CONVERSION_ACTION_ID/);
});

test('purchase: uploads to events:ingest with pi_ as transactionId, the charged value and Google-style hashes', async () => {
  const { out, find } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1' }, env,
    handlers: [stripeSessionList(session({ customer_details: { email: 'Alex.Rivera@Gmail.com', phone: '(404) 555-0123', name: 'Alex Rivera', address: { postal_code: '30305', country: 'US' } } })), googleToken, googleOk, hubspotPatch()],
  });
  assert.equal(out.gads_result, 'sent');
  const [ingest] = find('events:ingest');
  assert.equal(ingest.headers.Authorization, 'Bearer ya29.test');
  const d = ingest.body.destinations[0];
  assert.deepEqual(d.operatingAccount, { accountType: 'GOOGLE_ADS', accountId: '1234567890' });
  assert.equal(d.productDestinationId, '555000111');
  assert.equal(ingest.body.validateOnly, undefined);
  const ev = ingest.body.events[0];
  assert.equal(ev.transactionId, 'pi_1');
  assert.equal(ev.conversionValue, 297);
  assert.equal(ev.currency, 'USD');
  const ids = ev.userData.userIdentifiers;
  assert.ok(ids.some((i) => i.emailAddress === sha('alexrivera@gmail.com')), 'gmail dots stripped');
  assert.ok(ids.some((i) => i.phoneNumber === sha('+14045550123')), 'E.164 WITH the +');
  const addr = ids.find((i) => i.address);
  assert.equal(addr.address.postalCode, '30305', 'postal code unhashed');
  assert.equal(addr.address.regionCode, 'US');
  assert.equal(addr.address.givenName, sha('alex'));
  assert.ok(find('/crm/v3/objects/2-00000000/9001', 'PATCH')[0].body.properties.google_ads_purchase_sent_at);
});

test('purchase: validate-only asks Google to check, records nothing and never stamps the guard', async () => {
  const { out, find } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1' }, env: { ...env, GOOGLE_ADS_VALIDATE_ONLY: 'true' },
    handlers: [stripeSessionList(session()), googleToken, googleOk, hubspotPatch()],
  });
  assert.equal(out.gads_result, 'validated');
  assert.equal(find('events:ingest')[0].body.validateOnly, true);
  assert.equal(find('/crm/v3/objects/', 'PATCH').length, 0);
});

test('purchase: a dead refresh token returns "error" with the fix, instead of throwing', async () => {
  const { out, find } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1' }, env,
    handlers: [stripeSessionList(session()), ['oauth2.googleapis.com/token', () => [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }]], hubspotPatch()],
  });
  assert.equal(out.gads_result, 'error');
  assert.match(out.gads_error, /invalid_grant.*google-oauth-setup/);
  assert.equal(find('events:ingest').length, 0);
});

test('purchase: refunds are skipped', async () => {
  const { out } = await runAction(PURCHASE, {
    inputs: { paymentIntentId: 'pi_1' }, env,
    handlers: [stripeSessionList(session({ payment_intent: { latest_charge: { amount: 29700, amount_refunded: 29700, refunded: true } } })), googleToken, googleOk],
  });
  assert.equal(out.gads_result, 'skipped_refunded');
});

test('purchase: the contact gclid is used when the checkout carried none; exactly one ad identifier', async () => {
  const gclid = 'Cj0KCQjw' + 'a'.repeat(60);
  const { find } = await runAction(PURCHASE, { inputs: { paymentIntentId: 'pi_1', gclid }, env, handlers: [stripeSessionList(session()), googleToken, googleOk, hubspotPatch()] });
  assert.deepEqual(find('events:ingest')[0].body.events[0].adIdentifiers, { gclid });
});

test('lead: the key is person + offer, so a duplicate record for the same person and offer collapses', async () => {
  const run = (objectId) => runAction(LEAD, {
    objectId, env,
    inputs: { email: 'a@example.com', leadAt: String((nowSec - 60) * 1000), externalId: '501', offerName: 'Retirement Webinar', offerDate: '2026-10-06' },
    handlers: [googleToken, googleOk, hubspotPatch()],
  });
  const a = await run('7001');
  const b = await run('7002');
  assert.equal(a.out.gads_transaction_id, 'lead-501-2026-10-06-retirement-webinar');
  assert.equal(b.out.gads_transaction_id, a.out.gads_transaction_id);
  const ev = a.find('events:ingest')[0].body.events[0];
  assert.equal(ev.conversionValue, undefined, 'no value for a free sign-up');
});

test('lead: without offer fields the key falls back to the record id (no accidental merging)', async () => {
  const { out } = await runAction(LEAD, { objectId: '7003', env, inputs: { email: 'a@example.com', leadAt: String(nowSec * 1000), externalId: '501' }, handlers: [googleToken, googleOk, hubspotPatch()] });
  assert.equal(out.gads_transaction_id, 'lead-501-7003');
});

test('lead: a truncated gclid is dropped and the hashed email carries the match', async () => {
  const { out, find } = await runAction(LEAD, { env, inputs: { email: 'a@example.com', leadAt: String(nowSec * 1000), gclid: 'x'.repeat(100) }, handlers: [googleToken, googleOk, hubspotPatch()] });
  assert.equal(out.gads_click_id, 'dropped_truncated');
  assert.equal(find('events:ingest')[0].body.events[0].adIdentifiers, undefined);
});
