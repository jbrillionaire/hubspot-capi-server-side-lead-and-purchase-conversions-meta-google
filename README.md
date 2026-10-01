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
   - Step 1: Map every existing sender
   - Step 2: Create the guard properties
   - Step 3: A dedicated HubSpot key for the guards
3. [Setup: Meta](#3-setup-meta)
   - Step 4: Dataset id, access token and secrets
   - Step 5: The META Purchase workflow (`meta/meta-purchase-action.js`)
   - Step 6: The META Purchase retry workflow
   - Step 7: The META Lead workflow, with a safe cutover (`meta/meta-lead-action.js`)
4. [Setup: Google Ads](#4-setup-google-ads)
   - Step 8: Google Cloud project and the OAuth token (`scripts/google-oauth-setup.mjs`)
   - Step 9: Create the two conversion actions
   - Step 10: Enhanced conversions for leads, then test (`scripts/google-conversion-test.mjs`)
   - Step 11: The Google Lead workflow (`google/google-lead-action.js`)
   - Step 12: The Google Purchase workflow (`google/google-purchase-action.js`)
   - Step 13: Cut over: make the uploads Primary
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

*About 10 minutes.*

Each action stamps a "sent at" property on the record after Meta (or Google)
accepts the event. The workflows filter on it, the retry workflow re-checks it,
and it's the per-record answer to "did Meta get this?". Re-enrollment OFF and the
event ids are the primary duplicate protection; the guard catches everything
else (a manual re-enrollment, a cloned workflow, someone switching re-enrollment
back on, and the retry workflow).

| Label | Internal name | Object | Needed for |
|---|---|---|---|
| Meta CAPI purchase sent at | `meta_capi_purchase_sent_at` | your payment object | Meta Purchase (Steps 5, 6) |
| Meta CAPI lead sent at | `meta_capi_lead_sent_at` | your lead object | Meta Lead (Step 7) |
| Google Ads purchase sent at | `google_ads_purchase_sent_at` | your payment object | Google Purchase (Step 10) |
| Google Ads lead sent at | `google_ads_lead_sent_at` | your lead object | Google Lead (Step 10) |

All four must be **date and time** properties. Create them with the script (2A)
or by hand in HubSpot (2B). You only need the rows for the platforms you're
building.

> ⚠️ **Date picker is permanent once it's in use.** In production the Lead guard
> was created by hand as **Date picker** (date only), on the advice that the UI had
> no date-time option. It does. Once the property had values, HubSpot locked the
> field type: *"This property's field type can't be changed because it has a value
> on 1,627 records and is used in 1 asset."* It still works as a guard (the Lead
> action falls back to a midnight value), but you lose the send time. Migrating to
> a new property later would re-enroll and re-send every record already sent,
> because the new property is blank on all of them. Pick **Date and time picker**
> the first time.

#### 2A. With the script (Node 20)

1. Find each object's type id. Open the object's record list in HubSpot. The id
   is the `2-12345678` part of the URL. Contacts are `0-1`.
2. Make a temporary HubSpot service key for the script. This one needs schema
   scopes: `crm.schemas.custom.write` and `crm.schemas.custom.read` (for leads
   that are contacts, `crm.schemas.contacts.write` and `crm.schemas.contacts.read`).
   Step 3 shows where keys are created. This is **not** the key the actions use.
3. Find a property group on each object: **Settings → Properties**, pick the
   object, open the **Groups** tab, and note a group's internal name (wording may
   differ). Contacts can use `contactinformation`.
4. In PowerShell, from the repo folder:

   ```powershell
   $env:HUBSPOT_TOKEN   = "pat-..."
   $env:PAYMENTS_OBJECT = "2-12345678"; $env:PAYMENTS_GROUP = "your_payment_group"
   $env:LEADS_OBJECT    = "2-87654321"; $env:LEADS_GROUP    = "your_lead_group"
   node scripts/create-guard-properties.mjs --dry-run
   ```

   Windows PowerShell 5.1 has no `&&`. Put each command on its own line, or
   separate them with `;`.

5. The dry run prints one line per property, for example:

   ```text
   would create  2-12345678  meta_capi_purchase_sent_at  datetime
   ```

   Then run it for real:

   ```powershell
   node scripts/create-guard-properties.mjs
   ```

   Expect `created  <object>  <name>` for each one. It's safe to re-run: an
   existing date-time property prints `exists ... (datetime, ok)`. An existing
   **date-only** property prints a warning and sets a failing exit code.
6. Delete or rotate the temporary schema key once it's done.

> ⚠️ **A 403 on the first call means a missing schema scope,** not a broken
> script. Object-write scopes (what the actions use) can't create properties.

#### 2B. By hand in HubSpot

Repeat for each property in the table.

1. Go to **Settings → Properties** (under **Data Management**; wording may differ).
2. Next to **Select an object:**, choose the object (your payment object or your
   lead object).
3. Click **Create property**. A panel titled **Create new property** opens. Stay
   on the **Create manually** tab.
4. **Property label \***: type the label exactly, e.g. `Meta CAPI purchase sent at`.
5. Click the **`</>`** icon at the right of the label box to show the internal
   name. Make sure it reads exactly `meta_capi_purchase_sent_at`. The code reads
   that literal string, and a mismatch fails silently.
6. **Field type \***: open the dropdown and choose **Date and time picker**. Not
   **Date picker**.
7. Pick any property group if asked, then click **Create** (wording may differ).

✅ **Check:** in **Settings → Properties**, search each label. The type under the
name reads **Date and time picker**. If one reads **Date picker**, delete it now,
while it has no values, and recreate it.

### Step 3: A dedicated HubSpot key for the guards

*About 5 minutes.*

The actions use this key only to stamp the guard. Give it nothing else.

1. Go to **Settings**. In the left menu, under **Account Management**, expand
   **Integrations** and click **Service Keys**. *Older portals call these*
   **Private Apps**.
2. Create a new service key and name it `CAPI guard writer`.
3. Add exactly these scopes:

   | Scope | When |
   |---|---|
   | `crm.objects.custom.write` | Your payment or lead records are a custom object |
   | `crm.objects.contacts.write` | Your lead records are contacts |

4. Save. On the key's page, in the **Service Key** box, click **Show**, then
   **Copy**. The key starts with `pat-`.
5. Add it to HubSpot's secret store. Open any workflow's **Custom code** action,
   open the **Secrets** dropdown, and click **Add secret** at the bottom of the
   list. Name it **`CAPI_GUARD_WRITE_TOKEN`**, paste the key as the value, and
   save (field labels may differ).

> ⚠️ **Don't reuse a key another integration already uses.** In production one
> key stamped the guards *and* served four other actions. Rotating a shared key
> breaks every consumer with a 401 that names none of them. The guard needs one
> scope, which makes it the cheapest possible key to keep separate.

✅ **Check:** **Secrets → Manage secrets** opens **Secrets management**, and
`CAPI_GUARD_WRITE_TOKEN` is listed as **Available**. You never need to paste the
key anywhere else.

---

## 3. Setup: Meta

### Step 4: Dataset id, access token and secrets

*About 15 minutes.*

**4a. Find the dataset id.**
1. Open **Meta Events Manager** and click **Datasets** in the left menu (the menu
   also shows **Connect data**, **Custom conversions** and **Integrations**).
2. The list shows each dataset's name with **ID** and a number under it. Pick
   the dataset your browser pixel uses, the one whose **Overview** already shows
   PageView and your current Lead and Purchase events.
3. Copy the number. It also appears on the dataset's **Overview** tab in the
   right-hand panel under **Dataset ID**.

> ⚠️ **Use the pixel dataset, not an "Offline Events" set.** Many accounts have
> both, listed one under the other. The offline set is the retired Offline
> Conversions API. Server events belong on the same dataset as the browser pixel,
> which is also the only place `event_id` dedupe and match-quality reporting work.

**4b. Generate the access token.**
1. With the dataset selected, open the **Settings** tab (the tabs are
   **Overview**, **Test events**, **Actions**, **History**, **Settings**).
2. Scroll to **Set up direct integration**. Leave **Set up with Dataset Quality
   API** (*Recommended*) selected. It doesn't change how events are sent. It adds
   permission to read event match quality and diagnostics with the same token.
3. Click the button that generates the access token (**Generate access token**;
   wording may differ).
4. A box appears: *"Copy and save this token somewhere safe. It won't be stored by
   Facebook."* Click **Copy**.

> ⚠️ **Go straight from Meta's Copy button into HubSpot.** Don't paste the token
> into chat, email or a ticket, and don't screenshot this screen. If a screenshot
> of it exists anywhere shared, generate a new token. The old one stays valid
> until you do.

**4c. Get a Stripe restricted key (Purchase only).**
1. In the Stripe Dashboard (live mode), go to **Developers → API keys** and
   create a **restricted key** (wording may differ).
2. Give it **Read** on **Checkout Sessions** and **Read** on **PaymentIntents**.
   Everything else stays **None**. PaymentIntents read covers invoices,
   renewals and dashboard charges, which have no Checkout Session, and it's what
   makes the refund check work.
3. Copy the key (it starts with `rk_live_`).

**4d. Create the HubSpot secrets.** In any workflow's **Custom code** action,
open **Secrets**, click **Add secret**, and create each one. The name is what
the code reads as `process.env.<NAME>`, so type it exactly.

| Secret name | Value |
|---|---|
| `META_CAPI_ACCESS_TOKEN` | the token from 4b |
| `META_CAPI_DATASET_ID` | the dataset id from 4a, digits only |
| `STRIPE_READ_KEY` | the restricted key from 4c |
| `CAPI_GUARD_WRITE_TOKEN` | already created in Step 3 |

`META_CAPI_TEST_CODE` is created in Step 5, only for testing.

> The actions refuse any secret value containing a space or line break. That
> catches the common paste mistakes, such as a copied label or a trailing newline.

✅ **Check:** **Secrets → Manage secrets** lists all four as **Available**.

### Step 5: The META Purchase workflow

*About 30 minutes.*

**5a. Create the workflow.**
1. Go to **Automation → Workflows → Create workflow → From scratch**.
2. Choose your **payment object** as the object type (the one with one record
   per Stripe PaymentIntent). Name it `META Purchase CAPI` with the pencil icon
   next to the title.

