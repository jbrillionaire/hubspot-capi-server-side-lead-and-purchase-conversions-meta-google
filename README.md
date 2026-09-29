<!--
  README.md -- HubSpot + CAPI server-side lead and purchase conversions for Meta and Google
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (from production builds shipped 2026-09-05 to 2026-09-23)
  What:    Why server-side conversions from HubSpot, and every setup step with a check,
           for Purchase (Stripe) and Lead events to Meta and to Google Ads.
  Why:     Ad platforms optimise on these events. A double count, a lost sale or a
           wrong hash doesn't error; it just quietly teaches the campaigns the wrong thing.
-->

# HubSpot + CAPI server-side lead and purchase conversions for Meta and Google

Send **one conversion per real sale and one per real lead** from HubSpot to the
**Meta Conversions API** and **Google Ads**, server-side, from HubSpot workflows.

- **Purchase:** every settled Stripe payment, with the amount actually charged.
- **Lead:** every lead record (a sign-up, a registration), once, even when the
  same person submits twice.

Four HubSpot custom code actions do it, one per platform per event, plus the
scripts to set up Google's OAuth and test before anything goes live.

## Why it exists

**HubSpot's native ad conversion events can't do this job, and HubSpot support
confirmed why.** HubSpot's *Ads > Conversion events* (its built-in Meta
Conversions API integration) was diagnosed against these problems in production in
September 2026, and HubSpot's support team checked each one against the product
documentation and confirmed all of them:

1. **There's no event ID, so it can't be deduplicated, ever.** Meta dedupes by
   matching `event_id` + `event_name` across sources. That's Meta's documented way
   to run browser and server events side by side. A HubSpot conversion event lets
   you set the ad network, account, trigger, form, lifecycle stage, Meta event,
   value, lead score, data sharing and consent fields. There's no event ID field,
   and no supported way to inject one from the integration or from a HubSpot page
   template. HubSpot's own documentation says to *remove* any manually installed
   pixel to avoid duplicates. The design assumes HubSpot is the only source.
   So it can't coexist with a Conversions API sender: every purchase both report is
   counted twice, permanently. It's HubSpot or your own server events, not both.
2. **There's no payment trigger, so it fires before payment.** The only triggers are
   form submission, lifecycle stage change and page view. With a HubSpot form
   followed by a Stripe checkout, the event fires whether or not the buyer ever
   pays. On one ticket tier over seven days: 26 conversions reported, 14 sales.
   (Driving a lifecycle stage change from the payment fixes the timing only; points
   1, 3 and 4 still stand.)
3. **The value is static per event.** One fixed number per conversion event, so
   order bumps, promo codes and comp tickets can't be represented. With two events
   configured (base price, and base plus an optional add-on), only the add-on
   variant ever fired, so every sale reported at the higher price, though most
   buyers didn't take the add-on.
4. **It can't see the real amount.** Only Stripe knows what was charged. HubSpot
   reports an intention to buy; Stripe reports a payment.
5. **Its pixel keeps sending after you turn the events off.** The Meta pixel added
   through HubSpot is active on every page carrying the HubSpot tracking code, from
   the moment it's added, whether or not any conversion event exists. It can't be
   limited to certain pages or domains.
6. **Silent problems leave no trail.** HubSpot support can't pull event sync logs
   unless an event actually errored. An over-count isn't an error, so there's
   nothing on HubSpot's side to investigate.
7. **Two HubSpot events mapped to one Meta event report identical numbers,** which
   looks like duplication in reporting.

**Everyone else sends too, and nobody coordinates.** Diagnosing an 8x Purchase
over-count found **four independent senders** on the same pixel, none sharing an
event id:

- pixel snippets hard-coded into confirmation pages, firing on every page view
  instead of on payment
- Meta **Event Setup Tool** rules, configured in Events Manager and invisible
  from HubSpot. They persist until deleted there; nothing in HubSpot clears them.
- a tag-manager tag firing Purchase on confirmation-page load
- HubSpot's Ads conversion events

