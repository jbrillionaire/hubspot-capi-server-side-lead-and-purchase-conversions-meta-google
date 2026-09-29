/**
 * google-purchase-action.js -- Google Ads offline conversion: Purchase from a Stripe payment
 * -----------------------------------------------------------------------------------------
 * Author:   Jibril Sulaiman
 * Created:  2026-09-28 (from a production build first shipped 2026-09-23)
 * Deploy:   HubSpot > Automation > Workflows > a workflow on the object your Stripe
 *           payments sync into > Custom code, Node.js 20.x. Keep it in its OWN
 *           workflow, not bolted onto the Meta one: one platform's auth failure must
 *           not stall the other. Change only the SETTINGS block below.
 *
 * WHAT IT DOES
 *   Uploads one conversion per settled Stripe payment to a Google Ads conversion
 *   action through the Data Manager API (POST datamanager.googleapis.com/v1/events:ingest).
 *   Value and currency come from Stripe (amount actually charged). Identifiers: hashed
 *   email and phone, name + address, and one ad click id if available.
 *
 * WHY THE DATA MANAGER API
 *   Since 2026-06-15 Google has moved offline click conversions off the Google Ads
 *   API's UploadClickConversions. Data Manager needs no developer token and no manager
 *   account: an OAuth refresh token with the datamanager scope is enough.
 *
 * THINGS THAT ARE PERMANENT
 *   transactionId = the PaymentIntent id (pi_...). A repeat upload with the same
 *   transactionId on the same conversion action is treated as an ADJUSTMENT, forever
 *   (unlike Meta's 48-hour window). That makes re-sends safe, and a badly shaped key
 *   permanent, so don't change the key once live.
 *
 * WORKFLOW
 *   Object:         your payment records
 *   Trigger:        <PaymentIntent id property> is known
 *               AND status is any of succeeded
 *               AND google_ads_purchase_sent_at is unknown
 *               AND create date is less than 7 days ago
 *   Re-enrollment:  OFF · Rate limit ~5 per second
 *   Backfill:       optional. Because transactionId dedupes permanently, enrolling the
 *                   last 7 days on turn-on is safe (Google accepts up to 90 days).
 *
 * SECRETS
 *   STRIPE_READ_KEY               Stripe live restricted key: Checkout Sessions + PaymentIntents read
 *   GOOGLE_ADS_CLIENT_ID          } OAuth desktop client + refresh token from
 *   GOOGLE_ADS_CLIENT_SECRET      } scripts/google-oauth-setup.mjs --for hubspot
 *   GOOGLE_ADS_REFRESH_TOKEN      } (datamanager scope only)
 *   GOOGLE_ADS_CUSTOMER_ID        the Google Ads account, digits only (123-456-7890 -> 1234567890)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  optional: manager account id, only if access is through one
 *   GOOGLE_ADS_VALIDATE_ONLY      optional "true" while testing. Google checks and records
 *                                 NOTHING. Detach before go-live.
 *   CAPI_GUARD_WRITE_TOKEN        optional HubSpot token with write on this object (guard)
 *
 * INPUT FIELDS
 *   paymentIntentId    required  pi_... id
 *   gadsPurchaseSentAt optional  the guard property (google_ads_purchase_sent_at)
 *   checkoutSessionId  optional  cs_... id if stored
 *   orderReference     optional  another property holding the cs_... id
 *   contactEmail       optional  associated contact email (fallback)
 *   gclid              optional  associated contact's Google click id (HubSpot:
 *                                hs_google_click_id). Fallback only: it's the contact's
 *                                MOST RECENT click, which may not be the one that sold.
 *   minimumValue       optional  default 0.01
 *
 * OUTPUT FIELDS
 *   gads_result String  sent | validated | error | skipped_already_sent | skipped_no_amount |
 *                       skipped_refunded | skipped_not_succeeded | skipped_no_identifier |
 *                       skipped_test_mode | skipped_not_found | skipped_too_old
 *   gads_value Number · gads_currency String · gads_status Number · gads_request_id String
 *   gads_transaction_id String · gads_match_keys String · gads_click_id String · gads_source String
 *   gads_error String
 *
 * A 200 means RECEIVED, not matched. Google takes ~3 days to finish matching; never
 * judge a day's credit sooner. Check an upload with:
 *   node scripts/google-conversion-test.mjs --status <gads_request_id>
 */

const crypto = require('crypto');

/* ------------------------------------------------- per-workflow configuration */

// Google Ads conversion action id for "Purchase (Stripe)".
/* ---------------------------------------------------------------- SETTINGS */
const CONVERSION_ACTION_ID = 'REPLACE_WITH_CONVERSION_ACTION_ID';   // ctId= in the conversion action's URL