> This has to be its own workflow. Nothing in HubSpot "owns" the creation of a
> synced payment record, so there's no existing workflow to put it in. Keeping it
> separate also means a failure in another action (UTM capture, for example) can
> never stop a sale from being reported.

**5b. Set the trigger.**
1. Click the trigger card, which reads *"Trigger enrollment for \<payment
   records\>"*. The **Triggers** panel opens with **Start triggers** and
   **Settings** tabs.
2. Under **Start when this happens**, choose **Records meet custom conditions**.
3. Under *"Only enroll \<payment records\> that meet these conditions"*, build
   **Group 1**, clicking **+ Add criteria** *inside* the group box for each row so
   they're joined by **and**:

   | Property | Operator | Value |
   |---|---|---|
   | your PaymentIntent id property (e.g. *Stripe Payment Transaction ID*) | is known | |
   | Status | is any of | `succeeded` |
   | Created | is less than | 7 days ago |

   If **Status** is a text property, HubSpot offers **contains any of** instead
   of **is any of**. That's equivalent here, because no other Stripe status
   contains the word `succeeded`.

4. Click **Done**, then **Save** on the panel. The criteria editor and the
   trigger panel save separately.

> In production this workflow ran on **PaymentIntent id is known** alone. That
> works, because the code skips unpaid, refunded, $0, test-mode and stale payments
> itself. The status and age rows keep the logs quiet and stop an accidental
> "enroll existing" from sweeping years of history.

**5c. Turn re-enrollment off.** In the **Triggers** panel, open the **Settings**
tab and make sure re-enrollment is off (wording may differ). The trigger card
on the canvas then shows **Re-enroll off**.

> ⚠️ **Meta forgets an `event_id` after 48 hours.** If the record re-enrolled a
> week later, the same sale would be booked twice, permanently. Re-enrollment OFF
> is the main duplicate guard.

**5d. Add a 1-minute delay.** Click the **+** under the trigger, choose
**Delay**, and set **1 minute**. It gives the payment record's contact
association time to exist before `externalId` is read.

**5e. Add the custom code action.**
1. Click the **+** under the delay and choose **Custom code** (it's in the
   **Data ops** group, or search `code`). The panel opens titled **Custom code**,
   with **Edit action** and **\<payment records\> in action** tabs. Expand
   **Create action** if it's collapsed.
2. **Language:** **Node.js 20.x**.
3. **Secrets** (*"Choose one or multiple secrets to use in this action."*): open
   the dropdown and tick `STRIPE_READ_KEY`, `META_CAPI_ACCESS_TOKEN`,
   `META_CAPI_DATASET_ID` and `CAPI_GUARD_WRITE_TOKEN`. Each ticked secret
   shows as a chip in the box. Close the dropdown.
4. **Property to include in code** (*"Each property needs to be defined in your
   code."*): for each row, click **Add property**, type the name on the **left**,
   then click **Select a property** on the right. That opens the **All data
   tokens** panel. Properties of the payment record are under **Enrolled
   \<payment record\>**. The contact's properties are under **Contact: \<association
   label\>, Most recently created**.

   | Input name (left box) | Value (right box) |
   |---|---|
   | `paymentIntentId` | **Enrolled payment record →** your PaymentIntent id property (`pi_...`). **Required.** |
   | `metaCapiSentAt` | **Enrolled payment record → Meta CAPI purchase sent at** (the guard) |
   | `checkoutSessionId` | **Enrolled payment record →** a property holding the `cs_...` id, *if you have one*. Saves one Stripe call. |
   | `externalId` | **Contact: \<label\>, Most recently created → Record ID** |
   | `contactEmail` | *Optional, recommended.* **Contact → Email.** Sent *alongside* the Stripe email when they differ — buyers often pay with a different email than they signed up with, and Meta matches on either |
   | `contactPhone` | *Optional, recommended.* **Contact → Phone number.** Stripe checkouts rarely collect a phone, so this is usually the only `ph` the event gets |
   | `contactFirstName` | *Optional.* **Contact → First name** — a second `fn` value when it differs from the card name |
   | `contactLastName` | *Optional.* **Contact → Last name** — a second `ln` value |
   | `fbc` / `fbp` | *Optional.* Contact properties holding the Meta click ids, if you store them |
   | `orderReference` | *Optional.* Another property holding the `cs_...` id, if that's where yours lives (used only when `checkoutSessionId` is empty) |
   | `eventName` | *Optional, usually left out.* A property whose value overrides the event name. Leave it out and the code sends `Purchase`. |
   | `minimumValue` | *Optional, usually left out.* A property holding a number; payments below it are not sent. Leave it out and the code uses `0.01`, so $0 orders are skipped. |

   Skip any optional row you have no property for. Don't leave a row blank:
   an unmapped row shows *"Property selection is required"* and blocks **Save**.

   The four `contact*` rows exist because the payment usually carries a *thin*
   identity: Stripe checkouts rarely return a phone or address, and the card
   email is often not the sign-up email. The code sends the Stripe identity
   **and** the contact's as separate hashed values under the same key (`em`,
   `ph`, `fn`, `ln`), and Meta matches on any of them. The `capi_match_keys`
   output shows it per event — `em x2` means two distinct emails went out.
   This measurably lifts Event Match Quality on purchase events. (Meta only:
   don't replicate names onto the Google action — Google matches on email,
   phone and click id, and only uses names inside a full postal-address bundle.)

> ⚠️ **The left box is the name the code reads; the right box is the property.**
> In production the first attempt had them mirrored: the left boxes held property
> names (`stripe_payment_transaction_id`, `checkout_session_id`) and the code saw
> nothing. Names are case-sensitive, so `paymentintentid` won't match.

> ⚠️ **`externalId` must be the contact's Record ID.** Hover the token after
> picking it. It should read *"This is the **Record ID** property of the
> associated **Contact: …, Most recently created**."* The payment record's own
> Record ID is unique to every sale. Hashed, it matches nobody and wastes a match
> key. If the contact isn't offered, leave `externalId` out.

> ⚠️ **Map the guard and attach the guard key together, or neither.** Guard
> mapped without `CAPI_GUARD_WRITE_TOKEN`: the action checks the guard but never
> writes it, so it never protects anything. Key attached with no guard property:
> every successful send logs `guard not written (400)`. Both happened while this
> was being built.

5. **Code:** delete the sample code and paste in **all** of
   `meta/meta-purchase-action.js`. The **Full screen** button makes this easier.
   Then change one line in the SETTINGS block:

   ```js
   const OBJECT_TYPE = '2-12345678';   // your payment object's type id
   ```

   Leave the secret-name constants alone unless you named your secrets
   differently.

