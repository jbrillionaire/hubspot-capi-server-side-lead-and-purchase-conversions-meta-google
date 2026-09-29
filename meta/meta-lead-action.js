/**
 * meta-lead-action.js -- Meta Conversions API: one Lead per lead record
 * ---------------------------------------------------------------------
 * Author:   Jibril Sulaiman
 * Created:  2026-09-28 (from a production build first shipped 2026-09-19)
 * Deploy:   HubSpot > Automation > Workflows > a workflow on the object that holds
 *           one record per lead (a registrations / sign-ups custom object, or
 *           contacts) > Custom code, Node.js 20.x. Paste the whole file; change only
 *           the SETTINGS block below.
 *
 * WHY IT EXISTS
 *   HubSpot's native Ads > Conversion events send one event per FORM SUBMISSION,
 *   with no event_id, so one person tripping two mapped forms is two Leads and
 *   nothing can dedupe them. In production that ran ~1.2 Meta Leads per real
 *   registration, plus browser pixel Leads on top. This action sends exactly one
 *   Lead per record, keyed on the record id, and the count matches the CRM.
 *
 * CUTOVER ORDER (the Lead event usually drives your campaigns' optimisation)
 *   1. Turn this workflow ON while your existing Lead senders stay on. Volume goes
 *      up for a day. Expected and temporary.
 *   2. Confirm Lead events arrive in Events Manager with event_id = the record id,
 *      and capi_result = sent.
 *   3. Compare a full day: sends should equal new lead records 1:1.
 *   4. Only then turn OFF the other Lead senders (HubSpot Ads conversion events
 *      mapped to Lead, page pixels, Event Setup Tool rules).
 *   5. Re-measure. Server Leads should now equal lead records.
 *
 * WORKFLOW
 *   Object:         your lead records
 *   Trigger:        <lead time property> is known
 *               AND meta_capi_lead_sent_at is unknown
 *               AND <lead time property> is less than 7 days ago
 *   Re-enrollment:  OFF   (Meta forgets an event_id after 48 hours)
 *   On turn-on:     don't enroll existing records (Meta rejects events > 7 days old)
 *   Rate limit:     set one (e.g. 3 per second). Sign-ups spike around launches, and
 *                   parallel executions against one token get rate-limited.
 *
 * SECRETS
 *   META_CAPI_ACCESS_TOKEN · META_CAPI_DATASET_ID · META_CAPI_TEST_CODE (optional,
 *   DETACH before go-live) · CAPI_GUARD_WRITE_TOKEN (HubSpot token with write on
 *   this object, stamps the guard)
 *
 * GUARD PROPERTY (create first): meta_capi_lead_sent_at, "Date and time picker".
 *   Without it the action still sends, but a re-enrollment double-counts.
 *
 * INPUT FIELDS
 *   metaCapiLeadSentAt  required  the guard property
 *   email               required  email
 *   leadAt              required  when the lead happened (created date or a
 *                                 "registered at" property)
 *   phone               optional
 *   offerName           optional  what they signed up for (sent as content_name)
 *   offerDate           optional  the date of the thing, e.g. a webinar date
 *   externalId          optional  the associated CONTACT's record id. Map it: a free
 *                                 match-quality gain. Never this record's own id,
 *                                 which is unique per lead and matches nobody.
 *   firstName/lastName  optional  associated contact's names
 *   fbc / fbp           optional  if you store Meta click ids on the contact
 *   eventName           optional  defaults to Lead
 *
 * OUTPUT FIELDS
 *   capi_result String  sent | error | skipped_already_sent | skipped_no_identifier | skipped_too_old
 *   capi_status Number · capi_events_received Number · capi_event_id String
 *   capi_match_keys String · capi_fbtrace_id String · capi_error String
 */

const crypto = require('crypto');

const META_TOKEN_SECRET = 'META_CAPI_ACCESS_TOKEN';
const META_DATASET_SECRET = 'META_CAPI_DATASET_ID';
const META_TEST_SECRET = 'META_CAPI_TEST_CODE';
const TOKEN_SECRET_NAME = 'CAPI_GUARD_WRITE_TOKEN';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const GRAPH_VERSION = 'v23.0';

