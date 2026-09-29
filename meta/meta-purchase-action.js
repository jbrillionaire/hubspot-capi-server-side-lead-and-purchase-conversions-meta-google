/**
 * meta-purchase-action.js -- Meta Conversions API: Purchase from a Stripe payment
 * -------------------------------------------------------------------------------
 * Author:   Jibril Sulaiman
 * Created:  2026-09-28 (from a production build first shipped 2026-09-05, revised 2026-09-17)
 * Deploy:   HubSpot > Automation > Workflows > a workflow on the object your Stripe
 *           payments sync into (one record per PaymentIntent) > Custom code, Node.js 20.x.
 *           Paste the whole file; change only the SETTINGS block below.
 *           Never in a page or Design Manager: it holds a Meta token and a Stripe key.
 *
 * WHAT IT DOES
 *   Sends one server-side Purchase to Meta for each settled Stripe payment. Stripe is
 *   the source of truth: the amount actually charged (after promo codes and add-ons),
 *   the currency, the buyer's email/phone/name/address and, if your checkout link
 *   carried them, Meta's fbc/fbp click ids. Refunded, unpaid, $0, test-mode and stale
 *   payments are skipped with a reason.
 *
 * WHY IT'S BUILT THIS WAY (each point was a production failure first)
 *   - One sender. Browser pixels on confirmation pages, Events Manager "Event Setup
 *     Tool" rules, tag-manager pixel templates and HubSpot's Ads conversion events can
 *     ALL send Purchase, with no shared event_id, so Meta counts each. Before turning
 *     this on, remove every other Purchase sender (README, step 1).
 *   - event_id = order_id = the PaymentIntent id (pi_...). A browser pixel can't know
 *     it (Stripe's redirect only offers {CHECKOUT_SESSION_ID}), which is why this is
 *     meant to be the ONLY Purchase sender.
 *   - Meta dedupes an event_id for only 48 hours. Re-enrollment OFF plus the guard
 *     property are what stop a re-enrollment weeks later from booking the sale twice.
 *   - A Meta error never throws. HubSpot doesn't retry a failed custom code action and
 *     re-enrollment is off, so throwing would lose the sale with nothing recording it.
 *     It returns capi_result "error", leaves the guard blank, and the retry workflow
 *     (README, step 6) sends it later.
 *   - Any Stripe 4xx is classified, not thrown. Test-mode payments reaching the object
 *     make a live key 404 ("a similar object exists in test mode").
 *   - action_source is system_generated: "website" requires client_user_agent, which a
 *     server-side payment record doesn't have.
 *   - Events older than 6 days are skipped, never back-dated: an old sale reported as
 *     today's corrupts today's ROAS. Meta rejects events older than 7 days anyway.
 *
 * WORKFLOW (main)
 *   Object:         your payment records
 *   Trigger:        <PaymentIntent id property> is known
 *               AND status is any of succeeded           (if your object holds unpaid intents)
 *               AND create date is less than 7 days ago
 *   Re-enrollment:  OFF
 *   On turn-on:     don't enroll existing records
 *   Rate limit:     ~3 per second if you take bursts of payments
 *
 * SECRETS (the secret's NAME becomes the env var; match SETTINGS below)
 *   STRIPE_READ_KEY          Stripe live restricted key: Checkout Sessions read +
 *                            PaymentIntents read (the second covers invoices/renewals)
 *   META_CAPI_ACCESS_TOKEN   Events Manager > your dataset > Settings > Generate access token
 *   META_CAPI_DATASET_ID     the numeric Pixel / Dataset id
 *   META_CAPI_TEST_CODE      optional TEST12345 from Events Manager > Test events.
 *                            DETACH before go-live: attached to a live workflow, every
 *                            real event goes to Test events and is lost, not queued.
 *   CAPI_GUARD_WRITE_TOKEN   optional HubSpot token with write on this object; stamps
 *                            the guard. Use a key dedicated to these actions.
 *
 * INPUT FIELDS ("Property to include in code"; properties only, no static values)
 *   paymentIntentId   required  the pi_... id property
 *   metaCapiSentAt    optional  the guard property (meta_capi_purchase_sent_at)
 *   checkoutSessionId optional  cs_... id if you store it (saves one Stripe call)
 *   orderReference    optional  another property holding the cs_... id, if that's where yours is
 *   contactEmail      optional  associated contact's email, fallback if Stripe has none
 *   fbc / fbp         optional  associated contact properties, if you store them
 *   externalId        optional  associated CONTACT record id. Map it: a free match gain.
 *   eventName         optional  defaults to Purchase
 *   minimumValue      optional  defaults to 0.01; below it nothing is sent
 *
 * OUTPUT FIELDS (declare in the action UI)
 *   capi_result  String   sent | error | skipped_already_sent | skipped_no_amount |
 *                         skipped_refunded | skipped_not_succeeded | skipped_no_identifier |
 *                         skipped_test_mode | skipped_not_found | skipped_too_old
 *   capi_value Number · capi_currency String · capi_status Number · capi_events_received Number
 *   capi_event_id String · capi_fbtrace_id String · capi_source String
 *   capi_match_keys String   which identifiers were sent: watch this when Events Manager
 *                            reports low Event Match Quality
 *   capi_fbc_source String   url_fbc | synthesized_from_fbclid | truncated | malformed | none
 *   capi_error String
 *
 * A blank guard does NOT prove the event wasn't sent: if CAPI_GUARD_WRITE_TOKEN is
 * detached or rotated, events still reach Meta and nothing is stamped. Check Events
 * Manager before concluding the action is dead.
 */