const STRIPE_SECRET_NAME = 'STRIPE_READ_KEY';
const CLIENT_ID_SECRET = 'GOOGLE_ADS_CLIENT_ID';
const CLIENT_SECRET_SECRET = 'GOOGLE_ADS_CLIENT_SECRET';
const REFRESH_TOKEN_SECRET = 'GOOGLE_ADS_REFRESH_TOKEN';
const CUSTOMER_ID_SECRET = 'GOOGLE_ADS_CUSTOMER_ID';
const LOGIN_CUSTOMER_ID_SECRET = 'GOOGLE_ADS_LOGIN_CUSTOMER_ID';
const VALIDATE_ONLY_SECRET = 'GOOGLE_ADS_VALIDATE_ONLY';
const HUBSPOT_TOKEN_SECRET = 'CAPI_GUARD_WRITE_TOKEN';

const STRIPE_BASE = 'https://api.stripe.com/v1';
// Live events report api_version 2017-08-15. Pin a version so expand[] and
// field shapes do not depend on the account default.
const STRIPE_VERSION = '2024-06-20';
const HUBSPOT_BASE = 'https://api.hubapi.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';

const OBJECT_TYPE = '2-00000000';                 // object type id of your payment records
const GUARD_PROPERTY = 'google_ads_purchase_sent_at';

// Google accepts click conversions up to 90 days after the click.
const MAX_EVENT_AGE_SECONDS = 89 * 24 * 60 * 60;

const ZERO_DECIMAL = ['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf'];

/* ------------------------------------------------------------------ helpers */

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

// Google's rule: gmail.com / googlemail.com drop the dots in the local part.
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

// E.164 WITH the "+", unlike Meta.
const normPhone = (v) => {
  let d = str(v).replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, '');
  if (d.length === 10) d = '1' + d;
  return d.length >= 8 && d.length <= 15 ? `+${d}` : '';
};

// Names: lowercase, no accents, no punctuation other than spaces inside.
const normName = (v) =>
  str(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

const majorUnits = (minor, currency) => {
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return ZERO_DECIMAL.includes(str(currency).toLowerCase()) ? n : n / 100;
};

const splitName = (full) => {
  const parts = str(full).split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.length > 1 ? parts[parts.length - 1] : '' };
};

const looksTruncated = (v) => v.length === 100 || v.length < 20;

function getSecret(name, required) {
  const value = str(process.env[name]);
  if (!value && required) {
    throw new Error(`Missing secret "${name}". Add it under Custom code > Secrets.`);
  }
  if (value && /\s/.test(value)) {
    throw new Error(`Secret "${name}" contains whitespace, so it is not a credential.`);
  }
  return value;
}

async function stripeGet(path, key) {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION },
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { /* keep raw text for the error */ }
  if (!res.ok) {
    const msg = (json.error && json.error.message) || text.slice(0, 200);
    const err = new Error(`Stripe ${res.status} on ${path.split('?')[0]}: ${msg}`);
    err.status = res.status;
    err.stripeMessage = msg;
    throw err;
  }
  return json;
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
      if (res.status < 500 && res.status !== 429) return last;
    } catch (err) {
      last = { status: 0, json: {}, text: str(err && err.message) };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return last;
}

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

async function stampGuard(objectId, token) {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/${OBJECT_TYPE}/${objectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { [GUARD_PROPERTY]: new Date().toISOString() } }),
  });
  if (!res.ok) return `guard not written (${res.status}): ${(await res.text()).slice(0, 200)}`;
  return '';
}

function paramsFromUrl(url) {
  const out = {};
  const raw = str(url);
  const q = raw.indexOf('?');
  if (q === -1) return out;
  try {
    new URLSearchParams(raw.slice(q + 1)).forEach((value, key) => {
      if (value) out[key.toLowerCase()] = value;
    });
  } catch (e) { /* malformed query string */ }
  return out;
}

// Google allows exactly ONE of gclid / gbraid / wbraid per conversion. gclid is
// the most precise, so it wins; gbraid/wbraid are iOS app-to-web stand-ins.
function pickClickId(linkParams, contactGclid) {
  const candidates = [
    ['gclid', str(linkParams.gclid), 'gclid_url'],
    ['gbraid', str(linkParams.gbraid), 'gbraid_url'],
    ['wbraid', str(linkParams.wbraid), 'wbraid_url'],
    ['gclid', str(contactGclid), 'gclid_contact'],
  ];
  let sawTruncated = false;
  for (const [field, value, label] of candidates) {
    if (!value) continue;
    if (looksTruncated(value)) { sawTruncated = true; continue; }
    return { ids: { [field]: value }, label };
  }
  return { ids: null, label: sawTruncated ? 'dropped_truncated' : 'none' };
}

