#!/usr/bin/env node
/**
 * google-oauth-setup.mjs
 *
 * Author:   Jibril Sulaiman
 * Created:  2026-09-23
 * Run:      locally, from a terminal. Needs Node 18+ and nothing else.
 *
 * WHAT IT DOES
 *   Runs Google's OAuth consent flow in your browser and saves a long-lived
 *   refresh token to %USERPROFILE%\.hubspot-capi\, in Google's "authorized_user"
 *   credentials format. Two modes, two separate tokens:
 *
 *     --for hubspot  scope: datamanager
 *                    -> .hubspot-capi\google_hubspot_oauth.json
 *                    Values go into the HubSpot secrets GOOGLE_ADS_CLIENT_ID,
 *                    GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN.
 *                    Can upload conversions. Cannot read or change campaigns.
 *
 *     --for mcp      scopes: adwords + cloud-platform
 *                    -> .hubspot-capi\google_mcp_adc.json
 *                    Pointed at by GOOGLE_APPLICATION_CREDENTIALS for the
 *                    official Google Ads MCP server, so Claude can read the
 *                    account. Never paste this one into HubSpot.
 *
 * WHY TWO TOKENS
 *   A token stored in HubSpot's secret vault is readable by anyone who can edit
 *   a coded action. Keeping it to the one scope it needs means a leak can
 *   upload junk conversions, not read or edit the ad account.
 *
 * BEFORE RUNNING
 *   1. Google Cloud Console (same Google login that has Google Ads access):
 *      https://console.cloud.google.com/projectcreate  -> project e.g. "ads-conversions"
 *   2. Enable both APIs in that project:
 *      https://console.cloud.google.com/apis/library/datamanager.googleapis.com
 *      https://console.cloud.google.com/apis/library/googleads.googleapis.com
 *   3. OAuth consent screen: https://console.cloud.google.com/auth/branding
 *      User type INTERNAL if your domain is a Google Workspace domain.
 *      If it must be External, PUBLISH it to "In production". An app left in
 *      "Testing" kills refresh tokens after 7 days, and every upload then
 *      fails with invalid_grant.
 *   4. Create OAuth client: https://console.cloud.google.com/auth/clients
 *      Type "Desktop app". Download the JSON.
 *
 * USAGE (PowerShell)
 *   node google-oauth-setup.mjs --client "C:\path\client_secret_XXXX.json" --for hubspot
 *   node google-oauth-setup.mjs --client "C:\path\client_secret_XXXX.json" --for mcp
 *
 * The script never prints the refresh token. Open the saved file to copy it.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? '' : (args[i + 1] || '');
};

const clientPath = arg('--client');
const mode = arg('--for');

const MODES = {
  hubspot: {
    scopes: ['https://www.googleapis.com/auth/datamanager'],
    file: 'google_hubspot_oauth.json',
  },
  mcp: {
    scopes: [
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/cloud-platform',
    ],
    file: 'google_mcp_adc.json',
  },
};

if (!clientPath || !MODES[mode]) {
  console.error('Usage: node google-oauth-setup.mjs --client <client_secret.json> --for hubspot|mcp');
  process.exit(1);
}

const clientJson = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
const client = clientJson.installed || clientJson.web;
if (!client || !client.client_id || !client.client_secret) {
  console.error('That file is not an OAuth client JSON. Download it from Credentials > OAuth 2.0 Client IDs.');
  process.exit(1);
}
if (!clientJson.installed) {
  console.error('Warning: this is a "Web" client. A "Desktop app" client is expected; loopback redirects may be refused.');
}

// PKCE: the code in the redirect is useless to anyone who intercepts it.
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: MODES[mode].scopes.join(' '),
  access_type: 'offline',
  // Forces Google to issue a refresh token even if this client was approved before.
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

console.log(`\nSign in with the Google account that has access to the Google Ads account.`);
console.log(`If the browser does not open, paste this URL:\n\n${authUrl}\n`);
// rundll32 takes the URL as a plain argument, with no cmd.exe parsing. The
// first version used `start` with ^-escaped ampersands; inside quotes cmd keeps
// the ^ literally, Google received "response_type=code^" and returned a 400.
execFile('rundll32', ['url.dll,FileProtocolHandler', authUrl]);

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get('error');
    const ok = !err && url.searchParams.get('state') === state;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(ok
      ? '<h2>Done. You can close this tab and go back to the terminal.</h2>'
      : `<h2>Failed: ${err || 'state mismatch'}</h2>`);
    server.close();
    if (ok) resolve(url.searchParams.get('code'));
    else reject(new Error(err || 'OAuth state mismatch - start again.'));
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }).toString(),
});
const tokens = await tokenRes.json();

if (!tokenRes.ok || !tokens.refresh_token) {
  console.error('Token exchange failed:', tokens.error || tokenRes.status, tokens.error_description || '');
  if (tokenRes.ok && !tokens.refresh_token) {
    console.error('Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run again.');
  }
  process.exit(1);
}

const granted = String(tokens.scope || '').split(' ');
const missing = MODES[mode].scopes.filter((s) => !granted.includes(s));
if (missing.length) {
  console.error(`Consent screen did not grant: ${missing.join(', ')}. Tick every box on the consent page and retry.`);
  process.exit(1);
}

const dir = path.join(os.homedir(), '.hubspot-capi');
fs.mkdirSync(dir, { recursive: true });
const outFile = path.join(dir, MODES[mode].file);

// "authorized_user" is the format gcloud writes for Application Default
// Credentials, so the MCP server's google-auth library reads it as-is.
fs.writeFileSync(outFile, JSON.stringify({
  type: 'authorized_user',
  client_id: client.client_id,
  client_secret: client.client_secret,
  refresh_token: tokens.refresh_token,
  scopes: MODES[mode].scopes,
  created: new Date().toISOString(),
}, null, 2));

console.log(`Saved: ${outFile}`);
if (mode === 'hubspot') {
  console.log('\nCopy from that file into HubSpot secrets:');
  console.log('  client_id      -> GOOGLE_ADS_CLIENT_ID');
  console.log('  client_secret  -> GOOGLE_ADS_CLIENT_SECRET');
  console.log('  refresh_token  -> GOOGLE_ADS_REFRESH_TOKEN');
  console.log('\nThen test: node google-conversion-test.mjs --customer <id> --action <ctId>');
} else {
  console.log(`\nSet: GOOGLE_APPLICATION_CREDENTIALS = ${outFile}`);
}
