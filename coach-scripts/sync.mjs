/**
 * coach-scripts/sync.mjs
 * Fetches Strava activities and stores them in ~/.claude-coach/coach.db
 * Usage: node coach-scripts/sync.mjs [--days=730]
 */
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CONFIG_DIR = process.env.COACH_DATA_DIR || join(homedir(), '.claude-coach');
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json');
const DB_FILE = join(CONFIG_DIR, 'coach.db');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const days = parseInt(args['days'] ?? '730', 10);

// Load tokens
let tokens;
try {
  tokens = JSON.parse(await readFile(TOKENS_FILE, 'utf8'));
} catch {
  console.error('ERROR: No tokens found. Run auth first: node coach-scripts/auth.mjs --client-id=ID --client-secret=SECRET');
  process.exit(1);
}

// Refresh token if expired
const now = Math.floor(Date.now() / 1000);
if (tokens.expiresAt && tokens.expiresAt < now + 60) {
  console.log('Refreshing access token...');
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: tokens.clientId,
      client_secret: tokens.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const refreshed = await r.json();
  tokens.accessToken = refreshed.access_token;
  tokens.refreshToken = refreshed.refresh_token;
  tokens.expiresAt = refreshed.expires_at;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log('Token refreshed.');
}

// Setup SQLite DB
await mkdir(CONFIG_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS athlete (
    id INTEGER PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    weight REAL,
    ftp INTEGER,
    max_heartrate INTEGER,
    sex TEXT,
    city TEXT,
    country TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    name TEXT,
    sport_type TEXT,
    type TEXT,
    start_date TEXT,
    start_date_local TEXT,
    moving_time INTEGER,
    elapsed_time INTEGER,
    distance REAL,
    total_elevation_gain REAL,
    average_speed REAL,
    max_speed REAL,
    average_heartrate REAL,
    max_heartrate REAL,
    average_watts REAL,
    weighted_average_watts REAL,
    max_watts REAL,
    suffer_score INTEGER,
    perceived_exertion REAL,
    average_cadence REAL,
    kilojoules REAL,
    calories REAL,
    trainer INTEGER DEFAULT 0,
    commute INTEGER DEFAULT 0,
    description TEXT,
    gear_id TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT,
    event_date TEXT,
    event_type TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_streams (
    activity_id INTEGER PRIMARY KEY,
    heartrate TEXT,
    time TEXT,
    distance TEXT,
    velocity_smooth TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );
`);

// Fetch athlete profile
console.log('Fetching athlete profile...');
const athleteRes = await fetch('https://www.strava.com/api/v3/athlete', {
  headers: { Authorization: `Bearer ${tokens.accessToken}` },
});
const athlete = await athleteRes.json();

const insertAthlete = db.prepare(`
  INSERT OR REPLACE INTO athlete (id, firstname, lastname, weight, sex, city, country)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insertAthlete.run(athlete.id, athlete.firstname ?? null, athlete.lastname ?? null, athlete.weight ?? null, athlete.sex ?? null, athlete.city ?? null, athlete.country ?? null);
console.log(`✓ Athlete: ${athlete.firstname} ${athlete.lastname}`);

// Fetch activities page by page
const afterTimestamp = Math.floor(Date.now() / 1000) - days * 86400;
let page = 1;
let totalFetched = 0;

const insertActivity = db.prepare(`
  INSERT OR REPLACE INTO activities (
    id, name, sport_type, type, start_date, start_date_local,
    moving_time, elapsed_time, distance, total_elevation_gain,
    average_speed, max_speed, average_heartrate, max_heartrate,
    average_watts, weighted_average_watts, max_watts,
    suffer_score, perceived_exertion, average_cadence,
    kilojoules, calories, trainer, commute, description, gear_id
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?
  )
`);

console.log(`Syncing activities from the last ${days} days...`);

while (true) {
  const url = `https://www.strava.com/api/v3/athlete/activities?after=${afterTimestamp}&page=${page}&per_page=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });

  if (!res.ok) {
    console.error('Error fetching activities:', res.status, await res.text());
    break;
  }

  const activities = await res.json();
  if (!Array.isArray(activities) || activities.length === 0) break;

  for (const a of activities) {
    insertActivity.run(
      a.id, a.name, a.sport_type, a.type, a.start_date, a.start_date_local,
      a.moving_time, a.elapsed_time, a.distance, a.total_elevation_gain,
      a.average_speed, a.max_speed, a.average_heartrate ?? null, a.max_heartrate ?? null,
      a.average_watts ?? null, a.weighted_average_watts ?? null, a.max_watts ?? null,
      a.suffer_score ?? null, a.perceived_exertion ?? null, a.average_cadence ?? null,
      a.kilojoules ?? null, a.calories ?? null,
      a.trainer ? 1 : 0, a.commute ? 1 : 0,
      a.description ?? null, a.gear_id ?? null
    );
  }

  totalFetched += activities.length;
  process.stdout.write(`\r  Fetched ${totalFetched} activities (page ${page})...`);
  page++;

  if (activities.length < 100) break;
}

console.log(`\n✓ Synced ${totalFetched} activities to ${DB_FILE}`);

// ── FETCH HR STREAMS for recent runs (last 30 days) ──────────
const streamDays = parseInt(args['stream-days'] ?? '30', 10);
const streamAfter = new Date();
streamAfter.setDate(streamAfter.getDate() - streamDays);
const streamAfterStr = streamAfter.toISOString().slice(0, 10);

const recentRuns = db.prepare(`
  SELECT id FROM activities
  WHERE sport_type IN ('Run','TrailRun','VirtualRun')
    AND substr(start_date,1,10) >= ?
  ORDER BY start_date DESC
`).all(streamAfterStr);

const insertStream = db.prepare(`
  INSERT OR REPLACE INTO activity_streams (activity_id, heartrate, time, distance, velocity_smooth)
  VALUES (?, ?, ?, ?, ?)
`);

const alreadySynced = new Set(
  db.prepare('SELECT activity_id FROM activity_streams').all().map(r => r.activity_id)
);

const toFetch = recentRuns.filter(r => !alreadySynced.has(r.id));

if (toFetch.length > 0) {
  console.log(`\nFetching HR streams for ${toFetch.length} recent run(s)...`);
  let streamCount = 0;
  for (const { id } of toFetch) {
    const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=heartrate,time,distance,velocity_smooth&key_by_type=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!res.ok) {
      console.warn(`  ✗ Stream fetch failed for activity ${id}: ${res.status}`);
      continue;
    }
    const streams = await res.json();
    insertStream.run(
      id,
      streams.heartrate   ? JSON.stringify(streams.heartrate.data)         : null,
      streams.time        ? JSON.stringify(streams.time.data)               : null,
      streams.distance    ? JSON.stringify(streams.distance.data)           : null,
      streams.velocity_smooth ? JSON.stringify(streams.velocity_smooth.data) : null,
    );
    streamCount++;
    process.stdout.write(`\r  Fetched ${streamCount}/${toFetch.length} streams...`);
    // Respect Strava rate limit: ~100 req/15min → small delay between calls
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n✓ HR streams synced`);
} else {
  console.log('✓ HR streams up to date');
}

console.log('\nNext step: node coach-scripts/query.mjs "SELECT * FROM activities LIMIT 5"\n');