/* ---------------------------------------------------------------- SETTINGS */
const OBJECT_TYPE = '2-00000000';                 // object type id of your lead records ('0-1' for contacts)
const GUARD_PROPERTY = 'meta_capi_lead_sent_at';
const LEAD_CATEGORY = 'lead';                     // sent as custom_data.content_category

// Meta rejects events older than 7 days. Skip rather than back-date: a stale
// lead reported as today's corrupts the day's CPL for whoever is
// pacing spend against it.
const MAX_EVENT_AGE_SECONDS = 6 * 24 * 60 * 60;

/* ------------------------------------------------------------------ helpers */

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

const normEmail = (v) => {
  const e = str(v).toLowerCase();
  return e.includes('@') ? e : '';
};

const normPhone = (v) => {
  let d = str(v).replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, '');
  if (d.length === 10) d = '1' + d;      // bare US number
  return d.length >= 7 ? d : '';
};

const normText = (v) => str(v).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

// HubSpot hands datetime properties to custom code as epoch MILLISECONDS most
// of the time, but an ISO string comes through on some paths. Accept both
// rather than guessing, because getting this wrong silently shifts every
// event_time and Meta attributes the lead to the wrong day.
function toEpochSeconds(v) {
  const raw = str(v);
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? Math.floor(n / 1000) : n;   // ms vs s
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

// A date property arrives as epoch milliseconds, so passing it straight into
// custom_data ships "1790035200000" to Meta — the right date, in a form nobody
// can segment or read. Send YYYY-MM-DD instead.
function toIsoDate(v) {
  const raw = str(v);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);   // already a date
  const sec = toEpochSeconds(raw);
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';
}

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

async function postMeta(url, body, attempts = 3) {
  let last = { status: 0, json: {}, text: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = {};
      try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
      last = { status: res.status, json, text };
      if (res.status < 500 && res.status !== 429) return last;   // retry transient only
    } catch (err) {
      last = { status: 0, json: {}, text: str(err && err.message) };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return last;
}

// A failure here is reported but never thrown: the lead already reached Meta,
// and a misleading red action log is worse than a small risk of one duplicate.
//
// The property may be created as either "datetime" or date-only "date",
// depending on whether it was made through the API or HubSpot's property UI
// (which offers Date picker). A date-only property rejects a full ISO timestamp
// with a 400, so fall back to midnight UTC rather than leaving the guard blank —
// an unstamped record gets re-sent, which is the exact thing this prevents.
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
    // Date-only property: HubSpot wants midnight UTC.
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    );
    r = await patchGuard(objectId, token, String(midnightUtc));
    if (r.ok) return '';
  }

  return `guard not written (${r.status}): ${r.text}`;
}

// fb.<subdomain-index>.<click-time-ms>.<payload>
const FB_SHAPE = /^fb\.\d+\.\d{10,}\..+$/;

/* --------------------------------------------------------------------- main */

