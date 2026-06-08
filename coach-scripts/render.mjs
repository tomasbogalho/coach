/**
 * render.mjs — renders half-marathon-sep-2026.json to an interactive HTML training plan
 * with Zepp / Garmin structured workout export
 */
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const plan = JSON.parse(await readFile('half-marathon-sep-2026.json', 'utf8'));
const todayStr = new Date().toISOString().slice(0, 10);

// ── QUERY STRAVA ACTIVITIES (current week + full plan history) ─
const DATA_DIR_PATH = process.env.COACH_DATA_DIR || join(homedir(), '.claude-coach');
const DB_FILE = join(DATA_DIR_PATH, 'coach.db');
let recentActivities = [];  // current week only (for week-0 panel)
let allPlanActivities = []; // all activities since plan start (for plan-day matching)
try {
  const db = new DatabaseSync(DB_FILE);
  // Current week = Mon–Sun of today's week
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun,1=Mon...
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const planStart = plan.meta.planStartDate;

  const actQuery = `
    SELECT substr(a.start_date,1,10) as date, a.name, a.type,
           ROUND(a.distance/1000.0, 2) as km, a.moving_time,
           a.average_heartrate, a.average_speed, a.max_heartrate,
           a.total_elevation_gain,
           s.heartrate as hr_stream, s.time as time_stream,
           s.distance as distance_stream, s.velocity_smooth as velocity_smooth_stream
    FROM activities a
    LEFT JOIN activity_streams s ON s.activity_id = a.id
    WHERE a.start_date >= ?
    ORDER BY a.start_date DESC`;

  recentActivities = db.prepare(actQuery).all(weekStart);
  allPlanActivities = db.prepare(actQuery).all(planStart);
  db.close();
} catch(e) { /* DB unavailable — skip Week 0 */ }

// Build a lookup: date → array of activities (for plan-day matching)
const activitiesByDate = {};
for (const a of allPlanActivities) {
  if (!activitiesByDate[a.date]) activitiesByDate[a.date] = [];
  activitiesByDate[a.date].push(a);
}