Ad spend, impressions and the account connection were all flowing correctly the
whole time. The data problem was purely conversion events.

**Meta's recommendation: give each event one owner.** Meta's team, reviewing the
same case, put it plainly: HubSpot and Stripe were both claiming the same Purchase,
so only one can be kept, and it should be the one that knows the real amount. Let
HubSpot report the early steps (page views, form submissions as leads, with no
dollar values) and let the server-side Stripe sender own Purchase alone. Remove
HubSpot's Purchase conversion event and any old Event Setup Tool rules. This repo
does exactly that for Purchase. For Lead it goes a step further, replacing HubSpot's
lead events with one event per lead record, because in production they ran at
~1.2x real registrations (one person tripping two mapped forms counts twice).

**What this changed in production** (one HubSpot + Stripe account, Sep 2026):

| Signal | Before | After (this repo as the single sender) |
|---|---|---|
| Meta Purchase events per succeeded Stripe payment | **8.0x** (1,848 events, 230 payments, one day) | **1.02x** (536 events, 526 payments, one week) |
| Meta Lead events per lead record | ~1.2x server + ~0.5x browser (~1.75x in all) | **1.00x** (within 0.1-0.4% daily) |
| Google Ads tag-based purchase conversions vs Stripe | tag over-claimed **~7.7x** | uploads credited from real payments only |

Campaigns optimising on an 8x-inflated Purchase event are learning from noise;
bidding and reported ROAS are only as good as the event count.

**Why Google needs its own path.** Since June 15, 2026, Google has moved offline
click conversions off the Google Ads API's `UploadClickConversions` to the **Data
Manager API**. That's good news here: uploads need **no developer token and no
manager account**, just an OAuth refresh token with one scope.

---

## How it works

```text
 Stripe payment succeeds ──► synced into HubSpot (one record per PaymentIntent)
        │
        ├── workflow: META Purchase ──► meta/meta-purchase-action.js
        │        reads the Checkout Session from Stripe (amount, buyer, line items)
        │        POST graph.facebook.com/<version>/<dataset>/events   event_id = pi_...
        │
        └── workflow: GOOGLE Purchase ─► google/google-purchase-action.js
                 POST datamanager.googleapis.com/v1/events:ingest   transactionId = pi_...

 Lead record created (form, registration, sign-up object)
        ├── workflow: META Lead ───────► meta/meta-lead-action.js     event_id = record id
        └── workflow: GOOGLE Lead ─────► google/google-lead-action.js transactionId = person + offer

 Each action stamps a "sent at" guard property on the record after a real send.
```

## What's in this repo

| Path | What it is |
|---|---|
| `meta/meta-purchase-action.js` | Meta Purchase from a Stripe payment |
| `meta/meta-lead-action.js` | Meta Lead from a lead record |
| `google/google-purchase-action.js` | Google Ads Purchase from a Stripe payment |
| `google/google-lead-action.js` | Google Ads enhanced conversion for leads |
| `scripts/create-guard-properties.mjs` | Creates the four "sent at" guard properties (date-time) |
| `scripts/google-oauth-setup.mjs` | Mints the Google refresh token (datamanager scope only) |
| `scripts/google-conversion-test.mjs` | Validate-only test upload, and status lookup for real uploads |
| `test/` | 20 tests: the actions run unchanged against fake Stripe, Meta, Google and HubSpot |

Each action opens with a header covering its workflow setup, secrets, inputs and
outputs. That header is the reference; this README is the walkthrough.

---

## Table of contents