const crypto = require('crypto');

// A HubSpot secret's NAME becomes its env var name, so these must match the
// secrets attached to the action.
/* ---------------------------------------------------------------- SETTINGS */
const OBJECT_TYPE = '2-00000000';                 // object type id of your payment records
const GUARD_PROPERTY = 'meta_capi_purchase_sent_at';
const STRIPE_SECRET_NAME = 'STRIPE_READ_KEY';
const TOKEN_SECRET_NAME = 'CAPI_GUARD_WRITE_TOKEN';
const META_TOKEN_SECRET = 'META_CAPI_ACCESS_TOKEN';
const META_DATASET_SECRET = 'META_CAPI_DATASET_ID';
const META_TEST_SECRET = 'META_CAPI_TEST_CODE';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const HUBSPOT_BASE = 'https://api.hubapi.com';
const GRAPH_VERSION = 'v23.0';

// GUARD_PROPERTY (above) is set after a successful send. Its presence is the only thing
// standing between re-enrolment and a double-counted sale once Meta's 48h event_id window closes.

// Meta rejects events older than 7 days. Data Sync can lag, so allow margin and
// skip rather than back-date: reporting a stale purchase as today's is worse
// than not reporting it, because it corrupts the day's ROAS.
const MAX_EVENT_AGE_SECONDS = 6 * 24 * 60 * 60;

// Stripe reports these in whole units; everything else is in the minor unit.
const ZERO_DECIMAL = ['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf'];

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
  if (d.length === 10) d = '1' + d;          // Stripe usually gives E.164 already
  return d.length >= 7 ? d : '';
};

const normText = (v) => str(v).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

const normZip = (v) => {
  const z = str(v).toLowerCase().replace(/\s/g, '');
  return /^\d/.test(z) ? z.split('-')[0].slice(0, 5) : z.slice(0, 5);
};

