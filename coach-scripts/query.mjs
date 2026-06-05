/**
 * coach-scripts/query.mjs
 * Run a SQL query against ~/.claude-coach/coach.db and print JSON results.
 * Usage: node coach-scripts/query.mjs "SELECT ..."
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = join(homedir(), '.claude-coach', 'coach.db');
const sql = process.argv[2];

if (!sql) {
  console.error('Usage: node coach-scripts/query.mjs "SELECT ..."');
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
const stmt = db.prepare(sql);
const rows = stmt.all();
console.log(JSON.stringify(rows, null, 2));