1. [Requirements](#1-requirements)
2. [Setup: before anything else](#2-setup-before-anything-else)
3. [Setup: Meta](#3-setup-meta)
4. [Setup: Google Ads](#4-setup-google-ads)
5. [The ids that prevent double counting](#5-the-ids-that-prevent-double-counting)
6. [Hashing: Meta and Google differ](#6-hashing-meta-and-google-differ)
7. [Click ids: where they come from](#7-click-ids-where-they-come-from)
8. [Reconciling](#8-reconciling)
9. [Troubleshooting](#9-troubleshooting)
10. [Limits](#10-limits)
11. [Security](#11-security)

---

## 1. Requirements

| You need | Why |
|---|---|
| HubSpot with **custom code workflow actions** (Data Hub, formerly Operations Hub, Professional or Enterprise) | The four actions are custom code |
| Stripe payments in HubSpot, **one record per PaymentIntent**, with the `pi_...` id and the status in properties | The Purchase workflows run on these records. Commonly HubSpot's Stripe Data Sync app mapped to a custom object. |
| Leads in HubSpot as **one record per lead** | A registrations or sign-ups custom object, or contacts |
| A Meta **dataset** (Pixel) with an access token | Meta side |
| A **Google Ads** account where you're an Admin | Google side: enhanced conversions for leads needs Admin to accept terms |
| A Google Cloud project | For the OAuth client |
| Node 20+ locally | For the setup scripts |

---

## 2. Setup: before anything else

### Step 1: Map every existing sender

Before turning anything on, list everything that sends Purchase or Lead today:

- **Meta:** Events Manager > your dataset > **Event Setup Tool** (codeless rules
  like "URL equals" or "button text is": these don't appear in any page code);
  pixel snippets in page head HTML; tag-manager pixel tags; HubSpot's
  *Ads > Conversion events* mapped to Purchase or Lead; and the Meta pixel installed
  through HubSpot, which runs on every tracked page even with no conversion events.
  Keep that pixel if HubSpot should keep reporting page views; just make sure no
  HubSpot conversion event claims Purchase.
- **Google Ads:** Goals > Conversions: the tag-based purchase and lead actions.

You'll switch these off **after** each new sender is proven, never before (the
Lead cutover order is in step 5). For Purchase, removing the other senders is what
makes the new one accurate: the `pi_...` event id can't be shared with a browser
pixel, so this is designed to be the **only** Purchase sender.

> **Check:** you have a written list, per platform, of each sender and where it's
> configured. The Event Setup Tool is the one people miss.

### Step 2: Create the guard properties

```powershell
$env:HUBSPOT_TOKEN = "pat-..."
$env:PAYMENTS_OBJECT = "2-12345678"; $env:PAYMENTS_GROUP = "your_payment_group"
$env:LEADS_OBJECT = "2-87654321";    $env:LEADS_GROUP = "your_lead_group"
node scripts/create-guard-properties.mjs --dry-run
node scripts/create-guard-properties.mjs
```

It creates `meta_capi_purchase_sent_at`, `google_ads_purchase_sent_at` (payments)
and `meta_capi_lead_sent_at`, `google_ads_lead_sent_at` (leads), all **date-time**.

The guard is not the primary duplicate protection (re-enrollment off and the event
ids are). It's what the triggers and the retry workflow filter on, what makes a
manual re-enrollment safe, and the per-record answer to "did Meta get this sale?".

> **Check:** each property shows type *Date and time* in HubSpot. If you made one by
> hand as a *Date picker* (date only), it can't be converted; delete and recreate it.

### Step 3: A dedicated HubSpot key for the guards

Create a service key (or private app) with **write** on the payment and lead
objects only, and add it as the secret **`CAPI_GUARD_WRITE_TOKEN`**. Don't reuse a
key another integration uses: rotating a shared key breaks every consumer with a
401 that names none of them.

---

## 3. Setup: Meta

### Step 4: Token and secrets

1. Events Manager > your dataset > **Settings** > **Conversions API** > **Generate
   access token**.
2. HubSpot secrets: `META_CAPI_ACCESS_TOKEN`, `META_CAPI_DATASET_ID` (the numeric
   dataset id), and for testing only `META_CAPI_TEST_CODE` (from Events Manager >
   **Test events**).
3. For Purchase: `STRIPE_READ_KEY`, a Stripe **live restricted key** with
   *Checkout Sessions: read* and *PaymentIntents: read*.

> **Warning:** a workflow that's ON with `META_CAPI_TEST_CODE` attached sends every
> real event to Test events, where it's lost, not queued. Detach it before go-live.

### Step 5: The Purchase workflow

1. **Automation > Workflows > Create > From scratch**, on your payment object.
2. **Trigger:** PaymentIntent id property *is known* **and** status *is any of
   succeeded* **and** create date *is less than 7 days ago*.
3. **Re-enrollment: OFF.** Meta dedupes an `event_id` for 48 hours only; a
   re-enrollment weeks later would book the sale twice.
4. **Custom code** action, Node.js 20.x. Paste `meta/meta-purchase-action.js`. In
   its SETTINGS block set `OBJECT_TYPE` to your payment object's type id.
5. Attach the secrets: `STRIPE_READ_KEY`, `META_CAPI_ACCESS_TOKEN`,
   `META_CAPI_DATASET_ID`, `CAPI_GUARD_WRITE_TOKEN` and, for now,
   `META_CAPI_TEST_CODE`.
6. **Property to include in code** (the header lists them all): at least
   `paymentIntentId` = your `pi_...` property and `metaCapiSentAt` = the guard.
   Map `externalId` to the associated **contact's** record id: a free
   match-quality gain. Static values like the event name can't be mapped here;
   they're constants in the code.
7. **Data outputs:** declare the `capi_*` fields listed in the header.
8. **Test:** run the action's **Test** on a recent payment. Result `sent`; the event
   shows in Events Manager > **Test events** with event id `pi_...`.
9. Detach `META_CAPI_TEST_CODE`. Turn the workflow on with **"don't enroll existing
   records"**. Set a rate limit (~3/s) if payments arrive in bursts.
10. Remove the other Purchase senders from step 1.

> **Check (next day):** Meta's Purchase count for the day equals succeeded Stripe
> payments, within a few percent.

### Step 6: The Purchase retry workflow

A custom code action that fails isn't retried by HubSpot, and re-enrollment is off.
So the action never throws on a Meta error: it returns `error` and leaves the guard
blank. This second workflow sends those later.

1. New workflow on the payment object, **re-enrollment OFF**.
2. **Trigger:** PaymentIntent id *is known* **and** `meta_capi_purchase_sent_at`
   *is unknown* **and** create date *less than 7 days ago* **and** status *is any of
   succeeded*.
3. **Delay** 1 hour.
4. **If/then branch:** `meta_capi_purchase_sent_at` *is unknown*. Only the *yes*
   path continues. Use If/then; "branch on property value" doesn't offer
   *is known / unknown* for date-time properties.
5. On the *yes* path: the same custom code action with the same settings.

The branch is essential. Triggers are evaluated when the record is created, when
the guard is always blank, so **every** payment enrolls. Without the re-check after
the delay, the retry sends every sale a second time. This happened in production.
The status condition also catches payments that settle late (3-D Secure, bank
debits): they enroll when they flip to *succeeded*.

### Step 7: The Lead workflow, with a safe cutover

1. New workflow on your lead object. **Trigger:** your lead-time property *is known*
   **and** `meta_capi_lead_sent_at` *is unknown* **and** the lead time *less than 7
   days ago*. **Re-enrollment OFF.**
2. Custom code: paste `meta/meta-lead-action.js`; set `OBJECT_TYPE` (use `0-1` if
   your leads are contacts) and optionally `LEAD_CATEGORY`.
3. Map `email`, `leadAt`, the guard, and where you have them `phone`, `offerName`
   (what they signed up for), `offerDate`, the contact's names and `externalId` (the
   associated **contact** id, never the lead record's own id).
4. Test with the test code, as in step 5. Event id = the lead record's id.
5. **Cutover, in order.** The Lead event usually drives your campaigns, so never
   leave it at zero:
   1. Turn this on **while the old Lead senders stay on**. Volume doubles for a day.
   2. Confirm events arrive with `event_id` = record id and `capi_result = sent`.
   3. Compare a full day: sends = new lead records.
   4. Only then turn off the other Lead senders.
   5. Re-measure: server Leads = lead records.

---

## 4. Setup: Google Ads

### Step 8: OAuth, once

1. Google Cloud Console: create a project and enable the **Data Manager API**.
2. **OAuth consent screen:** user type **Internal** if your domain is Google
   Workspace; otherwise **publish it to Production**. An External app left in
   *Testing* expires refresh tokens after **7 days**, and every upload then fails
   with `invalid_grant`.
3. **Credentials > Create OAuth client > Desktop app.** Download the JSON.
4. Mint the token, signed in as a Google user with access to the ad account:

   ```powershell
   node scripts/google-oauth-setup.mjs --client "C:\path\client_secret_XXXX.json" --for hubspot
   ```

   It asks only for the `datamanager` scope and saves the token to
   `%USERPROFILE%\.hubspot-capi\`. It never prints the token.
5. HubSpot secrets: `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
   `GOOGLE_ADS_REFRESH_TOKEN` (from that file), `GOOGLE_ADS_CUSTOMER_ID` (the ad
   account, digits only), and `GOOGLE_ADS_LOGIN_CUSTOMER_ID` only if you reach the
   account through a manager.

The HubSpot token should carry the datamanager scope and nothing else. HubSpot
secrets are readable by anyone who can edit a custom code action; a leak should
at most upload junk conversions, not read or change the ad account.

### Step 9: Conversion actions and account settings

1. **Goals > Conversions > New conversion action > Import > Manual import using API
   or uploads > Track conversions from clicks.** One for purchases (category
   Purchase, *use different values*, count *Every*) and one for leads (category
   Sign-up or Qualified lead, *don't use a value*, count *One*). The id is the
   `ctId=` in the action's URL.
2. **Set both to Secondary for now.** New import actions are created **Primary**,
   which would double-count against your existing tag-based actions.
3. **Goals > Conversions > Settings > Enhanced conversions for leads:** turn on and
   accept the customer data terms (needs Admin). If the method dropdown only offers
   Google tag or Tag Manager, pick either; API uploads work regardless.
4. Prove access before HubSpot is involved:

   ```powershell
   node scripts/google-conversion-test.mjs --customer 1234567890 --action 987654321
   ```

   A validate-only upload: Google checks auth, access and payload and records
   nothing. After turning on enhanced conversions for leads, expect
   `DESTINATION_ACCOUNT_NOT_ENABLED_ENHANCED_CONVERSIONS_FOR_LEADS` for up to ~30-60
   minutes. That's propagation, not misconfiguration.

### Step 10: The Google workflows

Build them **as separate workflows** from the Meta ones, so one platform's auth
failure never stalls the other.

**Purchase** (`google/google-purchase-action.js`, set `CONVERSION_ACTION_ID` and
`OBJECT_TYPE`):
- Trigger: PaymentIntent id *known* **and** status *succeeded* **and**
  `google_ads_purchase_sent_at` *unknown* **and** created *less than 7 days ago*.
  Re-enrollment OFF. Rate limit ~5/s.
- Inputs: `paymentIntentId`, the guard, and as fallbacks the associated contact's
  `contactEmail` and `gclid` (HubSpot's `hs_google_click_id`).
- Enrolling the last 7 days on turn-on is safe: Google's dedupe on the `pi_...`
  transactionId is permanent.

**Lead** (`google/google-lead-action.js`):
- Trigger like the Meta Lead one, with `google_ads_lead_sent_at` *unknown*. Add a
  **5-minute delay** before the code: HubSpot writes the Google click id onto a
  brand-new contact shortly after it's created.
- Map `offerName` and `offerDate` from fields **every** lead record has. They form
  the permanent dedupe key (section 5).

**Testing each one:**
1. Attach `GOOGLE_ADS_VALIDATE_ONLY` = `true`. Run **Test**: result `validated`, no
   guard stamped, nothing recorded.
2. **Detach** `GOOGLE_ADS_VALIDATE_ONLY` (attached, it silently discards
   everything). Turn on.
3. After ~3 days of clean uploads, make the new actions **Primary** and the old
   tag-based ones **Secondary**. Check any campaign on a **custom goal**, which
   ignores account-default changes. Don't delete old actions; Secondary costs nothing.

> **Check:** a 200 from Google means *received*, not matched. Look up any upload with
> `node scripts/google-conversion-test.mjs --status <gads_request_id>`, and judge
> credited conversions only after **~3 days**: in production a day's purchase credit
> roughly doubled between day 1 and day 3.

---

## 5. The ids that prevent double counting

| Action | Id sent | Dedupe window | Why this id |
|---|---|---|---|
| Meta Purchase | `event_id` = `order_id` = `pi_...` | **48 hours** | One PaymentIntent = one sale. Re-enrollment off + guard cover the rest. |
| Meta Lead | `event_id` = lead record id | **48 hours** | One record = one lead |
| Google Purchase | `transactionId` = `pi_...` | **permanent** (a repeat is an adjustment) | Re-sends are harmless forever |
| Google Lead | `transactionId` = `lead-<contact>-<offer date>-<offer name>` | **permanent** | Collapses duplicate records for the same person and offer, permanently |

Rules learned the hard way:

- **Never key on a timestamp or a calculated "latest ..." property.** They drift, and
  the same lead gets two ids.
- **Build Google keys only from fields every record carries.** A field filled for some
  offers and blank for others splits one person into two keys, and on Google that's
  permanent. Once live, never change the key's shape.
- **Why not dedupe Purchase with the browser pixel?** Stripe's redirect only exposes
  `{CHECKOUT_SESSION_ID}`, never the PaymentIntent id, so a browser event can't share
  `pi_...`. If you must run both, switch Meta's `event_id` to the `cs_...` id and have
  the thank-you page's pixel send the same. Simpler: server only.

---

## 6. Hashing: Meta and Google differ

Both need SHA-256 of normalized values, but the normalization differs. Reusing one
platform's code for the other silently hashes values that match nobody.

| Field | Meta | Google |
|---|---|---|
| Email | trim, lowercase | trim, lowercase, **remove dots before @ for gmail.com / googlemail.com** |
| Phone | digits only, country code, **no `+`** (`14045550123`) | E.164 **with `+`** (`+14045550123`) |
| First / last name | lowercase, letters only, hashed on their own | only inside an **address** identifier with region + postal code, all or nothing |
| Postal code | first 5 digits, hashed | lowercase, no spaces, **not hashed** |
| State / region | 2-letter code, hashed ("Georgia" -> `ga`, never truncated to `ge`) | region = 2-letter country code, **not hashed** |
| Your own id | `external_id` = the **contact's** id, hashed | not sent |

`capi_match_keys` / `gads_match_keys` in each run's outputs list what was sent. Watch
them when Events Manager shows low Event Match Quality.

---

## 7. Click ids: where they come from

| Id | Best source | Fallback | Notes |
|---|---|---|---|
| Meta `fbc` / `fbp` | The Meta pixel's `_fbc` / `_fbp` cookies, stored on the contact (hidden form fields) and mapped to `fbc` / `fbp` | `fbc` rebuilt from a stored `fbclid` | Sent raw, never hashed. A truncated value is dropped: it looks present and matches nothing. |
| Google `gclid` | HubSpot's `hs_google_click_id` on the contact | | The contact's **most recent** click, not necessarily the one that led to this sale |

The Purchase actions also look for these ids on the Checkout Session's success URL,
for checkout links that carry them. But **Stripe documents only the five UTM
parameters as passing through to the success URL**, so don't rely on click ids
arriving that way. Store them on the contact. Hashed email, phone and address carry
the match when no click id is available (the production Google purchase test
ran on email and address alone).

The companion repo
[hubspot-order-form-stripe-checkout-link-integration](https://github.com/jbrillionaire/hubspot-order-form-stripe-checkout-link-integration)
builds the order form that sends buyers to Stripe with their email and campaign
attached, and writes the UTMs onto the payment record.

---

## 8. Reconciling

- **Purchase:** compare against **succeeded** payments only. Payment objects synced
  from Stripe often hold unpaid and canceled intents too (16% of rows in
  production), which inflates any denominator.
- **Refunds:** a synced payment can keep status *succeeded* after a refund. The
  actions check Stripe live and skip refunded charges; your HubSpot report won't.
- **Match the windows.** Meta reports by event time and lags ~2 hours. Compare full
  days in one timezone.
- **Browser vs server:** Meta's dataset stats API returns totals only. The Events
  Manager **export** (Overview > event > export) splits browser and server per hour.
  It's the only way to see which sender is over-counting.
- **Google:** wait ~3 days. Secondary actions appear only in *All conversions* /
  per-action breakdowns, not *Conversions*.
- **Pages cache.** A removed pixel snippet can keep firing until the page cache
  expires (hours on HubSpot). A removed tag-manager tag keeps firing until the
  container is **published**.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Meta Purchase still 2x+ Stripe | Another sender still on | Step 1 list; Event Setup Tool rules first |
| Events only in Test events | `META_CAPI_TEST_CODE` attached to a live workflow | Detach it |
| `capi_result = error` | Meta rejected or rate-limited | Read `capi_error`; the retry workflow sends it later |
| Retry workflow doubled every sale | No If/then re-check after the delay | Step 6, point 4 |
| Guard blank but Meta has the event | `CAPI_GUARD_WRITE_TOKEN` detached, rotated, or the property is date-only | Reattach; recreate the property as date-time |
| `skipped_test_mode` | A test-mode payment reached a live-key action | Expected; not revenue |
| `skipped_too_old` | Record synced > 6 days after payment (Meta) / > 89 days (Google) | Expected; never back-dated |
| Google `invalid_grant` | Consent screen left in Testing (7-day tokens) or token revoked | Publish or use Internal; re-run `google-oauth-setup.mjs` |
| `DESTINATION_ACCOUNT_NOT_ENABLED_ENHANCED_CONVERSIONS_FOR_LEADS` | Just enabled, still propagating | Wait 30-60 minutes |
| `gads_result = validated` in production | `GOOGLE_ADS_VALIDATE_ONLY` still attached | Detach it |
| Google shows 0 for new actions | Secondary actions, or < 3 days | *All conversions*; wait |
| One person counted twice on Google Lead | `offerName` / `offerDate` unmapped or from a field that's sometimes blank | Map them from fields every record has |

---

## 10. Limits

- **Refunds** after a send aren't retracted from either platform.
- **$0 orders** create no PaymentIntent, so most Stripe syncs create no record and the
  workflows never run. Fine for revenue; they're invisible to these actions.
- **Stripe test mode:** most Stripe-to-HubSpot syncs are live-only. Test with the
  platforms' test tools (Meta test code, Google validate-only), not test payments.
- **Meta rejects events older than 7 days;** the actions skip at 6. Google accepts 90
  days; the actions skip at 89.
- **Consent (EEA/UK):** the Google actions don't send a `consent` block. If you have
  EEA or UK users, add one (`adUserData`, `adPersonalization`) to the event. Meta's
  equivalent is your responsibility on the data you send.
- **Server events use `action_source: system_generated`.** `website` requires the
  buyer's user agent, which a CRM record doesn't have.

---

## 11. Security

- Secrets live only in HubSpot's secret store. The actions never log their values
  and refuse values containing whitespace, which catches pasted URLs and stray
  line breaks.
- Scope every credential to the job: a Stripe **restricted** read key, a Google token
  with only the **datamanager** scope, a HubSpot key with write on two objects.
- Hashing happens in the action. Plain-text emails and phones never leave HubSpot
  except to Stripe (which already has them).
- Anyone who can edit a custom code action can read its secrets. Limit who can edit
  these workflows.