exports.main = async (event, callback) => {
  const inp = event.inputFields || {};

  const metaToken = getSecret(META_TOKEN_SECRET, true);
  const datasetId = getSecret(META_DATASET_SECRET, true);
  const testCode = getSecret(META_TEST_SECRET, false);
  const hubspotToken = getSecret(TOKEN_SECRET_NAME, false);   // guard is optional

  const objectId = str(event.object && event.object.objectId);
  if (!objectId) throw new Error('No objectId on the event — this action must run on a record.');

  const eventName = str(inp.eventName) || 'Lead';

  const blank = {
    capi_status: 0,
    capi_events_received: 0,
    capi_event_id: objectId,
    capi_match_keys: '',
    capi_fbtrace_id: '',
    capi_error: '',
  };

  const done = (fields) => {
    console.log(JSON.stringify(fields));
    callback({ outputFields: fields });
  };

  /* ---------------------------------------------------- 0. the guard */
  // Re-enrollment OFF is the primary protection. This catches the rest: manual
  // re-enrolment, a cloned workflow, someone flipping re-enrollment back on,
  // and the companion retry workflow re-running a record already sent.

  if (str(inp.metaCapiLeadSentAt)) {
    return done({ ...blank, capi_result: 'skipped_already_sent' });
  }

  /* ------------------------------------------- 1. when did it happen */

  const nowSec = Math.floor(Date.now() / 1000);
  let eventTime = toEpochSeconds(inp.leadAt) || nowSec;
  if (eventTime > nowSec) eventTime = nowSec;

  if (nowSec - eventTime > MAX_EVENT_AGE_SECONDS) {
    return done({
      ...blank,
      capi_result: 'skipped_too_old',
      capi_error:
        `Lead is ${Math.floor((nowSec - eventTime) / 86400)} days old, ` +
        'outside the 7-day window Meta accepts.',
    });
  }

  /* --------------------------------------------- 2. who is the lead */

  const email = normEmail(inp.email);
  const phone = normPhone(inp.phone);
  const first = normText(inp.firstName);
  const last = normText(inp.lastName);
  const externalId = str(inp.externalId);

  const rawFbc = str(inp.fbc);
  const rawFbp = str(inp.fbp);
  const fbc = FB_SHAPE.test(rawFbc) ? rawFbc : '';
  const fbp = FB_SHAPE.test(rawFbp) ? rawFbp : '';

  const userData = {};
  const matchKeys = [];
  const add = (key, hashed) => { userData[key] = [hashed]; matchKeys.push(key); };

  if (email) add('em', sha256(email));
  if (phone) add('ph', sha256(phone));
  if (first) add('fn', sha256(first));
  if (last) add('ln', sha256(last));
  if (externalId) add('external_id', sha256(externalId));
  if (fbc) { userData.fbc = fbc; matchKeys.push('fbc'); }
  if (fbp) { userData.fbp = fbp; matchKeys.push('fbp'); }

  if (!email && !phone && !externalId && !fbc) {
    return done({
      ...blank,
      capi_result: 'skipped_no_identifier',
      capi_error: 'Lead has no email, phone, contact id or click id to match on.',
    });
  }

  /* ------------------------------------------------- 3. what it was */
  // No value/currency. A free sign-up has no revenue, and shipping a
  // placeholder value: 0.00 is exactly the defect that made the old browser
  // snippets useless. Omitting the field is honest and Meta accepts it.

  const customData = {};
  const offerName = str(inp.offerName);
  const offerDate = toIsoDate(inp.offerDate);
  if (offerName) {
    customData.content_name = offerName.slice(0, 200);
    customData.content_category = LEAD_CATEGORY;
  }
  if (offerDate) customData.offer_date = offerDate;

  /* ------------------------------------------------------ 4. to Meta */

  // "website" would require client_user_agent, which a server-side CRM record
  // does not have. system_generated is the honest, accepted value.
  const capiEvent = {
    event_name: eventName,
    event_time: eventTime,
    // The lead record id. Stable, unique per lead, and the one
    // thing any other sender could theoretically key on to dedupe.
    event_id: objectId,
    action_source: 'system_generated',
    user_data: userData,
  };
  if (Object.keys(customData).length) capiEvent.custom_data = customData;

  const body = { data: [capiEvent] };
  if (testCode) body.test_event_code = testCode;

  const result = await postMeta(
    `https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}/events` +
      `?access_token=${encodeURIComponent(metaToken)}`,
    body
  );

  const ok = result.status >= 200 && result.status < 300;
  const fbError = (result.json && result.json.error) || null;

  const outputFields = {
    capi_result: ok ? 'sent' : 'error',
    capi_status: result.status,
    capi_events_received: (result.json && result.json.events_received) || 0,
    capi_event_id: objectId,
    capi_match_keys: matchKeys.join(','),
    capi_fbtrace_id: str((result.json && result.json.fbtrace_id) || (fbError && fbError.fbtrace_id)),
    capi_error: ok
      ? ''
      : str(
          (fbError && `${fbError.code}/${fbError.error_subcode || 0}: ${fbError.message}`) ||
            result.text
        ).slice(0, 500),
  };

  // Never throw on a Meta failure. Re-enrollment is OFF and HubSpot does not
  // retry a failed action, so throwing loses the lead permanently with nothing
  // recording the loss. Returning 'error' leaves the guard UNSTAMPED, which is
  // exactly what the companion retry workflow enrols on.
  if (!ok) {
    console.log(JSON.stringify({ failed: capiEvent, response: outputFields }));
    return done(outputFields);
  }

  if (hubspotToken) {
    const guardError = await stampGuard(objectId, hubspotToken);
    if (guardError) outputFields.capi_error = guardError;
  }

  console.log(JSON.stringify({ sent: capiEvent, response: outputFields }));

  callback({ outputFields });
};