// Stripe returns the 2-letter code for US addresses most of the time, but not
// always — and blindly slicing a full name gives 'ge' for Georgia, which hashes
// to a value that matches nothing while still consuming a match key.
const US_STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', districtofcolumbia: 'dc',
  florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il',
  indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi',
  minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt',
  nebraska: 'ne', nevada: 'nv', newhampshire: 'nh', newjersey: 'nj',
  newmexico: 'nm', newyork: 'ny', northcarolina: 'nc', northdakota: 'nd',
  ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa',
  puertorico: 'pr', rhodeisland: 'ri', southcarolina: 'sc', southdakota: 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va',
  washington: 'wa', westvirginia: 'wv', wisconsin: 'wi', wyoming: 'wy'
};

const normState = (v) => {
  const s = normText(v);
  if (!s) return '';
  if (s.length === 2) return s;
  return US_STATES[s] || '';          // unknown or non-US: omit rather than guess
};

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

async function stripeGet(path, key) {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` }
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

async function postMeta(url, body, attempts = 3) {
  let last = { status: 0, json: {}, text: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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

// Stamps the guard so a re-enrolment cannot send this sale twice. A failure here
// is reported but never thrown: the money event already reached Meta, and a
// misleading red action log is worse than a small risk of one duplicate.
async function stampGuard(objectId, token) {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/${OBJECT_TYPE}/${objectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { [GUARD_PROPERTY]: new Date().toISOString() } })
  });
  if (!res.ok) {
    const text = await res.text();
    return `guard not written (${res.status}): ${text.slice(0, 200)}`;
  }
  return '';
}

// fb.<subdomain-index>.<click-time-ms>.<payload>
const FB_SHAPE = /^fb\.\d+\.\d{10,}\..+$/;
// A truncated click id is worse than none: it looks present, costs a user_data
// slot, and matches nothing. Two tells, because length alone is not enough —
// older IwAR-style fbclids are legitimately ~55 chars.
const MIN_FBCLID_LENGTH = 40;
// Older order-form code sliced tracking values at exactly 100 characters, sized
// for campaign names. A value landing on exactly that boundary is a truncation
// artefact, not a coincidence — an 81-char payload passes every length floor.
const CAP_LENGTHS = [100];
const looksCapped = (v) => CAP_LENGTHS.includes(v.length);

// Decides what actually goes to Meta and, just as importantly, records WHERE it
// came from: that tells you which checkout pages still send a bare fbclid and
// which send the pixel's real cookie values.
function classifyFb(rawFbc, rawFbp, fbclid, createdSec) {
  const out = { fbc: '', fbp: '', source: 'none', note: '' };

  if (rawFbp && FB_SHAPE.test(rawFbp)) out.fbp = rawFbp;
  else if (rawFbp) out.note = 'fbp malformed, dropped; ';

  if (rawFbc) {
    if (!FB_SHAPE.test(rawFbc)) {
      out.source = 'malformed';
      out.note += `fbc "${rawFbc.slice(0, 24)}…" is not fb.N.timestamp.payload, dropped`;
      return out;
    }
    const payload = rawFbc.split('.').slice(3).join('.');
    if (payload.length < MIN_FBCLID_LENGTH || looksCapped(rawFbc)) {
      out.source = 'truncated';
      out.note += `fbc cut short (${rawFbc.length} chars total, ${payload.length}-char click id), dropped`;
      return out;
    }
    out.fbc = rawFbc;
    out.source = 'url_fbc';
    return out;
  }

  // Legacy path: a link still forwarding bare fbclid instead of fbc. The click
  // time is unknown, so the session time stands in — approximate, and Meta uses
  // that timestamp when matching, so treat this as a page still to be updated.
  if (fbclid) {
    if (fbclid.length < MIN_FBCLID_LENGTH || looksCapped(fbclid)) {
      out.source = 'truncated';
      out.note += `fbclid cut short (${fbclid.length} chars), dropped`;
      return out;
    }
    out.fbc = `fb.1.${createdSec * 1000}.${fbclid}`;
    out.source = 'synthesized_from_fbclid';
    out.note += 'built from bare fbclid with an approximate click time — update the order form on this page to send fbc';
  }
  return out;
}

// Stripe copies the payment-link URL's query string onto success_url, which is
// how the UTM action recovers utm_source. fbclid rides along the same way.
function paramsFromUrl(url) {
  const out = {};
  const raw = str(url);
  if (!raw) return out;
  const q = raw.indexOf('?');
  if (q === -1) return out;
  try {
    new URLSearchParams(raw.slice(q + 1)).forEach((value, key) => {
      if (value) out[key.toLowerCase()] = value;
    });
  } catch (e) { /* malformed query string */ }
  return out;
}

/* --------------------------------------------------------------------- main */

exports.main = async (event, callback) => {
  const inp = event.inputFields || {};

  const stripeKey = getSecret(STRIPE_SECRET_NAME, true);
  const hubspotToken = getSecret(TOKEN_SECRET_NAME, false);   // optional guard
  const metaToken = getSecret(META_TOKEN_SECRET, true);
  const datasetId = getSecret(META_DATASET_SECRET, true);
  const testCode = getSecret(META_TEST_SECRET, false);

  const paymentIntentId = str(inp.paymentIntentId);
  if (!paymentIntentId) throw new Error('paymentIntentId input is required (stripe_payment_transaction_id).');

  const objectId = str(event.object && event.object.objectId);
  const eventName = str(inp.eventName) || 'Purchase';
  const minimumValue = Number(str(inp.minimumValue)) > 0 ? Number(str(inp.minimumValue)) : 0.01;

  const blank = {
    capi_value: 0, capi_currency: '', capi_status: 0, capi_events_received: 0,
    capi_event_id: paymentIntentId, capi_fbtrace_id: '', capi_match_keys: '',
    capi_source: 'none', capi_fbc_source: 'none', capi_error: ''
  };

  const done = (fields) => {
    console.log(JSON.stringify(fields));
    callback({ outputFields: fields });
  };

  /* -------------------------------------------- 0. the optional guard */
  // Re-enrollment OFF is the primary protection. This catches the rest: manual
  // re-enrolment, a cloned workflow, someone flipping re-enrollment back on,
  // and — by design — the companion retry workflow re-running a sent record.

  if (str(inp.metaCapiSentAt)) {
    return done({ ...blank, capi_result: 'skipped_already_sent' });
  }

  /* ------------------------------------------------- 1. find the session */

  let session = null;
  const sessionId = str(inp.checkoutSessionId) || str(inp.orderReference);

  // Expanding payment_intent.latest_charge is what makes the refund check work
  // on this path. It needs "PaymentIntents: read" on the restricted key, so fall
  // back to the plain retrieve if the key is narrower — a missing refund check
  // is a far smaller problem than not sending the sale at all.
  const fullExpand = 'expand[]=line_items&expand[]=payment_intent.latest_charge';

  if (/^cs_/.test(sessionId)) {
    try {
      session = await stripeGet(`/checkout/sessions/${sessionId}?${fullExpand}`, stripeKey);
    } catch (err) {
      if (err.status === 400 || err.status === 403) {
        session = await stripeGet(`/checkout/sessions/${sessionId}?expand[]=line_items`, stripeKey);
      } else if (err.status === 404) {
        session = null;          // fall through to the PaymentIntent path below
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
  // Renewals, invoices and dashboard-created charges have no Checkout Session.
  // This is also where TEST-MODE records land: no live session exists for them,
  // and the live key then 404s on the PaymentIntent itself.

  let intent = null;
  if (!session) {
    try {
      intent = await stripeGet(
        `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
        stripeKey
      );
    } catch (err) {
      // Any 4xx here means this payment is simply not reachable with this key.
      // Throwing would kill the execution and lose the record silently, so
      // classify it and exit cleanly instead.
      if (err.status >= 400 && err.status < 500) {
        const isTestMode = /test mode/i.test(str(err.stripeMessage));
        let result = 'skipped_not_found';
        if (err.status === 403) result = 'skipped_no_identifier';
        if (isTestMode) result = 'skipped_test_mode';

        return done({
          ...blank,
          capi_result: result,
          capi_status: err.status,
          capi_error: isTestMode
            ? 'Test-mode payment reached by a live-mode key. Expected: the test-mode ' +
              'writer feeds this object too, and these are not real revenue.'
            : str(err.message).slice(0, 500)
        });
      }
      throw err;   // 5xx and network faults stay loud — those are worth a retry
    }
  }

  const source = session ? 'checkout_session' : 'payment_intent';

  // The charge now resolves on BOTH paths, so skipped_refunded actually works
  // for payment-link sales rather than only for invoices.
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

  const skeleton = {
    capi_value: value || 0,
    capi_currency: currency,
    capi_status: 0,
    capi_events_received: 0,
    capi_event_id: paymentIntentId,
    capi_fbtrace_id: '',
    capi_match_keys: '',
    capi_source: source,
    capi_fbc_source: 'none',
    capi_error: ''
  };

  if (notPaid) return done({ ...skeleton, capi_result: 'skipped_not_succeeded' });
  if (charge && (charge.refunded || Number(charge.amount_refunded) >= Number(charge.amount))) {
    return done({ ...skeleton, capi_result: 'skipped_refunded' });
  }
  if (value === null || value < minimumValue) {
    // $0 comps (100%-off promo codes) land here on the rare occasion they reach the object.
    return done({ ...skeleton, capi_result: 'skipped_no_amount' });
  }

  /* -------------------------------------------------- 4. buyer identifiers */

  const details = (session && session.customer_details) || (charge && charge.billing_details) || {};
  const address = details.address || {};

  const email = normEmail(details.email || (intent && intent.receipt_email) || inp.contactEmail);
  const phone = normPhone(details.phone);
  const { first, last } = splitName(details.name);

  const linkParams = paramsFromUrl(session && session.success_url);
  const fbclid = str(linkParams.fbclid);
  const createdSec = Number((session && session.created) || (intent && intent.created)) || Math.floor(Date.now() / 1000);

  // An order form can send fbc/fbp ready-made, built from the pixel's own
  // _fbc/_fbp cookies. Pass those through untouched — never rebuild what the
  // browser already knows.
  const raw = { fbc: str(inp.fbc) || str(linkParams.fbc), fbp: str(inp.fbp) || str(linkParams.fbp) };
  const checked = classifyFb(raw.fbc, raw.fbp, fbclid, createdSec);
  const fbc = checked.fbc;
  const fbp = checked.fbp;

  const externalId = str(inp.externalId);

  const userData = {};
  const matchKeys = [];
  const add = (key, hashed, label) => { userData[key] = [hashed]; matchKeys.push(label || key); };

  if (email) add('em', sha256(email));
  if (phone) add('ph', sha256(phone));
  if (normText(first)) add('fn', sha256(normText(first)));
  if (normText(last)) add('ln', sha256(normText(last)));
  if (normText(address.city)) add('ct', sha256(normText(address.city)));
  if (normState(address.state)) add('st', sha256(normState(address.state)));
  if (normZip(address.postal_code)) add('zp', sha256(normZip(address.postal_code)));
  if (normText(address.country)) add('country', sha256(normText(address.country).slice(0, 2)));
  if (externalId) add('external_id', sha256(externalId));
  if (fbc) { userData.fbc = fbc; matchKeys.push('fbc'); }
  if (fbp) { userData.fbp = fbp; matchKeys.push('fbp'); }

  if (!email && !phone && !fbc && !externalId) {
    return done({ ...skeleton, capi_result: 'skipped_no_identifier',
      capi_error: 'Stripe returned no email, phone or click id for this payment.' });
  }

  /* -------------------------------------------------------- 5. custom_data */

  const lineItems = (session && session.line_items && session.line_items.data) || [];
  const contents = lineItems.map((li) => {
    const qty = Number(li.quantity) || 1;
    const lineTotal = majorUnits(li.amount_total, currency);
    return {
      id: str((li.price && li.price.id) || li.id),
      quantity: qty,
      // UNIT price. amount_total is the whole line, so dividing is what keeps
      // quantity > 1 from reporting double the real per-item price.
      item_price: lineTotal === null ? null : Number((lineTotal / qty).toFixed(2))
    };
  });

  const customData = {
    value,
    currency,
    order_id: paymentIntentId
  };
  if (lineItems.length) {
    customData.content_name = lineItems.map((li) => str(li.description)).filter(Boolean).join(' + ').slice(0, 200);
    customData.content_type = 'product';
    customData.contents = contents;
    customData.num_items = contents.reduce((n, c) => n + c.quantity, 0);
  }
  if (str(linkParams.utm_source)) customData.utm_source = str(linkParams.utm_source);
  if (str(linkParams.utm_campaign)) customData.utm_campaign = str(linkParams.utm_campaign);

  /* ------------------------------------------------------------ 6. to Meta */

  // "website" would require client_user_agent, which a server-side payment
  // record does not have. system_generated is the honest, accepted value.
  let eventTime = createdSec;
  const nowSec = Math.floor(Date.now() / 1000);
  if (eventTime > nowSec) eventTime = nowSec;
  if (nowSec - eventTime > MAX_EVENT_AGE_SECONDS) {
    // Do NOT back-date to fit the window. An old sale reported as today's
    // inflates today's ROAS and misleads whoever is pacing spend against it.
    return done({
      ...skeleton,
      capi_result: 'skipped_too_old',
      capi_error: `Payment is ${Math.floor((nowSec - eventTime) / 86400)} days old, ` +
        'outside the 7-day window Meta accepts.'
    });
  }

  const capiEvent = {
    event_name: eventName,
    event_time: eventTime,
    event_id: paymentIntentId,      // same id as order_id, so any pixel Purchase can dedupe
    action_source: 'system_generated',
    user_data: userData,
    custom_data: customData
  };
  if (session && session.success_url) {
    capiEvent.event_source_url = str(session.success_url).split('?')[0];
  }

  const body = { data: [capiEvent] };
  if (testCode) body.test_event_code = testCode;

  const result = await postMeta(
    `https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}/events?access_token=${encodeURIComponent(metaToken)}`,
    body
  );

  const ok = result.status >= 200 && result.status < 300;
  const fbError = (result.json && result.json.error) || null;

  const outputFields = {
    capi_result: ok ? 'sent' : 'error',
    capi_value: value,
    capi_currency: currency,
    capi_status: result.status,
    capi_events_received: (result.json && result.json.events_received) || 0,
    capi_event_id: paymentIntentId,
    capi_fbtrace_id: str((result.json && result.json.fbtrace_id) || (fbError && fbError.fbtrace_id)),
    capi_match_keys: matchKeys.join(','),
    capi_source: source,
    capi_fbc_source: checked.source,
    capi_error: ok
      ? ''
      : str((fbError && `${fbError.code}/${fbError.error_subcode || 0}: ${fbError.message}`) || result.text).slice(0, 500)
  };

  // A Meta failure used to throw here. It must not: re-enrollment is OFF and
  // HubSpot does not retry a failed action, so throwing lost the sale with
  // nothing recording the loss. Returning 'error' leaves the guard UNSTAMPED,
  // which is exactly what the companion retry workflow enrols on.
  if (!ok) {
    console.log(JSON.stringify({ failed: capiEvent, fb: checked.note, response: outputFields }));
    return done(outputFields);
  }

  if (objectId && hubspotToken) {
    const guardError = await stampGuard(objectId, hubspotToken);
    if (guardError) outputFields.capi_error = guardError;
  }

  console.log(JSON.stringify({ sent: capiEvent, fb: checked.note, response: outputFields }));

  callback({ outputFields });
};
