#!/usr/bin/env node
/**
 * google-conversion-test.mjs
 *
 * Author:   Jibril Sulaiman
 * Created:  2026-09-23
 * Run:      locally, from a terminal, AFTER google-oauth-setup.mjs --for hubspot.
 *
 * WHAT IT DOES
 *   Proves the Google side works before anything goes into HubSpot, so a
 *   failure here is about Google access and not about workflow mapping.
 *
 *   Default:   sends one VALIDATE-ONLY conversion (a fake hashed email) to the
 *              conversion action. Google checks auth, account access and the
 *              payload, and records nothing. Run it once per conversion action.
 *   --status:  looks up what happened to a real upload, using the
 *              gads_request_id a HubSpot workflow run printed.
 *
 * USAGE (PowerShell)
 *   node google-conversion-test.mjs --customer 1234567890 --action 987654321
 *   node google-conversion-test.mjs --customer 1234567890 --action 987654321 --login 1112223333
 *   node google-conversion-test.mjs --status <requestId>
 *
 * WHAT THE ERRORS USUALLY MEAN
 *   PERMISSION_DENIED   the Google login used for OAuth has no access to that
 *                       Google Ads account, or it reaches it through a manager
 *                       and --login was not passed.
 *   NOT_FOUND / INVALID_ARGUMENT on productDestinationId
 *                       wrong ctId, or the conversion action belongs to a
 *                       different account than --customer.
 *   SERVICE_DISABLED    the Data Manager API is not enabled in the Cloud project.
 *   invalid_grant       refresh token dead. Re-run google-oauth-setup.mjs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? '' : (args[i + 1] || '');
};

const credFile = path.join(os.homedir(), '.hubspot-capi', 'google_hubspot_oauth.json');
if (!fs.existsSync(credFile)) {
  console.error(`No credentials at ${credFile}. Run google-oauth-setup.mjs --for hubspot first.`);
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: 'refresh_token',
  }).toString(),
});
const tok = await tokenRes.json();
if (!tok.access_token) {
  console.error('OAuth failed:', tok.error, tok.error_description || '');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };

const statusId = arg('--status');
if (statusId) {
  const r = await fetch(
    `https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=${encodeURIComponent(statusId)}`,
    { headers }
  );
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
  process.exit(r.ok ? 0 : 1);
}

const customer = arg('--customer').replace(/\D/g, '');
const action = arg('--action').replace(/\D/g, '');
const login = arg('--login').replace(/\D/g, '');
if (!customer || !action) {
  console.error('Usage: --customer <Google Ads id> --action <conversion action ctId> [--login <manager id>]');
  process.exit(1);
}

const destination = {
  operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customer },
  productDestinationId: action,
};
if (login && login !== customer) destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: login };

const body = {
  destinations: [destination],
  encoding: 'HEX',
  validateOnly: true,
  events: [{
    transactionId: `validate-${Date.now()}`,
    eventTimestamp: new Date(Date.now() - 60_000).toISOString(),
    eventSource: 'WEB',
    userData: {
      userIdentifiers: [{
        emailAddress: crypto.createHash('sha256').update('validate-only@example.com').digest('hex'),
      }],
    },
  }],
};

const r = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
const out = await r.json().catch(() => ({}));
console.log(r.status, JSON.stringify(out, null, 2));
console.log(r.ok
  ? '\nPASS - auth, account access and conversion action all check out. Nothing was recorded.'
  : '\nFAIL - see the error meanings in this file\'s header.');
process.exit(r.ok ? 0 : 1);
