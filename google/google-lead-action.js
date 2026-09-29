/**
 * google-lead-action.js -- Google Ads enhanced conversion for leads: one per person per offer
 * ------------------------------------------------------------------------------------------
 * Author:   Jibril Sulaiman
 * Created:  2026-09-28 (from a production build first shipped 2026-09-23)
 * Deploy:   HubSpot > Automation > Workflows > a workflow on the object that holds one
 *           record per lead > Custom code, Node.js 20.x. Its own workflow, separate from
 *           the Meta one. Change only the SETTINGS block below.
 *
 * WHAT IT DOES
 *   Uploads a lead conversion to a Google Ads conversion action through the Data
 *   Manager API: hashed email and phone, plus the Google click id when the contact
 *   has one. Needs "Enhanced conversions for leads" turned on in Google Ads.
 *
 * THE KEY IS PERMANENT, SO IT'S PERSON + OFFER, NOT THE RECORD
 *   transactionId = "lead-<contact id>-<offer date + offer name>". A repeat upload of a
 *   transactionId counts as an ADJUSTMENT, forever. Keying on the person and what they
 *   signed up for collapses duplicate records (the same person submitting twice) into one
 *   conversion permanently. Keying on the record id would count every duplicate.
 *   Build the key only from fields EVERY record carries: an optional field filled for
 *   some offers and blank for others silently splits one person into two keys.
 *   With offerDate/offerName unmapped, the key falls back to the record id (records stay
 *   distinct rather than unrelated leads merging).
 *
 * WORKFLOW
 *   Object:         your lead records
 *   Trigger:        <lead time property> is known
 *               AND google_ads_lead_sent_at is unknown
 *               AND <lead time property> is less than 7 days ago
 *   Re-enrollment:  OFF
 *   Delay:          5 minutes, then the code. On a brand-new contact HubSpot writes the
 *                   Google click id a little after creation.
 *   Rate limit:     ~5 per second
 *
 * SECRETS
 *   GOOGLE_ADS_CLIENT_ID · GOOGLE_ADS_CLIENT_SECRET · GOOGLE_ADS_REFRESH_TOKEN ·
 *   GOOGLE_ADS_CUSTOMER_ID · GOOGLE_ADS_LOGIN_CUSTOMER_ID (optional) ·
 *   GOOGLE_ADS_VALIDATE_ONLY (optional; detach before go-live) · CAPI_GUARD_WRITE_TOKEN
 *
 * INPUT FIELDS
 *   gadsLeadSentAt  optional  guard property (google_ads_lead_sent_at)
 *   email           required
 *   leadAt          required  when the lead happened
 *   phone           optional
 *   offerName       optional  } together they make the dedupe key. Map both, from
 *   offerDate       optional  } fields every lead record has.
 *   externalId      optional  associated CONTACT record id (the "who" in the key)
 *   gclid           optional  associated contact's Google click id (hs_google_click_id)
 *
 * OUTPUT FIELDS
 *   gads_result String  sent | validated | error | skipped_already_sent |
 *                       skipped_no_identifier | skipped_too_old
 *   gads_status Number · gads_request_id String · gads_transaction_id String
 *   gads_match_keys String · gads_click_id String · gads_error String
 *
 * No conversionValue is sent: a free sign-up has no revenue. Set a default value on the
 * conversion action in Google Ads if you want one.
 */

const crypto = require('crypto');

/* ------------------------------------------------- per-workflow configuration */

/* ---------------------------------------------------------------- SETTINGS */
// Google Ads conversion action id (ctId= in its URL). Not a secret.
const CONVERSION_ACTION_ID = 'REPLACE_WITH_CONVERSION_ACTION_ID';
const KEY_PREFIX = 'lead';