/* --------------------------------------------------------------------- main */

exports.main = async (event, callback) => {
  const inp = event.inputFields || {};

  if (/^REPLACE/.test(CONVERSION_ACTION_ID)) {
    throw new Error('Set CONVERSION_ACTION_ID at the top of this action before testing.');
  }

  const stripeKey = getSecret(STRIPE_SECRET_NAME, true);
  const clientId = getSecret(CLIENT_ID_SECRET, true);
  const clientSecret = getSecret(CLIENT_SECRET_SECRET, true);
  const refreshToken = getSecret(REFRESH_TOKEN_SECRET, true);
  const customerId = getSecret(CUSTOMER_ID_SECRET, true).replace(/\D/g, '');
  const loginCustomerId = getSecret(LOGIN_CUSTOMER_ID_SECRET, false).replace(/\D/g, '');
  const validateOnly = getSecret(VALIDATE_ONLY_SECRET, false).toLowerCase() === 'true';
  const hubspotToken = getSecret(HUBSPOT_TOKEN_SECRET, false);

  const paymentIntentId = str(inp.paymentIntentId);
  if (!paymentIntentId) throw new Error('paymentIntentId input is required (stripe_payment_transaction_id).');

  const objectId = str(event.object && event.object.objectId);
  const minimumValue = Number(str(inp.minimumValue)) > 0 ? Number(str(inp.minimumValue)) : 0.01;

  const blank = {
    gads_value: 0, gads_currency: '', gads_status: 0, gads_request_id: '',
    gads_transaction_id: paymentIntentId, gads_match_keys: '', gads_click_id: 'none',
    gads_source: 'none', gads_error: '',
  };

  const done = (fields) => {
    console.log(JSON.stringify(fields));
    callback({ outputFields: fields });
  };

  /* -------------------------------------------------------- 0. the guard */

  if (str(inp.gadsPurchaseSentAt)) {
    return done({ ...blank, gads_result: 'skipped_already_sent' });
  }

  /* ------------------------------------------------- 1. find the session */

  let session = null;
  const sessionId = str(inp.checkoutSessionId) || str(inp.orderReference);
  const fullExpand = 'expand[]=line_items&expand[]=payment_intent.latest_charge';

  if (/^cs_/.test(sessionId)) {
    try {
      session = await stripeGet(`/checkout/sessions/${sessionId}?${fullExpand}`, stripeKey);
    } catch (err) {
      if (err.status === 400 || err.status === 403) {
        session = await stripeGet(`/checkout/sessions/${sessionId}?expand[]=line_items`, stripeKey);
      } else if (err.status === 404) {
        session = null;
      } else {
        throw err;
      }
    }
  } else {
    const listPath = `/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`;
    try {
      const list = await stripeGet(
        `${listPath}&expand[]=data.line_items&expand[]=data.payment_intent.latest_charge`,
        stripeKey
      );
      session = (list.data && list.data[0]) || null;
    } catch (err) {
      if (err.status === 400 || err.status === 403) {
        const list = await stripeGet(`${listPath}&expand[]=data.line_items`, stripeKey);
        session = (list.data && list.data[0]) || null;
      } else {
        throw err;
      }
    }
  }

  /* ------------------------- 2. fall back to the PaymentIntent if needed */
  // Renewals, invoices and dashboard charges have no Checkout Session. Test-mode
  // records also land here: the live key 404s on them.

  let intent = null;
  if (!session) {
    try {
      intent = await stripeGet(
        `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
        stripeKey
      );
    } catch (err) {
      if (err.status >= 400 && err.status < 500) {
        const isTestMode = /test mode/i.test(str(err.stripeMessage));
        let result = 'skipped_not_found';
        if (err.status === 403) result = 'skipped_no_identifier';
        if (isTestMode) result = 'skipped_test_mode';
        return done({ ...blank, gads_result: result, gads_status: err.status, gads_error: str(err.message).slice(0, 500) });
      }
      throw err;   // 5xx and network faults stay loud
    }
  }

  const source = session ? 'checkout_session' : 'payment_intent';
  const sessionIntent = session && session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent
    : null;
  const chargeHolder = intent || sessionIntent;
  const charge = chargeHolder && chargeHolder.latest_charge && typeof chargeHolder.latest_charge === 'object'
    ? chargeHolder.latest_charge
    : null;

  /* ---------------------------------------------------- 3. amount + guards */

  const currency = str((session && session.currency) || (intent && intent.currency) || 'usd').toUpperCase();
  const minor = session
    ? (session.amount_total !== undefined && session.amount_total !== null ? session.amount_total : null)
    : (intent && (intent.amount_received || intent.amount));
  const value = majorUnits(minor, currency);

  const paymentStatus = session ? str(session.payment_status) : str(intent && intent.status);
  const notPaid = session
    ? paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required'
    : paymentStatus && paymentStatus !== 'succeeded';

  const skeleton = { ...blank, gads_value: value || 0, gads_currency: currency, gads_source: source };

  if (notPaid) return done({ ...skeleton, gads_result: 'skipped_not_succeeded' });
  if (charge && (charge.refunded || Number(charge.amount_refunded) >= Number(charge.amount))) {
    return done({ ...skeleton, gads_result: 'skipped_refunded' });
  }
  if (value === null || value < minimumValue) {
    return done({ ...skeleton, gads_result: 'skipped_no_amount' });
  }

  const createdSec = Number((session && session.created) || (intent && intent.created)) || Math.floor(Date.now() / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  let eventTime = createdSec > nowSec ? nowSec : createdSec;
  if (nowSec - eventTime > MAX_EVENT_AGE_SECONDS) {
    return done({ ...skeleton, gads_result: 'skipped_too_old',
      gads_error: `Payment is ${Math.floor((nowSec - eventTime) / 86400)} days old, outside Google's 90-day window.` });
  }

  /* -------------------------------------------------- 4. buyer identifiers */

  const details = (session && session.customer_details) || (charge && charge.billing_details) || {};
  const address = details.address || {};

  const email = normEmail(details.email || (intent && intent.receipt_email) || inp.contactEmail);
  const phone = normPhone(details.phone);
  const { first, last } = splitName(details.name);
  const given = normName(first);
  const family = normName(last);
  const postal = str(address.postal_code).toLowerCase().replace(/\s/g, '');
  const region = str(address.country).toUpperCase();

  const linkParams = paramsFromUrl(session && session.success_url);
  const click = pickClickId(linkParams, inp.gclid);

  const userIdentifiers = [];
  const matchKeys = [];
  if (email) { userIdentifiers.push({ emailAddress: sha256(email) }); matchKeys.push('email'); }
  if (phone) { userIdentifiers.push({ phoneNumber: sha256(phone) }); matchKeys.push('phone'); }
  // Google only takes a name as part of a full address identifier: given name,
  // family name, 2-letter region and postal code, all four or none.
  if (given && family && postal && /^[A-Z]{2}$/.test(region)) {
    userIdentifiers.push({
      address: {
        givenName: sha256(given),
        familyName: sha256(family),
        regionCode: region,
        postalCode: postal,
      },
    });
    matchKeys.push('address');
  }
  if (click.ids) matchKeys.push(click.label);

  if (!click.ids && !userIdentifiers.length) {
    return done({ ...skeleton, gads_click_id: click.label, gads_result: 'skipped_no_identifier',
      gads_error: 'Stripe returned no email, phone, address or Google click id for this payment.' });
  }

  /* ------------------------------------------------------------ 5. to Google */

  const gEvent = {
    transactionId: paymentIntentId,
    eventTimestamp: new Date(eventTime * 1000).toISOString(),
    eventSource: 'WEB',
    conversionValue: value,
    currency,
  };
  if (click.ids) gEvent.adIdentifiers = click.ids;
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
    // Never throw: the guard stays blank and the retry workflow picks it up.
    return done({ ...skeleton, gads_click_id: click.label, gads_match_keys: matchKeys.join(','),
      gads_result: 'error', gads_error: auth.error });
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
    gads_value: value,
    gads_currency: currency,
    gads_status: result.status,
    gads_request_id: str(result.json && result.json.requestId),
    gads_transaction_id: paymentIntentId,
    gads_match_keys: matchKeys.join(','),
    gads_click_id: click.label,
    gads_source: source,
    gads_error: ok
      ? (warnings.length ? `warnings: ${JSON.stringify(warnings)}`.slice(0, 500) : '')
      : googleError(result),
  };

  if (!ok) {
    console.log(JSON.stringify({ failed: gEvent, response: outputFields }));
    return done(outputFields);
  }

  if (objectId && hubspotToken && !validateOnly) {
    const guardError = await stampGuard(objectId, hubspotToken);
    if (guardError) outputFields.gads_error = guardError;
  }

  console.log(JSON.stringify({ sent: gEvent, response: outputFields }));
  callback({ outputFields });
};