// ── WEEKLY ACTUAL KM + FITNESS TREND + INJURY RISK ──────────
let actualKmByWeek = {}; // weekStart → km
let fitnessTrend = [];   // [{week, avgPace, runs}]
let injuryRisk = null;   // warning string or null
try {
  const db2 = new DatabaseSync(DB_FILE);

  // 1. Actual km per plan week (only past + current weeks)
  for (const w of plan.weeks) {
    if (w.startDate > todayStr) break;
    const row = db2.prepare(`
      SELECT COALESCE(SUM(distance)/1000.0, 0) as km
      FROM activities
      WHERE type='Run' AND start_date >= '${w.startDate}' AND start_date <= '${w.endDate}T23:59:59'
    `).get();
    actualKmByWeek[w.startDate] = Math.round((row?.km || 0) * 10) / 10;
  }

  // 2. Z2 pace trend — weekly avg pace for easy runs (avg HR 135-149)
  const z2Rows = db2.prepare(`
    SELECT substr(start_date,1,10) as date,
           ROUND(1000.0 / average_speed) as pace_sec
    FROM activities
    WHERE type='Run' AND average_heartrate>=135 AND average_heartrate<150
      AND average_speed>0.3 AND distance>3000
      AND start_date >= date('now','-20 weeks')
    ORDER BY start_date
  `).all();
  const wkMap = new Map();
  for (const r of z2Rows) {
    const d = new Date(r.date), dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
    const key = mon.toISOString().slice(0, 10);
    if (!wkMap.has(key)) wkMap.set(key, []);
    wkMap.get(key).push(r.pace_sec);
  }
  fitnessTrend = [...wkMap.entries()]
    .map(([week, paces]) => ({ week, avgPace: Math.round(paces.reduce((a, b) => a + b, 0) / paces.length), runs: paces.length }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // 3. Injury risk: consecutive hard runs (avg HR ≥155) in last 14 days
  const hardRuns = db2.prepare(`
    SELECT average_heartrate FROM activities
    WHERE type='Run' AND distance>3000 AND start_date>=date('now','-14 days')
    ORDER BY start_date
  `).all();
  let streak = 0, maxStreak = 0;
  for (const r of hardRuns) {
    if ((r.average_heartrate || 0) >= 155) streak++; else streak = 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  if (maxStreak >= 3) injuryRisk = `⚠️ ${maxStreak} consecutive hard runs (avg HR ≥155 bpm) detected in the last 2 weeks — insert an easy day now`;
  else if (maxStreak === 2) injuryRisk = `💛 2 back-to-back hard efforts recently — consider making your next run an easy Z2 day`;

  db2.close();
} catch(e) { /* ignore */ }

// ── RACE TIME PREDICTOR ──────────────────────────────────────
// Uses Riegel formula: T2 = T1 × (D2/D1)^1.06
// Uses best recent effort (last 90 days) at race-ish distances (5–22km)
let racePrediction = null;
let baselinePrediction = null; // earliest prediction (pre-plan or plan start)
try {
  const db3 = new DatabaseSync(DB_FILE);
  const goalDistM = 21097;
  const goalDistKm = goalDistM / 1000;
  const goalSec = (1 * 3600) + (40 * 60); // 1:40:00

  function riegelPredict(rows) {
    let best = null;
    for (const r of rows) {
      if (r.distance < 4000) continue;
      const predicted = r.moving_time * Math.pow(goalDistM / r.distance, 1.06);
      if (!best || predicted < best.predicted) best = { ...r, predicted: Math.round(predicted) };
    }
    if (!best) return null;
    const hrs = Math.floor(best.predicted / 3600);
    const mins = Math.floor((best.predicted % 3600) / 60);
    const secs = best.predicted % 60;
    const timeStr = `${hrs}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    const paceSec = Math.round(best.predicted / goalDistKm);
    const paceStr = `${Math.floor(paceSec/60)}:${String(paceSec%60).padStart(2,'0')}/km`;
    const gapSec = best.predicted - goalSec;
    const srcDistKm = Math.round(best.distance / 100) / 10;
    const srcPaceSec = Math.round(1000 / best.average_speed);
    const srcPaceStr = `${Math.floor(srcPaceSec/60)}:${String(srcPaceSec%60).padStart(2,'0')}/km`;
    return { timeStr, paceStr, gapSec, srcDistKm, srcPaceStr, srcDate: best.date, onTrack: gapSec <= 0, predicted: best.predicted };
  }

  // Current prediction — best effort last 90 days
  const recentRuns = db3.prepare(`
    SELECT distance, moving_time, average_heartrate, average_speed,
           substr(start_date,1,10) as date
    FROM activities
    WHERE type='Run' AND distance>=4000 AND average_speed>0
      AND start_date>=date('now','-90 days')
    ORDER BY average_speed DESC LIMIT 20
  `).all();
  racePrediction = riegelPredict(recentRuns);

  // Baseline prediction — best effort in the 90 days BEFORE plan start
  const planStart = plan.meta.planStartDate;
  const baselineRuns = db3.prepare(`
    SELECT distance, moving_time, average_heartrate, average_speed,
           substr(start_date,1,10) as date
    FROM activities
    WHERE type='Run' AND distance>=4000 AND average_speed>0
      AND start_date < '${planStart}'
      AND start_date >= date('${planStart}','-90 days')
    ORDER BY average_speed DESC LIMIT 20
  `).all();
  baselinePrediction = riegelPredict(baselineRuns);

  db3.close();
} catch(e) { /* ignore */ }

// ── PLAN PROGRESS STATS ──────────────────────────────────────
const planStartDate = plan.meta.planStartDate;
const totalPlanWeeks = plan.weeks.length;
const weeksCompleted = plan.weeks.filter(w => w.endDate < todayStr).length;
const plannedKmToDate = plan.weeks
  .filter(w => w.endDate < todayStr)
  .reduce((s, w) => s + (w.summary?.totalKm || 0), 0);
const actualKmToDate = Object.values(actualKmByWeek).reduce((s, v) => s + v, 0);

// ── ZONE TIME FROM HR STREAM ────────────────────────────────
function zoneTimesFromStream(hrStream, timeStream) {
  if (!hrStream || !timeStream) return null;
  const hrs = JSON.parse(hrStream);
  const times = JSON.parse(timeStream);
  const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    const hr = hrs[i];
    if (!hr) continue;
    if (hr < 135)      zones.z1 += dt;
    else if (hr < 150) zones.z2 += dt;
    else if (hr < 156) zones.z3 += dt;
    else if (hr < 167) zones.z4 += dt;
    else               zones.z5 += dt;
  }
  return zones;
}

function fmtMin(secs) {
  const m = Math.round(secs / 60);
  return m === 0 ? null : `${m}m`;
}

// ── STREAM HELPERS ────────────────────────────────────────────
function downsample(arr, maxPts) {
  if (!arr || arr.length <= maxPts) return arr;
  const step = arr.length / maxPts;
  const out = [];
  for (let i = 0; i < maxPts; i++) {
    const s = Math.floor(i * step), e = Math.floor((i + 1) * step);
    let sum = 0, cnt = 0;
    for (let j = s; j < e; j++) { if (arr[j] != null) { sum += arr[j]; cnt++; } }
    out.push(cnt ? sum / cnt : null);
  }
  return out;
}

// Returns downsampled {hr, pace, dist} for chart rendering (300 pts)
function buildChartData(a) {
  if (!a.hr_stream || !a.time_stream) return null;
  try {
    const hrs = JSON.parse(a.hr_stream);
    const dists = a.distance_stream ? JSON.parse(a.distance_stream) : null;
    const vels = a.velocity_smooth_stream ? JSON.parse(a.velocity_smooth_stream) : null;
    const paces = vels ? vels.map(v => (v != null && v > 0.3) ? Math.round(1000 / v) : null) : null;
    const distKm = dists ? dists.map(d => Math.round(d / 10) / 100) : null;
    const N = 300;

    // Per-km splits from raw streams
    const kmSplits = [];
    if (dists && vels && hrs) {
      let kmTarget = 1;
      let bucketPace = [], bucketHr = [], bucketStart = 0;
      for (let i = 1; i < dists.length; i++) {
        const d = dists[i];
        if (d == null) continue;
        const v = vels[i], hr = hrs[i];
        if (v != null && v > 0.3) bucketPace.push(Math.round(1000 / v));
        if (hr != null && hr > 40) bucketHr.push(hr);
        if (d >= kmTarget * 1000) {
          const avgPaceSec = bucketPace.length ? Math.round(bucketPace.reduce((a,b)=>a+b,0)/bucketPace.length) : null;
          const avgHrVal = bucketHr.length ? Math.round(bucketHr.reduce((a,b)=>a+b,0)/bucketHr.length) : null;
          kmSplits.push({ km: kmTarget, pace: avgPaceSec, hr: avgHrVal });
          bucketPace = []; bucketHr = [];
          kmTarget++;
        }
      }
    }

    return {
      hr: downsample(hrs, N).map(v => v != null ? Math.round(v) : null),
      pace: paces ? downsample(paces, N).map(v => v != null ? Math.round(v) : null) : null,
      dist: distKm ? downsample(distKm, N).map(v => v != null ? Math.round(v * 100) / 100 : null) : null,
      kmSplits,
    };
  } catch(e) { return null; }
}

// Returns {hrDrift, paceDriftSec} from stream data
function analyzeStreamData(a) {
  if (!a.hr_stream || !a.time_stream) return {};
  try {
    const hrs = JSON.parse(a.hr_stream);
    const vels = a.velocity_smooth_stream ? JSON.parse(a.velocity_smooth_stream) : null;
    const n = hrs.length;
    if (n < 30) return {};
    const third = Math.floor(n / 3);
    const avgArr = arr => { const v = arr.filter(x => x != null && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    const hrFirst = avgArr(hrs.slice(0, third));
    const hrLast = avgArr(hrs.slice(n - third));
    const hrDrift = hrFirst > 0 ? Math.round(hrLast - hrFirst) : undefined;
    let paceDriftSec = undefined;
    if (vels) {
      const velFirst = avgArr(vels.slice(0, third).filter(v => v > 0.3));
      const velLast = avgArr(vels.slice(n - third).filter(v => v > 0.3));
      if (velFirst > 0 && velLast > 0) {
        paceDriftSec = Math.round(1000 / velLast - 1000 / velFirst); // positive = slowing
      }
    }
    return { hrDrift, paceDriftSec };
  } catch(e) { return {}; }
}

// ── COACH FEEDBACK GENERATOR ────────────────────────────────
function coachFeedback(a) {
  if (a.type === 'Ride') return `🚴 Recovery spin — HR ${a.average_heartrate ? Math.round(a.average_heartrate) + ' bpm' : 'not recorded'}. Good active recovery between run sessions. Cycling at low intensity promotes blood flow without adding run-specific fatigue.`;
  if (a.km < 1) return `Short movement check — ${a.km}km. More of a warm-up than a workout. Counts as a movement day; add 15 min next time for a meaningful aerobic stimulus.`;

  const paceSecKm = a.average_speed > 0 ? Math.round(1000 / a.average_speed) : null;
  const paceStr = paceSecKm ? `${Math.floor(paceSecKm/60)}:${String(paceSecKm%60).padStart(2,'0')}/km` : null;
  const hr = a.average_heartrate ? Math.round(a.average_heartrate) : null;
  const maxHr = a.max_heartrate ? Math.round(a.max_heartrate) : null;
  const durMin = a.moving_time ? Math.round(a.moving_time / 60) : null;

  let zone = 'unknown zone';
  let zoneNum = 0;
  if (hr) {
    if (hr < 135)      { zone = 'Z1 (recovery)';    zoneNum = 1; }
    else if (hr < 150) { zone = 'Z2 (aerobic)';     zoneNum = 2; }
    else if (hr < 156) { zone = 'Z3 (tempo)';       zoneNum = 3; }
    else if (hr < 167) { zone = 'Z4 (threshold)';   zoneNum = 4; }
    else               { zone = 'Z5 (VO₂max)';      zoneNum = 5; }
  }

  // Summary line
  const parts = [];
  if (paceStr && a.km >= 1) parts.push(`${a.km}km at ${paceStr}`);
  if (durMin) parts.push(`${durMin}min`);
  if (hr) parts.push(`avg HR ${hr} bpm (${zone})`);
  if (maxHr) parts.push(`peak ${maxHr} bpm`);
  if (a.total_elevation_gain > 20) parts.push(`↑${Math.round(a.total_elevation_gain)}m`);
  const summary = parts.join(' · ');

  // Zone time breakdown from HR stream
  const zoneTimes = zoneTimesFromStream(a.hr_stream, a.time_stream);
  let zoneBreakdown = '';
  if (zoneTimes) {
    const pieces = [
      zoneTimes.z1 > 60 ? `Z1 ${fmtMin(zoneTimes.z1)}` : null,
      zoneTimes.z2 > 60 ? `Z2 ${fmtMin(zoneTimes.z2)}` : null,
      zoneTimes.z3 > 60 ? `Z3 ${fmtMin(zoneTimes.z3)}` : null,
      zoneTimes.z4 > 60 ? `Z4 ${fmtMin(zoneTimes.z4)}` : null,
      zoneTimes.z5 > 60 ? `Z5 ${fmtMin(zoneTimes.z5)}` : null,
    ].filter(Boolean);
    if (pieces.length) zoneBreakdown = `\n⏱ Time in zones: ${pieces.join(' · ')}`;
  }

  // Stream-based analysis: HR drift + pace consistency
  const { hrDrift, paceDriftSec } = analyzeStreamData(a);
  const analysisBits = [];
  if (hrDrift !== undefined) {
    if (hrDrift > 12) analysisBits.push(`📈 HR drifted +${hrDrift} bpm first→last third. Significant cardiac drift — could be heat, dehydration, or accumulated fatigue. If this repeats, prioritise sleep and hydration before your next run.`);
    else if (hrDrift > 6) analysisBits.push(`📈 HR drifted +${hrDrift} bpm through the run. Normal aerobic drift — your heart worked slightly harder to maintain pace as you fatigued. Aerobic fitness building.`);
    else if (hrDrift >= 0 && hrDrift <= 6) analysisBits.push(`💚 HR stayed steady (${hrDrift > 0 ? '+' : ''}${hrDrift} bpm drift) — excellent cardiovascular control.`);
    else if (hrDrift < -5) analysisBits.push(`📉 HR dropped ${Math.abs(hrDrift)} bpm through the run. You either started too hard and settled, or ran a strong negative split. Check your first km — if it was faster than planned, aim to start more conservatively next time.`);
  }
  if (paceDriftSec !== undefined) {
    if (paceDriftSec > 25) analysisBits.push(`⚠️ Pace faded ~${paceDriftSec}s/km in the final third. This is a pacing/fuelling signal: either you started ${Math.round(paceDriftSec * 0.6)}–${paceDriftSec}s/km too fast, or you under-fuelled. Next run: start 10 sec/km easier than you think you need to.`);
    else if (paceDriftSec > 10) analysisBits.push(`📉 Pace softened ~${paceDriftSec}s/km toward the end — slight fade, normal for longer efforts. Aim for more even splits or negative splits by starting more conservatively.`);
    else if (paceDriftSec < -15) analysisBits.push(`💪 Negative split: you ran the last third ~${Math.abs(paceDriftSec)}s/km faster than the first. This is excellent pacing discipline — it means you had more to give and you used it strategically.`);
    else analysisBits.push(`✓ Very consistent pace from start to finish — strong pacing discipline.`);
  }
  const analysisLine = analysisBits.length ? '\n' + analysisBits.join('\n') : '';

  // ── WHAT YOU DID WELL ──
  const wells = [];
  const z2Ideal = paceSecKm && paceSecKm >= 350 && paceSecKm <= 375;
  const z2HrIdeal = hr && hr >= 135 && hr < 150;
  if (z2HrIdeal && z2Ideal) wells.push(`Perfect Z2 execution: HR ${hr} bpm at ${paceStr} — exactly what easy running should look like. This is the bread-and-butter of half marathon base building.`);
  else if (z2HrIdeal) wells.push(`HR locked in Z2 (${hr} bpm) — your heart worked at the right intensity for aerobic adaptation.`);
  if (a.km >= 16) wells.push(`${a.km}km long run — this is meaningful long-run volume that builds the endurance base you need for the final 7km of a half marathon.`);
  else if (a.km >= 10) wells.push(`${a.km}km is solid mileage that accumulates the aerobic work your body needs.`);
  if (a.total_elevation_gain > 80) wells.push(`${Math.round(a.total_elevation_gain)}m of climbing builds leg strength and improves running economy — especially valuable for flat race-day performance.`);
  else if (a.total_elevation_gain > 30) wells.push(`${Math.round(a.total_elevation_gain)}m of elevation adds strength training you can't replicate on flat roads.`);
  if (hr && hr >= 150 && hr < 156 && paceSecKm && paceSecKm < 330) wells.push(`Solid tempo-zone effort at ${paceStr} — this is the kind of lactate-threshold work that directly translates to faster race pace.`);
  if (maxHr && hr && (maxHr - hr) < 15 && zoneNum >= 3) wells.push(`Small avg→max HR gap (${maxHr - hr} bpm) — you maintained even effort without spiking. Quality controlled hard effort.`);
  if (durMin && durMin >= 70) wells.push(`${durMin} minutes of running — time on feet counts. Your aerobic system was stimulated for a meaningful duration.`);
  if (paceDriftSec !== undefined && Math.abs(paceDriftSec) < 10) wells.push(`Excellent pacing consistency — less than 10 sec/km variation start to finish. This pacing control will serve you well on race day.`);

  // ── WHAT TO IMPROVE ──
  const improves = [];
  // Easy run too fast
  if (z2HrIdeal && paceSecKm && paceSecKm < 345) improves.push(`Your easy-run pace (${paceStr}) was faster than the Z2 target of 5:50–6:15/km. Even though HR was in range, slowing 10–15 sec/km would lower physiological cost and let you absorb more aerobic benefit. Save the speed for quality sessions.`);
  // Z1 run with decent pace — too fast for recovery
  if (hr && hr < 135 && paceSecKm && paceSecKm < 390) improves.push(`Z1 HR is great for a recovery run, but ${paceStr} is faster than recovery pace needs to be (>6:30/km). Slowing down further would reduce muscular stress and maximise recovery.`);
  // High HR unintentionally
  if (zoneNum >= 4 && a.km > 5 && !(a.name.toLowerCase().includes('tempo') || a.name.toLowerCase().includes('interval') || a.name.toLowerCase().includes('speed') || a.name.toLowerCase().includes('quality'))) {
    improves.push(`Average HR ${hr} bpm put this in Z${zoneNum} — which is hard territory. If this was supposed to be an easy run, it accumulated more fatigue than intended. Next time, start significantly slower and let HR settle before adding pace.`);
  }
  // Large avg→max HR spread on easy run
  if (maxHr && hr && (maxHr - hr) > 30 && zoneNum <= 2) improves.push(`${maxHr - hr} bpm gap between avg and peak HR suggests at least one significant surge or hill. Aim for more even HR on easy days — surges spike fatigue disproportionately.`);
  // Pace fade
  if (paceDriftSec !== undefined && paceDriftSec > 20) improves.push(`The ${paceDriftSec}s/km pace fade in the final third tells you this run was right at the edge of your current capacity. Fix: start your next run of this type ${Math.round(paceDriftSec * 0.5)}–${paceDriftSec}s/km slower and aim to finish faster than you started.`);
  // Short run — general note
  if (a.km < 5 && a.km >= 1) improves.push(`${a.km}km is short for meaningful adaptation. Aim for 6–8km minimum on easy days to get enough aerobic stimulus.`);

  const wellText    = wells.length    ? '✅ ' + wells.join('\n✅ ') : '';
  const improveText = improves.length ? '💡 ' + improves.join('\n💡 ') : '';

  return [summary + zoneBreakdown + analysisLine, wellText, improveText].filter(Boolean).join('\n');
}

// ── WEEK 0 HTML ──────────────────────────────────────────────
function activityTypeIcon(type) {
  if (type === 'Ride') return '🚴';
  if (type === 'Hike') return '🥾';
  if (type === 'WeightTraining' || type === 'Crossfit') return '💪';
  if (type === 'Yoga') return '🧘';
  return '🏃';
}

function week0Html() {
  if (!recentActivities.length) return '';
  const runs = recentActivities.filter(a => a.type === 'Run' || a.type === 'Ride');
  const totalRunKm = recentActivities.filter(a => a.type === 'Run').reduce((s, a) => s + (a.km || 0), 0);

  // Build chart data map (keyed by activity slug)
  const streamsMap = {};
  const actIdFor = a => `act_${(a.date || '').replace(/-/g, '')}_${Math.round((a.km || 0) * 100)}`;

  const cards = recentActivities.map(a => {
    if (a.km < 0.5 && a.type === 'Run') return ''; // skip micro-runs
    const paceSecKm = a.average_speed > 0 ? Math.round(1000 / a.average_speed) : null;
    const paceStr = (paceSecKm && a.type === 'Run') ? `${Math.floor(paceSecKm/60)}:${String(paceSecKm%60).padStart(2,'0')}/km` : null;
    const feedback = coachFeedback(a);
    const feedbackLines = feedback.split('\n').filter(Boolean);
    const icon = activityTypeIcon(a.type);
    const dateLabel = new Date(a.date).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
    const distLabel = a.km >= 0.5 ? `${a.km}km` : '';
    const durMin = a.moving_time ? Math.round(a.moving_time / 60) : null;
    const detail = [distLabel, durMin ? durMin + 'min' : null, paceStr].filter(Boolean).join(' · ');
    const actId = actIdFor(a);
    const chartData = buildChartData(a);
    if (chartData) streamsMap[actId] = chartData;
    const chartBtn = chartData ? `<button class="chart-btn" onclick="showRunChart('${actId}')">📈 Run Analysis</button>` : '';
    return `
      <div class="actual-activity">
        <div class="actual-header">
          <span class="actual-icon">${icon}</span>
          <div class="actual-info">
            <div class="actual-name">${a.name}</div>
            <div class="actual-detail">${dateLabel}${detail ? ' · ' + detail : ''}</div>
          </div>
          ${a.average_heartrate ? `<span class="actual-hr">❤️ ${Math.round(a.average_heartrate)}</span>` : ''}
        </div>
        <div class="actual-feedback">
          ${feedbackLines.map((l,i) => `<div class="feedback-line${i===0?' feedback-summary':''}">${l}</div>`).join('')}
        </div>
        ${chartBtn}
      </div>`;
  }).join('');

  const today2 = new Date();
  const dow = today2.getDay();
  const weekDate = new Date(today2); weekDate.setDate(today2.getDate() - ((dow + 6) % 7)); // Monday
  const weekEnd  = new Date(weekDate); weekEnd.setDate(weekDate.getDate() + 6); // Sunday
  const fmt = d => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });

  return `
  <script>window.ACTIVITY_STREAMS = ${JSON.stringify(streamsMap)};<\/script>
  <section class="week-section week-zero">
    <div class="week-header">
      <div class="week-title">
        <span class="week-num">Week 0</span>
        <span class="week-dates">${fmt(weekDate)} – ${fmt(weekEnd)}</span>
        <span class="week0-badge">Pre-Plan · Current Week</span>
      </div>
      <div class="week-meta">
        <span class="phase-badge" style="background:#6b7280">Assessment</span>
        <span class="week-stat">🏃 ${totalRunKm.toFixed(1)}km run this week</span>
      </div>
      <div class="week-focus">Your actual Strava activities this week — auto-analysed against your training zones</div>
    </div>
    <div class="week0-grid">${cards}</div>
  </section>`;
}

const sportColors = {
  run: { easy: '#3b82f6', aerobic: '#2563eb', long: '#7c3aed', tempo: '#f97316', intervals: '#ef4444', strides: '#06b6d4', race: '#f59e0b', recovery: '#10b981' },
  strength: '#84cc16',
  rest: '#e5e7eb',
};

// ── WORKOUT FOCUS/RATIONALE ──────────────────────────────────
function workoutFocus(w) {
  const t = w.type;
  if (t === 'easy' || t === 'aerobic') return {
    why: 'Easy runs build mitochondrial density and your aerobic engine — the foundation of a faster half marathon. Research consistently shows that 80%+ of mileage at genuinely easy effort produces the biggest long-term fitness gains.',
    focus: `Keep HR in Z2 (135–149 bpm) for the entire run. If HR climbs above 149, slow down or walk — even if it feels embarrassingly slow. Target ${w.targetPace || '5:50–6:15/km'}. You should be able to hold a full conversation. This is not a jog — it's precise stimulus.`,
  };
  if (t === 'long') return {
    why: 'Long runs train fat metabolism, glycogen efficiency, and the connective tissue resilience you need for 21km. They also build the mental toughness that makes the final 5km of a half marathon manageable rather than a survival exercise.',
    focus: `First ${w.distanceKm ? Math.round(w.distanceKm * 0.7) + 'km' : '70%'} in Z2 (HR 135–149 bpm). Only push the final portion if you feel genuinely strong and HR has stayed controlled. Eat/drink every 30–40 min to practise race-day fuelling. Do NOT race this run — fatigue from a too-hard long run can wreck the following week.`,
  };
  if (t === 'tempo') return {
    why: 'Tempo running lifts your lactate threshold — the fastest pace your body can sustain while clearing lactate. Every session here directly raises the ceiling of what you can hold on September 20.',
    focus: `Comfortably hard — target ${w.targetPace || '5:00–5:20/km'}, HR settling in Z3–Z4 (150–166 bpm). You can speak 3–4 words, not full sentences. Start the first km 10 sec/km slower than target, then lock in. A tempo that feels impossible in the first 2 minutes is usually paced correctly.`,
  };
  if (t === 'intervals') return {
    why: 'Intervals push your VO₂max — the aerobic ceiling. A higher VO₂max means race pace demands a smaller percentage of your maximum capacity, making 4:44/km feel less hard as training progresses.',
    focus: `Hit the target pace ${w.targetPace ? '(' + w.targetPace + ')' : ''} on every single rep — not faster. Going 5 sec/km too fast on rep 1 costs you reps 5–8. Recovery between reps is as important as the effort: take the full rest. Stop a rep if form breaks down, not just if pace drops.`,
  };
  if (t === 'strides') return {
    why: 'Strides activate fast-twitch fibres and improve running economy (how efficiently you use each stride). They sharpen neuromuscular coordination without accumulating significant fatigue — the best return on 6 minutes of work.',
    focus: 'Smooth acceleration over 15–20 seconds to ~90% effort, then gradually decelerate. These are NOT sprints — think controlled, effortless speed with tall posture. Full 90-second walk/jog recovery between each. Focus on feeling fast, not going fast.',
  };
  if (t === 'recovery') return {
    why: 'Recovery runs flush metabolic waste products, maintain run habit frequency, and allow your body to absorb the training stimulus from harder sessions — but only if kept genuinely easy. Run too hard here and you delay the adaptation you worked for yesterday.',
    focus: 'HR must stay in Z1 (<135 bpm). Walk hills without hesitation. The slower you go, the better this run does its job. There is no such thing as "too slow" on a recovery run.',
  };
  if (t === 'race') return {
    why: 'Race-pace practice trains both physiological and psychological readiness for 4:44/km. Your cardiovascular system, muscles, and brain need rehearsal at the exact race effort so September 20 feels familiar instead of shocking.',
    focus: 'Lock in 4:44/km — do not go faster. Use a GPS watch or pace band. By km 3 your HR should settle at 160–167 bpm. If it feels easy in the first half, trust the plan — the second half of every race never feels easy.',
  };
  return {
    why: 'This session builds a specific fitness quality for your sub-1:40 goal.',
    focus: w.targetPace ? `Target: ${w.targetPace}.${w.targetHR ? ' Heart rate: ' + w.targetHR + '.' : ''} Follow the structure below.` : 'Follow the structured description below.',
  };
}

function sportColor(workout) {
  if (workout.sport === 'strength') return '#84cc16';
  if (workout.sport === 'rest') return '#d1d5db';
  return sportColors.run[workout.type] || '#3b82f6';
}

function sportIcon(workout) {
  if (workout.sport === 'rest') return '😴';
  if (workout.sport === 'strength') return '💪';
  if (workout.type === 'race') return '🏁';
  if (workout.type === 'long') return '🏃';
  if (workout.type === 'tempo') return '⚡';
  if (workout.type === 'intervals') return '🔥';
  if (workout.type === 'strides') return '💨';
  return '🏃';
}

function phaseBadgeColor(phase) {
  if (phase === 'Recovery') return '#6b7280';
  if (phase === 'Base') return '#10b981';
  if (phase === 'Build') return '#f97316';
  if (phase === 'Taper') return '#8b5cf6';
  return '#3b82f6';
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function escJson(obj) {
  return JSON.stringify(obj).replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&apos;');
}

// ── STRENGTH WORKOUT PRESCRIPTIONS (Hyrox / CrossFit gym) ────
function strengthWorkout(w) {
  const match = w.id.match(/^w(\d+)-(\w+)-str/);
  if (!match) return null;
  const weekNum = parseInt(match[1]);
  const day = match[2]; // mon | wed | fri | sat
  const weekData = plan.weeks.find(wk => wk.weekNumber === weekNum);
  const phase = weekData?.phase || 'Base';
  const isTaper  = phase === 'Taper';
  const isBuild  = phase === 'Build';
  const isRecov  = phase === 'Recovery';

  // ── TRAVEL OVERRIDE: w2 Mon (Jun 8) + Wed (Jun 10) — KB only ─────────────
  if (weekNum === 2 && day === 'mon') return {
    label: '🧳 Session A — KB Only (Travelling)',
    duration: '25 min',
    exercises: [
      'KB Halo — 3×8 each direction  (shoulder + thoracic mobility)',
      'Single-Arm KB Farmer Carry — 3×20 m each side  (lateral core, posture)',
      'KB Bent-Over Row — 3×10 each arm  (upper back)',
      'KB Glute Bridge — 3×15  (hip activation)',
      'Dead Bug — 3×10 each side',
      'Couch Stretch — 2×60 s each leg',
    ],
    note: 'Travelling this week — KB only. Day after long run so keep it light. Upper body + core only, no leg loading.',
  };
  if (weekNum === 2 && day === 'wed') return {
    label: '🧳 Session B — KB Only (Travelling)',
    duration: '35 min',
    exercises: [
      'KB Deadlift — 4×10  (hip hinge pattern, posterior chain)',
      'KB Goblet Squat — 4×12  (quad + glute base)',
      'KB Swing — 4×20  (hip drive power)',
      'KB Walking Lunge — 3×10 each leg',
      'Copenhagen Plank — 3×25 s each side',
      'KB Suitcase Carry — 3×20 m each side  (lateral core)',
      'Weighted Calf Raise — 3×15',
    ],
    note: 'Travelling — KB only version of the Wednesday power session. Focus on hip hinge quality and swing power. Increase KB weight if the goblet squat feels easy.',
  };

  // ── SESSION A — MONDAY: Upper body + core (post long run, no leg loading) ──
  if (day === 'mon') {
    if (isBuild) return {
      label: '💪 Session A — Upper & Core (Build)',
      duration: '30–35 min',
      exercises: [
        'Pull-Up or Ring Row — 4×6–8  (scapular strength, posture under fatigue)',
        'DB/KB Bench Press or Push-Up w/ weight vest — 3×12  (horizontal push)',
        'Single-Arm DB Row — 4×10 each side  (heavy — lat activation)',
        'Farmers Carry — 4×30 m @ heavy  (grip + lateral core + posture)',
        'Pallof Press — 3×12 each side  (anti-rotation, protects the spine at race pace)',
        'Dead Bug — 3×10 each side',
        'Hip 90/90 stretch — 2 min each side  (hip flexor mobility)',
      ],
      note: 'Day after long run. Upper body and core only — no squats, lunges, or anything that loads the legs. If you\'re sore from Sunday, reduce sets by 1 across the board.',
    };
    return {
      label: '💪 Session A — Upper & Core (Base)',
      duration: '25–30 min',
      exercises: [
        'Ring Row or Banded Pull-Down — 3×10  (horizontal pull, scapular control)',
        'DB Shoulder Press — 3×10  (overhead stability)',
        'KB Bent-Over Row — 3×10 each arm',
        'Farmers Carry — 3×20 m each side  (lateral core + posture)',
        'Dead Bug — 3×8 each side',
        'Couch Stretch — 2×60 s each leg  (hip flexor recovery)',
      ],
      note: 'Day after long run. Light loads, full ROM, 60 s rest. This is recovery + maintenance, not a hard session.',
    };
  }

  // ── SESSION B — WEDNESDAY: Hyrox Power (main strength session of the week) ──
  if (day === 'wed') {
    if (isTaper) return {
      label: '💪 Session B — Hyrox Maintenance (Taper)',
      duration: '20–25 min',
      exercises: [
        'Sled Push — 2×20 m @ light  (movement quality only)',
        'DB Romanian Deadlift — 2×8  (posterior chain activation)',
        'Wall Ball — 2×10 @ light  (movement pattern)',
        'Copenhagen Plank — 2×20 s each side',
        'Calf Raise — 2×15',
      ],
      note: 'Taper week — 2 sets max on everything. Move well, not heavy. No DOMS allowed this close to race day.',
    };
    if (isBuild) return {
      label: '💪 Session B — Hyrox Power (Build)',
      duration: '50–55 min',
      exercises: [
        'Sled Push — 5×20 m @ heavy (rest 90 s)  (race-specific leg drive — go heavier each week)',
        'Barbell or DB Romanian Deadlift — 4×6 @ heavy  (posterior chain, hamstrings/glutes)',
        'Sandbag/DB Lunge — 4×10 each leg  (race station + single-leg strength)',
        'Wall Ball — 4×20 @ 9 kg  (squat + throw, quad endurance)',
        'Barbell Hip Thrust — 3×12  (glute max power)',
        'Copenhagen Plank — 3×40 s each side',
        'Weighted Calf Raise off step — 3×20  (Achilles resilience for high mileage)',
      ],
      note: 'This is your main Hyrox power session. 2–3 min rest between sled sets, 90 s everywhere else. Progressive overload: add 5kg to sled every 2 weeks. Stop a set if form breaks, never if just hard.',
    };
    if (isRecov) return {
      label: '💪 Session B — Hyrox Power (Recovery Week)',
      duration: '35–40 min',
      exercises: [
        'Sled Push — 3×20 m @ moderate  (technique focus)',
        'DB Romanian Deadlift — 3×10 @ moderate',
        'Goblet Squat — 3×12',
        'Wall Ball — 3×15 @ 9 kg',
        'Copenhagen Plank — 2×25 s each side',
        'Calf Raise — 3×15',
      ],
      note: 'Recovery week — 70% of normal load. Focus on movement quality over weight.',
    };
    return {
      label: '💪 Session B — Hyrox Power (Base)',
      duration: '45–50 min',
      exercises: [
        'Sled Push — 4×20 m @ moderate (build up to heavy over base phase)  (race-specific)',
        'DB Romanian Deadlift — 4×10  (posterior chain foundation)',
        'Goblet Squat — 3×12  (quad + hip stability)',
        'DB/KB Walking Lunge — 3×10 each leg',
        'Wall Ball — 3×15 @ 9 kg  (learn the standard: full squat, ball to 10 ft target)',
        'Copenhagen Plank — 3×25 s each side',
        'Calf Raise off step — 3×15',
      ],
      note: 'Learn the Hyrox movements at moderate load before going heavy in Build phase. Sled push is the most race-specific exercise here — prioritise it when fresh.',
    };
  }

  // ── SESSION C — FRIDAY: Hyrox Conditioning (cardio-functional, no heavy legs) ──
  if (day === 'fri') {
    if (isTaper) return {
      label: '💪 Session C — Light Conditioning (Taper)',
      duration: '20 min',
      exercises: [
        'SkiErg — 3×250 m @ easy pace (no sprinting)',
        'Farmers Carry — 3×20 m @ light',
        'Ring Row — 2×8',
        'Hip flexor + hamstring mobility — 5 min',
      ],
      note: 'Taper. Easy movement only — purpose is to stay loose and feel athletic without adding fatigue.',
    };
    if (isBuild) return {
      label: '💪 Session C — Hyrox Conditioning (Build)',
      duration: '45–50 min',
      exercises: [
        'SkiErg — 4×500 m @ hard (rest 90 s) — target sub-2:00/500m  (Hyrox station 1)',
        'Row — 4×500 m @ hard (rest 90 s)  (Hyrox station 4)',
        'Burpee Broad Jump — 3×10 reps  (Hyrox station 3 — technique: jump forward, not up)',
        'Farmers Carry — 4×30 m @ Hyrox weight (24 kg/hand M, 16 kg/hand F)  (station 6)',
        'Pull-Up or Ring Row — 3×8–10  (upper body pulling strength)',
        'Box Step-Up — 3×10 each leg @ light  (running posture carryover)',
      ],
      note: 'This session trains 4 of the 8 Hyrox stations. Push the SkiErg and row intervals hard — they\'re the biggest fitness drivers for Hyrox. Track your 500m times and aim to improve each week.',
    };
    return {
      label: '💪 Session C — Hyrox Conditioning (Base)',
      duration: '40–45 min',
      exercises: [
        'SkiErg — 4×250 m @ moderate–hard pace  (learn the movement: hinge, not row)',
        'Row — 3×500 m @ moderate  (damper 4–5, drive with legs first)',
        'Burpee Broad Jump — 3×8 reps  (learn technique at manageable volume)',
        'Farmers Carry — 3×20 m each side @ moderate  (build grip + lateral core)',
        'DB Bent-Over Row — 3×10 each arm',
      ],
      note: 'Base phase: learn the SkiErg and row at moderate effort. Focus on form before intensity. SkiErg: hinge at the hips, don\'t just pull with arms. Row: legs → lean → arms on the drive.',
    };
  }

  // ── SESSION D — SATURDAY: Hyrox Skill/Sim (moderate, legs available for Sunday) ──
  if (day === 'sat') {
    if (isBuild) return {
      label: '💪 Session D — Hyrox Simulation (Build)',
      duration: '35–40 min',
      exercises: [
        'Mini-Hyrox Circuit × 3 rounds (2 min rest between):',
        '  → SkiErg 250 m',
        '  → Burpee Broad Jump 5 reps',
        '  → Farmers Carry 30 m',
        '  → Wall Ball 10 reps @ 9 kg',
        'Finish: Row 500 m @ race pace — note your time',
        'Cool-down: 5 min mobility (hip flexors + quads)',
      ],
      note: 'This is Hyrox race practice. Go at 80% effort — not all-out. Transition fast between stations (that\'s where Hyrox time is won or lost). Legs must be functional tomorrow for the long run.',
    };
    if (isRecov) return {
      label: '💪 Session D — Hyrox Skill (Recovery Week)',
      duration: '25–30 min',
      exercises: [
        'SkiErg — 3×200 m @ easy  (technique drill: keep chest tall)',
        'Farmers Carry — 3×20 m  (light — practice transition speed)',
        'Wall Ball — 2×10 @ 9 kg  (catch at chest, full squat)',
        'Burpee Broad Jump — 2×6  (slow, controlled)',
        'Hip flexor stretch — 5 min',
      ],
      note: 'Recovery week. Skill only — no intensity. Practice efficient transitions between stations.',
    };
    return {
      label: '💪 Session D — Hyrox Skill (Base)',
      duration: '30–35 min',
      exercises: [
        'SkiErg — 4×200 m @ easy–moderate  (technique focus)',
        'Wall Ball — 3×12 @ 9 kg  (squat depth + target accuracy)',
        'Farmers Carry — 3×20 m  (practice grip switch and turns)',
        'Burpee Broad Jump — 3×6  (controlled jump distance)',
        'Row — 2×300 m @ moderate  (pacing practice)',
        'Cool-down: 5 min hip + quad mobility',
      ],
      note: 'Saturday is skill and movement quality day. Intensity is moderate — your legs need to run tomorrow. Focus on learning efficient Hyrox station technique. Wall balls: the ball must hit the target, full squat below parallel.',
    };
  }

  return null;
}

function workoutCard(w, dayDate) {
  const color = sportColor(w);
  const icon = sportIcon(w);
  const dist = w.distanceKm ? `${w.distanceKm}km` : '';
  const dur = w.durationMinutes ? `${w.durationMinutes}min` : '';
  const detail = [dist, dur].filter(Boolean).join(' · ');
  const hr = (w.humanReadable || w.description || '').replace(/\n/g, '<br>');
  const pace = w.targetPace ? `<div class="pace">🎯 ${w.targetPace}</div>` : '';
  const hrTarget = w.targetHR ? `<div class="hr-target">❤️ ${w.targetHR}</div>` : '';
  const exportBtn = w.sport !== 'rest'
    ? `<button class="export-btn" onclick="exportWorkout(event, this)" data-wid="${w.id}" title="Export workout">↓</button>`
    : '';

  // Match a real Strava activity to this planned workout (by date + sport)
  const dayActs = dayDate ? (activitiesByDate[dayDate] || []) : [];
  const matchedAct = w.sport === 'run'
    ? dayActs.find(a => a.type === 'Run')
    : w.sport === 'strength'
      ? dayActs.find(a => a.type === 'WeightTraining' || a.type === 'Crossfit' || a.type === 'Workout')
      : null;
  // Auto-complete: day is in the past and a matching activity exists
  const isPast = dayDate && dayDate < todayStr;
  const autoComplete = !!(isPast && matchedAct);
  const autoDnf = isPast && !matchedAct && w.sport !== 'rest'; // past day, no activity found

  const focus = w.sport === 'run' ? workoutFocus(w) : null;
  const str = w.sport === 'strength' ? strengthWorkout(w) : null;

  const focusHtml = focus ? `
    <div class="workout-rationale">
      <div class="rationale-block">
        <span class="rationale-label">🧠 Why this session</span>
        <p class="rationale-text">${focus.why}</p>
      </div>
      <div class="rationale-block">
        <span class="rationale-label">🎯 What to focus on</span>
        <p class="rationale-text">${focus.focus}</p>
      </div>
    </div>` : '';

  const strHtml = str ? `
    <div class="workout-rationale">
      <div class="rationale-block">
        <span class="rationale-label">${str.label} · ${str.duration}</span>
        <ul class="str-exercise-list">
          ${str.exercises.map(e => `<li>${e}</li>`).join('')}
        </ul>
      </div>
      ${str.note ? `<div class="rationale-block"><span class="rationale-label">📌 Coach note</span><p class="rationale-text">${str.note}</p></div>` : ''}
    </div>` : '';

  // Strava feedback block for matched activity
  let actFeedbackHtml = '';
  if (matchedAct) {
    const fb = coachFeedback(matchedAct);
    const fbLines = fb.split('\n').map(l => l.trim()).filter(Boolean);
    const fbFormatted = fbLines.map(l => {
      if (l.startsWith('✅')) return `<div class="fb-well">${l}</div>`;
      if (l.startsWith('💡')) return `<div class="fb-improve">${l}</div>`;
      return `<div class="fb-line">${l}</div>`;
    }).join('');
    const paceStr = matchedAct.average_speed > 0
      ? (() => { const s = Math.round(1000/matchedAct.average_speed); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}/km`; })()
      : null;
    const actSummary = [matchedAct.km + 'km', paceStr, matchedAct.average_heartrate ? Math.round(matchedAct.average_heartrate) + ' bpm avg' : null].filter(Boolean).join(' · ');
    actFeedbackHtml = `<div class="act-feedback">
      <div class="act-feedback-header">📊 Strava: ${matchedAct.name} <span class="act-feedback-meta">${actSummary}</span></div>
      <div class="act-feedback-body">${fbFormatted}</div>
    </div>`;
  } else if (autoDnf) {
    actFeedbackHtml = `<div class="act-feedback act-feedback-miss">❌ No Strava activity found for this day — skipped or not synced yet.</div>`;
  }

  const checkIcon = autoComplete ? '✅' : autoDnf ? '❌' : '⬜';
  const cardClass = autoComplete ? 'workout-card auto-done' : autoDnf ? 'workout-card auto-miss' : 'workout-card';

  return `
    <div class="${cardClass}" style="border-left: 4px solid ${color}" onclick="toggleDetail(this)">
      <div class="workout-header">
        <span class="sport-icon">${icon}</span>
        <div class="workout-info">
          <div class="workout-name">${w.name}</div>
          ${detail ? `<div class="workout-detail">${detail}</div>` : ''}
        </div>
        <span class="expand-arrow">▾</span>
        <div class="workout-check" onclick="toggleComplete(event, this, '${w.id}')">${checkIcon}</div>
        ${exportBtn}
      </div>
      <div class="workout-body" style="display:none">
        ${pace}${hrTarget}
        <div class="workout-desc">${hr}</div>
        ${focusHtml}${strHtml}
        ${actFeedbackHtml}
      </div>
    </div>`;
}

function weekCard(w) {
  const isRecovery = w.isRecoveryWeek;
  const phaseColor = phaseBadgeColor(w.phase);
  const totalKm = w.summary?.totalKm || 0;
  const strengthSessions = w.summary?.strengthSessions || 0;
  const actKm = actualKmByWeek[w.startDate] ?? null;
  const kmStatus = actKm !== null
    ? actKm < totalKm * 0.8 ? 'km-under' : actKm > totalKm * 1.2 ? 'km-over' : 'km-on-track'
    : '';
  const kmBadge = actKm !== null
    ? `<span class="week-stat actual-km ${kmStatus}">📍 ${actKm}km done</span>`
    : '';

  const daysHtml = w.days.map(day => {
    const isRestOnly = day.workouts.every(wo => wo.sport === 'rest');
    return `
    <div class="day-col${isRestOnly ? ' day-rest-only' : ''}" data-date="${day.date}">
      <div class="day-header">
        <div class="day-name">${day.dayOfWeek.slice(0,3)}</div>
        <div class="day-date">${formatDate(day.date)}</div>
      </div>
      <div class="day-workouts">
        ${day.workouts.map(wo => workoutCard(wo, day.date)).join('')}
      </div>
    </div>`;
  }).join('');

  return `
  <section class="week-section ${isRecovery ? 'recovery-week' : ''}" data-week-start="${w.startDate}">
    <div class="week-header" onclick="toggleWeek(this)">
      <div class="week-title">
        <span class="week-num">Week ${w.weekNumber}</span>
        <span class="week-dates">${formatDate(w.startDate)} – ${formatDate(w.endDate)}</span>
        ${isRecovery ? '<span class="recovery-badge">Recovery</span>' : ''}
        <span class="week-collapse-arrow">▾</span>
      </div>
      <div class="week-meta">
        <span class="phase-badge" style="background:${phaseColor}">${w.phase}</span>
        <span class="week-stat">🏃 ${totalKm}km planned</span>
        <span class="week-stat">💪 ${strengthSessions}×S</span>
        ${kmBadge}
      </div>
      <div class="week-focus">${w.focus}</div>
    </div>
    <div class="week-grid">${daysHtml}</div>
  </section>`;
}

// ── TODAY PANEL (server-side) ────────────────────────────────
// ── COACH STATUS / PROGRESSION COMMENTARY ───────────────────
function coachStatusHtml() {
  const goalSec = 6000; // 1:40:00
  const weeksLeft = totalPlanWeeks - weeksCompleted;
  const pctDone = Math.round((weeksCompleted / totalPlanWeeks) * 100);

  // Progress sentence
  const progressLine = weeksCompleted === 0
    ? `Plan just started — week 1 of ${totalPlanWeeks}.`
    : `${weeksCompleted} of ${totalPlanWeeks} weeks complete (${pctDone}% of the plan).`;

  // Km adherence
  let kmLine = '';
  if (plannedKmToDate > 0) {
    const pct = Math.round((actualKmToDate / plannedKmToDate) * 100);
    const diff = Math.abs(actualKmToDate - plannedKmToDate).toFixed(0);
    if (pct >= 90) kmLine = `You've run <strong>${actualKmToDate.toFixed(0)}km</strong> vs ${plannedKmToDate.toFixed(0)}km planned — great adherence (${pct}%).`;
    else if (pct >= 70) kmLine = `You've run <strong>${actualKmToDate.toFixed(0)}km</strong> vs ${plannedKmToDate.toFixed(0)}km planned (${pct}%). About ${diff}km behind — manageable, keep the current week clean.`;
    else if (actualKmToDate > 0) kmLine = `You've run <strong>${actualKmToDate.toFixed(0)}km</strong> vs ${plannedKmToDate.toFixed(0)}km planned (${pct}%). ${diff}km behind schedule — prioritise not missing any more runs this block.`;
  }

  // Prediction delta narrative
  let predLine = '';
  let trend = null;
  if (racePrediction && baselinePrediction) {
    const deltaS = baselinePrediction.predicted - racePrediction.predicted;
    const deltaMins = Math.abs(Math.floor(deltaS / 60));
    const deltaSecs = Math.abs(deltaS % 60);
    const deltaStr = deltaMins > 0 ? `${deltaMins}m ${deltaSecs}s` : `${deltaSecs}s`;
    if (deltaS > 30) {
      trend = 'improving';
      predLine = `Since starting the plan your predicted time has improved by <strong>${deltaStr}</strong> — from ${baselinePrediction.timeStr} → <strong>${racePrediction.timeStr}</strong>. The training is working.`;
    } else if (deltaS < -30) {
      trend = 'slower';
      predLine = `Your current prediction (${racePrediction.timeStr}) is <strong>${deltaStr} slower</strong> than at plan start (${baselinePrediction.timeStr}). This can happen with training fatigue or low mileage — keep the easy runs easy and hit the quality sessions.`;
    } else {
      trend = 'flat';
      predLine = `Prediction is holding steady at <strong>${racePrediction.timeStr}</strong> (baseline was ${baselinePrediction.timeStr}). Fitness gains typically show up in the Build phase — stay consistent.`;
    }
  } else if (racePrediction) {
    predLine = `Current prediction: <strong>${racePrediction.timeStr}</strong>. No baseline data from before the plan — progress comparison will appear once more Strava data is synced.`;
  }

  // Gap to goal
  let gapLine = '';
  if (racePrediction) {
    const gapAbs = Math.abs(racePrediction.gapSec);
    const gapMins = Math.floor(gapAbs / 60), gapSecs = gapAbs % 60;
    const gapStr = `${gapMins}m ${gapSecs}s`;
    if (racePrediction.onTrack) {
      gapLine = `You're <strong>${gapStr} ahead of your 1:40 goal</strong>. Keep building — don't change anything, don't go harder.`;
    } else {
      const gapPerKm = Math.round(racePrediction.gapSec / 21.1);
      gapLine = `You need to find <strong>${gapStr}</strong> to hit 1:40 — that's ${gapPerKm} sec/km at race pace. ${weeksLeft > 8 ? 'Plenty of time with consistent training.' : weeksLeft > 4 ? 'Focused quality work in the next few weeks can close this.' : 'Taper well and race smart.'}`;
    }
  }

  // Overall coaching status label
  let statusEmoji = '📋', statusColor = '#64748b', statusLabel = 'Building base';
  if (racePrediction) {
    if (racePrediction.onTrack && trend === 'improving') { statusEmoji = '🚀'; statusColor = '#10b981'; statusLabel = 'On fire — ahead of target'; }
    else if (racePrediction.onTrack) { statusEmoji = '✅'; statusColor = '#10b981'; statusLabel = 'On track for sub-1:40'; }
    else if (trend === 'improving') { statusEmoji = '📈'; statusColor = '#f59e0b'; statusLabel = 'Improving — keep going'; }
    else if (trend === 'slower') { statusEmoji = '⚠️'; statusColor = '#ef4444'; statusLabel = 'Attention needed'; }
    else { statusEmoji = '🔄'; statusColor = '#6366f1'; statusLabel = 'Steady — gains coming'; }
  }

  // Z2 trend narrative (last 3 weeks if available)
  let z2Line = '';
  if (fitnessTrend.length >= 2) {
    const last = fitnessTrend[fitnessTrend.length - 1];
    const prev = fitnessTrend[fitnessTrend.length - 2];
    const delta = last.avgPace - prev.avgPace;
    const fmtPace = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}/km`;
    if (delta < -8) z2Line = `Your easy-run pace improved by ${Math.abs(delta)} sec/km this week (${fmtPace(prev.avgPace)} → ${fmtPace(last.avgPace)}) — aerobic engine is responding.`;
    else if (delta > 8) z2Line = `Easy-run pace was ${delta} sec/km slower this week — likely accumulated fatigue. Prioritise sleep and keep this week's easy runs genuinely easy.`;
  }

  // Weeks left comment
  const timelineComment = weeksLeft <= 0 ? '' :
    weeksLeft === 1 ? '⏱️ Race week — trust your training, protect the legs.' :
    weeksLeft <= 3 ? '🎯 Taper block — your body is absorbing the work. Resist extra effort.' :
    weeksLeft <= 6 ? '🔥 Build phase — the hardest and most important weeks. Execute every session.' :
    '🌱 Still in base — consistency over intensity. Every easy run counts.';

  const lines = [progressLine, kmLine, predLine, gapLine, z2Line].filter(Boolean);

  return `
  <div class="coach-status-card">
    <div class="cs-header">
      <div>
        <span class="cs-status-emoji">${statusEmoji}</span>
        <span class="cs-status-label" style="color:${statusColor}">${statusLabel}</span>
      </div>
      ${timelineComment ? `<div class="cs-timeline-pill">${timelineComment}</div>` : ''}
    </div>
    <div class="cs-body">
      ${lines.map(l => `<p class="cs-line">${l}</p>`).join('')}
    </div>
    ${racePrediction && baselinePrediction ? `
    <div class="cs-pred-row">
      <div class="cs-pred-box cs-pred-baseline">
        <div class="cs-pred-label">At plan start</div>
        <div class="cs-pred-time">${baselinePrediction.timeStr}</div>
      </div>
      <div class="cs-pred-arrow">→</div>
      <div class="cs-pred-box cs-pred-now" style="border-color:${racePrediction.onTrack ? '#10b981' : '#f59e0b'}">
        <div class="cs-pred-label">Now</div>
        <div class="cs-pred-time" style="color:${racePrediction.onTrack ? '#10b981' : '#f59e0b'}">${racePrediction.timeStr}</div>
      </div>
      <div class="cs-pred-arrow">→</div>
      <div class="cs-pred-box cs-pred-goal">
        <div class="cs-pred-label">Goal</div>
        <div class="cs-pred-time" style="color:#f59e0b">1:40:00</div>
      </div>
    </div>` : (racePrediction ? `
    <div class="cs-pred-row">
      <div class="cs-pred-box cs-pred-now" style="border-color:${racePrediction.onTrack ? '#10b981' : '#f59e0b'}">
        <div class="cs-pred-label">Current prediction</div>
        <div class="cs-pred-time" style="color:${racePrediction.onTrack ? '#10b981' : '#f59e0b'}">${racePrediction.timeStr}</div>
      </div>
      <div class="cs-pred-arrow">→</div>
      <div class="cs-pred-box cs-pred-goal">
        <div class="cs-pred-label">Goal</div>
        <div class="cs-pred-time" style="color:#f59e0b">1:40:00</div>
      </div>
    </div>` : '')}
  </div>`;
}

function todayPanelHtml() {
  const todayPlan = plan.weeks.flatMap(wk => wk.days).find(d => d.date === todayStr);
  const dateHeading = new Date(todayStr).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  let todayWorkoutHtml = '';
  if (!todayPlan) {
    const planStart = plan.meta.planStartDate;
    const planEnd   = plan.meta.eventDate;
    if (todayStr < planStart) {
      todayWorkoutHtml = `<div class="today-rest-card">📋 Plan starts <strong>${new Date(planStart).toLocaleDateString('en-GB',{day:'numeric',month:'long'})}</strong>. Use the next few days to build an easy base and arrive at Week 1 feeling fresh.</div>`;
    } else if (todayStr > planEnd) {
      todayWorkoutHtml = `<div class="today-rest-card">🏁 Race day has passed! Congratulations on completing the plan. Check the <em>Plan</em> tab for the full 16-week schedule.</div>`;
    } else {
      todayWorkoutHtml = `<div class="today-rest-card">📋 No structured session scheduled today. Use the <em>Plan</em> tab for your full schedule.</div>`;
    }
  } else {
    const active = todayPlan.workouts.filter(w => w.sport !== 'rest');
    if (active.length === 0) {
      todayWorkoutHtml = `<div class="today-rest-card">😴 <strong>Rest Day</strong> — scheduled recovery. Sleep 8+ hrs, stay hydrated, do light stretching. Recovery is not wasted time; it's when fitness is built.</div>`;
    } else {
      todayWorkoutHtml = active.map(w => {
        const color = sportColor(w);
        const icon  = sportIcon(w);
        const dist  = w.distanceKm ? `${w.distanceKm}km` : '';
        const dur   = w.durationMinutes ? `${w.durationMinutes}min` : '';
        const detail = [dist, dur].filter(Boolean).join(' · ');
        const desc  = (w.humanReadable || w.description || '').replace(/\n/g, '<br>');
        const focus = w.sport === 'run' ? workoutFocus(w) : null;
        const str   = w.sport === 'strength' ? strengthWorkout(w) : null;
        const exportBtn = w.sport !== 'rest'
          ? `<button class="dl-btn" style="margin-top:12px" onclick="exportWorkout(event,this)" data-wid="${w.id}">↓ Export to watch</button>`
          : '';
        return `<div class="today-workout-card" style="border-left:5px solid ${color}">
          <div class="today-workout-header">
            <span class="today-sport-icon">${icon}</span>
            <div style="flex:1">
              <div class="today-workout-name">${w.name}</div>
              ${detail ? `<div class="today-workout-detail">${detail}</div>` : ''}
            </div>
            ${w.targetPace ? `<span class="today-chip pace-chip">🎯 ${w.targetPace}</span>` : ''}
            ${w.targetHR   ? `<span class="today-chip hr-chip">❤️ ${w.targetHR}</span>` : ''}
          </div>
          ${desc ? `<div class="today-session-desc">${desc}</div>` : ''}
          ${focus ? `<div class="today-focus-section">
            <div class="today-focus-block">
              <span class="today-focus-label">🧠 Why this session</span>
              <p class="today-focus-text">${focus.why}</p>
            </div>
            <div class="today-focus-block">
              <span class="today-focus-label">🎯 What to focus on</span>
              <p class="today-focus-text">${focus.focus}</p>
            </div>
          </div>` : ''}
          ${str ? `<div class="today-focus-section">
            <div class="today-focus-block">
              <span class="today-focus-label">${str.label} · ${str.duration}</span>
              <ul class="str-exercise-list" style="margin-top:8px">
                ${str.exercises.map(e => `<li>${e}</li>`).join('')}
              </ul>
            </div>
            ${str.note ? `<div class="today-focus-block"><span class="today-focus-label">📌 Coach note</span><p class="today-focus-text">${str.note}</p></div>` : ''}
          </div>` : ''}
          ${exportBtn}
        </div>`;
      }).join('');
    }
  }

  // Upcoming quality sessions — expandable
  const qualTypes = new Set(['tempo','intervals','strides','race','long']);
  const upcomingDays = plan.weeks.flatMap(wk => wk.days)
    .filter(d => d.date > todayStr)
    .filter(d => d.workouts.some(w => qualTypes.has(w.type)))
    .slice(0, 4);
  const upcomingHtml = upcomingDays.length ? `
  <div class="upcoming-section">
    <h3 class="section-sub-title">📅 Next Quality Sessions</h3>
    ${upcomingDays.map((d, idx) => {
      const qw = d.workouts.find(w => qualTypes.has(w.type));
      const dt = new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const color = sportColor(qw);
      const icon = sportIcon(qw);
      const focus = workoutFocus(qw);
      const dist = qw.distanceKm ? `${qw.distanceKm}km` : '';
      const dur = qw.durationMinutes ? `${qw.durationMinutes}min` : '';
      const detail = [dist, dur].filter(Boolean).join(' · ');
      const desc = (qw.humanReadable || qw.description || '').replace(/\n/g,'<br>');
      const uid = `upc-${idx}`;
      return `<div class="upcoming-card" style="border-left:4px solid ${color}" onclick="toggleUpcoming('${uid}')">
        <div class="upcoming-card-header">
          <span class="upcoming-icon">${icon}</span>
          <div class="upcoming-card-info">
            <div class="upcoming-name">${qw.name}</div>
            <div class="upcoming-date">${dt}${detail ? ' · ' + detail : ''}</div>
          </div>
          ${qw.targetPace ? `<span class="upcoming-pace-chip">🎯 ${qw.targetPace}</span>` : ''}
          <span class="upcoming-expand-arrow" id="${uid}-arrow">›</span>
        </div>
        <div class="upcoming-detail" id="${uid}" style="display:none">
          ${desc ? `<p class="upcoming-desc">${desc}</p>` : ''}
          ${focus ? `<div class="upcoming-focus-block">
            <div class="upcoming-focus-label">🧠 Why</div>
            <p class="upcoming-focus-text">${focus.why}</p>
          </div>
          <div class="upcoming-focus-block">
            <div class="upcoming-focus-label">🎯 Focus</div>
            <p class="upcoming-focus-text">${focus.focus}</p>
          </div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>` : '';

  return `
  ${coachStatusHtml()}
  <div class="today-panel-wrap">
    <div class="today-left">
      <h2 class="today-date-heading">📅 ${dateHeading}</h2>
      ${injuryRisk ? `<div class="inj-risk-banner ${injuryRisk.startsWith('⚠️') ? 'risk-warn' : 'risk-caution'}" style="margin:0 0 16px">${injuryRisk}</div>` : ''}
      <div class="today-workouts-wrap">${todayWorkoutHtml}</div>
      ${upcomingHtml}
    </div>
    <div class="today-right">
      <h3 class="section-sub-title" style="margin-bottom:12px">🏃 This Week's Strava Activity</h3>
      ${week0Html()}
    </div>
  </div>`;
}

const planWeeksHtml = plan.weeks.map(weekCard).join('\n');
const totalKm = plan.weeks.reduce((s, w) => s + (w.summary?.totalKm || 0), 0).toFixed(0);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${plan.meta.athlete} — Half Marathon Training Plan · Sep 20, 2026</title>
  <style>
    /* ── PASSWORD GATE ───────────────────────────────────────── */
    #pw-gate { position:fixed; inset:0; background:#0f172a; display:flex; align-items:center; justify-content:center; z-index:9999; flex-direction:column; gap:16px; }
    #pw-gate h1 { color:#f59e0b; font-size:22px; font-weight:700; margin-bottom:4px; }
    #pw-gate p  { color:#94a3b8; font-size:13px; margin-bottom:8px; }
    #pw-form    { display:flex; gap:8px; }
    #pw-input   { background:#1e293b; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:10px 14px; font-size:15px; width:220px; outline:none; }
    #pw-input:focus { border-color:#f59e0b; }
    #pw-btn     { background:#f59e0b; border:none; color:#000; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:700; cursor:pointer; }
    #pw-btn:hover { background:#fbbf24; }
    #pw-err     { color:#f87171; font-size:12px; min-height:16px; }
    #pw-gate.hidden { display:none; }
  </style>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f172a; --surface: #1e293b; --surface2: #273344;
      --border: #334155; --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b;
      --accent: #f59e0b; --radius: 10px;
    }
    [data-theme="light"] {
      --bg: #f1f5f9; --surface: #ffffff; --surface2: #f8fafc;
      --border: #e2e8f0; --text: #0f172a; --text2: #475569; --text3: #94a3b8;
      --accent: #d97706;
    }
    [data-theme="light"] .plan-header { background: linear-gradient(135deg,#fff,#f1f5f9); }
    [data-theme="light"] .workout-card { box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    [data-theme="light"] .week-section { box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; transition: background .2s, color .2s; }
    .theme-toggle { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); border-radius: 20px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; margin-left: 12px; }
    .theme-toggle:hover { background: var(--accent); color: #000; border-color: var(--accent); }

    /* ── HEADER ─────────────────────────────────────────────── */
    .plan-header { background: linear-gradient(135deg,#1e293b,#0f172a); border-bottom: 1px solid var(--border); padding: 32px 24px; }
    .plan-title { font-size: 28px; font-weight: 800; color: var(--accent); margin-bottom: 4px; }
    .plan-subtitle { color: var(--text2); font-size: 16px; margin-bottom: 20px; }
    .plan-stats { display: flex; gap: 24px; flex-wrap: wrap; }
    .stat-box { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 18px; text-align: center; min-width: 100px; }
    .stat-value { font-size: 22px; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }

    /* ── RACE STRATEGY ──────────────────────────────────────── */
    .race-strategy { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 24px; padding: 20px; }
    .race-strategy h2 { color: var(--accent); margin-bottom: 12px; font-size: 16px; }
    .strategy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 16px; }
    .strategy-card { background: var(--surface2); border-radius: 8px; padding: 14px; }
    .strategy-card h3 { font-size: 12px; text-transform: uppercase; color: var(--text3); letter-spacing: .05em; margin-bottom: 8px; }
    .strategy-card p { font-size: 13px; color: var(--text2); }
    .pace-goal { font-size: 20px; font-weight: 700; color: var(--accent); }

    /* ── ZONES ──────────────────────────────────────────────── */
    .zones-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 24px 24px; padding: 20px; }
    .zones-section h2 { color: var(--accent); margin-bottom: 12px; font-size: 16px; }
    .zone-table { width: 100%; border-collapse: collapse; }
    .zone-table th, .zone-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
    .zone-table th { color: var(--text3); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    .zone-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }

    /* ── PHASE LEGEND ───────────────────────────────────────── */
    .phase-legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 24px 16px; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }

    /* ── WEEKS ──────────────────────────────────────────────── */
    .weeks-container { padding: 0 24px 48px; display: flex; flex-direction: column; gap: 24px; }
    .week-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .week-section.recovery-week { border-color: #10b981; }
    .week-header { padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--surface2); cursor: pointer; user-select: none; }
    .week-title { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
    .week-num { font-size: 15px; font-weight: 700; }
    .week-dates { font-size: 13px; color: var(--text3); }
    .recovery-badge { background: #10b981; color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 20px; font-weight: 600; text-transform: uppercase; }
    .week-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
    .phase-badge { color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 20px; font-weight: 700; text-transform: uppercase; }
    .week-stat { font-size: 12px; color: var(--text2); }
    .week-focus { font-size: 12px; color: var(--text3); font-style: italic; }

    /* ── DAY GRID ───────────────────────────────────────────── */
    .week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0; }
    .day-col { border-right: 1px solid var(--border); padding: 10px 8px; min-height: 100px; }
    .day-col:last-child { border-right: none; }
    .day-header { margin-bottom: 8px; }
    .day-name { font-size: 11px; font-weight: 700; color: var(--text3); text-transform: uppercase; }
    .day-date { font-size: 11px; color: var(--text3); }
    .week-collapse-arrow { font-size: 13px; color: var(--text3); margin-left: auto; transition: transform .2s; }
    .week-section.collapsed .week-collapse-arrow { transform: rotate(-90deg); }
    .week-section.collapsed .week-grid { display: none; }

    .workout-card { background: var(--surface2); border-radius: 6px; padding: 8px; margin-bottom: 6px; cursor: pointer; transition: opacity .15s; }
    .workout-card:hover { opacity: .9; }
    .workout-header { display: flex; align-items: flex-start; gap: 5px; }
    .sport-icon { font-size: 14px; flex-shrink: 0; }
    .workout-info { flex: 1; min-width: 0; }
    .workout-name { font-size: 12px; font-weight: 600; color: var(--text); line-height: 1.3; }
    .workout-detail { font-size: 11px; color: var(--text3); margin-top: 2px; }
    .expand-arrow { font-size: 12px; color: var(--text3); flex-shrink: 0; transition: transform .2s; user-select: none; }
    .workout-card.open .expand-arrow { transform: rotate(180deg); }
    .workout-check { font-size: 14px; cursor: pointer; flex-shrink: 0; }
    .export-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text2); border-radius: 4px; font-size: 11px; padding: 1px 5px; cursor: pointer; flex-shrink: 0; line-height: 1.4; }
    .export-btn:hover { background: var(--accent); color: #000; border-color: var(--accent); }
    .workout-body { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .pace { font-size: 11px; font-weight: 600; color: #f97316; margin-bottom: 4px; }
    .hr-target { font-size: 11px; color: #ef4444; margin-bottom: 6px; }
    .workout-desc { font-size: 11px; color: var(--text2); line-height: 1.6; }

    /* ── RESPONSIVE — NATIVE MOBILE APP ──────────────────────── */
    @media (max-width: 700px) {

      /* ── BASE FONT ── */
      body { font-size: 16px; }

      /* ── HIDE DESKTOP HEADER — too dense for mobile ── */
      .plan-header { display: none; }

      /* ── SLIM APP BAR (countdown bar repurposed as top app bar) ── */
      .countdown-bar {
        position: sticky; top: 0; z-index: 80;
        padding: 12px 18px;
        gap: 16px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }
      .cd-value { font-size: 22px; font-weight: 800; }
      .cd-label { font-size: 11px; }
      .cd-sep { display: none; }
      .plan-prog-wrap { display: none !important; }
      #next-session-pill-wrap { margin-left: auto; }

      /* ── BOTTOM TAB BAR (native mobile pattern) ── */
      .main-tabs {
        position: fixed;
        bottom: 0; left: 0; right: 0; top: auto;
        padding: 0 0 env(safe-area-inset-bottom, 6px);
        background: var(--surface);
        border-top: 2px solid var(--border);
        border-bottom: none;
        z-index: 100;
        gap: 0;
      }
      .main-tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 8px 4px 6px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        border-radius: 0;
        border-bottom: none;
        border-top: 3px solid transparent;
        margin-bottom: 0;
        min-height: 56px;
      }
      .main-tab.active { border-bottom-color: transparent; border-top-color: var(--accent); color: var(--accent); }
      .tab-icon { font-size: 22px; line-height: 1; display: block; }
      .tab-label { font-size: 10px; font-weight: 600; display: block; }

      /* ── CONTENT AREA — pad for bottom nav ── */
      .tab-panel {
        padding: 16px 14px;
        padding-bottom: calc(76px + env(safe-area-inset-bottom, 6px));
      }

      /* ── TODAY PANEL ── */
      .today-panel-wrap { grid-template-columns: 1fr; gap: 20px; }
      .today-date-heading { font-size: 20px; font-weight: 800; margin-bottom: 16px; }
      .today-workout-card { padding: 20px 18px; border-radius: 16px; margin-bottom: 12px; }
      .today-workout-header { gap: 14px; }
      .today-sport-icon { font-size: 36px; }
      .today-workout-name { font-size: 22px; font-weight: 800; line-height: 1.2; }
      .today-workout-detail { font-size: 15px; margin-top: 5px; }
      .today-chip { font-size: 14px; font-weight: 700; padding: 6px 12px; border-radius: 12px; }
      /* Hide verbose session description — focus sections cover it */
      .today-session-desc { display: none; }
      .today-focus-section { padding: 16px; gap: 14px; margin-top: 14px; border-radius: 12px; }
      .today-focus-label { font-size: 11px; }
      .today-focus-text { font-size: 15px; line-height: 1.65; }
      .str-exercise-list { margin-top: 10px; gap: 8px; }
      .str-exercise-list li { font-size: 15px; padding-left: 20px; line-height: 1.5; }
      .today-rest-card { font-size: 17px; padding: 22px; border-radius: 16px; line-height: 1.7; }
      /* Export to watch button */
      .dl-btn { font-size: 15px; padding: 12px 20px; margin-top: 16px; border-radius: 10px; }

      /* Coach status card */
      .coach-status-card { padding: 18px 16px; border-radius: 16px; margin-bottom: 20px; }
      .cs-status-emoji { font-size: 26px; }
      .cs-status-label { font-size: 18px; }
      .cs-timeline-pill { font-size: 12px; padding: 5px 12px; }
      .cs-line { font-size: 15px; line-height: 1.7; }
      .cs-pred-row { gap: 8px; }
      .cs-pred-time { font-size: 20px; }
      .cs-pred-arrow { font-size: 16px; }

      /* Upcoming sessions */
      .section-sub-title { font-size: 15px; letter-spacing: .04em; margin-bottom: 12px; }
      .upcoming-section { margin-top: 24px; }
      .upcoming-card { border-radius: 14px; margin-bottom: 10px; }
      .upcoming-card-header { padding: 14px 16px; gap: 12px; }
      .upcoming-icon { font-size: 24px; }
      .upcoming-name { font-size: 17px; }
      .upcoming-date { font-size: 13px; margin-top: 3px; }
      .upcoming-pace-chip { font-size: 13px; padding: 5px 10px; }
      .upcoming-expand-arrow { font-size: 24px; }
      .upcoming-detail { padding: 0 16px 16px 16px; gap: 12px; }
      .upcoming-focus-label { font-size: 11px; }
      .upcoming-focus-text { font-size: 15px; line-height: 1.7; }
      .upcoming-desc { font-size: 14px; }

      /* ── PLAN TAB ── */
      .weeks-container { padding: 0 0 16px; gap: 10px; }
      .week-section { border-radius: 14px; }
      .week-header { padding: 16px 18px; }
      .week-num { font-size: 17px; font-weight: 800; }
      .week-dates { font-size: 13px; }
      .week-stat { font-size: 13px; }
      /* Hide verbose italic focus text — too small and dense */
      .week-focus { display: none; }
      .week-collapse-arrow { margin-left: auto; font-size: 18px; }
      .recovery-badge, .phase-badge, .week0-badge { font-size: 11px; padding: 3px 9px; }

      /* Vertical day list — rest-only days hidden */
      .week-grid { display: flex; flex-direction: column; border-top: 1px solid var(--border); }
      .day-rest-only { display: none; }
      .day-col {
        border-right: none;
        border-bottom: 1px solid var(--border);
        padding: 0; min-height: unset; display: block;
      }
      .day-col:last-child { border-bottom: none; }
      /* Day label strip */
      .day-header {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 18px 8px;
        background: rgba(255,255,255,.04);
        border-bottom: 1px solid var(--border);
        margin-bottom: 0;
      }
      .day-name { font-size: 14px; font-weight: 800; text-transform: uppercase; color: var(--accent); }
      .day-date { font-size: 13px; color: var(--text3); }

      /* Workout cards */
      .day-workouts { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
      .workout-card { padding: 14px 16px; border-radius: 12px; margin-bottom: 0; }
      .workout-header { gap: 10px; }
      .sport-icon { font-size: 24px; }
      .workout-name { font-size: 17px; font-weight: 700; }
      .workout-detail { font-size: 14px; margin-top: 4px; }
      .expand-arrow { font-size: 18px; }
      .workout-check { font-size: 24px; padding: 4px 8px; }
      .export-btn { font-size: 13px; padding: 6px 12px; border-radius: 6px; }
      /* Expanded card body */
      .workout-body { margin-top: 14px; padding-top: 14px; }
      .pace { font-size: 15px; margin-bottom: 6px; }
      .hr-target { font-size: 15px; margin-bottom: 8px; }
      .workout-desc { font-size: 15px; line-height: 1.7; }
      /* Rationale */
      .workout-rationale { padding: 14px; gap: 12px; margin-top: 12px; border-radius: 10px; }
      .rationale-label { font-size: 11px; }
      .rationale-text { font-size: 15px; line-height: 1.65; }
      /* Strava feedback in plan cards */
      .act-feedback { padding: 12px 14px; margin-top: 12px; border-radius: 10px; }
      .act-feedback-header { font-size: 12px; }
      .fb-line { font-size: 14px; }
      .fb-well { font-size: 14px; }
      .fb-improve { font-size: 14px; }

      /* ── WEEK 0 / STRAVA ACTIVITY CARDS ── */
      .actual-activity { padding: 16px 18px; }
      .actual-icon { font-size: 26px; }
      .actual-name { font-size: 17px; font-weight: 700; }
      .actual-detail { font-size: 14px; margin-top: 3px; }
      .actual-hr { font-size: 14px; }
      /* Remove left indent — fill full width on mobile */
      .actual-feedback { padding-left: 0; margin-top: 10px; }
      /* Show only the one-line summary; hide the detailed bullet lines */
      .feedback-line { display: none; }
      .feedback-summary { display: block; font-size: 15px; font-style: normal; color: var(--text2); }
      .chart-btn { margin-left: 0; margin-top: 12px; font-size: 14px; padding: 10px 16px; border-radius: 8px; }

      /* ── STRATEGY TAB ── */
      .race-strategy, .zones-section { margin: 0 0 14px; border-radius: 14px; padding: 18px; }
      .race-strategy h2, .zones-section h2 { font-size: 18px; margin-bottom: 16px; }
      /* Single column — no 2-column grids */
      .strategy-grid { grid-template-columns: 1fr; gap: 10px; }
      .strategy-card { padding: 16px; border-radius: 12px; }
      .strategy-card h3 { font-size: 11px; margin-bottom: 8px; }
      .strategy-card p { font-size: 16px; line-height: 1.6; }
      .pace-goal { font-size: 32px; }
      .phase-legend { margin: 0 0 14px; gap: 10px; }
      .legend-item { font-size: 14px; }
      .zone-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
      .zone-table th { font-size: 11px; padding: 8px 10px; }
      .zone-table td { font-size: 15px; padding: 11px 10px; }

      /* ── STATS TAB ── */
      .progress-bar-wrap { margin: 0 0 14px; padding: 16px; border-radius: 14px; }
      .progress-bar-wrap h2 { font-size: 16px; margin-bottom: 12px; }
      .prog-week { width: 32px; height: 32px; font-size: 10px; border-radius: 8px; }
      .progress-weeks { gap: 4px; }
      .volume-canvas-wrap, .trend-canvas-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .volume-canvas-wrap canvas, .trend-canvas-wrap canvas { min-width: 520px; }
      .predictor-section { flex-direction: column; gap: 16px; }
      .pred-main { text-align: center; }

      /* ── MODAL — full screen on mobile ── */
      .modal-box { width: 100vw !important; height: 100dvh; max-height: 100dvh; top: 0 !important; left: 0 !important; transform: none !important; border-radius: 0; position: fixed; }
    }

    /* Tiny phones (≤380px): emoji-only bottom nav */
    @media (max-width: 380px) {
      .tab-label { display: none; }
      .main-tab { padding-top: 10px; }
      .strategy-grid { grid-template-columns: 1fr; }
    }

    /* ── PROGRESS BAR ───────────────────────────────────────── */
    .progress-bar-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 24px 20px; padding: 16px; }
    .progress-bar-wrap h2 { color: var(--accent); font-size: 14px; margin-bottom: 10px; }
    .progress-weeks { display: flex; gap: 4px; flex-wrap: wrap; }
    .prog-week { width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; cursor: pointer; transition: transform .1s; border: 2px solid transparent; }
    .prog-week:hover { transform: scale(1.1); }

    /* ── MODAL ──────────────────────────────────────────────── */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 99; }
    .modal-box { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 100; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: min(700px,95vw); max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-close { background: none; border: none; color: var(--text2); font-size: 18px; cursor: pointer; }
    .modal-tabs { display: flex; border-bottom: 1px solid var(--border); }
    .tab { flex: 1; background: none; border: none; color: var(--text2); padding: 10px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-content { padding: 16px; overflow-y: auto; flex: 1; }
    .export-pre { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; color: var(--text2); font-family: 'Consolas','Courier New',monospace; margin-bottom: 10px; }
    .export-info { font-size: 12px; color: var(--text2); margin-bottom: 12px; line-height: 1.6; }
    .dl-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 12px; margin-right: 8px; margin-bottom: 6px; }
    .dl-btn:hover { background: var(--accent); color: #000; border-color: var(--accent); }
    .export-all-btn { background: var(--surface2); border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .export-all-btn:hover { background: var(--accent); color: #000; }

    /* ── WEEK 0 / ACTUAL ACTIVITIES ────────────────────────── */
    .week-zero { border-color: #6366f1; }
    .week0-badge { background: #6366f1; color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 20px; font-weight: 700; text-transform: uppercase; }
    .week0-grid { display: flex; flex-direction: column; gap: 0; }
    .actual-activity { padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .actual-activity:last-child { border-bottom: none; }
    .actual-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
    .actual-icon { font-size: 20px; flex-shrink: 0; padding-top: 2px; }
    .actual-info { flex: 1; }
    .actual-name { font-size: 14px; font-weight: 700; color: var(--text); }
    .actual-detail { font-size: 12px; color: var(--text3); margin-top: 2px; }
    .actual-hr { font-size: 12px; color: #ef4444; font-weight: 600; white-space: nowrap; }
    .actual-feedback { padding-left: 30px; }
    .feedback-line { font-size: 12px; color: var(--text2); line-height: 1.6; margin-bottom: 2px; }
    .feedback-summary { color: var(--text3); font-style: italic; margin-bottom: 4px; }

    /* ── TODAY HIGHLIGHT ─────────────────────────────────────── */
    .day-col.today-col { background: rgba(245,158,11,0.07); }
    .day-col.today-col .day-name { color: var(--accent); font-weight: 800; }
    .day-col.today-col .day-date { color: var(--accent); }
    .today-marker { font-size: 7px; background: var(--accent); color: #000; padding: 1px 4px; border-radius: 3px; font-weight: 800; margin-left: 4px; vertical-align: middle; letter-spacing: .04em; }

    /* ── COUNTDOWN BAR ───────────────────────────────────────── */
    .countdown-bar { background: #0d1929; border-bottom: 1px solid var(--border); padding: 10px 24px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; position: sticky; top: 0; z-index: 40; }
    [data-theme="light"] .countdown-bar { background: #fff; }
    .cd-block { text-align: center; }
    .cd-value { font-size: 20px; font-weight: 800; color: var(--accent); line-height: 1; }
    .cd-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }
    .cd-sep { color: var(--border); font-size: 20px; flex-shrink: 0; }
    .next-session-pill { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 5px 12px; font-size: 12px; color: var(--text2); }
    .next-session-pill strong { color: var(--text); }
    .plan-prog-wrap { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .plan-prog-bar { width: 100px; height: 5px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
    .plan-prog-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .5s; }

    /* ── INJURY RISK BANNER ──────────────────────────────────── */
    .inj-risk-banner { margin: 0 24px 16px; border-radius: var(--radius); padding: 11px 16px; font-size: 13px; font-weight: 500; border: 1px solid; }
    .inj-risk-banner.risk-warn { background: rgba(239,68,68,.1); border-color: rgba(239,68,68,.35); color: #fca5a5; }
    .inj-risk-banner.risk-caution { background: rgba(251,191,36,.07); border-color: rgba(251,191,36,.3); color: #fde68a; }

    /* ── COACH STATUS CARD ───────────────────────────────────── */
    .coach-status-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; margin-bottom: 22px; }
    .cs-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    .cs-status-emoji { font-size: 22px; margin-right: 8px; }
    .cs-status-label { font-size: 16px; font-weight: 800; }
    .cs-timeline-pill { font-size: 12px; color: var(--text2); background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; }
    .cs-body { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
    .cs-line { font-size: 14px; color: var(--text2); line-height: 1.65; }
    .cs-pred-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .cs-pred-box { background: var(--surface2); border: 2px solid var(--border); border-radius: 10px; padding: 10px 14px; text-align: center; flex: 1; min-width: 90px; }
    .cs-pred-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .cs-pred-time { font-size: 22px; font-weight: 800; color: var(--text); }
    .cs-pred-arrow { font-size: 20px; color: var(--text3); flex-shrink: 0; }

    /* ── UPCOMING QUALITY SESSIONS (expandable) ──────────────── */
    .upcoming-card { background: var(--surface2); border-radius: 10px; margin-bottom: 8px; cursor: pointer; transition: background .15s; overflow: hidden; }
    .upcoming-card:hover { background: var(--surface); }
    .upcoming-card-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
    .upcoming-icon { font-size: 20px; flex-shrink: 0; }
    .upcoming-card-info { flex: 1; min-width: 0; }
    .upcoming-name { font-size: 14px; font-weight: 700; color: var(--text); }
    .upcoming-date { font-size: 12px; color: var(--text3); margin-top: 2px; }
    .upcoming-pace-chip { font-size: 12px; font-weight: 600; color: var(--accent); background: rgba(245,158,11,.12); border-radius: 8px; padding: 3px 8px; white-space: nowrap; flex-shrink: 0; }
    .upcoming-expand-arrow { font-size: 20px; color: var(--text3); flex-shrink: 0; transition: transform .2s; font-weight: 300; }
    .upcoming-expand-arrow.open { transform: rotate(90deg); }
    .upcoming-detail { padding: 0 14px 14px 44px; display: flex; flex-direction: column; gap: 10px; }
    .upcoming-desc { font-size: 13px; color: var(--text2); line-height: 1.6; border-left: 2px solid var(--border); padding-left: 10px; }
    .upcoming-focus-block { display: flex; flex-direction: column; gap: 4px; }
    .upcoming-focus-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); }
    .upcoming-focus-text { font-size: 13px; color: var(--text2); line-height: 1.6; }

    /* ── ACTUAL KM BADGES ────────────────────────────────────── */
    .actual-km { border-radius: 20px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
    .km-on-track { background: rgba(16,185,129,.15); color: #6ee7b7; }
    .km-under { background: rgba(239,68,68,.12); color: #fca5a5; }
    .km-over { background: rgba(245,158,11,.12); color: #fde68a; }

    /* ── FITNESS TREND ───────────────────────────────────────── */
    .fitness-trend-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 24px 20px; padding: 18px 20px; }
    .fitness-trend-section h2 { color: var(--accent); font-size: 14px; margin-bottom: 3px; }
    .trend-subtitle { font-size: 12px; color: var(--text3); margin-bottom: 12px; }
    .trend-canvas-wrap { background: #0c1525; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
    #trend-canvas { display: block; width: 100%; height: auto; }
    .trend-insight { margin-top: 10px; font-size: 12px; color: var(--text2); }

    /* ── RACE PREDICTOR ──────────────────────────────────────── */
    .predictor-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 24px 20px; padding: 18px 20px; display: flex; gap: 24px; flex-wrap: wrap; align-items: center; }
    .pred-main { flex: 0 0 auto; }
    .pred-time { font-size: 42px; font-weight: 900; line-height: 1; }
    .pred-time.on-track { color: #6ee7b7; }
    .pred-time.off-track { color: #fca5a5; }
    .pred-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; margin-top: 4px; }
    .pred-details { flex: 1; min-width: 200px; }
    .pred-details h2 { color: var(--accent); font-size: 14px; margin-bottom: 6px; }
    .pred-gap { font-size: 13px; margin-bottom: 6px; }
    .pred-gap.fast { color: #6ee7b7; font-weight: 600; }
    .pred-gap.slow { color: #fca5a5; font-weight: 600; }
    .pred-source { font-size: 11px; color: var(--text3); }
    .pred-bar-wrap { flex: 1; min-width: 160px; }
    .pred-bar-track { background: var(--surface2); border-radius: 4px; height: 8px; margin-top: 6px; overflow: hidden; }
    .pred-bar-fill { height: 100%; border-radius: 4px; transition: width .6s; }

    /* ── VOLUME BAR CHART ────────────────────────────────────── */
    .volume-chart-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 24px 20px; padding: 18px 20px; }
    .volume-chart-section h2 { color: var(--accent); font-size: 14px; margin-bottom: 3px; }
    .volume-subtitle { font-size: 12px; color: var(--text3); margin-bottom: 12px; }
    .volume-canvas-wrap { background: #0c1525; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
    #vol-canvas { display: block; width: 100%; height: auto; }

    /* ── KM SPLITS TABLE ─────────────────────────────────────── */
    .splits-table-wrap { margin-top: 14px; max-height: 220px; overflow-y: auto; border-radius: 6px; border: 1px solid var(--border); }
    .splits-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .splits-table th { background: var(--surface); color: var(--text3); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 6px 10px; position: sticky; top: 0; text-align: left; border-bottom: 1px solid var(--border); }
    .splits-table td { padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); color: var(--text2); }
    .splits-table tr:last-child td { border-bottom: none; }
    .splits-table tr:hover td { background: var(--surface2); }
    .split-pace { font-weight: 700; font-family: 'Consolas','Courier New',monospace; }
    .split-hr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
    .split-delta { font-size: 10px; }
    .split-delta.fast { color: #6ee7b7; }
    .split-delta.slow { color: #fca5a5; }

    /* ── RUN ANALYSIS CHART ──────────────────────────────────── */
    .chart-btn { display: inline-block; margin-top: 8px; margin-left: 30px; background: var(--surface2); border: 1px solid var(--border); color: var(--accent); border-radius: 5px; font-size: 11px; font-weight: 600; padding: 4px 10px; cursor: pointer; transition: background .15s; }
    .chart-btn:hover { background: var(--accent); color: #000; border-color: var(--accent); }
    #run-chart-modal .modal-box { width: min(920px, 97vw); }
    .chart-legend { display: flex; gap: 16px; padding: 6px 0 10px; font-size: 12px; color: var(--text2); flex-wrap: wrap; }
    .chart-legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-swatch { width: 24px; height: 4px; border-radius: 2px; }
    .chart-stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
    .chart-stat-box { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; font-size: 12px; color: var(--text2); }
    .chart-stat-box strong { color: var(--text); }
    .chart-canvas-wrap { position: relative; background: #0c1525; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    #run-chart-canvas { display: block; width: 100%; height: auto; }

    /* ── MAIN TABS ───────────────────────────────────────────── */
    .main-tabs { display: flex; gap: 4px; padding: 12px 20px 0; background: var(--surface); border-bottom: 2px solid var(--border); position: sticky; top: 0; z-index: 90; }
    .main-tab { background: transparent; border: none; border-bottom: 3px solid transparent; padding: 10px 18px; font-size: 14px; font-weight: 600; color: var(--text2); cursor: pointer; transition: all .15s; margin-bottom: -2px; border-radius: 6px 6px 0 0; letter-spacing: .01em; display: flex; align-items: center; gap: 6px; }
    .main-tab:hover { color: var(--text); background: var(--surface2); }
    .main-tab.active { color: var(--accent); border-bottom-color: var(--accent); background: var(--surface2); }
    .tab-icon { font-size: 16px; line-height: 1; }
    .tab-label { font-size: 14px; font-weight: 600; }
    .tab-panel { padding: 20px; }

    /* ── TODAY PANEL ─────────────────────────────────────────── */
    .today-panel-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .today-date-heading { font-size: 18px; font-weight: 700; color: var(--text); margin-bottom: 14px; }
    .today-workout-card { background: var(--surface2); border-radius: 10px; padding: 18px; margin-bottom: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .today-workout-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .today-sport-icon { font-size: 28px; line-height: 1; flex-shrink: 0; }
    .today-workout-name { font-size: 16px; font-weight: 700; color: var(--text); }
    .today-workout-detail { font-size: 13px; color: var(--text2); margin-top: 2px; }
    .today-chip { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 10px; white-space: nowrap; }
    .pace-chip { background: rgba(59,130,246,.18); color: #60a5fa; }
    .hr-chip { background: rgba(239,68,68,.15); color: #f87171; }
    .today-session-desc { font-size: 13px; color: var(--text2); line-height: 1.6; margin: 10px 0; border-left: 2px solid var(--border); padding-left: 10px; }
    .today-focus-section { background: var(--surface); border-radius: 8px; padding: 12px; margin-top: 12px; border: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    .today-focus-block { display: flex; flex-direction: column; gap: 4px; }
    .today-focus-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); }
    .today-focus-text { font-size: 13px; color: var(--text); line-height: 1.55; }
    .today-rest-card { background: var(--surface2); border-radius: 10px; padding: 18px; font-size: 14px; color: var(--text2); line-height: 1.6; border: 1px dashed var(--border); }
    .section-sub-title { font-size: 14px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px; }
    .upcoming-section { margin-top: 20px; }
    .upcoming-row { display: grid; grid-template-columns: 80px 1fr auto auto; align-items: center; gap: 8px; background: var(--surface2); border-radius: 7px; padding: 9px 12px; margin-bottom: 6px; }
    .upcoming-date { font-size: 11px; font-weight: 700; color: var(--text3); }
    .upcoming-name { font-size: 13px; font-weight: 600; color: var(--text); }
    .upcoming-km { font-size: 12px; color: var(--text2); }
    .upcoming-pace { font-size: 12px; color: var(--accent); }

    /* ── WORKOUT RATIONALE (Plan tab expanded cards) ─────────── */
    .workout-rationale { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
    .rationale-block { display: flex; flex-direction: column; gap: 3px; }
    .rationale-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); }
    .rationale-text { font-size: 12px; color: var(--text2); line-height: 1.55; }
    .str-exercise-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .str-exercise-list li { font-size: 12px; color: var(--text2); line-height: 1.45; padding-left: 14px; position: relative; }
    .str-exercise-list li::before { content: '—'; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
    .dl-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--accent); border-radius: 6px; font-size: 12px; font-weight: 600; padding: 6px 14px; cursor: pointer; transition: background .15s; }
    .dl-btn:hover { background: var(--accent); color: #000; }

    /* ── STRAVA ACTIVITY FEEDBACK (Plan tab) ─────────────────── */
    .act-feedback { background: rgba(59,130,246,.07); border: 1px solid rgba(59,130,246,.2); border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
    .act-feedback-miss { background: rgba(239,68,68,.07); border-color: rgba(239,68,68,.2); font-size: 12px; color: var(--text2); }
    .act-feedback-header { font-size: 11px; font-weight: 700; color: var(--accent); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .act-feedback-meta { font-weight: 400; color: var(--text2); font-size: 11px; }
    .act-feedback-body { display: flex; flex-direction: column; gap: 4px; }
    .fb-line { font-size: 12px; color: var(--text2); line-height: 1.5; }
    .fb-well { font-size: 12px; color: #86efac; line-height: 1.5; }
    .fb-improve { font-size: 12px; color: #fde68a; line-height: 1.5; }

    /* ── AUTO-COMPLETE CARD STATES ───────────────────────────── */
    .workout-card.auto-done { opacity: 0.82; }
    .workout-card.auto-done .workout-name { text-decoration: line-through; text-decoration-color: #22c55e60; }
    .workout-card.auto-miss .workout-name { text-decoration: line-through; text-decoration-color: #ef444470; }
  </style>
</head>
<body>
<!-- PASSWORD GATE -->
<div id="pw-gate">
  <h1>🏃 Coach</h1>
  <p>Enter your password to access the training plan.</p>
  <div id="pw-form">
    <input id="pw-input" type="password" placeholder="Password" autocomplete="current-password">
    <button id="pw-btn" type="button">Unlock</button>
  </div>
  <div id="pw-err"></div>
</div>
<script>
(function() {
  const HASH = '9cd69e6cdd426e2df45364f2fa1e2d07612237f098fb26225a1ef2c1a62ec4a7';
  const SESSION_KEY = 'coach_unlocked';
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  function unlock() {
    document.getElementById('pw-gate').classList.add('hidden');
    sessionStorage.setItem(SESSION_KEY, '1');
  }
  if (sessionStorage.getItem(SESSION_KEY) === '1') { unlock(); return; }
  document.getElementById('pw-btn').addEventListener('click', async () => {
    const val = document.getElementById('pw-input').value;
    const h = await sha256(val);
    if (h === HASH) { unlock(); }
    else {
      const err = document.getElementById('pw-err');
      err.textContent = 'Incorrect password.';
      document.getElementById('pw-input').value = '';
      setTimeout(() => { err.textContent = ''; }, 3000);
    }
  });
  document.getElementById('pw-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('pw-btn').click();
  });
})();
</script>

<!-- HEADER -->
<header class="plan-header">
  <div class="plan-title">🏃 Half Marathon Training Plan</div>
  <div class="plan-subtitle">${plan.meta.athlete} · Sep 20, 2026 · Goal: <strong style="color:var(--accent)">${plan.meta.goalTime}</strong> (${plan.meta.racePacePerKm}/km)</div>
  <div class="plan-stats">
    <div class="stat-box"><div class="stat-value">16</div><div class="stat-label">Weeks</div></div>
    <div class="stat-box"><div class="stat-value">${totalKm}</div><div class="stat-label">Total km</div></div>
    <div class="stat-box"><div class="stat-value">6</div><div class="stat-label">Days/week</div></div>
    <div class="stat-box"><div class="stat-value">2–3×</div><div class="stat-label">Strength/week</div></div>
    <div class="stat-box"><div class="stat-value">Jun 1</div><div class="stat-label">Start Date</div></div>
    <div class="stat-box"><div class="stat-value">Sep 20</div><div class="stat-label">Race Day</div></div>
  </div>
  <div style="margin-top:16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px">
    <button class="export-all-btn" onclick="exportAll()">⬇ Download Full Plan (.txt)</button>
    <button class="theme-toggle" onclick="toggleTheme()" id="theme-btn">☀️ Light Mode</button>
    <span style="color:var(--text3);font-size:12px;margin-left:12px">Click any workout card to expand · Click ↓ to export that session · Press E to expand all</span>
  </div>
</header>

<!-- COUNTDOWN BAR -->
<div class="countdown-bar">
  <div class="cd-block"><div class="cd-value" id="cd-days">—</div><div class="cd-label">days to race</div></div>
  <span class="cd-sep">│</span>
  <div class="cd-block"><div class="cd-value" id="cd-weeks">—</div><div class="cd-label">weeks left</div></div>
  <span class="cd-sep">│</span>
  <div id="next-session-pill-wrap"></div>
  <div class="plan-prog-wrap" id="plan-prog-wrap" style="display:none">
    <span style="font-size:11px;color:var(--text3)">Plan progress</span>
    <div class="plan-prog-bar"><div class="plan-prog-fill" id="plan-prog-fill" style="width:0%"></div></div>
    <span style="font-size:11px;color:var(--text2)" id="plan-prog-label"></span>
  </div>
</div>

<!-- MAIN TABS -->
<nav class="main-tabs">
  <button class="main-tab active" onclick="switchMainTab('today')"><span class="tab-icon">📅</span><span class="tab-label">Today</span></button>
  <button class="main-tab" onclick="switchMainTab('plan')"><span class="tab-icon">📋</span><span class="tab-label">Plan</span></button>
  <button class="main-tab" onclick="switchMainTab('strategy')"><span class="tab-icon">🏁</span><span class="tab-label">Strategy</span></button>
  <button class="main-tab" onclick="switchMainTab('stats')"><span class="tab-icon">📊</span><span class="tab-label">Stats</span></button>
</nav>

<!-- TAB: TODAY -->
<div id="maintab-today" class="tab-panel">
  ${todayPanelHtml()}
</div>

<!-- TAB: PLAN -->
<div id="maintab-plan" class="tab-panel" style="display:none">
  <div class="weeks-container">
    ${planWeeksHtml}
  </div>
</div>

<!-- TAB: STRATEGY -->
<div id="maintab-strategy" class="tab-panel" style="display:none">

<!-- RACE STRATEGY -->
<div class="race-strategy">
  <h2>🏁 Race Strategy — Sub 1:40:00</h2>
  <div class="strategy-grid">
    <div class="strategy-card">
      <h3>Goals</h3>
      <p>🥇 <strong>A:</strong> Sub 1:40:00<br>🥈 <strong>B:</strong> Sub 1:45:00<br>🥉 <strong>C:</strong> Sub 1:50:00 (guaranteed PB)</p>
    </div>
    <div class="strategy-card">
      <h3>Pacing</h3>
      <p class="pace-goal">4:44/km</p>
      <p style="margin-top:4px;font-size:12px;">Km 1–3: 4:50–4:55 (controlled)<br>Km 4–15: 4:44 (lock in)<br>Km 16–21: Push if feeling good</p>
    </div>
    <div class="strategy-card">
      <h3>Nutrition</h3>
      <p>Breakfast 3hr before<br>1 gel at km 7–8<br>1 gel at km 13–14<br>Water at every station</p>
    </div>
    <div class="strategy-card">
      <h3>Warm-Up</h3>
      <p>10 min easy jog + 4 strides, 30 min before gun. Don't stand in the queue.</p>
    </div>
    <div class="strategy-card">
      <h3>Taper</h3>
      <p>Starts Aug 31 (Week 14). Volume –40% over 3 weeks. Intensity maintained. Trust the process.</p>
    </div>
    <div class="strategy-card">
      <h3>Weather</h3>
      <p>Sept in Portugal: likely warm. Start conservative if >20°C. Add 5–10 sec/km for heat.</p>
    </div>
  </div>
</div>

<!-- TRAINING ZONES -->
<div class="zones-section">
  <h2>📊 Training Zones (Estimated LTHR: 167 bpm)</h2>
  <table class="zone-table">
    <thead><tr><th>Zone</th><th>Name</th><th>HR Range</th><th>Pace Range</th><th>Feel</th></tr></thead>
    <tbody>
      <tr><td><span class="zone-dot" style="background:#6ee7b7"></span>Z1</td><td>Recovery</td><td>&lt;135 bpm</td><td>&gt;6:30/km</td><td>Very easy, sing if you want</td></tr>
      <tr><td><span class="zone-dot" style="background:#3b82f6"></span>Z2</td><td>Aerobic</td><td>135–149 bpm</td><td>5:50–6:15/km</td><td>Easy, full conversations</td></tr>
      <tr><td><span class="zone-dot" style="background:#f97316"></span>Z3</td><td>Tempo</td><td>150–155 bpm</td><td>5:10–5:30/km</td><td>Moderate, short sentences</td></tr>
      <tr><td><span class="zone-dot" style="background:#ef4444"></span>Z4</td><td>Sub-threshold</td><td>157–166 bpm</td><td>4:48–5:10/km</td><td>Hard, few words</td></tr>
      <tr><td><span class="zone-dot" style="background:#7c3aed"></span>Z5</td><td>VO₂max</td><td>&gt;167 bpm</td><td>4:25–4:35/km</td><td>Very hard, can't talk</td></tr>
      <tr style="font-weight:700;color:#f59e0b"><td>⭐ RP</td><td>Race Pace</td><td>160–167 bpm</td><td>4:44/km</td><td>Controlled hard — race effort</td></tr>
    </tbody>
  </table>
</div>

<!-- PHASE LEGEND -->
<div class="phase-legend">
  <div class="legend-item"><div class="legend-dot" style="background:#6b7280"></div>Recovery</div>
  <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div>Base</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f97316"></div>Build</div>
  <div class="legend-item"><div class="legend-dot" style="background:#8b5cf6"></div>Taper</div>
  <div class="legend-item">🏃 Easy</div>
  <div class="legend-item">🏃 Long</div>
  <div class="legend-item">⚡ Tempo</div>
  <div class="legend-item">🔥 Intervals</div>
  <div class="legend-item">💨 Strides</div>
  <div class="legend-item">💪 Strength</div>
  <div class="legend-item">😴 Rest</div>
</div>

</div><!-- /maintab-strategy -->

<!-- TAB: STATS -->
<div id="maintab-stats" class="tab-panel" style="display:none">

<!-- RACE PREDICTOR -->
${racePrediction ? (() => {
  const { timeStr, paceStr, gapSec, srcDistKm, srcPaceStr, srcDate, onTrack } = racePrediction;
  const gapAbs = Math.abs(gapSec);
  const gapMins = Math.floor(gapAbs / 60), gapSecs = gapAbs % 60;
  const gapStr = gapMins > 0 ? `${gapMins}m ${gapSecs}s` : `${gapSecs}s`;
  const gapText = onTrack
    ? `✅ <span class="pred-gap fast">You're ${gapStr} under target pace</span> — on track for sub-1:40!`
    : `⏳ <span class="pred-gap slow">Currently ${gapStr} over target</span> — keep building fitness`;
  // Progress bar: 0% = 1:50 (6600s), 100% = 1:40 (6000s), > 100% = on track
  const secFor150 = 6600, secFor140 = 6000;
  const barPct = Math.min(100, Math.max(0, Math.round((secFor150 - racePrediction.predicted) / (secFor150 - secFor140) * 100)));
  const barColor = onTrack ? '#6ee7b7' : barPct > 60 ? '#f59e0b' : '#ef4444';
  return `<div class="predictor-section">
  <div class="pred-main">
    <div class="pred-time ${onTrack ? 'on-track' : 'off-track'}">${timeStr}</div>
    <div class="pred-label">Predicted half marathon</div>
  </div>
  <div class="pred-details">
    <h2>🏁 Race Time Predictor</h2>
    <div class="pred-gap">${gapText}</div>
    <div class="pred-source">Based on ${srcDistKm}km @ ${srcPaceStr} on ${new Date(srcDate).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} · Riegel formula</div>
  </div>
  <div class="pred-bar-wrap">
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3)"><span>1:50</span><span>🎯 1:40</span></div>
    <div class="pred-bar-track"><div class="pred-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
    <div style="font-size:10px;color:var(--text3);margin-top:4px">Pace @ race pace: ${paceStr} · Target: 4:44/km</div>
  </div>
</div>`;
})() : ''}

<!-- VOLUME BAR CHART -->
<div class="volume-chart-section">
  <h2>📊 Weekly Training Volume</h2>
  <div class="volume-subtitle">Planned km (grey) vs actual km run (coloured) · 16-week plan</div>
  <div class="volume-canvas-wrap"><canvas id="vol-canvas" width="860" height="140"></canvas></div>
</div>

<!-- FITNESS TREND -->
${fitnessTrend.length >= 2 ? `
<div class="fitness-trend-section">
  <h2>\u{1F4C8} Aerobic Fitness Trend \u2014 Z2 Pace Over Time</h2>
  <div class="trend-subtitle">Avg pace on easy (Z2: 135\u2013149 bpm) runs each week \u00b7 lower = faster = fitter</div>
  <div class="trend-canvas-wrap"><canvas id="trend-canvas" width="860" height="160"></canvas></div>
  <div class="trend-insight" id="trend-insight"></div>
</div>` : ''}

</div><!-- /maintab-stats -->

<script>
// ── DATA CONSTANTS ───────────────────────────────────────────
const TODAY = '${todayStr}';
const RACE_DATE = '${plan.meta.eventDate}';
const PLAN_START = '${plan.meta.planStartDate}';
const PLAN_TOTAL_WEEKS = ${plan.meta.totalWeeks};
window.FITNESS_TREND = ${JSON.stringify(fitnessTrend)};
window.ACTUAL_KM = ${JSON.stringify(actualKmByWeek)};
window.PLAN_WEEKS_KM = ${JSON.stringify(plan.weeks.map(w => ({ start: w.startDate, planned: w.summary?.totalKm || 0, wk: w.weekNumber })))};
window.RACE_PRED = ${JSON.stringify(racePrediction)};

// Plan day index for "next quality session"
const PLAN_DAYS = ${JSON.stringify(
  plan.weeks.flatMap(wk => wk.days.map(d => ({
    date: d.date,
    weekNum: wk.weekNumber,
    workouts: d.workouts.map(w => ({ id: w.id, sport: w.sport, type: w.type, name: w.name }))
  })))
)};

// ── WORKOUT LOOKUP MAP ───────────────────────────────────────
const WORKOUT_MAP = ${JSON.stringify(
  Object.fromEntries(
    plan.weeks.flatMap(wk => wk.days.flatMap(d => d.workouts.map(w => [w.id, w])))
  )
)};

// ── EXPAND / COLLAPSE ────────────────────────────────────────
function toggleDetail(card) {
  const body = card.querySelector('.workout-body');
  const isOpen = body.style.display !== 'none' && body.style.display !== '';
  body.style.display = isOpen ? 'none' : 'block';
  card.classList.toggle('open', !isOpen);
}

// ── MARK COMPLETE ────────────────────────────────────────────
function toggleComplete(event, el, id) {
  event.stopPropagation();
  const key = 'coach_complete_' + id;
  const done = localStorage.getItem(key) === '1';
  localStorage.setItem(key, done ? '0' : '1');
  el.textContent = done ? '⬜' : '✅';
}

// ── RESTORE STATE ON LOAD ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.workout-check').forEach(el => {
    const id = el.getAttribute('onclick').match(/'([^']+)'/)?.[1];
    if (id && localStorage.getItem('coach_complete_' + id) === '1') {
      el.textContent = '✅';
    }
  });
});

// ── EXPORT WORKOUT ───────────────────────────────────────────
function exportWorkout(event, btn) {
  event.stopPropagation();
  const w = WORKOUT_MAP[btn.dataset.wid];
  if (!w) return;
  showExportModal(w);
}

function showExportModal(w) {
  const existing = document.getElementById('export-modal');
  if (existing) existing.remove();

  window._currentWorkout = w;
  const text = buildTextExport(w);
  const zeppSteps = buildZeppManual(w);
  const zeppJson = buildZeppJson(w);

  const modal = document.createElement('div');
  modal.id = 'export-modal';
  modal.innerHTML = \`
    <div class="modal-overlay" onclick="closeModal()"></div>
    <div class="modal-box">
      <div class="modal-header">
        <span>Export: \${w.name}</span>
        <button onclick="closeModal()" class="modal-close">✕</button>
      </div>
      <div class="modal-tabs">
        <button class="tab active" onclick="switchTab(this,'tab-text')">📄 Text</button>
        <button class="tab" onclick="switchTab(this,'tab-fit')">⌚ .FIT File</button>
        <button class="tab" onclick="switchTab(this,'tab-zepp-json')">📱 Zepp JSON</button>
        <button class="tab" onclick="switchTab(this,'tab-zepp')">📝 Zepp Steps</button>
      </div>
      <div id="tab-text" class="tab-content">
        <pre class="export-pre">\${text}</pre>
        <button class="dl-btn" onclick="downloadText('\${w.id}.txt', document.querySelector('#tab-text pre').textContent)">⬇ Download .txt</button>
        <button class="dl-btn" onclick="copyText(document.querySelector('#tab-text pre').textContent)">📋 Copy</button>
      </div>
      <div id="tab-fit" class="tab-content" style="display:none">
        <p class="export-info">⌚ <strong>Garmin FIT Structured Workout (.fit)</strong><br>
        Real binary FIT file — warm-up, intervals, cool-down and pace targets encoded to Garmin FIT protocol.<br><br>
        ✅ <strong>Garmin Connect:</strong> My Workouts → Import → select .fit → sync to watch<br>
        ✅ <strong>TrainingPeaks / intervals.icu / Wahoo SYSTM:</strong> Upload .fit directly<br>
        ⚠️ <strong>Zepp / Amazfit:</strong> use the Zepp JSON tab instead</p>
        <button class="dl-btn" style="font-size:14px;padding:10px 24px;margin-top:4px" onclick="downloadFit(window._currentWorkout)">⬇ Download .fit</button>
      </div>
      <div id="tab-zepp-json" class="tab-content" style="display:none">
        <p class="export-info">📱 <strong>Zepp / Amazfit — Importable JSON</strong><br>
        This JSON matches the Zepp training template sharing format (same format used by Zepp share links).<br><br>
        <strong>How to use:</strong><br>
        1. Download the JSON file below<br>
        2. Open the Zepp app → Training → Custom Workout → top-right menu → Import<br>
        <em>If Zepp import is unavailable on your watch, use the Zepp Steps tab for manual entry.</em></p>
        <pre class="export-pre">\${escapeHtml(zeppJson)}</pre>
        <button class="dl-btn" onclick="downloadText('\${w.id}-zepp.json', document.querySelector('#tab-zepp-json pre').textContent)">⬇ Download Zepp JSON</button>
        <button class="dl-btn" onclick="copyText(document.querySelector('#tab-zepp-json pre').textContent)">📋 Copy JSON</button>
      </div>
      <div id="tab-zepp" class="tab-content" style="display:none">
        <p class="export-info">📝 <strong>Manual entry steps for Zepp App:</strong><br>
        Training → Custom Workout → + → Running → add each step below</p>
        <pre class="export-pre">\${escapeHtml(zeppSteps)}</pre>
        <button class="dl-btn" onclick="copyText(document.querySelector('#tab-zepp pre').textContent)">📋 Copy steps</button>
        <button class="dl-btn" onclick="downloadText('\${w.id}-zepp-steps.txt', document.querySelector('#tab-zepp pre').textContent)">⬇ Download .txt</button>
      </div>
    </div>
  \`;
  document.body.appendChild(modal);
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function closeModal() { document.getElementById('export-modal')?.remove(); }
function switchTab(btn, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.style.display='none');
  btn.classList.add('active');
  document.getElementById(id).style.display='block';
}
function downloadText(name, content) {
  const a = document.createElement('a');
  a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
  a.download = decodeURIComponent(name);
  a.click();
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
}

// ── TEXT EXPORT ──────────────────────────────────────────────
function buildTextExport(w) {
  const lines = [
    '═══════════════════════════════════════════════',
    w.name.toUpperCase(),
    '═══════════════════════════════════════════════',
    '',
    w.description || '',
    '',
  ];
  if (w.distanceKm) lines.push('Distance  : ' + w.distanceKm + ' km');
  if (w.durationMinutes) lines.push('Duration  : ' + w.durationMinutes + ' min');
  if (w.targetPace) lines.push('Target    : ' + w.targetPace);
  if (w.targetHR) lines.push('Heart Rate: ' + w.targetHR);
  if (w.primaryZone) lines.push('Zone      : ' + w.primaryZone);
  if (w.humanReadable) {
    lines.push('');
    lines.push('SESSION STRUCTURE');
    lines.push('─────────────────');
    lines.push(w.humanReadable.replace(/<br>/g,'\\n'));
  }
  return lines.join('\\n');
}

// ── FIT BINARY ENCODER ───────────────────────────────────────
function fitCrc16(data) {
  const t = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,
             0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400];
  let crc = 0;
  for (const b of data) {
    crc = (crc >> 4) ^ t[crc & 0xF] ^ t[b & 0xF];
    crc = (crc >> 4) ^ t[crc & 0xF] ^ t[(b >> 4) & 0xF];
  }
  return crc;
}

function paceStrToMms(paceStr) {
  if (!paceStr) return null;
  const times = [...paceStr.matchAll(/(\\d+):(\\d+)/g)];
  if (!times.length) return null;
  const toMms = ([,m,s]) => Math.round(1000000 / (parseInt(m)*60 + parseInt(s)));
  const speeds = times.map(toMms);
  if (speeds.length === 1) return { low: Math.round(speeds[0]*0.97), high: Math.round(speeds[0]*1.04) };
  return { low: Math.min(...speeds), high: Math.max(...speeds) };
}

function workoutToFitSteps(w) {
  const mainSpd = paceStrToMms(w.targetPace);
  const easy = { low: 2667, high: 2857 }; // 6:15–5:50/km in mm/s
  const ps = (distM, durMs, spd, intensity) => ({ distanceM:distM, durationMs:durMs, speedLow:spd?.low, speedHigh:spd?.high, intensity });
  const os = (distM, durMs, intensity) => ({ distanceM:distM, durationMs:durMs, intensity });
  const steps = [];
  if (w.type === 'rest' || w.type === 'strength') return [];
  if (w.type === 'easy' || w.type === 'recovery')
    return [ps((w.distanceKm||8)*1000, null, mainSpd||easy, 0)];
  if (w.type === 'strides') {
    const n = parseInt(w.humanReadable?.match(/(\\d+)[×x]/)?.[1] || '6');
    steps.push(ps(Math.max(2000,(w.distanceKm||8)*1000 - n*200), null, easy, 0));
    for (let i=0; i<n; i++) { steps.push(ps(200, null, {low:3846,high:4167}, 0)); steps.push(os(null,90000,1)); }
    return steps;
  }
  if (w.type === 'intervals') {
    const rep = w.humanReadable?.match(/(\\d+)[×x](\\d+)/i);
    const reps = rep ? parseInt(rep[1]) : 4, repM = rep ? parseInt(rep[2]) : 1000;
    steps.push(os(2000, null, 2));
    for (let i=0; i<reps; i++) { steps.push(ps(repM, null, mainSpd, 0)); steps.push(os(null,150000,1)); }
    steps.push(os(1500, null, 3));
    return steps;
  }
  if (w.type === 'tempo') {
    const dur = w.humanReadable?.match(/(\\d+)\\s*min/)?.[1];
    steps.push(os(2000, null, 2));
    steps.push(ps(null, parseInt(dur||25)*60000, mainSpd, 0));
    steps.push(os(2000, null, 3));
    return steps;
  }
  if (w.type === 'long') {
    const rk = parseInt(w.description?.match(/Last (\\d+)km/)?.[1] || '0');
    const ek = Math.max(1, (w.distanceKm||15) - rk);
    steps.push(ps(ek*1000, null, easy, 0));
    if (rk > 0) steps.push(ps(rk*1000, null, {low:3333,high:3521}, 0)); // 4:44–5:00/km
    return steps;
  }
  return [ps((w.distanceKm||5)*1000, null, mainSpd||easy, 0)];
}

function buildFitFile(workoutName, steps) {
  const FIT_EPOCH = 631065600; // seconds from Unix epoch to FIT epoch (Dec 31 1989)
  const buf = [];
  const u8  = v => buf.push(v & 0xFF);
  const u16 = v => { u8(v & 0xFF); u8((v >> 8) & 0xFF); };
  const u32 = v => { u16(v & 0xFFFF); u16((v >>> 16) & 0xFFFF); };
  const str = (s,n) => { for (let i=0;i<n;i++) buf.push(i<s.length?s.charCodeAt(i)&0xFF:0); };
  // Definition msg 0: FILE_ID (global mesg_num=0)
  u8(0x40); u8(0); u8(0); u16(0); u8(3);
  u8(0); u8(1); u8(0x00);  // field 0: type, ENUM
  u8(1); u8(2); u8(0x84);  // field 1: manufacturer, UINT16
  u8(4); u8(4); u8(0x86);  // field 4: time_created, UINT32
  // Data msg 0: FILE_ID
  u8(0); u8(5); u16(255); u32(Math.floor(Date.now()/1000) - FIT_EPOCH);
  // Definition msg 1: WORKOUT (global mesg_num=26)
  u8(0x41); u8(0); u8(0); u16(26); u8(3);
  u8(4);  u8(1);  u8(0x00); // field 4: sport, ENUM (1=running)
  u8(6);  u8(2);  u8(0x84); // field 6: num_valid_steps, UINT16
  u8(8);  u8(16); u8(0x07); // field 8: wkt_name, STRING[16]
  // Data msg 1: WORKOUT
  u8(1); u8(1); u16(steps.length); str(workoutName.substring(0,15), 16);
  // Definition msg 2: WORKOUT_STEP (global mesg_num=27)
  u8(0x42); u8(0); u8(0); u16(27); u8(7);
  u8(254); u8(2); u8(0x84); // field 254: message_index, UINT16
  u8(1);   u8(1); u8(0x00); // field 1: duration_type, ENUM
  u8(2);   u8(4); u8(0x86); // field 2: duration_value, UINT32
  u8(3);   u8(1); u8(0x00); // field 3: target_type, ENUM
  u8(5);   u8(4); u8(0x86); // field 5: target_value_low, UINT32
  u8(6);   u8(4); u8(0x86); // field 6: target_value_high, UINT32
  u8(7);   u8(1); u8(0x00); // field 7: intensity, ENUM
  // Data msg 2: one per step
  for (let i=0; i<steps.length; i++) {
    const s = steps[i];
    u8(2); u16(i); // local msg header + message_index
    if (s.distanceM)       { u8(1); u32(Math.round(s.distanceM * 100)); } // distance in cm
    else if (s.durationMs) { u8(0); u32(Math.round(s.durationMs)); }       // time in ms
    else                   { u8(5); u32(0xFFFFFFFF); }                      // open
    if (s.speedLow && s.speedHigh) { u8(0); u32(s.speedLow); u32(s.speedHigh); } // speed mm/s
    else                           { u8(2); u32(0); u32(0); }                      // open target
    u8(s.intensity || 0); // 0=active 1=rest 2=warmup 3=cooldown
  }
  // Assemble: 14-byte header + body + 2-byte file CRC
  const bodyLen = buf.length;
  const hdr = [14, 0x20, 0x54, 0x08,
    bodyLen&0xFF,(bodyLen>>8)&0xFF,(bodyLen>>16)&0xFF,(bodyLen>>24)&0xFF,
    0x2E,0x46,0x49,0x54]; // ".FIT"
  const hdrCrc = fitCrc16(hdr);
  hdr.push(hdrCrc & 0xFF, (hdrCrc >> 8) & 0xFF);
  const all = [...hdr, ...buf];
  const fileCrc = fitCrc16(all);
  all.push(fileCrc & 0xFF, (fileCrc >> 8) & 0xFF);
  return new Uint8Array(all);
}

function downloadFit(w) {
  const steps = workoutToFitSteps(w);
  if (!steps.length) { alert('No steps for this workout type.'); return; }
  const data = buildFitFile(w.name, steps);
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = w.id + '.fit'; a.click();
  URL.revokeObjectURL(url);
}

// ── ZEPP JSON EXPORT (Zepp sharing format) ───────────────────
function buildZeppJson(w) {
  // Pace string (e.g. "5:50–6:15/km") → seconds/km range [low, high] (lower sec = faster)
  const paceToSec = (paceStr) => {
    if (!paceStr) return null;
    const times = [...paceStr.matchAll(/(\\d+):(\\d+)/g)];
    if (!times.length) return null;
    return times.map(([,m,s]) => parseInt(m)*60+parseInt(s)).sort((a,b)=>a-b); // [faster, slower]
  };
  const steps = workoutToFitSteps(w);
  if (!steps.length) return JSON.stringify({error:'Rest or strength — no running steps'}, null, 2);

  // Convert FIT steps back to Zepp interval nodes
  // intervalType: 1=time(ms->s), 2=distance(cm->m?), 5=open
  // intervalUnit: 1=seconds, 2=meters, 8=open
  // alertRule: 0=none, 1=pace
  // alertRuleDetail: "low_sec-high_sec" (seconds per km, slower first)
  const paceRange = paceToSec(w.targetPace);
  const easyRange = [210, 225]; // 3:30–3:45/km... wait — seconds/km: easy is 350–375s/km (5:50–6:15)
  const easySecRange = [350, 375];
  const mainSecRange = paceRange || [284, 300]; // 4:44–5:00/km

  const children = steps.map((s, i) => {
    let intervalType, intervalUnit, intervalUnitValue;
    if (s.distanceM) {
      intervalType = '2'; intervalUnit = '2'; intervalUnitValue = String(Math.round(s.distanceM));
    } else if (s.durationMs) {
      intervalType = '1'; intervalUnit = '1'; intervalUnitValue = String(Math.round(s.durationMs / 1000));
    } else {
      intervalType = '5'; intervalUnit = '8'; intervalUnitValue = '0';
    }
    const isEasy = s.intensity === 1 || s.intensity === 2 || s.intensity === 3; // rest/warmup/cooldown
    const secRange = isEasy ? easySecRange : mainSecRange;
    const alertRule = '1';
    const alertRuleDetail = secRange[0] + '-' + secRange[1];
    return {
      type: 'NODE',
      trainingInterval: {
        intervalType, intervalUnit, intervalUnitValue,
        alertRule,
        alertRuleDetail,
        lengthUnit: 0,
        intervalTypeI18nKey: intervalType==='2'?'gapType_distance':intervalType==='1'?'gapType_time':'gapType_open',
        alertRuleI18nKey: 'trainRemind_pace,,gap_Km',
        lengthUnitI18nKey: 'gap_metric',
        actionName: '',
        selfWeightType: 0,
        mainPositions: [],
        subPositions: []
      }
    };
  });

  const template = {
    username: 'Coach Plan',
    avatar: '',
    shareUrl: '',
    title: w.name,
    description: (w.description || '') + (w.targetPace ? ' | Target: ' + w.targetPace : ''),
    trainingIntervals: { type: 'PARENT', children }
  };
  return JSON.stringify(template, null, 2);
}

// ── ZEPP MANUAL STEPS ────────────────────────────────────────
function buildZeppManual(w) {
  const TYPES = ['Active','Rest','Warmup','Cooldown'];
  const steps = workoutToFitSteps(w);
  if (!steps.length) return 'Rest or strength day — no running steps to configure.';
  const toPace = v => { const t=Math.round(1000000/v); return Math.floor(t/60)+':'+(t%60).toString().padStart(2,'0'); };
  const lines = [
    'WORKOUT: ' + w.name,
    'Sport: Running  |  Target: ' + (w.targetPace||'open') + '  |  ' + (w.primaryZone||''),
    '',
    'HOW TO ADD IN ZEPP APP:',
    '  Training -> Custom Workout -> + -> Running',
    '  Add each step below, save, then sync to your watch',
    '-----------------------------------------------------------',
    '',
  ];
  steps.forEach((s, i) => {
    const type = TYPES[s.intensity||0];
    const dur = s.distanceM
      ? 'Distance: ' + (s.distanceM >= 1000 ? (s.distanceM/1000).toFixed(1)+'km' : s.distanceM+'m')
      : s.durationMs
        ? 'Time: ' + Math.floor(s.durationMs/60000) + 'min ' + Math.round((s.durationMs%60000)/1000) + 'sec'
        : 'Open — tap to stop';
    const tgt = (s.speedLow && s.speedHigh)
      ? 'Pace: ' + toPace(s.speedHigh) + ' - ' + toPace(s.speedLow) + '/km'
      : 'No target (easy effort)';
    lines.push('Step ' + (i+1) + ': [' + type + ']');
    lines.push('  Duration : ' + dur);
    lines.push('  Target   : ' + tgt);
    lines.push('');
  });
  lines.push('Tip: In Zepp app, set target type to "Pace" for each active/tempo step.');
  return lines.join('\\n');
}

// ── GLOBAL EXPORT ALL ────────────────────────────────────────
const PLAN_DATA = ${JSON.stringify({meta: plan.meta, weeks: plan.weeks.map(w => ({weekNumber: w.weekNumber, phase: w.phase, focus: w.focus, days: w.days}))})};
function exportAll() {
  const plan = PLAN_DATA;  const lines = ['HALF MARATHON TRAINING PLAN — ' + plan.meta.athlete, 'Goal: ' + plan.meta.goalTime + ' | Race: ' + plan.meta.eventDate, ''];
  for (const week of plan.weeks) {
    lines.push('══ WEEK ' + week.weekNumber + ' — ' + week.phase + ' ══');
    lines.push(week.focus);
    for (const day of week.days) {
      for (const w of day.workouts) {
        const dist = w.distanceKm ? w.distanceKm+'km' : '';
        const dur = w.durationMinutes ? w.durationMinutes+'min' : '';
        lines.push('  ' + day.dayOfWeek.padEnd(11) + w.name + (dist?' ('+[dist,dur].filter(Boolean).join(', ')+')':''));
        if (w.targetPace) lines.push('             🎯 ' + w.targetPace);
        if (w.humanReadable) lines.push('             ' + w.humanReadable.replace(/<br>/g,'\\n             ').replace(/\\n/g,'\\n             '));
      }
    }
    lines.push('');
  }
  downloadText('half-marathon-training-plan.txt', lines.join('\\n'));
}

// ── THEME TOGGLE ─────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  html.setAttribute('data-theme', isLight ? 'dark' : 'light');
  document.getElementById('theme-btn').textContent = isLight ? '☀️ Light Mode' : '🌙 Dark Mode';
  localStorage.setItem('coach_theme', isLight ? 'dark' : 'light');
}
(function() {
  const saved = localStorage.getItem('coach_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = saved === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode';
  });
})();

// ── COUNTDOWN + NEXT SESSION + PROGRESS ─────────────────────
(function initCountdown() {
  const race = new Date(RACE_DATE);
  const today = new Date(TODAY);
  const daysLeft = Math.max(0, Math.ceil((race - today) / 86400000));
  const weeksLeft = Math.ceil(daysLeft / 7);
  document.getElementById('cd-days').textContent = daysLeft || '🏁';
  document.getElementById('cd-weeks').textContent = weeksLeft || '🏁';

  // Plan progress bar
  const planStart = new Date(PLAN_START);
  if (today >= planStart && today <= race) {
    const pct = Math.min(100, Math.round((today - planStart) / (race - planStart) * 100));
    const weeksDone = Math.min(PLAN_TOTAL_WEEKS, Math.floor((today - planStart) / 604800000) + 1);
    const wrap = document.getElementById('plan-prog-wrap');
    if (wrap) { wrap.style.display = 'flex'; }
    const fill = document.getElementById('plan-prog-fill');
    if (fill) fill.style.width = pct + '%';
    const lbl = document.getElementById('plan-prog-label');
    if (lbl) lbl.textContent = \`Wk \${weeksDone}/\${PLAN_TOTAL_WEEKS}\`;
  }

  // Next quality session
  const qualTypes = new Set(['tempo', 'intervals', 'strides', 'race']);
  const nextQuality = PLAN_DAYS.find(d =>
    new Date(d.date) > today &&
    d.workouts.some(w => w.sport === 'run' && qualTypes.has(w.type))
  );
  const pill = document.getElementById('next-session-pill-wrap');
  if (pill && nextQuality) {
    const q = nextQuality.workouts.find(w => w.sport === 'run' && qualTypes.has(w.type));
    const dt = new Date(nextQuality.date);
    const dow = dt.toLocaleDateString('en-GB', { weekday: 'long' });
    const ds = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    pill.innerHTML = \`<div class="next-session-pill">🎯 Next quality: <strong>\${q.name}</strong> · \${dow} \${ds} · Wk \${nextQuality.weekNum}</div>\`;
  }
})();

// ── TODAY HIGHLIGHT + AUTO-SCROLL ────────────────────────────
(function highlightToday() {
  const col = document.querySelector(\`.day-col[data-date="\${TODAY}"]\`);
  if (!col) return;
  col.classList.add('today-col');
  const nameEl = col.querySelector('.day-name');
  if (nameEl) { const m = document.createElement('span'); m.className = 'today-marker'; m.textContent = 'TODAY'; nameEl.appendChild(m); }
  setTimeout(() => col.closest('.week-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
})();

// ── FITNESS TREND CHART ───────────────────────────────────────
(function drawFitnessTrend() {
  const canvas = document.getElementById('trend-canvas');
  if (!canvas || !window.FITNESS_TREND || window.FITNESS_TREND.length < 2) return;
  const data = window.FITNESS_TREND;
  const dpr = window.devicePixelRatio || 1;
  const displayW = canvas.clientWidth || 860;
  const displayH = 160;
  canvas.width = displayW * dpr; canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px'; canvas.style.height = displayH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = displayW, H = displayH;
  const PAD = { top: 16, right: 24, bottom: 30, left: 52 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;

  ctx.fillStyle = '#0c1525'; ctx.fillRect(0, 0, W, H);

  const paces = data.map(d => d.avgPace);
  const pMin = Math.max(220, Math.min(...paces) - 15);
  const pMax = Math.min(500, Math.max(...paces) + 15);
  const toX = i => PAD.left + (i / Math.max(data.length - 1, 1)) * cW;
  // Inverted: lower pace sec (faster) = higher on chart
  const toY = p => PAD.top + ((p - pMin) / (pMax - pMin)) * cH;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = PAD.top + (i/3)*cH; ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left+cW, y); ctx.stroke(); }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
  grad.addColorStop(0, 'rgba(59,130,246,0.3)'); grad.addColorStop(1, 'rgba(59,130,246,0.02)');
  ctx.beginPath();
  data.forEach((d, i) => { const x=toX(i), y=toY(d.avgPace); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.lineTo(toX(data.length-1), PAD.top+cH); ctx.lineTo(toX(0), PAD.top+cH); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  data.forEach((d, i) => { const x=toX(i), y=toY(d.avgPace); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.stroke();

  // Dots
  data.forEach((d, i) => {
    const x=toX(i), y=toY(d.avgPace);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2);
    ctx.fillStyle='#3b82f6'; ctx.fill();
    ctx.strokeStyle='#0c1525'; ctx.lineWidth=1.5; ctx.stroke();
  });

  // Y axis — pace labels
  ctx.fillStyle='#475569'; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='right';
  for (let p = Math.ceil(pMin/30)*30; p <= pMax; p += 30) {
    const y=toY(p); if (y<PAD.top+4||y>H-PAD.bottom-4) continue;
    ctx.fillText(\`\${Math.floor(p/60)}:\${(''+p%60).padStart(2,'0')}\`, PAD.left-5, y+4);
  }

  // X axis — date labels (every other point)
  ctx.textAlign='center'; ctx.fillStyle='#475569';
  data.forEach((d, i) => {
    if (i % 2 !== 0 && i !== data.length-1) return;
    const x=toX(i); const dt=new Date(d.week).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    ctx.fillText(dt, x, H-PAD.bottom+14);
  });

  // Trend insight text
  const first=data[0].avgPace, last=data[data.length-1].avgPace, diff=first-last;
  const el=document.getElementById('trend-insight');
  if (el) {
    if (diff>10) el.innerHTML=\`<strong style="color:#6ee7b7">\u2191 Getting faster</strong> \u2014 Z2 pace improved \${Math.round(diff)}s/km over \${data.length} weeks. Aerobic base is building.\`;
    else if (diff<-10) el.innerHTML=\`<strong style="color:#fca5a5">\u2193 Pace fading</strong> \u2014 Z2 pace slowed \${Math.abs(Math.round(diff))}s/km. Check recovery and sleep quality.\`;
    else el.innerHTML=\`<strong style="color:#fde68a">\u2192 Stable</strong> \u2014 Z2 pace consistent over \${data.length} weeks. Continue building volume to drive adaptation.\`;
  }
})();

// ── VOLUME BAR CHART ──────────────────────────────────────────
(function drawVolumeChart() {
  const canvas = document.getElementById('vol-canvas');
  if (!canvas || !window.PLAN_WEEKS_KM) return;
  const weeks = window.PLAN_WEEKS_KM;
  const actual = window.ACTUAL_KM || {};
  const dpr = window.devicePixelRatio || 1;
  const displayW = canvas.clientWidth || 860;
  const displayH = 140;
  canvas.width = displayW * dpr; canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px'; canvas.style.height = displayH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = displayW, H = displayH;
  const PAD = { top: 12, right: 16, bottom: 28, left: 36 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;

  ctx.fillStyle = '#0c1525'; ctx.fillRect(0, 0, W, H);

  const maxKm = Math.max(...weeks.map(w => Math.max(w.planned, actual[w.start] || 0))) * 1.15 || 60;
  const n = weeks.length;
  const barGap = 3;
  const barW = Math.max(4, (cW / n) - barGap);
  const toH = km => Math.max(1, (km / maxKm) * cH);

  // Y grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) { const y = PAD.top + (1 - i/4)*cH; ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cW,y); ctx.stroke(); }

  weeks.forEach((w, i) => {
    const x = PAD.left + i * (cW / n);
    const planH = toH(w.planned);
    const actKm = actual[w.start];
    const hasAct = actKm !== null && actKm !== undefined;

    // Planned bar (grey background)
    ctx.fillStyle = 'rgba(100,116,139,0.3)';
    ctx.fillRect(x + barGap/2, PAD.top + cH - planH, barW, planH);

    // Actual bar (coloured)
    if (hasAct) {
      const actH = toH(actKm);
      const pct = w.planned > 0 ? actKm / w.planned : 1;
      const color = pct >= 0.8 && pct <= 1.2 ? '#6ee7b7' : pct < 0.8 ? '#f87171' : '#fde68a';
      ctx.fillStyle = color;
      ctx.fillRect(x + barGap/2, PAD.top + cH - actH, barW, actH);
    }

    // Week label (every 2nd week)
    if ((i % 2 === 0) || i === n - 1) {
      ctx.fillStyle = '#475569'; ctx.font = '10px -apple-system,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('W' + w.wk, x + barW/2, H - PAD.bottom + 12);
    }
  });

  // Y axis labels
  ctx.textAlign = 'right'; ctx.fillStyle = '#475569'; ctx.font = '10px -apple-system,sans-serif';
  for (let i = 1; i <= 3; i++) {
    const km = Math.round(maxKm * i / 4);
    const y = PAD.top + (1 - i/4)*cH;
    ctx.fillText(km + 'km', PAD.left - 4, y + 4);
  }

  // Legend
  ctx.fillStyle = 'rgba(100,116,139,0.5)'; ctx.fillRect(PAD.left, H - 14, 12, 8);
  ctx.fillStyle = '#475569'; ctx.textAlign = 'left'; ctx.font = '10px -apple-system,sans-serif';
  ctx.fillText('Planned', PAD.left + 16, H - 7);
  ctx.fillStyle = '#6ee7b7'; ctx.fillRect(PAD.left + 70, H - 14, 12, 8);
  ctx.fillStyle = '#475569'; ctx.fillText('Actual (on track)', PAD.left + 86, H - 7);
  ctx.fillStyle = '#f87171'; ctx.fillRect(PAD.left + 190, H - 14, 12, 8);
  ctx.fillStyle = '#475569'; ctx.fillText('Under target', PAD.left + 206, H - 7);
})();

// ── MAIN TAB SWITCHING ───────────────────────────────────────
function switchMainTab(name) {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => { p.style.display = 'none'; });
  const btn = document.querySelector(\`.main-tab[onclick*="'\${name}'"]\`);
  if (btn) btn.classList.add('active');
  const panel = document.getElementById('maintab-' + name);
  if (panel) panel.style.display = '';
  if (name === 'plan') {
    const col = document.querySelector(\`.day-col[data-date="\${TODAY}"]\`);
    if (col) setTimeout(() => col.closest('.week-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }
  if (name === 'stats') {
    try { drawFitnessTrend(); } catch(e) {}
    try { drawVolumeChart(); } catch(e) {}
  }
  try { localStorage.setItem('coach_active_tab', name); } catch(e) {}
}
(function() {
  const saved = localStorage.getItem('coach_active_tab');
  if (saved && saved !== 'today') switchMainTab(saved);
})();

// ── WEEK COLLAPSE ────────────────────────────────────────────
function toggleWeek(headerEl) {
  headerEl.closest('.week-section').classList.toggle('collapsed');
}

// ── UPCOMING SESSION EXPAND ──────────────────────────────────
function toggleUpcoming(uid) {
  const detail = document.getElementById(uid);
  const arrow = document.getElementById(uid + '-arrow');
  if (!detail) return;
  const open = detail.style.display === 'none' || detail.style.display === '';
  detail.style.display = open ? 'flex' : 'none';
  if (arrow) arrow.classList.toggle('open', open);
}
// On mobile, collapse all past weeks by default to keep plan tidy
(function() {
  if (window.innerWidth > 700) return;
  document.querySelectorAll('.week-section').forEach(sec => {
    const start = sec.dataset.weekStart;
    if (start && start < TODAY) sec.classList.add('collapsed');
  });
})();

// ── KEYBOARD SHORTCUTS ───────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'e') document.querySelectorAll('.workout-body').forEach(b => { b.style.display='block'; b.closest('.workout-card').classList.add('open'); });
  if (e.key === 'c') document.querySelectorAll('.workout-body').forEach(b => { b.style.display='none'; b.closest('.workout-card').classList.remove('open'); });
  if (e.key === 'Escape') { closeModal(); closeRunChart(); }
});

// ── RUN ANALYSIS CHART ───────────────────────────────────────
function showRunChart(actId) {
  const data = window.ACTIVITY_STREAMS && window.ACTIVITY_STREAMS[actId];
  if (!data) return;

  // Compute summary stats for header
  const hrVals = (data.hr || []).filter(v => v != null && v > 40);
  const paceVals = (data.pace || []).filter(v => v != null && v > 180 && v < 900);
  const totalDistKm = data.dist ? (data.dist.filter(v => v != null).slice(-1)[0] || 0) : 0;
  const avgHr = hrVals.length ? Math.round(hrVals.reduce((a,b)=>a+b,0)/hrVals.length) : null;
  const maxHr = hrVals.length ? Math.max(...hrVals) : null;
  const avgPaceSec = paceVals.length ? Math.round(paceVals.reduce((a,b)=>a+b,0)/paceVals.length) : null;
  const fmtPace = s => s ? Math.floor(s/60)+':'+(''+(s%60)).padStart(2,'0') : '—';

  const statsHtml = \`
    <div class="chart-stats">
      \${avgHr ? \`<div class="chart-stat-box">Avg HR <strong>\${avgHr} bpm</strong></div>\` : ''}
      \${maxHr ? \`<div class="chart-stat-box">Max HR <strong>\${maxHr} bpm</strong></div>\` : ''}
      \${avgPaceSec ? \`<div class="chart-stat-box">Avg Pace <strong>\${fmtPace(avgPaceSec)}/km</strong></div>\` : ''}
      \${totalDistKm ? \`<div class="chart-stat-box">Distance <strong>\${totalDistKm.toFixed(2)} km</strong></div>\` : ''}
    </div>\`;

  const modal = document.createElement('div');
  modal.id = 'run-chart-modal';
  modal.innerHTML = \`
    <div class="modal-overlay" onclick="closeRunChart()"></div>
    <div class="modal-box">
      <div class="modal-header">
        <span>📈 Run Analysis</span>
        <button onclick="closeRunChart()" class="modal-close">✕</button>
      </div>
      <div class="tab-content">
        \${statsHtml}
        <div class="chart-legend">
          <div class="chart-legend-item"><div class="legend-swatch" style="background:linear-gradient(90deg,#6ee7b7,#3b82f6,#f97316,#ef4444,#7c3aed)"></div>Heart Rate (colored by zone)</div>
          <div class="chart-legend-item"><div class="legend-swatch" style="background:#818cf8"></div>Pace (right axis)</div>
          <span style="color:var(--text3);font-size:11px;margin-left:auto">x-axis = distance (km)</span>
        </div>
        <div class="chart-canvas-wrap">
          <canvas id="run-chart-canvas" width="860" height="340"></canvas>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:8px">Zone bands: <span style="color:#6ee7b7">Z1</span> <span style="color:#3b82f6">Z2</span> <span style="color:#f97316">Z3</span> <span style="color:#ef4444">Z4</span> <span style="color:#7c3aed">Z5</span></div>
        \${buildSplitsTable(data)}
      </div>
    </div>\`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => drawRunChart(data));
}

function closeRunChart() { document.getElementById('run-chart-modal')?.remove(); }

function buildSplitsTable(data) {
  const splits = data.kmSplits;
  if (!splits || splits.length === 0) return '';
  const fmtPace = s => s ? Math.floor(s/60)+':'+(''+(s%60)).padStart(2,'0') : '—';
  function hrColor(hr) {
    if (!hr) return '#64748b';
    if (hr < 135) return '#6ee7b7';
    if (hr < 150) return '#3b82f6';
    if (hr < 156) return '#f97316';
    if (hr < 167) return '#ef4444';
    return '#7c3aed';
  }
  const avgPace = splits.filter(s => s.pace).reduce((a,s,_,arr) => a + s.pace/arr.length, 0);
  const rows = splits.map((s, i) => {
    const delta = s.pace ? s.pace - Math.round(avgPace) : null;
    const deltaStr = delta !== null
      ? (delta > 0 ? \`<span class="split-delta slow">+\${delta}s</span>\` : \`<span class="split-delta fast">\${delta}s</span>\`)
      : '';
    return \`<tr>
      <td style="color:var(--text3);font-size:11px">\${i+1}</td>
      <td class="split-pace">\${fmtPace(s.pace)}</td>
      <td>\${deltaStr}</td>
      <td>\${s.hr ? \`<span class="split-hr-dot" style="background:\${hrColor(s.hr)}"></span>\${s.hr} bpm\` : '—'}</td>
    </tr>\`;
  }).join('');
  return \`<div class="splits-table-wrap">
    <table class="splits-table">
      <thead><tr><th>km</th><th>Pace</th><th>vs avg</th><th>HR</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

function drawRunChart(data) {
  const canvas = document.getElementById('run-chart-canvas');
  if (!canvas) return;
  // Scale canvas for device pixel ratio for sharp rendering
  const dpr = window.devicePixelRatio || 1;
  const displayW = canvas.clientWidth || 860;
  const displayH = 340;
  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = displayW, H = displayH;

  const PAD = { top: 24, right: 72, bottom: 40, left: 52 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  ctx.fillStyle = '#0c1525';
  ctx.fillRect(0, 0, W, H);

  const hrs = data.hr || [];
  const paces = data.pace || [];
  const dists = data.dist || [];
  const n = hrs.length;
  if (n === 0) return;

  // X-axis values: distance if available, else normalised index 0..1
  const xRaw = dists.length === n ? dists : Array.from({length:n}, (_,i) => i/(n-1));
  const xMin = xRaw.find(v => v != null) ?? 0;
  const xMax = [...xRaw].reverse().find(v => v != null) ?? 1;

  // HR range
  const hrVals = hrs.filter(v => v != null && v > 40);
  if (!hrVals.length) return;
  const hrMin = Math.max(50, Math.min(...hrVals) - 8);
  const hrMax = Math.min(210, Math.max(...hrVals) + 8);

  // Pace range — clamp to reasonable running paces (3:00–10:00/km = 180–600 s/km)
  const paceValid = paces.filter(v => v != null && v > 180 && v < 600);
  const hasPace = paceValid.length > 10;
  const paceMin = hasPace ? Math.max(180, Math.min(...paceValid) - 15) : 180;
  const paceMax = hasPace ? Math.min(600, Math.max(...paceValid) + 15) : 480;

  const toX = v => PAD.left + ((v - xMin) / (xMax - xMin || 1)) * cW;
  const toYhr = v => PAD.top + (1 - (v - hrMin) / (hrMax - hrMin)) * cH;
  // Pace axis is inverted on screen: faster (lower sec/km) = higher on chart
  const toYpace = v => PAD.top + ((v - paceMin) / (paceMax - paceMin)) * cH;

  // Zone background bands
  const zoneBands = [
    { lo: 0,   hi: 135, fill: 'rgba(110,231,183,0.06)' },
    { lo: 135, hi: 150, fill: 'rgba(59,130,246,0.08)'  },
    { lo: 150, hi: 156, fill: 'rgba(249,115,22,0.09)'  },
    { lo: 156, hi: 167, fill: 'rgba(239,68,68,0.11)'   },
    { lo: 167, hi: 220, fill: 'rgba(124,58,237,0.14)'  },
  ];
  zoneBands.forEach(b => {
    const y1 = Math.max(PAD.top, toYhr(Math.min(b.hi, hrMax)));
    const y2 = Math.min(PAD.top + cH, toYhr(Math.max(b.lo, hrMin)));
    if (y2 > y1) { ctx.fillStyle = b.fill; ctx.fillRect(PAD.left, y1, cW, y2 - y1); }
  });

  // Horizontal grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (i / 4) * cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
  }

  // Zone color for a given HR
  function hrColor(hr) {
    if (hr < 135) return '#6ee7b7';
    if (hr < 150) return '#3b82f6';
    if (hr < 156) return '#f97316';
    if (hr < 167) return '#ef4444';
    return '#7c3aed';
  }

  // HR line — segment by segment colored by zone
  for (let i = 1; i < n; i++) {
    const hr = hrs[i], hrp = hrs[i-1];
    if (hr == null || hrp == null) continue;
    const x1 = toX(xRaw[i-1]), x2 = toX(xRaw[i]);
    if (x2 - x1 < 0.2) continue;
    ctx.beginPath();
    ctx.moveTo(x1, toYhr(hrp));
    ctx.lineTo(x2, toYhr(hr));
    ctx.strokeStyle = hrColor((hr + hrp) / 2);
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Pace line
  if (hasPace) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(129,140,248,0.9)';
    ctx.lineWidth = 1.8;
    let started = false;
    for (let i = 0; i < n; i++) {
      const p = paces[i];
      if (p == null || p < 180 || p > 600) { started = false; continue; }
      const x = toX(xRaw[i]), y = toYpace(p);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── AXES ──────────────────────────────────────────────────
  ctx.fillStyle = '#64748b';
  ctx.font = \`\${11 * dpr / dpr}px -apple-system,sans-serif\`;

  // Left axis — HR labels
  ctx.textAlign = 'right';
  const hrStep = (hrMax - hrMin) > 60 ? 20 : 10;
  for (let hr = Math.ceil(hrMin / hrStep) * hrStep; hr <= hrMax; hr += hrStep) {
    const y = toYhr(hr);
    if (y < PAD.top + 4 || y > H - PAD.bottom - 4) continue;
    ctx.fillStyle = hrColor(hr);
    ctx.fillText(hr, PAD.left - 5, y + 4);
  }

  // Right axis — Pace labels
  if (hasPace) {
    ctx.textAlign = 'left';
    const paceStepSec = (paceMax - paceMin) > 120 ? 60 : 30;
    for (let p = Math.ceil(paceMin / paceStepSec) * paceStepSec; p <= paceMax; p += paceStepSec) {
      const y = toYpace(p);
      if (y < PAD.top + 4 || y > H - PAD.bottom - 4) continue;
      ctx.fillStyle = '#818cf8';
      ctx.fillText(\`\${Math.floor(p/60)}:\${(''+p%60).padStart(2,'0')}\`, PAD.left + cW + 6, y + 4);
    }
  }

  // X axis — distance labels
  ctx.textAlign = 'center';
  ctx.fillStyle = '#475569';
  const xRange = xMax - xMin;
  const xStep = xRange <= 3 ? 0.5 : xRange <= 8 ? 1 : xRange <= 15 ? 2 : xRange <= 30 ? 5 : 10;
  for (let km = Math.ceil(xMin / xStep) * xStep; km <= xMax + 0.01; km += xStep) {
    const x = toX(km);
    if (x < PAD.left + 10 || x > PAD.left + cW - 10) continue;
    ctx.fillText(km.toFixed(xStep < 1 ? 1 : 0) + 'km', x, H - PAD.bottom + 14);
  }

  // Axis title labels
  ctx.save();
  ctx.translate(13, PAD.top + cH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#6ee7b7';
  ctx.fillText('HR (bpm)', 0, 0);
  ctx.restore();

  if (hasPace) {
    ctx.save();
    ctx.translate(W - 10, PAD.top + cH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#818cf8';
    ctx.fillText('Pace /km', 0, 0);
    ctx.restore();
  }
}
</script>
</body>
</html>`;

await writeFile('half-marathon-sep-2026.html', html);
console.log('✓ HTML plan rendered: half-marathon-sep-2026.html');
console.log('  Open in browser to view your interactive training plan.');