6. **Data outputs** (*"Define the data type and name of outputs from your code.
   Each output name must be unique and can only be used once."*): click **Add
   output** for each row and pick the type from the dropdown. HubSpot adds its
   own `hs_execution_state` (Enumeration). Leave it alone.

   | Output | Type |
   |---|---|
   | `capi_result` | String |
   | `capi_value` | Number |
   | `capi_currency` | String |
   | `capi_status` | Number |
   | `capi_events_received` | Number |
   | `capi_event_id` | String |
   | `capi_fbtrace_id` | String |
   | `capi_match_keys` | String |
   | `capi_source` | String |
   | `capi_fbc_source` | String |
   | `capi_error` | String |

7. **Configure rate limit:** expand it, switch on **Turn on rate limiting**, and
   set **Action executions** `3` per `1` **Seconds**. Over the limit, executions
   queue rather than fail. It matters when payments arrive in bursts, such as a
   flash sale or a retry sweep.
8. Click **Save**.

✅ **Check:** four secret chips, the input rows above with no red *"Property
selection is required"*, and eleven outputs plus `hs_execution_state`.

**5f. Test with a test code.**
1. In Events Manager, open the dataset's **Test events** tab. Leave the channel
   dropdown on **Website**. Under **Confirm your server's events are set up
   correctly**, step 1 shows `test_event_code: TEST12345` with a **Copy**
   button. Keep this tab open during the test.
2. Back in the action, **Secrets → Add secret**: name `META_CAPI_TEST_CODE`,
   value **only** the code, e.g. `TEST12345`. Leave out the `test_event_code:`
   prefix. Tick it so it shows as a chip, then **Save**.
3. Expand **Test action** at the bottom of the panel. HubSpot warns *"Changes will
   be applied to your \<payment record\>…"*. It's right: a successful test really
   sends to Meta and stamps the guard. Pick a **recent** payment (last few days)
   that came through your checkout, not an old one.
4. If a **Properties to include in code** box asks for a test value (this happens
   for associated-contact inputs like `externalId`), type the contact's record id
   by hand. At runtime it resolves on its own.
5. Click **Test**.

✅ **Check:** **Status** reads **Success**, and the **Data outputs** table shows:

| Output | Expected |
|---|---|
| `hs_execution_state` | `SUCCESS` |
| `capi_result` | `sent` |
| `capi_value` | what that buyer actually paid, after promo codes and add-ons |
| `capi_currency` | `USD` (or your currency) |
| `capi_status` | `200` |
| `capi_events_received` | `1` |
| `capi_event_id` | the payment's `pi_...` id |
| `capi_source` | `checkout_session` |
| `capi_match_keys` | e.g. `em,fn,ln,zp,country,external_id` (more if Stripe collects phone and full address) |
| `capi_fbc_source` | `url_fbc`, or `none` if that buyer had no Meta click id |
| `capi_error` | empty |

**Logs** shows one `{"sent":{"event_name":"Purchase",...}}` line and then
Memory and Runtime. Expect roughly 110 MB and 0.4 to 0.9 s. Meanwhile the
**Test events** tab should show a server Purchase with that `pi_...` as its
event id.

> ⚠️ **An old payment tests the wrong path.** The first production test used a
> two-year-old payment. It returned `sent` and `200`, but with
> `capi_source: payment_intent` and `capi_match_keys: em`. That's the no-session
> fallback with email only, and it proved nothing about the normal path. Also,
> before the test code was attached, that test went to the **live** dataset as a
> real Purchase. Always attach the test code first, and test a recent checkout
> payment.

> **"Not defined in output field"** under an output in the test results means that
> output isn't declared in **Data outputs**, or its name is misspelled.

> **A second test on the same record returns `skipped_already_sent`.** That's
> the guard working. Test a different payment, or clear **Meta CAPI purchase sent
> at** on the record first.

**5g. Detach the test code.** Open **Secrets**, remove the
`META_CAPI_TEST_CODE` chip (the **×**), and **Save**. You can delete the secret
itself later under **Manage secrets**.

> ⚠️ **Never turn the workflow on with the test code attached.** Production
> behavior here was inconsistent: one send appeared in Test events, and later
> events carrying a code showed up as live anyway. Don't rely on either. Detach it,
> and the question never comes up.

**5h. Turn it on without enrolling existing records.**
1. Click **Review and turn on** (top right). The **Review Workflow** panel opens
   at **Step 1: Enrollment**.
2. Under *"Do you want to enroll \<payment records\> that currently meet the
   enrollment criteria when the workflow turns on?"*, choose **No, only enroll
   \<payment records\> who meet the enrollment criteria after the workflow is
   turned on**. HubSpot's default is **Yes**.
3. Turn the workflow on.

> ⚠️ **"Yes" would push your history through Meta.** The production object had
> about 82,800 existing payments. Anything older than 7 days is rejected by Meta
> (the code skips it at 6), and it's one Stripe call per record for nothing.

> If you ever edit the trigger of a workflow that's already on, HubSpot asks
> *"Do you want to enroll existing \<records\>?"* Choose **Save and don't enroll
> existing \<records\>**.

**5i. Remove the other Purchase senders** from your Step 1 list, in the same
sitting. The `pi_...` event id can't be shared with a browser pixel, so this is
built to be the **only** Purchase sender. In HubSpot, delete or switch off every
*Ads → Conversion events* entry mapped to Purchase. Also remove the Event Setup
Tool Purchase rules, page snippets and tag-manager tags.

> A removed page snippet keeps firing until the page cache expires. On HubSpot
> pages that can be hours. A tag-manager change does nothing until the container is
> published.

> ⚠️ **Don't switch this workflow off to "see if HubSpot handles it".** In
> production it was switched off for two and a half days on that assumption, and
> no sale in that window reached Meta. With re-enrollment off, those records were
> never picked up again until the retry workflow swept them.

✅ **Check:** in the first hour, open **Actions → Enrollment history** (wording
may differ) on a few live payments. Each should show `capi_result = sent` and a
filled **Meta CAPI purchase sent at**. The next day, Meta's server Purchase
count for a full day should equal your **succeeded** payments for the same day,
within a few percent.

### Step 6: The META Purchase retry workflow

*About 20 minutes.*

HubSpot doesn't retry a failed custom code action, and re-enrollment is off. So
the action never throws on a Meta error: it returns `error` and leaves the
guard blank. This workflow sends those later. It also catches payments that
settle late (3-D Secure, bank debits), which the main workflow saw before they
succeeded.

**6a. Create it.** **Automation → Workflows → Create workflow → From scratch**,
on the same payment object. Name it `META Purchase CAPI Retry`.

**6b. Trigger.** **Records meet custom conditions**, all in **Group 1**, joined
by **and**:

| Property | Operator | Value |
|---|---|---|
| your PaymentIntent id property | is known | |
| Meta CAPI purchase sent at | is unknown | |
| Created | is less than | 7 days ago |
| Status | is any of / contains any of | `succeeded` |

Click **Done**, then **Save**. Set re-enrollment **off** in the **Settings** tab.
The card must show **Re-enroll off**.

> The **Status** row was added a few days after launch, and it does two jobs.
> Failed and abandoned payments stop re-running every hour. And a payment created
> as `requires_action` or `processing` enters this workflow the moment it flips
> to `succeeded`. Without the row, such a payment is never reported at all.

> ⚠️ **Keep the 7-day row.** Without it, the trigger matches every historical
> payment that never had a Meta send.

**6c. Delay.** **+ → Delay → 1 hour.**

**6d. Re-check the guard with an If/then branch.**
1. Click **+** under the delay and choose **Branch**.
2. Choose the **If/then** branch type. *Don't* choose **Branch based on property
   value**. That one looks at *"values of a single property"*, and its token
   picker doesn't list the date-time guard at all. In production, searching
   `meta` there found only unrelated properties.
3. Name the branch `No Meta CAPI purchase sent at`, and set its criteria to
   **Meta CAPI purchase sent at is unknown** (from the enrolled payment record).
4. Save. The canvas shows *"Go to **No Meta CAPI purchase sent at** if these
   criteria are met: **Meta CAPI purchase sent at is unknown**"*, with two paths:
   **No Meta CAPI purchase sent at** and **None met**. Leave **None met** going
   straight to **End**.

> ⚠️ **The branch is not optional.** HubSpot evaluates the trigger when the payment
> is *created*. At that moment the guard is always blank, because the main
> workflow hasn't run yet. So every payment enrolls, and the 1-hour delay happens
> after enrollment, not before it. In production the branch was removed on the
> reasoning that Meta's `event_id` dedupe would absorb repeats. The retry then
> re-sent nearly every sale: 8 events received for 6 payments. Meta dedupes
> attribution, but it still counts the duplicates as received. Put the branch
> back, and put it **before** the code. A branch *after* the code can't stop code
> that already ran.

**6e. The code, on the yes path.** Under **No Meta CAPI purchase sent at**, click
**+ → Custom code** and set it up exactly like Step 5e. Use the same four secrets
(no test code), the same input rows, all of `meta/meta-purchase-action.js` with
the same `OBJECT_TYPE`, the same eleven outputs, and the same rate limit
(`3` per `1` **Seconds**). **Save.**

> If you built the code action first and moved it under the branch, its step
> number changes (e.g. `2.` becomes `3.`). Open it once and confirm the secrets
> and input rows survived the move. A dropped secret fails every retry.

**6f. Test and turn on.**
1. Optional: **Test action** on a recent **succeeded** payment whose guard is
   blank, with `META_CAPI_TEST_CODE` attached, as in Step 5f. Detach it and save
   afterwards.
2. **Review and turn on.** The panel shows how many records currently meet the
   criteria (*"N \<payment records\> meet the enrollment criteria"*).
   - **No, only enroll … after the workflow is turned on** is the normal choice.
   - **Yes, enroll … immediately** is a deliberate backfill of unsent succeeded
     payments from the last 7 days. Choose it only when you mean it. In
     production it was used once, after the main workflow had been off for two
     days, and it swept 433 payments. Set the rate limit first, and expect a tail
     of `skipped_too_old` for payments in their 7th day.

✅ **Check:** on a healthy day the retry's custom code runs close to zero times.
Everything should leave through **None met**, or not enroll at all. If it runs
many times a day, look at those records. They should be late-settling payments
or real Meta errors (`capi_result = error`, reason in `capi_error`), not normal
sales.

### Step 7: The META Lead workflow, with a safe cutover

*About 30 minutes, plus a day of running side by side.*

**7a. Decide where it runs.** Build it as its **own workflow on the lead
object**, not inline in your sign-up workflow, unless that workflow already
enrolls the lead records themselves.

> Most sign-up workflows are **contact-based** (*"Trigger enrollment for
> contacts"*) with re-enrollment on. Inline there, the event id would be the
> contact id. Someone who signs up for two offers would produce two lead records
> but one `event_id`, and Meta would drop the second. The guard also lives on the
> lead record, and a Meta outage inline would stop the confirmation email and
> everything after it. The rule of thumb: inline only when the workflow enrolls
> the same object you key the event on.

**7b. Create the workflow.** **Automation → Workflows → Create workflow → From
scratch**, choose your **lead object**, and name it `META Lead CAPI`.

**7c. Trigger.** **Records meet custom conditions**, all in **Group 1**, joined
by **and**:

| Property | Operator | Value |
|---|---|---|
| your lead-time property (e.g. *Registered At*, or *Create date*) | is known | |
| Meta CAPI lead sent at | is unknown | |
| your lead-time property | is less than | 7 days ago |
| your status property, *if the object also holds non-lead records* | is any of | the "signed up" value only |

Click **Done**, then **Save**. Set re-enrollment **off** (**Settings** tab). The
card shows **Re-enroll off**.

> ⚠️ **"is known", not "is unknown".** The first production draft had *Registered
> At is unknown*, which enrolls nothing, or only malformed records.

> ⚠️ **Exclude records that aren't leads.** In production the same object also
> held attendance and replay records. Each one fired a Lead, 530 of them before
> anyone noticed. The fix was a fourth row, *Class Status is any of
> Registered*. Add it with the **+ Add criteria** *inside* the Group 1 box. The
> **+ Add criteria** next to the **or** pill creates a Group 2 that's OR'd in, and
> then the filter does nothing.

> The trigger panel also shows **Manually triggered** OR'd above Group 1. Leave it
> alone. Manual enrollment bypasses these filters, so don't bulk-enroll by hand.

**7d. Delay.** **+ → Delay → 1 minute.** The contact association may not exist
the instant the record is created, and without it `externalId` comes through
empty.

**7e. Custom code.**
1. **+ → Custom code**, **Language: Node.js 20.x**.
2. **Secrets:** `META_CAPI_ACCESS_TOKEN`, `META_CAPI_DATASET_ID`,
   `CAPI_GUARD_WRITE_TOKEN`. No test code yet.
3. **Property to include in code:**

   | Input name (left box) | Value (right box) |
   |---|---|
   | `metaCapiLeadSentAt` | **Enrolled lead record → Meta CAPI lead sent at** (the guard) |
   | `email` | **Enrolled lead record → Email** (or the associated contact's Email). **Required.** |
   | `leadAt` | **Enrolled lead record →** your lead-time property |
   | `phone` | **Enrolled lead record →** Phone number, if it has one |
   | `offerName` | **Enrolled lead record →** what they signed up for (sent as `content_name`) |
   | `offerDate` | **Enrolled lead record →** the date of the thing, e.g. a webinar date |
   | `externalId` | **Contact: \<label\>, Most recently created → Record ID** |
   | `firstName` | **Contact → First name** (optional, adds a match key) |
   | `lastName` | **Contact → Last name** (optional, adds a match key) |
   | `fbc` / `fbp` | *Optional.* Contact properties holding Meta click ids, if you store them |
   | `eventName` | *Optional, usually left out.* A property whose value overrides the event name. Leave it out and the code sends `Lead`. |

> ⚠️ **Don't forget `email`.** The first production mapping had the guard, time,
> phone, topic, date and externalId, but no email. Email is the strongest match
> key and the one field nearly every lead has. Without it, any lead missing phone
> and contact id is skipped as `skipped_no_identifier`.

> ⚠️ **Check `externalId` by hovering it.** In production it first resolved to
> *"the Record ID property of the **Enrolled class registration**"*. That's the
> lead record's own id, which is identical to the event id and matches nobody.
> It must read *"…of the associated **Contact: Most recently created**"*.

4. **Code:** delete the sample and paste in **all** of `meta/meta-lead-action.js`.
   In SETTINGS set:

   ```js
   const OBJECT_TYPE   = '2-87654321';  // your lead object ('0-1' if leads are contacts)
   const LEAD_CATEGORY = 'lead';        // sent as custom_data.content_category
   ```

5. **Data outputs:**

   | Output | Type |
   |---|---|
   | `capi_result` | String |
   | `capi_status` | Number |
   | `capi_events_received` | Number |
   | `capi_event_id` | String |
   | `capi_match_keys` | String |
   | `capi_fbtrace_id` | String |
   | `capi_error` | String |

   `capi_events_received` must be **Number**. It was first set to String in
   production, which stops you summing it when you reconcile.

6. **Configure rate limit:** **Turn on rate limiting**, `3` per `1` **Seconds**.
   Lead objects take hundreds to thousands of records a day and spike at launch
   or class time (217 in one hour in production). Queued executions wait; they
   don't fail.
7. **Save.**

**7f. Test.** Attach `META_CAPI_TEST_CODE` as in Step 5f. In **Test action**,
pick **your own** recent lead record, one with both email and phone. The event
reaches Meta, so it should carry your data, not a customer's. Type the contact's
record id into the `externalId` test box if it asks. Click **Test**.

✅ **Check:** **Status** **Success**, and:

| Output | Expected |
|---|---|
| `capi_result` | `sent` |
| `capi_status` | `200` |
| `capi_events_received` | `1` |
| `capi_event_id` | **the lead record's id**, not the contact's |
| `capi_match_keys` | `em,ph,external_id` at minimum (`fn,ln` too if mapped) |
| `capi_error` | empty |

**Logs** show `{"sent":{"event_name":"Lead",...,"action_source":"system_generated",...}}`.
If you mapped `offerDate`, `custom_data.offer_date` must read like `2026-09-22`,
not a 13-digit number. Memory is about 113 MB and runtime about 0.5 s.

> A useful second test: run it on another of your own lead records for a
> different offer. The hashes stay the same (same person), but `capi_event_id`
> differs, and both are sent. That's one event per sign-up, which is the point
> of keying on the record.

> If `capi_match_keys` shows only `em`, the contact association didn't resolve. In
> **Test action** that can be the test harness. Confirm on a live enrollment
> before changing the mapping.

Then **detach `META_CAPI_TEST_CODE`** and **Save**.

**7g. Turn it on.** **Review and turn on** → **No, only enroll \<lead records\>
who meet the criteria after the workflow is turned on** → turn on. HubSpot's
default here is also **Yes**.

**7h. Cut over, in this order.** The Lead event usually drives your campaigns'
optimization, so it must never drop to zero.

1. Leave the old Lead senders **on**: HubSpot *Ads → Conversion events* mapped
   to Lead, page `fbq('track','Lead')` snippets, and Event Setup Tool Lead rules.
   Meta's Lead count goes **up** for a day. That's expected. `Lead` is a standard
   event, so campaigns need no change.
2. In Events Manager, open **Overview** and the **Lead** row. New events should
   arrive with the lead record id as the event id. Spot-check a few enrollments
   for `capi_result = sent`.
3. After a full day, compare **sends** (records whose guard was stamped) against
   **new lead records** for the **same window, in the same timezone**. Meta's
   reporting lags about 2 hours, so cut both sides at the same hour. In
   production a matched 12 AM to 10 AM window gave 360 sends against 362 lead
   records, with 2 still in the delay.
4. Only then turn off the other Lead senders. In HubSpot, delete or switch off
   each *Ads → Conversion events* entry mapped to Lead. They can't carry an event
   id, so they can never dedupe against this. Remove the page snippets and Event
   Setup Tool Lead rules too.
5. Re-measure the next day: Meta's server Lead count should equal your lead
   records, and browser Lead should be at or near zero.

> ⚠️ **Compare matched windows, or you'll chase ghosts.** Twice in production a
> "gap" turned out to be Meta's still-filling hour compared against a CRM count
> that ran later. Let an hour settle for a few hours before treating it as final.

> If your lead guard ended up date-only (Step 2 warning), you can't cut sends at an
> hour. `hs_lastmodifieddate` on recently stamped records is a workable proxy.

> **No Lead retry was built in production.** If you want one, copy Step 6 onto the
> lead object: trigger guard *unknown* + lead time *< 7 days* + your status
> filter, **Delay 1 hour**, **If/then branch** *Meta CAPI lead sent at is unknown*,
> then the same code. Keep the branch, for the same reason as Step 6.

✅ **Check:** a full day after cutover, Meta server Lead ≈ lead records (within a
fraction of a percent), browser Lead ≈ 0, and the workflow's enrollment history
shows `sent` on all but a handful of `skipped_*` records.

---

## 4. Setup: Google Ads

The Google side is six steps. Do them in this order: each one produces something the next one
needs (a token, then conversion action ids, then a passing test, then the workflows).

| Step | Where | You end up with |
|---|---|---|
| 8 | Google Cloud Console + your terminal | An OAuth client and a refresh token with the `datamanager` scope only |
| 9 | Google Ads | Two import conversion actions (lead, purchase), their ids, set to **Secondary** |
| 10 | Google Ads + your terminal | Enhanced conversions for leads on, and a passing validate-only test |
| 11 | HubSpot | The **Google Lead** workflow, tested and on |
| 12 | HubSpot | The **Google Purchase** workflow, tested and on |
| 13 | Google Ads, ~3 days later | The uploads made Primary, the old tag-based actions Secondary |

Sign in with **the same Google login for every Google step**, and make it one that is an
**Admin** on the Google Ads account. Creating the Cloud project can be done by anyone, but the
login that clicks **Allow** in step 8e is the one Google checks on every upload, and accepting the
customer data terms in step 10 needs Admin. A *Standard* user can get most of the way and then
fail on those two.

> ⚠️ **Check you're in the right ad account before creating anything.** Conversion actions only
> work for the account they're created in. The account id and name are in the top right of Google
> Ads (e.g. `123-456-7890 Your Company`). If your live campaigns run in a different account, make
> everything there. Uploads can only match people who clicked an ad in that account in the last
> 90 days, so an account with no running campaigns will show very few matches.

### Step 8: Google Cloud project and the OAuth token

*About 10 minutes.*

You need a Google Cloud project only to own an OAuth client. Nothing runs in Google Cloud, and the
uploads cost nothing there. (The *"Start your Free Trial with $300 in credit"* banner can be
dismissed; you don't need billing.)

You do **not** need a Google Ads developer token or a manager (MCC) account for uploads. Google
Ads' **Admin → API center** page asks for one; ignore it. That's only for reading Ads data through
the Google Ads API.

**8a. Create the project.**
1. Open https://console.cloud.google.com. Check the avatar in the top right is the login you'll
   use for everything (switch accounts there if not), and accept the terms if asked.
2. Open https://console.cloud.google.com/projectcreate.
   - **Project name:** e.g. `ads-conversions`.
   - **Organization / Location:** leave the default (your Workspace domain, if you have one).
   - Click **Create**. Wait about 20 seconds.
3. Pick the new project in the **project dropdown** at the top of the page. Every page from here on
   shows the project name in that pill; check it before each click.

> ⚠️ *"You don't have permission to create a project"* means your Workspace admin has blocked
> Google Cloud for your account. They have to allow it; there's no way around it from here.

**8b. Enable the Data Manager API.**
1. Open https://console.cloud.google.com/apis/library/datamanager.googleapis.com.
2. Confirm the top bar shows your project, then click **Enable**. When it's done, the button reads
   **Manage**. If you come back later and it says **Enable** again, you're in the wrong project.

You don't need the Google Ads API for uploads. Enable it only if you also want a reporting token
(the script's `--for mcp` mode, below).

**8c. Set up the consent screen (Google Auth Platform).**
1. Open https://console.cloud.google.com/auth/branding and click **Get started**. The page is
   titled **Project configuration** and has four numbered parts: **App Information**, **Audience**,
   **Contact Information**, **Finish**.
2. **App Information:**
   - **App name:** e.g. `Conversion uploads`. This is *"The name of the app asking for consent"*,
     and it's what you'll see on the sign-in screen in 8e.
   - **User support email:** the dropdown offers only the account you're signed in with (plus any
     Google Groups you manage). Pick your own address. It's just a contact shown on the sign-in
     screen and has no effect on uploads.
   - Click **Next** (wording may differ).
3. **Audience:** choose **Internal** if your email domain is a Google Workspace domain. Click
   **Next**.
4. **Contact Information:** your email address. Click **Next**.
5. **Finish:** tick the agreement (Google's API services user data policy; wording may differ),
   then click **Create**. A toast reads *"OAuth configuration created!"* and you land on **OAuth Overview**.

> ⚠️ **The 7-day trap.** If **Internal** is greyed out (a personal Gmail account, or no
> Workspace), you must pick **External**. An External app left in **Testing** makes Google expire
> the refresh token after **7 days**. Every upload then fails with `invalid_grant`, silently, from
> day 8. Right after creating it, open **Audience** in the left menu and click **Publish app**,
> then confirm, so the status reads **In production** (wording may differ). You don't need
> Google's app verification for a single-user internal tool; you'll just see an "unverified app"
> warning when you sign in in 8e.

**8d. Create the OAuth client and download it.**
1. On **OAuth Overview**, click **Create OAuth client** (or open
   https://console.cloud.google.com/auth/clients and click **+ Create client**).
2. **Application type:** **Desktop app**. Not *Web application*: the setup script signs in through
   a local loopback address, which Web clients may refuse.
3. **Name:** e.g. `CRM conversion uploads`. Click **Create**.
4. A dialog titled **OAuth client created** opens with the **Client ID** and a yellow warning:
   *"You will no longer be able to view or download the client secret once you close this
   dialog."* Click **Download JSON** **before** you close it. The file is named
   `client_secret_<numbers>-<letters>.apps.googleusercontent.com.json`.
5. Move that file out of your Downloads folder to somewhere private and not cloud-synced, e.g.
   `C:\Users\you\.hubspot-capi\client_secret.json`.

> ⚠️ **Don't leave the client file in a synced folder** (OneDrive, Dropbox, a repo). It holds the
> client secret. In production it was first downloaded into a synced project folder and had to be
> moved. If you already have an older `client_secret_…json` in Downloads from another project,
> check the number at the start of the filename matches the **Client ID** in the dialog.

**8e. Mint the refresh token.** From the repo folder, in a terminal:

```powershell
node scripts/google-oauth-setup.mjs --client "C:\Users\you\.hubspot-capi\client_secret.json" --for hubspot
```

1. The terminal prints *"Sign in with the Google account that has access to the Google Ads
   account."* and, below it, *"If the browser does not open, paste this URL:"* followed by a long
   `https://accounts.google.com/o/oauth2/v2/auth?...` link. Your browser opens that link.
2. Choose the **Admin** login from the intro to this section. If it isn't listed, click **Use
   another account** and sign in with it. (With an Internal app any account on your domain can sign
   in, so it's easy to pick the wrong one.)
3. The consent screen names your app and asks for access to Data Manager. Tick every box if there
   are checkboxes, then click **Allow** (wording may differ).
4. The browser tab shows *"Done. You can close this tab and go back to the terminal."*
5. The terminal ends with:

   ```
   Saved: C:\Users\you\.hubspot-capi\google_hubspot_oauth.json

   Copy from that file into HubSpot secrets:
     client_id      -> GOOGLE_ADS_CLIENT_ID
     client_secret  -> GOOGLE_ADS_CLIENT_SECRET
     refresh_token  -> GOOGLE_ADS_REFRESH_TOKEN
   ```

The script asks for the `datamanager` scope only, checks Google actually granted it, and never
prints the token. The saved file is in Google's `authorized_user` format. You'll paste its three
values into HubSpot in step 11.

| If you see | It means | Do this |
|---|---|---|
| Google page *"400. That's an error. The server cannot process the request because it is malformed."* | The browser got a corrupted copy of the sign-in link (an early version of this script broke it on Windows) | Leave the script running. Copy the clean link the terminal printed under *"If the browser does not open…"* into the browser, and sign in from there |
| `Consent screen did not grant: …datamanager` | A permission box was left unticked | Run it again and tick every box |
| `Google returned no refresh token` | This client was approved before and Google skipped issuing a new token | Remove the app at https://myaccount.google.com/permissions and run again |
| `Warning: this is a "Web" client` | You created a Web application client in 8d | Create a **Desktop app** client instead |
| `That file is not an OAuth client JSON` | Wrong file passed to `--client` | Use the file from 8d.4 |

> ⚠️ **Keep this token for uploads only.** Everything pasted into a HubSpot secret is readable by
> anyone who can edit a custom code action. A `datamanager`-only token can upload conversions and
> nothing else: it can't read or change campaigns. If you also want to read Google Ads data (for
> example with the Google Ads MCP server), mint a **separate** token with
> `--for mcp`, which saves to `google_mcp_adc.json`, and never put that one in HubSpot.

✅ **Check:** `%USERPROFILE%\.hubspot-capi\google_hubspot_oauth.json` exists and the terminal said
`Saved:`. Open it in Notepad: it has `client_id`, `client_secret` and `refresh_token`.

### Step 9: Create the two conversion actions

*About 15 minutes.*

You need one Google Ads conversion action per event, of the **Import → conversions from clicks**
kind. The action's number (its *conversion type id*, `ctId`) goes into each HubSpot action's code.

**9a. Run the wizard for the lead action.**
1. In Google Ads, click **Goals** in the left rail, then **Conversions → Summary**.
2. Click **+ Create conversion action** (on some accounts it's **+ New conversion action**).
3. The newer wizard opens at **Get started**, headed *"Choose data sources to measure
   conversions"*, with four boxes. Set them like this:

   | Box | Set it to | Why |
   |---|---|---|
   | **Conversions on a website** | **Untick** | It creates Google tag / Google Analytics conversions for your site. Those would count the same sign-ups and sales a second time, next to the uploads. |
   | **Conversions on an app** | Leave unticked | |
   | **Conversions from phone calls** | **Untick** | Not needed for this |
   | **Conversions offline** | **Keep ticked** | *"Conversions outside of the internet, measured by connecting data in a CRM, importing a file, or with the Google Ads API"*. This is the upload type. |

   Under **Conversions offline**, *"Connect data source later"* is fine. If **Edit data sources**
   offers a manual upload or API option you can pick it, but the code doesn't depend on it.
4. Click **Save and continue**.
5. **Create conversion actions**, headed *"Group your conversions"*: under *"Choose a category to
   create conversion actions"*, click the category for your lead. **Sign-up** for a free sign-up
   or registration; **Submit lead form** or **Qualified lead** if that describes it better. Each
   row says how many actions already exist in it (e.g. *"6 conversion actions already measured for
   this category"*). Click **Save and continue**.
6. **Summary** reads *"You are almost done!"* and *"You've created 1 new conversion action"*.
   Under **Finish setting up your conversions → 1. Set up your data source** there are three
   buttons. **Don't click any of them:**
   - **Set up in Data manager** is Google's no-code connector for linking a CRM or a sheet.
     HubSpot pushes the data itself.
   - **Data Manager API** just opens Google's developer docs. It's the API the actions already use.
   - **Google Ads API** is the old upload method, closed to offline click conversions since
     June 2026.
7. Click **Finish**.

On an older account the wizard may instead be **+ New conversion action → Import → CRMs, files, or
other data sources → Track conversions from clicks → Continue**, followed by a settings screen.
Google moves these screens often. What matters is ending with an **Import** action whose source
reads *Import from clicks*.

**9b. Run it again for the purchase action.** Repeat 9a.2 to 9a.7, choosing the **Purchase**
category in 9a.5.

**9c. Find the new actions.** Back on **Goals → Conversions → Summary**, each category is a table
(the *goal*), headed by **Account-default**, the goal name, **Campaigns**, **Primary conversion
actions** and **Status**. The new actions appear in their goal's table with the wizard's default
names: `offline (Upload)`, then `offline (Upload) (1)` for the second, and so on. Their
**Conversion source** reads *Website (Import from clicks)*, and their **Status** reads *Awaiting
conversions*.

> ⚠️ **Google creates every new action as Primary.** Look at the **Action optimization** column:
> the new rows say *Primary*, and the goal's **Primary conversion actions** count went up by one.
> If your existing tag-based lead or purchase action is also Primary in that goal, bidding now
> counts every sign-up and every sale **twice**. Fix it in 9d before doing anything else.

**9d. Rename each action, set it to Secondary, and fix its settings.**
1. Click the action's name (e.g. `offline (Upload)`). The action page has **Details** and
   **Settings** tabs; open **Settings** (on some layouts, click **Edit settings** at the bottom).
2. Set each row below, clicking a row to expand it and **Save** inside it:

   | Setting | Lead action | Purchase action |
   |---|---|---|
   | **Conversion name** | e.g. `Lead (CRM upload)` | e.g. `Purchase (Stripe)` |
   | **Action optimization** | **Secondary action** | **Secondary action** |
   | **Value** | **Don't use a value** | **Use different values for each conversion** |
   | **Count** | **One** | **Every conversion** |
   | **Click-through conversion window** | your choice (90 days is the maximum) | **90 days** |
   | **Attribution** | Data-driven (default) | Data-driven (default) |

   **Source** reads *Import from clicks* and isn't editable. **Conversion type ID** is shown here
   too, marked *Not editable*.
3. **Faster way to switch Primary to Secondary:** on the Summary page, click the underlined word
   **Primary** in the action's **Action optimization** cell, choose **Secondary**, and **Save**.

> ⚠️ **The newer wizard never asks for value or count.** It creates the action with **Value**
> *"Use different values. If there's no value, use $1."* and **Count** *Every conversion*. In
> production the lead action was left that way, so Google showed **$1 per sign-up** (a lead goal
> reading 122.27 in value for 122 registrations) and counted every conversion. That's harmless
> unless a campaign bids on value (Maximize conversion value, Target ROAS), but set the lead action
> to **Don't use a value** and **One** so the numbers stay clean. The lead code sends no value.

**9e. Copy each action's id.**
1. Open each action. The id is the number after `ctId=` in the browser's address bar, e.g.
   `https://ads.google.com/aw/conversions/detail?ocid=…&ctId=987654321&…`. The URL is long; look
   for `ctId=` followed by digits. The same number is the **Conversion type ID** on the Settings
   tab.
2. Write down which id is which. The links themselves don't say, and ids are numbered in creation
   order: if you created the lead action first, it has the lower number.

✅ **Check:** on the Summary page each goal's **Primary conversion actions** is back to what it was
before (typically **1**, your existing tag-based action), and both new actions read **Secondary**
with source *Website (Import from clicks)*. You have two ctIds written down.

Two labels on that page look alarming and can be ignored for now:
- A goal that now has **no** Primary action (e.g. a **Qualified lead** goal you only put a
  Secondary action in) shows **Misconfigured**. It clears when an action in it is made Primary.
- The **Set up import** link in the Actions column, and on the action page a red banner *"Start
  measuring conversions by connecting to a data source"* with a **Connect data source** button,
  are Google's manual-upload tools. API uploads don't need them; the status changes from
  *Awaiting conversions* once uploads arrive.

### Step 10: Enhanced conversions for leads, then test from your terminal

*About 5 minutes, plus up to an hour of waiting.*

**10a. Turn on enhanced conversions for leads.** Uploads matched by hashed email are rejected
until the account allows them.
1. In Google Ads, go to **Goals → Conversions → Settings** (the left menu under Conversions:
   **Summary**, **Leads**, **Value rules**, **Custom variables**, **Settings**, **Uploads**).
2. The page is a list of collapsed rows: **Call conversion action**, **Customer data terms**,
   **Enhanced conversions for leads**, **Enhanced conversions**, **Engaged-view conversions**,
   **App attribution sharing**.
3. Check **Customer data terms** reads **Accepted**. If it doesn't, expand it and accept them. This
   needs **Admin** access; for a Standard user the button or Save is greyed out.
4. Expand **Enhanced conversions for leads** (*"Measure leads on your website that converted
   offline, using submitted lead form user data."*).
5. Tick **Turn on enhanced conversions for leads**.
6. Under *"Choose a method for setting up and managing user-provided data"* (*"You can use your
   existing Google tag, or Google Tag Manager"*) the dropdown offers only **Google tag** and
   **Google Tag Manager**. There's no API option, and that's fine: the checkbox is what lets
   uploads in, and the method only describes how your *website* collects form data. Pick whichever
   your site already uses (if the **Enhanced conversions** row below says *"Managed through Google
   Tag Manager"*, pick **Google Tag Manager**). Choosing it changes nothing in your tags or pages.
7. Click **Save**. The collapsed row now reads e.g. *"Managed through Google Tag manager"*.

> ⚠️ **Don't touch the row below it.** **Enhanced conversions** (without "for leads") is a
> different setting: it controls your *website* tags attaching hashed customer data. Its method
> dropdown *does* offer **Google Ads API**. Switching it to that tells Google to stop using the
> data your existing tags send and wait for API uploads instead, so your live tag-based actions
> lose their match data. It also doesn't fix anything for these uploads. If you open it by
> mistake, click **Cancel**.

**10b. Run the validate-only test for each action.** From the repo folder:

```powershell
node scripts/google-conversion-test.mjs --customer 1234567890 --action 987654321
```

- `--customer`: the ad account id from the top right of Google Ads, with or without dashes
  (`123-456-7890` → `1234567890`).
- `--action`: a ctId from 9e. Run the command once per action.
- `--login 1112223333`: only if you reach the ad account through a manager account.

It sends one fake, hashed conversion with `validateOnly: true`. Google checks the token, your
access to the account, the conversion action and the payload, and **records nothing**.

**Success:**

```
200 {
  "requestId": "v-06680012-…"
}

PASS - auth, account access and conversion action all check out. Nothing was recorded.
```

Validate-only request ids start with `v-`.

> ⚠️ **Expect this failure right after 10a, for up to about an hour:**
>
> ```
> 400 { "error": { "code": 400, "status": "INVALID_ARGUMENT", ...
>   "fieldViolations": [{
>     "field": "events.events[0].destination_references[0]",
>     "description": "The destination account is not enabled for enhanced conversions for leads.",
>     "reason": "DESTINATION_ACCOUNT_NOT_ENABLED_ENHANCED_CONVERSIONS_FOR_LEADS" }] ...
> FAIL - see the error meanings in this file's header.
> ```
>
> It's propagation, not misconfiguration. It's actually good news: to get this far, Google has
> already accepted your token, your access to the account and the ctId. In production it kept
> failing for about 25 minutes after Save, then passed on all actions with nothing changed. Wait
> 30 minutes and re-run. If it still fails after an hour, reopen **Enhanced conversions for
> leads**, check the box is still ticked, and save it again **as an Admin**.

| Other result | Meaning | Fix |
|---|---|---|
| `No credentials at …google_hubspot_oauth.json` | Step 8e hasn't been run (or finished) | Run 8e first |
| `Usage: --customer <Google Ads id> --action <conversion action ctId>` | An argument is missing, or you pasted a placeholder like `CTID` as-is | Use real digits |
| `PERMISSION_DENIED` | The login from 8e has no access to that ad account, or reaches it via a manager | Re-run 8e with the right login, or pass `--login` |
| `NOT_FOUND` / `INVALID_ARGUMENT` on `productDestinationId` | Wrong ctId, or it belongs to another account than `--customer` | Recheck 9e and the account id |
| `SERVICE_DISABLED` | Data Manager API not enabled in the project | 8b |
| `OAuth failed: invalid_grant` | Refresh token dead: an External app in Testing, or access revoked | 8c warning, then re-run 8e |

✅ **Check:** every ctId prints **PASS**. The Google side is done: token, access, conversion
actions and the account setting all work. Nothing in HubSpot has been touched yet.

### Step 11: The Google Lead workflow

*About 25 minutes.*

Build the lead workflow first: once it's proven, the purchase one is a near-copy. Build it **as
its own workflow**, not as an extra action in the Meta Lead workflow, so a Google auth failure
never stalls Meta (and the other way round).

Before you start, confirm the guard property from step 2 exists on your lead object:
`google_ads_lead_sent_at`, field type **Date and time picker** (not *Date picker*).

**11a. Create the workflow.**
1. Go to **Automation → Workflows → Create workflow → From scratch**.
2. Choose your lead object (e.g. your registrations custom object, or **Contact** if leads are
   contacts), and name it, e.g. `GOOGLE Lead Upload` (click the pencil next to the name at the top).

**11b. Set the trigger.** Click the trigger card, then in the **Triggers** panel (tabs **Start
triggers** and **Settings**):
1. Choose **Records meet custom conditions** (wording may differ). Under *"Only enroll [records]
   that meet these conditions"*, build **Group 1** with **+ Add criteria**, one condition at a time:

   | Condition | Why |
   |---|---|
   | *your lead-time property* (e.g. **Registered At**) **is known** | Only real leads |
   | **Google Ads lead sent at** **is unknown** | Skip anything already sent |
   | *your lead-time property* **is less than 7 days ago** | Safety net: an old record can never enroll, even if someone later flips the enrollment setting |
   | *a status property* **is any of** *the value that means a new sign-up* | Only if the same object also holds records that aren't new leads (see below) |

2. Optional: add **Manually triggered** as a second start trigger (it shows above the group with
   **OR** between them). It lets you push one record through by hand for testing, or backfill
   later.
3. Click **Done**, then **Save** at the top of the panel.
4. **Settings** tab: **Re-enrollment off**. The trigger card shows *Re-enroll off*.

> 💡 **The status condition came from the person building it in production, and it was better
> than the original trigger.** The registrations object there also receives records that aren't
> new sign-ups: another workflow creates an extra record, with status *Attended / Watched Replay*,
> each time someone opens the replay page. Of about 19,400 records in one week, about 7,200 were
> those. Without **Class Status is any of Registered**, each replay visit would have uploaded as a
> new lead. Before relying on a filter like this, count records per status value: if any real
> lead has a blank status, the filter silently drops it (in production none did).

**11c. Add a 5-minute delay.** Click the **+** under the trigger → **Delay** → **Delay for 5
minutes** → **Save**.

Why: when a form creates a brand-new contact, HubSpot writes its Google click id
(`hs_google_click_id`) a little after the record is created. Without the delay, the click id is
blank on exactly the people who just clicked your ad.

> ⚠️ **Check the delay really is step 1.** The custom code action should be numbered **2**. In
> production the first build had the code as action 2 with the delay missing from the canvas; it
> was caught from a screenshot. If the code is action 1, add the delay above it.

**11d. Add the custom code action.**
1. Click the **+** under the delay and choose **Custom code** (in the **Data ops** group, or search
   for `code`). The panel opens titled **2. Custom code**, with **Cancel** and **Save**.
2. **Language:** **Node.js 20.x**. Leave **Description** empty or add a note.
3. **Secrets** (*"Choose one or multiple secrets to use in this action."*): open the dropdown and
   add a secret for each row below. For a new one, choose the option to add a secret, enter the
   **Secret name** exactly as shown and paste the **value**, then save it (dialog wording may
   differ). Make sure every one shows as a chip in the field when you're done.

   | Secret name | Value |
   |---|---|
   | `GOOGLE_ADS_CLIENT_ID` | `client_id` from `google_hubspot_oauth.json` (step 8e) |
   | `GOOGLE_ADS_CLIENT_SECRET` | `client_secret` from the same file |
   | `GOOGLE_ADS_REFRESH_TOKEN` | `refresh_token` from the same file |
   | `GOOGLE_ADS_CUSTOMER_ID` | the ad account id, digits only (`1234567890`) |
   | `GOOGLE_ADS_VALIDATE_ONLY` | `true`. **For testing only.** You'll detach it in 11g. |
   | `CAPI_GUARD_WRITE_TOKEN` | already created in step 3: just select it |
   | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | **only** if you reach the ad account through a manager account: the manager's id, digits only. Otherwise don't create it. |

   Open the JSON file in Notepad and copy only the text **inside** the quotes. The code rejects a
   secret containing any space or line break (*"Secret "…" contains whitespace, so it is not a
   credential."*), which catches a stray quote, line break or pasted URL.

4. **Property to include in code** (*"Each property needs to be defined in your code."*): for
   each row, click **Add property**, type the **Input name** on the left exactly as shown (they're
   case-sensitive), then use **Select a property** on the right. Properties of the record itself
   are under the enrolled object's group (e.g. *Enrolled class registration*); contact
   properties are under the **associated contact** group. The picker shows the group in brackets
   after the label, e.g. *Email (Enrolled…)*, *Record ID (Contact)*.

   | Input name | Value | Required? |
   |---|---|---|
   | `gadsLeadSentAt` | Enrolled object → **Google Ads lead sent at** | Yes (it's the guard) |
   | `email` | Enrolled object → the lead's email (or Associated contact → **Email** if the record has none) | Yes |
   | `leadAt` | Enrolled object → your lead-time property (e.g. **Registered At**) | Yes |
   | `phone` | Enrolled object → the phone number property (or Associated contact → **Phone number**) | If you collect it |
   | `offerName` | Enrolled object → **what they signed up for** (e.g. class topic, webinar name) | Yes, see warning |
   | `offerDate` | Enrolled object → **the date of that offer** (e.g. class date, webinar date) | Yes, see warning |
   | `externalId` | Associated contact → **Record ID** | Yes |
   | `gclid` | Associated contact → **Google Click ID** (`hs_google_click_id`) | Yes |

   If your leads **are** contacts, every value comes from the enrolled contact, and `externalId` is
   the contact's own **Record ID**.

> ⚠️ **`offerName` and `offerDate` form a permanent key. Map them from fields *every* lead record
> has.** The upload id is `lead-<contact id>-<offer date>-<offer name>`, e.g.
> `lead-123456789012-2026-10-06-retirement-webinar`. Google treats a repeat of the same id as an
> adjustment, **forever**, which is what collapses one person's duplicate records into one
> conversion. In production the first version used a "session" field when it was present; live
> data then showed that field filled for one offer and blank for another, so one person's
> duplicates could get two different keys and count twice. It was fixed within the hour to date +
> topic, which every record carries, and re-pasted into the live workflow. Check your two fields
> on a sample of records for **each** offer before going live, and never change the key's shape
> once live: keys already sent would stop matching. `externalId` must be the **contact's** id,
> never the lead record's own id, or every duplicate record becomes its own person.

5. **Code:** delete the sample code and paste in **all** of `google/google-lead-action.js`. The
   **Full screen** button makes this easier. Scroll to the bottom: the last line number should be
   about **394**. A much lower number means the paste was cut off.
6. Still in the code, near the top, find the **SETTINGS** block and change two lines:

   ```js
   const CONVERSION_ACTION_ID = 'REPLACE_WITH_CONVERSION_ACTION_ID';   // -> your lead ctId, e.g. '987654321'
   ```
   ```js
   const OBJECT_TYPE = '2-00000000';   // -> your lead object's type id, e.g. '2-87654321' ('0-1' for contacts)
   ```

   The object type id is in the address bar when you view the object's record list:
   `…/objects/2-87654321/views/…`. The code uses it to stamp the guard; a wrong one means the
   guard never gets written.
7. **Data outputs** (*"Define the data type and name of outputs from your code. Each output name
   must be unique and can only be used once."*): click **Add output** for each row, choosing the
   type from the dropdown and typing the name exactly:

   | Output | Type |
   |---|---|
   | `gads_result` | String |
   | `gads_status` | Number |
   | `gads_request_id` | String |
   | `gads_transaction_id` | String |
   | `gads_match_keys` | String |
   | `gads_click_id` | String |
   | `gads_error` | String |

   HubSpot also lists a built-in **Enumeration** output, `hs_execution_state` (*Succeeded*,
   *Failed, object rem…*, *Failed, object cont…*, *Skipped, action d…*, *Partially succeede…*).
   Leave it alone.
8. **Configure rate limit** (collapsed, below the outputs): expand it and set about **5 actions per
   1 second** (wording may differ). Sign-ups spike at launch and class times; production saw 217
   in one hour.
9. Click **Save**.

**11e. Test it with validate-only on.**
1. Reopen the action and expand **Test action** at the bottom. HubSpot warns *"Changes will be
   applied to your [record]. If you don't want to edit existing [records] try making a test
   [record]."* Here that's safe: with `GOOGLE_ADS_VALIDATE_ONLY` attached, the action changes
   nothing, not even the guard.
2. In the record dropdown, pick a **recent** lead (from today). If you can, pick one whose contact
   has a Google Click ID, so the click-id path is tested too.
3. Under **Properties to include in code** (*"The test data helps you to see if the data inputs are
   being used correctly in your code. [Record] properties used in the code will come from the
   [record] you chose above."*) you'll see an **Enter test value** box for `externalId` and
   `gclid`. **Test mode can't read associated-contact properties**, so type them in: open the
   record's contact (the **View [record]** link helps), and copy its **Record ID** into `externalId`
   and its Google Click ID into `gclid`. Leave `gclid` blank if the contact has none. When live,
   the workflow fills both automatically.
4. Click **Test**.

✅ **Check:** the result shows **Status**, then **Data outputs** (*"These will be available to use
as inputs in supported actions later on in this workflow…"*) as a Name / Value table:

| Name | Expected value |
|---|---|
| `hs_execution_state` | `SUCCESS` |
| `gads_result` | `validated` |
| `gads_status` | `200` |
| `gads_request_id` | starts with `v-` |
| `gads_transaction_id` | `lead-<the contact id you typed>-<YYYY-MM-DD>-<offer-slug>` |
| `gads_match_keys` | `email`, plus `phone` and `gclid` when present, e.g. `email,phone,gclid` |
| `gads_click_id` | `gclid` if you typed one, `none` otherwise |
| `gads_error` | empty |

**Logs** shows one line `{"sent":{…},"response":{…}}`: check `eventTimestamp` is the lead's time,
not the test time, and that email and phone went out as 64-character hashes. At the bottom,
**Memory** (about 114/2048 MB) and **Runtime** (about 1 s).

Read the date in `gads_transaction_id`. It must be the offer the person actually signed up for.
In production a test record's *name* said one class date while the key said the next week's: the
person had registered after the first class and been rolled forward, so the key (from the class
fields) was right and the name was stale. If yours is wrong, the field you mapped to `offerDate`
is.

| Test shows | Cause |
|---|---|
| Error *"Set CONVERSION_ACTION_ID at the top of this action before testing."* | 11d.6 not done |
| Error *Missing secret "…". Add it under Custom code > Secrets.* | That secret isn't attached as a chip |
| `gads_result = error`, `gads_error` starts `OAuth invalid_grant` | Refresh token dead (8c warning); re-run 8e and update `GOOGLE_ADS_REFRESH_TOKEN` |
| `gads_result = error`, `DESTINATION_ACCOUNT_NOT_ENABLED_…` | Step 10 wait isn't over |
| `gads_result = skipped_no_identifier` | The record has no email, phone or click id mapped |
| An output reads *"Not defined in code"* | Typo in that output's name |

**11f. If you change the code later, verify the paste by line count.** A validate-only test can look
identical before and after a code change. Scroll to the bottom of the code box and compare the last
line number with the file in the repo. Production caught an un-replaced paste this way.

**11g. Go live.**
1. In the action's **Secrets** box, click the **×** on **`GOOGLE_ADS_VALIDATE_ONLY`**. Only detach
   it from this action; don't delete the secret, because you'll use it again in step 12.
2. Check **Configure rate limit** is still about 5 per second, then **Save**.
3. Click **Review and publish** (or the on/off control at the top; wording may differ). The
   **Review Workflow** panel opens at **Step 1: Enrollment** and asks *"Do you want to enroll
   [records] that currently meet the enrollment criteria when the workflow turns on?"*
4. Choose **No, only enroll [records] who meet the enrollment criteria after the workflow is turned
   on**. Click **Next**, then turn it on. The header now reads **ON**.

> ⚠️ **`GOOGLE_ADS_VALIDATE_ONLY` attached to a live workflow silently discards everything.**
> Every run returns `validated`, nothing is recorded, and because validate-only runs never stamp
> the guard, nothing looks wrong on the records either. It's the one setting to double-check.

✅ **Check (a few minutes later):** open the workflow's **Enrollment history** / action logs.
New enrollments show `gads_result = sent` and a `gads_request_id` that does **not** start with
`v-`, and **Google Ads lead sent at** is filled on the record. `validated` on a live record means
the secret is still attached. In production the lead workflow had stamped 44 records within 10
minutes of going live.

| `gads_result` | Meaning | Action |
|---|---|---|
| `sent` | Google received it (not yet *matched*) | None |
| `validated` | `GOOGLE_ADS_VALIDATE_ONLY` is attached | Detach it |
| `skipped_already_sent` | Guard already filled | None |
| `skipped_no_identifier` | No email, phone or click id | Check the mappings |
| `skipped_too_old` | Lead older than 89 days | None; Google accepts 90 days |
| `error` | Google or OAuth rejected it; the guard stays blank | Read `gads_error`. Enroll the record manually (the **Manually triggered** start) once fixed |

### Step 12: The Google Purchase workflow

*About 20 minutes.*

Same pattern as step 11, on your payment object. Confirm first that `google_ads_purchase_sent_at`
exists on the payment object as a **Date and time picker**, and that the `STRIPE_READ_KEY` secret
from step 4 exists.

**12a. Create the workflow.** **Automation → Workflows → Create workflow → From scratch**, choose
your payment object, name it e.g. `GOOGLE Purchase Upload`.

Cloning the Meta Purchase workflow (**File → Clone**) also works, since the trigger is nearly the
same. If you do, replace everything Meta in the copy: the Meta secrets, the code, the Meta inputs
and every `capi_*` output. In production the clone kept a leftover `capi_fbc_source` output (always
empty) and an unused `externalId` input until they were spotted in a screenshot. Leave the Meta
original as it is.

**12b. Set the trigger.** In the **Triggers** panel, **Records meet custom conditions**, **Group 1**,
all joined with **and**:

| Condition | Why |
|---|---|
| *your PaymentIntent id property* (e.g. **Stripe Payment Transaction ID**) **is known** | Only real payments |
| **Status** **is equal to any of** **succeeded** | Keeps out intents that never complete (16% of rows in production). The code checks Stripe too; this saves the calls. |
| **Google Ads purchase sent at** **is unknown** | Skip anything already sent |
| **Created** (the record's create date) **is less than 7 days ago** | Safety net, and it caps the backfill in 12f |

Optionally add **Manually triggered** as a second start trigger. **Done**, **Save**.
**Settings** tab: **Re-enrollment off**.

No delay is needed: the code reads the buyer, amount and click id from Stripe, not from HubSpot.
(The production workflow, cloned from Meta, kept a harmless **Delay for 1 minute**.)

**12c. Add the custom code action.** **+ → Custom code**, **Node.js 20.x**.
1. **Secrets:** select the ones created in step 11 plus the Stripe key:

   | Secret | Note |
   |---|---|
   | `STRIPE_READ_KEY` | Stripe live restricted key: *Checkout Sessions: read*, *PaymentIntents: read* (step 4) |
   | `GOOGLE_ADS_CLIENT_ID` | |
   | `GOOGLE_ADS_CLIENT_SECRET` | |
   | `GOOGLE_ADS_REFRESH_TOKEN` | |
   | `GOOGLE_ADS_CUSTOMER_ID` | |
   | `GOOGLE_ADS_VALIDATE_ONLY` | For testing; detached in 12e |
   | `CAPI_GUARD_WRITE_TOKEN` | Stamps the guard |
   | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Only if you created it in step 11 |

2. **Property to include in code:**

   | Input name | Value | Required? |
   |---|---|---|
   | `paymentIntentId` | Enrolled object → your `pi_...` property (e.g. **Stripe Payment Transaction ID**) | Yes |
   | `gadsPurchaseSentAt` | Enrolled object → **Google Ads purchase sent at** | Yes (guard) |
   | `checkoutSessionId` | Enrolled object → a property holding the `cs_...` Checkout Session id, if you have one | Optional: without it the code finds the session from the PaymentIntent |
   | `orderReference` | Enrolled object → another property that may hold the `cs_...` id | Optional |
   | `contactEmail` | Associated contact → **Email** | Optional fallback |
   | `gclid` | Associated contact → **Google Click ID** | Optional fallback |

   Leave `minimumValue` unmapped (it defaults to 0.01, so $0 orders are skipped). The contact
   `gclid` is used only when the checkout carried no click id: it's the contact's *most recent*
   click, which may not be the one that led to this sale.
3. **Code:** delete the sample code and paste in **all** of `google/google-purchase-action.js`.
   The last line should be about **510**. Then set, in the SETTINGS block:

   ```js
   const CONVERSION_ACTION_ID = 'REPLACE_WITH_CONVERSION_ACTION_ID';   // -> your purchase ctId
   ```
   and, a few lines below it:
   ```js
   const OBJECT_TYPE = '2-00000000';   // -> your payment object's type id, e.g. '2-12345678'
   ```
4. **Data outputs:**

   | Output | Type |
   |---|---|
   | `gads_result` | String |
   | `gads_value` | Number |
   | `gads_currency` | String |
   | `gads_status` | Number |
   | `gads_request_id` | String |
   | `gads_transaction_id` | String |
   | `gads_match_keys` | String |
   | `gads_click_id` | String |
   | `gads_source` | String |
   | `gads_error` | String |

5. **Configure rate limit:** about **5 per second**. **Save**.

**12d. Test with validate-only on.**
1. **Test action** → in the payment dropdown pick a **recent succeeded** payment (search by its
   `pi_...` id). A payment from today with a real amount is best.
2. Leave the **Enter test value** boxes for the associated-contact inputs (`contactEmail`,
   `gclid`) **blank**. That deliberately proves the action finds the buyer and any click id from
   Stripe on its own.
3. Click **Test**.

✅ **Check:**

| Name | Expected value |
|---|---|
| `hs_execution_state` | `SUCCESS` |
| `gads_result` | `validated` |
| `gads_value` | the amount actually charged, e.g. `97` |
| `gads_currency` | e.g. `USD` |
| `gads_status` | `200` |
| `gads_request_id` | starts with `v-` |
| `gads_transaction_id` | the `pi_...` id |
| `gads_match_keys` | includes `email`; often `phone` and `address` (name + postcode from Stripe billing) |
| `gads_click_id` | `gclid_url` / `gbraid_url` / `wbraid_url` if the buyer came from a Google ad and the id reached checkout; `none` otherwise. Both are fine. |
| `gads_source` | `checkout_session` (or `payment_intent` for renewals and invoices) |
| `gads_error` | empty |

In **Logs**, the `sent` event has `conversionValue` and `currency`, hashed `emailAddress`, and an
`address` with hashed `givenName` / `familyName` but **unhashed** `regionCode` and `postalCode`.
That's Google's rule, not a leak. In production the test ran on email + address alone, with
`gads_click_id = none`.

| Test shows | Cause |
|---|---|
| `skipped_test_mode` | You picked a Stripe test-mode payment; the live key can't see it. Pick a live one. |
| `skipped_refunded` / `skipped_not_succeeded` | That payment was refunded or never paid. Expected; pick another. |
| `skipped_no_amount` | A $0 order |
| `skipped_not_found` | Stripe has no session or intent for that id |
| `error` with a Stripe 401/403 | `STRIPE_READ_KEY` wrong or missing a *read* permission |

**12e. Detach validate-only.** Click the **×** on `GOOGLE_ADS_VALIDATE_ONLY` in the Secrets box
and **Save**. While you're there, reopen the **Google Lead** workflow's action and confirm it isn't
attached there either.

> ⚠️ In production the purchase workflow reached the turn-on screen with
> `GOOGLE_ADS_VALIDATE_ONLY` still attached (it was the second chip in the Secrets box). Turned on
> like that, with a backfill, every purchase would have been validated and thrown away. Look at
> the chips, not your memory, before 12f.

**12f. Turn it on, with the optional 7-day backfill.** **Review and publish** → **Step 1:
Enrollment** shows *"N [payments] meet the enrollment criteria"*.

Here, unlike the lead workflow, **Yes, enroll … immediately when the workflow is turned on** is
safe and useful:
- The *Created is less than 7 days ago* condition caps it at one week of payments (643 in
  production).
- Each is keyed on its `pi_...` id, which Google dedupes permanently, so nothing can double.
- Google files each purchase at its real payment time and credits the original click, so nothing
  piles up on today.
- The action is still **Secondary**, so bidding isn't affected.
- You get a week of Google purchase data to compare against Stripe straight away.

Choose **Yes** only if 12e is done. If you're not sure, choose **No**; you can backfill later by
enrolling records manually through the **Manually triggered** start. Click **Next**, then turn it
on. At 5 per second a few hundred records take a few minutes.

✅ **Check (10-20 minutes later):** in **Enrollment history**, runs show `gads_result = sent`, and
**Google Ads purchase sent at** is filled. In production 640 of 643 backfilled payments were
stamped within minutes; the 3 left blank were `skipped_refunded`, which is correct.

**The day after:** in Google Ads open each new action (**Goals → Conversions → Summary →** the
action) and look at its **Diagnostics** / status panel. Uploads show within about 24 hours;
matching follows. A **200 means received, not matched**. Look up any single upload with:

```powershell
node scripts/google-conversion-test.mjs --status <gads_request_id>
```

> ⚠️ **Don't judge credited conversions for about 3 days.** Google keeps matching after the day
> ends. In production a day's purchase credit went from 8 to 17, and a day's lead credit from 121
> to 223, between day 1 and day 3. An early read made the old tag look ~16x over-counted; the
> matured number was ~7.7x. And while the actions are Secondary they appear only in **All
> conversions** / per-action views, never in the **Conversions** column.

A **Needs attention** status on the lead action in the first days is common. Open it: in
production it read *"No user-provided data matches — Your imported user-provided data (eg, email
addresses) has no matches to web events. Use the Google tag on your website to send
user-provided data."* Uploads were still being received and credited. Google suggests turning on
user-provided data in the Google tag on your sign-up confirmation page as well; whether that is
required for email-only uploads to match was not confirmed with Google.

### Step 13: Cut over: make the uploads Primary

*About 10 minutes, after ~3 days of clean uploads.*

Until now the uploads run as **Secondary**: they record data but don't steer bidding. Switch once
the matured numbers line up: Google's credited purchases track succeeded Stripe payments, and lead
uploads track new lead records.

In production purchase was switched after two days, early on purpose, because the tag-based
purchase action had stopped recording (a tag-manager change had removed it from the purchase
pages). If your old action is still healthy, wait the full ~3 days.

**13a. Switch each goal.** In Google Ads, **Goals → Conversions → Summary**.
1. In the **Purchase** goal's table, click the underlined **Secondary** next to your upload action
   (e.g. *Purchase (Stripe)*), choose **Primary**, and **Save**.
2. Click the underlined **Primary** next to your old tag-based purchase action, choose
   **Secondary**, and **Save**. (Or, on each action's **Settings** tab, **Action optimization →
   Primary action / Secondary action**.)
3. Do the same in your lead goal (e.g. **Sign-up**): upload action → **Primary**, old tag action →
   **Secondary**.
4. Each goal's **Primary conversion actions** should still read **1**, now the upload. The
   collapsed goal cards don't say *which* action that is, so expand each (the ⌄ arrow) and look.

> ⚠️ **Both Primary = every conversion counted twice** as soon as the old tag fires. Confirm the
> old action says Secondary after you save.

> ⚠️ **One Primary action per person-event across all account-default goals.** Campaigns on
> account-default goals bid toward every Primary action in every account-default goal combined. If
> you also upload a second lead-type event (e.g. an "attended" action in **Qualified lead**), keep
> it Secondary: made Primary alongside the sign-up, one person who signs up *and* attends counts as
> two conversions. Switching bidding to that event is a separate decision.

**13b. Check custom goals.** Scroll to **Custom goals** at the bottom of the Summary page. The
table has **Custom goals**, **Conversion actions** (e.g. *2 actions*), **Conversion sources** and
**Total campaigns** (e.g. *1 campaign*).
1. Click the **actions** link to see which conversion actions the custom goal contains, and the
   **campaign** link to see which campaign uses it.
2. A campaign on a custom goal **ignores account-default goals completely**, so 13a didn't change
   it. If the custom goal still contains your old tag-based actions, either:
   - click the custom goal's name, edit it, and swap the old actions for the upload actions (the
     smaller change: the campaign keeps its setup), or
   - in that campaign's **Settings → Goals**, switch it from the custom goal to **account-default
     goals**.

**13c. Don't remove the old actions.**
- Removing a conversion action is **permanent**: it can't be turned back on, and its history
  leaves your comparisons. Secondary actions cost nothing and don't affect bidding.
- Keep the old tag actions as Secondary: if the upload ever stops (an expired token, a detached
  secret), you'll see the two diverge.
- Goal categories (Purchase, Sign-up, …) can't be deleted at all.
- If the list is in your way, filter **Status** to hide *Misconfigured* rows. That's reversible.
- Before removing a genuinely retired action later, open it and check it isn't in any custom goal.

**13d. Tell whoever watches the Google dashboard, before they see it.** Reported conversions
usually **drop** at the cutover, and reported ROAS with them. That isn't performance getting
worse; it's the reporting starting to match real payments. A purchase-only campaign may wobble for
a week or two on the thinner signal. Note the switch date: every before/after comparison of Google
numbers has to cut at that day.

✅ **Check:** each goal's single Primary action is the upload; the old tag actions are Secondary
and still recording; no custom goal points only at old actions; and the next day's **Conversions**
column (not just *All conversions*) shows the uploads.

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
| Retry workflow doubled every sale | No If/then re-check after the delay | Step 6d |
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
