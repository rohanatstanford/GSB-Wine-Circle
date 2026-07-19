#!/usr/bin/env node
// One-time local helper: generates a Gmail OAuth2 refresh token for GMAIL_REFRESH_TOKEN.
//
// Prerequisite: an OAuth 2.0 Client ID of type "Desktop app" from
// https://console.cloud.google.com (APIs & Services > Credentials), for a
// project that has the Gmail API enabled and an OAuth consent screen with
// the sending Gmail account added as a test user.
//
// Usage:
//   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/get-gmail-refresh-token.js
//
// Opens a Google consent URL — sign in as the Gmail account that should send
// mail and approve access. The refresh token is printed to the terminal;
// save it as GMAIL_REFRESH_TOKEN in your deployment's environment variables.

const http = require('http');
const { OAuth2Client } = require('google-auth-library');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first (from the Desktop app OAuth client you created).');
  process.exit(1);
}

const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\nOpen this URL and sign in as the Gmail account that should send mail:\n');
console.log(authUrl + '\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.end('');
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No authorization code received — check the terminal for errors.');
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    res.end('Success — you can close this tab and return to the terminal.');
    console.log('\nRefresh token (save this as GMAIL_REFRESH_TOKEN):\n');
    console.log(tokens.refresh_token);
    console.log('');
    server.close();
    process.exit(0);
  } catch (err) {
    res.end('Error exchanging code: ' + err.message);
    console.error('\nError:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for the browser authorization on http://localhost:${PORT} ...\n`);
});
