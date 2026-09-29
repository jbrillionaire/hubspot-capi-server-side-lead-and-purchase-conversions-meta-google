#!/usr/bin/env node
/**
 * create-guard-properties.mjs -- the "sent at" properties the four actions stamp
 * ---------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (from production scripts first run 2026-09-05 and 2026-09-23)
 * Deploy:  Run locally, once (PowerShell):
 *            $env:HUBSPOT_TOKEN = "pat-..."                 # crm.schemas.*.write for the objects
 *            $env:PAYMENTS_OBJECT = "2-12345678"            # your Stripe payment records
 *            $env:PAYMENTS_GROUP  = "your_payment_group"
 *            $env:LEADS_OBJECT    = "2-87654321"            # or 0-1 for contacts
 *            $env:LEADS_GROUP     = "your_lead_group"       # e.g. contactinformation for contacts
 *            node scripts/create-guard-properties.mjs --dry-run
 *            node scripts/create-guard-properties.mjs
 * What:    Creates, as DATE-TIME properties:
 *            payments: meta_capi_purchase_sent_at, google_ads_purchase_sent_at
 *            leads:    meta_capi_lead_sent_at,     google_ads_lead_sent_at
 * Why:     Each action stamps its guard after a real send. The guard is what the
 *          workflow triggers and the retry workflow filter on, what makes manual
 *          re-enrollment safe, and the per-record answer to "did Meta/Google get
 *          this?". Created by hand, it's easy to pick "Date picker" (date only),
 *          which can't be converted to date-time later; this script can't get it wrong.
 */
const TOKEN = process.env.HUBSPOT_TOKEN;
const DRY = process.argv.includes('--dry-run');
if (!TOKEN) { console.error('Set HUBSPOT_TOKEN.'); process.exit(1); }

const PLAN = [
  { object: process.env.PAYMENTS_OBJECT, group: process.env.PAYMENTS_GROUP, props: [
    ['meta_capi_purchase_sent_at', 'Meta CAPI purchase sent at', 'When meta-purchase-action.js last sent this payment to Meta. Blank = not sent (or the guard token was detached).'],
    ['google_ads_purchase_sent_at', 'Google Ads purchase sent at', 'When google-purchase-action.js uploaded this payment to Google Ads.'],
  ] },
  { object: process.env.LEADS_OBJECT, group: process.env.LEADS_GROUP, props: [
    ['meta_capi_lead_sent_at', 'Meta CAPI lead sent at', 'When meta-lead-action.js sent this lead to Meta.'],
    ['google_ads_lead_sent_at', 'Google Ads lead sent at', 'When google-lead-action.js uploaded this lead to Google Ads.'],
  ] },
];

async function hubspot(method, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, raw: await res.text() };
}

for (const { object, group, props } of PLAN) {
  if (!object) { console.log(`(skipping: no object set for ${props[0][0]})`); continue; }
  if (!group) { console.error(`Set the property group for object ${object}.`); process.exitCode = 1; continue; }
  for (const [name, label, description] of props) {
    const def = { name, label, description, groupName: group, type: 'datetime', fieldType: 'date' };
    if (DRY) { console.log(`would create  ${object}  ${name}  datetime`); continue; }
    const r = await hubspot('POST', `/crm/v3/properties/${object}`, def);
    if (r.ok) { console.log(`created  ${object}  ${name}`); continue; }
    if (r.status !== 409) { console.error(`FAILED   ${object}  ${name} -> ${r.status} ${r.raw}`); process.exitCode = 1; continue; }
    // Exists: make sure it's date-time, not date-only (the action writes an ISO timestamp).
    const got = await hubspot('GET', `/crm/v3/properties/${object}/${name}`);
    const type = got.ok ? JSON.parse(got.raw).type : '?';
    if (type === 'datetime') console.log(`exists   ${object}  ${name}  (datetime, ok)`);
    else {
      console.log(`exists   ${object}  ${name}  is "${type}", not datetime. The LEAD actions fall back`
        + ' to a midnight value; the PURCHASE actions write a full timestamp and their guard write'
        + ' will fail (the event is still sent, but nothing is stamped). Recreate it as date-time.');
      process.exitCode = 1;
    }
  }
}
