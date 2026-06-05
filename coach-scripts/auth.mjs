/**
 * coach-scripts/auth.mjs
 * Strava OAuth — generates auth URL and exchanges the redirect code for tokens.
 * Usage:
 *   node coach-scripts/auth.mjs --client-id=ID --client-secret=SECRET
 *   node coach-scripts/auth.mjs --code="http://localhost:8080/..."
 */
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

const CONFIG_DIR = join(homedir(), '.claude-coach');
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

await mkdir(CONFIG_DIR, { recursive: true });

// Mode 1: generate auth URL
if (args['client-id'] && args['client-secret'] && !args['code']) {
  const clientId = args['client-id'];
  const clientSecret = args['client-secret'];

  // Save credentials for later use
  await writeFile(join(CONFIG_DIR, 'credentials.json'), JSON.stringify({ clientId, clientSecret }, null, 2));

  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:8080&response_type=code&scope=activity:read_all`;

  console.log('\n========================================');
  console.log('  STRAVA AUTHORIZATION URL');
  console.log('========================================');
  console.log('\n1. Open this URL in your browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2. Click "Authorize" on Strava');
  console.log("3. You'll be redirected to a page that won't load — that's expected!");
  console.log('4. Copy the ENTIRE URL from the browser address bar');
  console.log('5. Run: node coach-scripts/auth.mjs --code="<paste URL here>"\n');
  process.exit(0);
}

// Mode 2: exchange code for tokens
if (args['code']) {
  let code = args['code'];

  // Handle if user passed the full redirect URL
  if (code.startsWith('http')) {
    const u = new URL(code);
    code = u.searchParams.get('code');
  }

  // Load saved credentials
  let credentials;
  try {
    credentials = JSON.parse(await readFile(join(CONFIG_DIR, 'credentials.json'), 'utf8'));
  } catch {
    console.error('ERROR: No saved credentials found. Run auth first with --client-id and --client-secret');
    process.exit(1);
  }

  console.log('Exchanging authorization code for tokens...');

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('ERROR exchanging token:', response.status, text);
    process.exit(1);
  }

  const tokens = await response.json();

  if (tokens.errors) {
    console.error('Strava error:', JSON.stringify(tokens.errors));
    process.exit(1);
  }

  // Merge credentials into tokens file
  const saved = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
    athlete: tokens.athlete,
  };

  await writeFile(TOKENS_FILE, JSON.stringify(saved, null, 2));

  console.log('\n✓ Authentication successful!');
  console.log(`  Athlete: ${tokens.athlete?.firstname} ${tokens.athlete?.lastname}`);
  console.log(`  Tokens saved to: ${TOKENS_FILE}`);
  console.log('\nNext step: node coach-scripts/sync.mjs\n');
  process.exit(0);
}

console.error('Usage:');
console.error('  node coach-scripts/auth.mjs --client-id=ID --client-secret=SECRET');
console.error('  node coach-scripts/auth.mjs --code="http://localhost:8080/..."');
process.exit(1);