const CLIENT_ID_SECRET = 'GOOGLE_ADS_CLIENT_ID';
const CLIENT_SECRET_SECRET = 'GOOGLE_ADS_CLIENT_SECRET';
const REFRESH_TOKEN_SECRET = 'GOOGLE_ADS_REFRESH_TOKEN';
const CUSTOMER_ID_SECRET = 'GOOGLE_ADS_CUSTOMER_ID';
const LOGIN_CUSTOMER_ID_SECRET = 'GOOGLE_ADS_LOGIN_CUSTOMER_ID';
const VALIDATE_ONLY_SECRET = 'GOOGLE_ADS_VALIDATE_ONLY';
const HUBSPOT_TOKEN_SECRET = 'CAPI_GUARD_WRITE_TOKEN';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const OBJECT_TYPE = '2-00000000';                 // object type id of your lead records ('0-1' for contacts)
const GUARD_PROPERTY = 'google_ads_lead_sent_at';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';

// Google accepts click conversions for up to 90 days after the click. Stay
// inside that; anything older is history, not optimisation signal.
const MAX_EVENT_AGE_SECONDS = 89 * 24 * 60 * 60;

/* ------------------------------------------------------------------ helpers */

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

// Google's rule, which differs from Meta's: for gmail.com / googlemail.com the
// dots in the local part are removed before hashing. Skipping it makes every
// dotted Gmail address hash to something Google never matches.
const normEmail = (v) => {
  const e = str(v).toLowerCase().replace(/\s/g, '');
  const at = e.lastIndexOf('@');
  if (at < 1) return '';
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@${domain}`;
  }
  return e;
};

// Google wants E.164 WITH the leading "+" before hashing. Meta wants it without.
// Reusing the Meta normaliser here would hash every phone number wrongly.
const normPhone = (v) => {
  let d = str(v).replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, '');
  if (d.length === 10) d = '1' + d;      // bare US number
  return d.length >= 8 && d.length <= 15 ? `+${d}` : '';
};

// HubSpot hands datetime properties to custom code as epoch MILLISECONDS most of
// the time, but an ISO string on some paths. Accept both.
function toEpochSeconds(v) {
  const raw = str(v);
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function toIsoDate(v) {
  const raw = str(v);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const sec = toEpochSeconds(raw);
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';
}

const slug = (v) =>
  str(v).toLowerCase().normalize('NFD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Some order-form code slices tracking values at exactly 100 characters. A
// click id landing on that boundary is a truncation artefact. A cut gclid looks
// present and matches nothing, so drop it and let the hashed email carry it.
const looksTruncated = (v) => v.length === 100 || v.length < 20;

function getSecret(name, required) {
  const value = str(process.env[name]);
  if (!value && required) {
    throw new Error(`Missing secret "${name}". Add it under Custom code > Secrets.`);
  }
  // Never echo the value — action logs are widely readable.
  if (value && /\s/.test(value)) {
    throw new Error(`Secret "${name}" contains whitespace, so it is not a credential.`);
  }
  return value;
}

async function fetchWithRetry(url, options, attempts = 3) {
  let last = { status: 0, json: {}, text: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let json = {};
      try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
      last = { status: res.status, json, text };
      if (res.status < 500 && res.status !== 429) return last;   // retry transient only
    } catch (err) {
      last = { status: 0, json: {}, text: str(err && err.message) };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return last;
}

// Swaps the long-lived refresh token for a one-hour access token. Runs on every
// execution; Google's token endpoint is built for that.
async function getAccessToken(clientId, clientSecret, refreshToken) {
  const r = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (r.status === 200 && r.json.access_token) return { token: r.json.access_token, error: '' };
  // invalid_grant almost always means the refresh token died: the OAuth app was
  // left in "Testing" (tokens expire after 7 days), or the user revoked access.
  const code = str(r.json.error) || `http_${r.status}`;
  const hint = code === 'invalid_grant'
    ? ' — refresh token expired or revoked. Re-run google-oauth-setup.mjs --for hubspot and update GOOGLE_ADS_REFRESH_TOKEN.'
    : '';
  return { token: '', error: `OAuth ${code}: ${str(r.json.error_description)}${hint}`.slice(0, 500) };
}

function googleError(r) {
  const e = r.json && r.json.error;
  if (e) return `${e.status || e.code}: ${e.message}`.slice(0, 500);
  return str(r.text).slice(0, 500);
}

// The property may be datetime or date-only depending on how it was created.
// A date-only property rejects a full ISO timestamp with a 400, so fall back to
// midnight UTC rather than leaving the guard blank.
async function patchGuard(objectId, token, value) {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/${OBJECT_TYPE}/${objectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { [GUARD_PROPERTY]: value } }),
  });
  if (res.ok) return { ok: true, status: res.status, text: '' };
  return { ok: false, status: res.status, text: (await res.text()).slice(0, 200) };
}

async function stampGuard(objectId, token) {
  const now = new Date();
  let r = await patchGuard(objectId, token, now.toISOString());
  if (r.ok) return '';
  if (r.status === 400) {
    const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    r = await patchGuard(objectId, token, String(midnightUtc));
    if (r.ok) return '';
  }
  return `guard not written (${r.status}): ${r.text}`;
}

/* --------------------------------------------------------------------- main */

exports.main = async (event, callback) => {
  const inp = event.inputFields || {};

  if (/^REPLACE/.test(CONVERSION_ACTION_ID)) {
    throw new Error('Set CONVERSION_ACTION_ID at the top of this action before testing.');
  }

  const clientId = getSecret(CLIENT_ID_SECRET, true);
  const clientSecret = getSecret(CLIENT_SECRET_SECRET, true);
  const refreshToken = getSecret(REFRESH_TOKEN_SECRET, true);
  const customerId = getSecret(CUSTOMER_ID_SECRET, true).replace(/\D/g, '');
  const loginCustomerId = getSecret(LOGIN_CUSTOMER_ID_SECRET, false).replace(/\D/g, '');
  const validateOnly = getSecret(VALIDATE_ONLY_SECRET, false).toLowerCase() === 'true';
  const hubspotToken = getSecret(HUBSPOT_TOKEN_SECRET, false);   // guard is optional

  const objectId = str(event.object && event.object.objectId);
  if (!objectId) throw new Error('No objectId on the event — this action must run on a record.');

  // Person + offer, so duplicate lead records collapse into one conversion
  // permanently (see header). Falls back to this record's id when the offer
  // fields are unmapped, which keeps records distinct rather than silently
  // merging unrelated leads.
  const email = normEmail(inp.email);
  const who = str(inp.externalId) || (email ? sha256(email).slice(0, 16) : objectId);
  // Date THEN name, e.g. "2026-10-06 Retirement Webinar" -> "2026-10-06-retirement-webinar".
  // Once live, never change this shape: keys already sent would stop matching.
  const offerDate = toIsoDate(inp.offerDate);
  const offerName = str(inp.offerName);
  const offerSlug = offerDate && offerName ? slug(`${offerDate} ${offerName}`) : '';
  const transactionId = `${KEY_PREFIX}-${who}-${offerSlug || objectId}`.slice(0, 200);

  const blank = {
    gads_status: 0,
    gads_request_id: '',
    gads_transaction_id: transactionId,
    gads_match_keys: '',
    gads_click_id: 'none',
    gads_error: '',
  };

  const done = (fields) => {
    console.log(JSON.stringify(fields));
    callback({ outputFields: fields });
  };

  /* ---------------------------------------------------- 0. the guard */

  if (str(inp.gadsLeadSentAt)) {
    return done({ ...blank, gads_result: 'skipped_already_sent' });
  }

  /* ------------------------------------------- 1. when did it happen */

  const nowSec = Math.floor(Date.now() / 1000);
  let eventTime = toEpochSeconds(inp.leadAt) || nowSec;
  if (eventTime > nowSec) eventTime = nowSec;
  if (nowSec - eventTime > MAX_EVENT_AGE_SECONDS) {
    return done({
      ...blank,
      gads_result: 'skipped_too_old',
      gads_error: `Lead is ${Math.floor((nowSec - eventTime) / 86400)} days old, outside Google's 90-day window.`,
    });
  }

  /* --------------------------------------------- 2. who registered */

  const phone = normPhone(inp.phone);

  const rawGclid = str(inp.gclid);
  let gclid = '';
  let clickState = 'none';
  if (rawGclid) {
    if (looksTruncated(rawGclid)) clickState = 'dropped_truncated';
    else { gclid = rawGclid; clickState = 'gclid'; }
  }

  const userIdentifiers = [];
  const matchKeys = [];
  if (email) { userIdentifiers.push({ emailAddress: sha256(email) }); matchKeys.push('email'); }
  if (phone) { userIdentifiers.push({ phoneNumber: sha256(phone) }); matchKeys.push('phone'); }
  // No name: Google only accepts a name inside an address identifier, which
  // also needs postal code and region. Most lead forms collect no postal code.
  if (gclid) matchKeys.push('gclid');

  if (!gclid && !userIdentifiers.length) {
    return done({
      ...blank,
      gads_click_id: clickState,
      gads_result: 'skipped_no_identifier',
      gads_error: 'Lead has no gclid, email or phone to match on.',
    });
  }

  /* ------------------------------------------------------ 3. to Google */

  // No conversionValue. A free sign-up has no revenue; the value
  // belongs on the conversion action's default in Google Ads if you want one,
  // not invented here per event.
  const gEvent = {
    transactionId,
    eventTimestamp: new Date(eventTime * 1000).toISOString(),
    eventSource: 'WEB',
  };
  if (gclid) gEvent.adIdentifiers = { gclid };
  if (userIdentifiers.length) gEvent.userData = { userIdentifiers };

  const destination = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
    productDestinationId: CONVERSION_ACTION_ID,
  };
  if (loginCustomerId && loginCustomerId !== customerId) {
    destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: loginCustomerId };
  }

  const body = { destinations: [destination], encoding: 'HEX', events: [gEvent] };
  if (validateOnly) body.validateOnly = true;

  const auth = await getAccessToken(clientId, clientSecret, refreshToken);
  if (!auth.token) {
    // Never throw: re-enrollment is OFF and HubSpot will not retry, so a throw
    // loses the conversion with nothing recording it. 'error' leaves the guard
    // unstamped for the retry workflow.
    return done({ ...blank, gads_click_id: clickState, gads_match_keys: matchKeys.join(','), gads_result: 'error', gads_error: auth.error });
  }

  const result = await fetchWithRetry(INGEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const ok = result.status >= 200 && result.status < 300;
  const warnings = (result.json && result.json.fieldWarnings) || [];

  const outputFields = {
    gads_result: ok ? (validateOnly ? 'validated' : 'sent') : 'error',
    gads_status: result.status,
    gads_request_id: str(result.json && result.json.requestId),
    gads_transaction_id: transactionId,
    gads_match_keys: matchKeys.join(','),
    gads_click_id: clickState,
    gads_error: ok
      ? (warnings.length ? `warnings: ${JSON.stringify(warnings)}`.slice(0, 500) : '')
      : googleError(result),
  };

  if (!ok) {
    console.log(JSON.stringify({ failed: gEvent, response: outputFields }));
    return done(outputFields);
  }

  // A validate-only run proves the payload, not a send. Stamping the guard here
  // would block the real send once the secret is removed.
  if (hubspotToken && !validateOnly) {
    const guardError = await stampGuard(objectId, hubspotToken);
    if (guardError) outputFields.gads_error = guardError;
  }

  console.log(JSON.stringify({ sent: gEvent, response: outputFields }));
  callback({ outputFields });
};
