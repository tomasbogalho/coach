/**
 * generate-plan.mjs
 * Generates the 16-week half-marathon training plan JSON for Tomás Bogalho.
 * Race: Half Marathon, September 20, 2026 | Goal: Sub 1:40
 */
import { writeFile } from 'node:fs/promises';

// ─── ATHLETE PROFILE ────────────────────────────────────────────────────────
const athlete = 'Tomás Bogalho';
const event = 'Half Marathon';
const eventDate = '2026-09-20';
const planStartDate = '2026-06-01';
const goalTime = '1:39:59';
const racePacePerKm = '4:44';

// ─── ZONES ──────────────────────────────────────────────────────────────────
// LTHR estimated at 167 bpm (from race data: HM at HR 169, 10k at HR 165)
// Threshold pace ~5:05/km (10k race at 4:57, HM race at 5:22)
// Goal race pace: 4:44/km (sub-1:40)
const zones = {
  run: {
    hr: {
      lthr: 167,
      zones: [
        { zone: 1, name: 'Recovery',      percentLow: 0,   percentHigh: 81,  hrLow: 0,   hrHigh: 135, paceLow: '6:30', paceHigh: '7:00' },
        { zone: 2, name: 'Aerobic',       percentLow: 81,  percentHigh: 89,  hrLow: 135, hrHigh: 149, paceLow: '5:50', paceHigh: '6:15' },
        { zone: 3, name: 'Tempo',         percentLow: 90,  percentHigh: 93,  hrLow: 150, hrHigh: 155, paceLow: '5:10', paceHigh: '5:30' },
        { zone: 4, name: 'Sub-threshold', percentLow: 94,  percentHigh: 99,  hrLow: 157, hrHigh: 166, paceLow: '4:48', paceHigh: '5:10' },
        { zone: '5a', name: 'Threshold',  percentLow: 100, percentHigh: 102, hrLow: 167, hrHigh: 170, paceLow: '4:40', paceHigh: '4:48' },
        { zone: '5b', name: 'VO2max',     percentLow: 103, percentHigh: 106, hrLow: 172, hrHigh: 177, paceLow: '4:20', paceHigh: '4:35' },
      ],
    },
    paces: {
      easy: '5:50–6:15/km',
      marathon: '5:00/km',
      threshold: '4:48–5:05/km',
      interval: '4:25–4:35/km',
      raceGoal: '4:44/km',
      strides: '4:00–4:20/km (20 sec)',
    },
  },
};

// ─── PHASES ─────────────────────────────────────────────────────────────────
const phases = [
  {
    name: 'Recovery',
    startWeek: 1, endWeek: 2,
    focus: 'Post-marathon recovery, restore consistency',
    weeklyKmRange: { low: 36, high: 45 },
    keyWorkouts: ['Easy runs only', 'First strides in W2'],
    physiologicalGoals: ['Allow marathon adaptation', 'Restore connective tissue', 'Rebuild routine'],
  },
  {
    name: 'Base',
    startWeek: 3, endWeek: 8,
    focus: 'Aerobic foundation, introduce tempo',
    weeklyKmRange: { low: 50, high: 68 },
    keyWorkouts: ['Progressive long runs', 'Strides', 'Tempo introduced W6'],
    physiologicalGoals: ['Maximise aerobic capacity', 'Fat metabolism', 'Build mileage base'],
  },
  {
    name: 'Build',
    startWeek: 9, endWeek: 13,
    focus: 'Threshold & VO2max development',
    weeklyKmRange: { low: 50, high: 68 },
    keyWorkouts: ['VO2max intervals', 'Threshold intervals', 'Race-pace long runs'],
    physiologicalGoals: ['Raise VO2max', 'Improve lactate threshold', 'Race-pace specificity'],
  },
  {
    name: 'Taper',
    startWeek: 14, endWeek: 16,
    focus: 'Sharpen, recover, race',
    weeklyKmRange: { low: 20, high: 48 },
    keyWorkouts: ['Race-pace sharpeners', 'Strides', 'Race Day'],
    physiologicalGoals: ['Supercompensation', 'Neuromuscular freshness', 'Confidence'],
  },
];

// ─── WEEK BUILDER HELPERS ────────────────────────────────────────────────────
let dayId = 0;
const uid = (w, d, s) => `w${w}-${d}-${s}`;

function rest(weekNum, dayAbbr) {
  return { id: uid(weekNum, dayAbbr, 'rest'), sport: 'rest', type: 'rest', name: 'Rest Day', description: 'Full rest. Focus on sleep, hydration and nutrition.', completed: false };
}

function strength(weekNum, dayAbbr, notes = '') {
  return {
    id: uid(weekNum, dayAbbr, 'str'),
    sport: 'strength', type: 'strength',
    name: 'Strength & Conditioning',
    description: `CrossFit / weight training. Focus on glutes, hip flexors, core, single-leg stability. ${notes}`.trim(),
    durationMinutes: 45,
    completed: false,
  };
}

function easyRun(weekNum, dayAbbr, km, notes = '') {
  const mins = Math.round(km * 6.1);
  return {
    id: uid(weekNum, dayAbbr, 'easy'),
    sport: 'run', type: 'easy',
    name: 'Easy Run',
    description: `Easy aerobic run — conversational pace. ${notes}`.trim(),
    durationMinutes: mins,
    distanceKm: km,
    primaryZone: 'Zone 2',
    targetHR: '<149 bpm',
    targetPace: '5:50–6:15/km',
    humanReadable: `Warm-up: First 1km very easy (Z1)\nMain: ${km - 1}km easy Z2 — HR < 149, full sentences\nFocus: Relaxed form, don't chase pace`,
    completed: false,
  };
}

function recoveryRun(weekNum, dayAbbr, km) {
  const mins = Math.round(km * 6.4);
  return {
    id: uid(weekNum, dayAbbr, 'rec'),
    sport: 'run', type: 'recovery',
    name: 'Recovery Run',
    description: 'Very easy recovery jog. Should feel effortless.',
    durationMinutes: mins,
    distanceKm: km,
    primaryZone: 'Zone 1',
    targetHR: '<135 bpm',
    targetPace: '6:00–6:30/km',
    humanReadable: `${km}km very easy Z1 — HR < 135\nThis is active recovery, not training. Walk if HR creeps up.`,
    completed: false,
  };
}

function stridesRun(weekNum, dayAbbr, km, numStrides = 6) {
  const mins = Math.round(km * 6.0) + numStrides * 2;
  return {
    id: uid(weekNum, dayAbbr, 'str-run'),
    sport: 'run', type: 'strides',
    name: `Easy Run + ${numStrides}×Strides`,
    description: `Easy aerobic run with ${numStrides} strides to activate fast-twitch fibres without adding fatigue.`,
    durationMinutes: mins,
    distanceKm: km,
    primaryZone: 'Zone 2',
    targetPace: '5:50–6:10/km easy + strides @ 4:10/km for 20 sec',
    humanReadable: `Warm-up: 2km easy Z2\nMain: ${km - 3}km easy Z2\nStrides: ${numStrides}×20 sec @ 4:00–4:20/km, walk/jog 90 sec between\nCool-down: 1km easy`,
    completed: false,
  };
}

function longRun(weekNum, dayAbbr, km, raceKm = 0) {
  const easyKm = km - raceKm;
  const mins = Math.round(easyKm * 6.0 + raceKm * 5.0);
  const raceNote = raceKm > 0 ? ` Last ${raceKm}km at marathon/race pace (4:44–5:00/km).` : '';
  return {
    id: uid(weekNum, dayAbbr, 'long'),
    sport: 'run', type: 'long',
    name: raceKm > 0 ? 'Progressive Long Run' : 'Long Run',
    description: `Weekly long run.${raceNote} This is the cornerstone workout of the week.`,
    durationMinutes: mins,
    distanceKm: km,
    primaryZone: raceKm > 0 ? 'Zone 2 → Zone 3' : 'Zone 2',
    targetPace: raceKm > 0 ? `5:50–6:00/km easy, last ${raceKm}km @ 4:44–5:00/km` : '5:50–6:10/km',
    targetHR: raceKm > 0 ? '<149 easy, <165 race finish' : '<149 bpm',
    humanReadable: raceKm > 0
      ? `Warm-up: 2km very easy Z1\nMain: ${easyKm - 2}km easy Z2 (HR < 149)\nFinish: ${raceKm}km @ 4:44–5:00/km (Z3-4, controlled effort)\nNutrition: Take a gel every 45 min`
      : `Warm-up: 2km very easy Z1\nMain: ${km - 2}km steady Z2 (HR < 149)\nFocus: Stay aerobic, resist pushing. Fuel with gels every 45 min.\nCool-down: Walk 5 min after.`,
    completed: false,
  };
}

function tempoRun(weekNum, dayAbbr, totalKm, tempoMins, pace = '5:05–5:15/km') {
  const approxTempoKm = Math.round((tempoMins / 60) * (60 / 5.1) * 10) / 10;
  const wuCd = totalKm - approxTempoKm;
  return {
    id: uid(weekNum, dayAbbr, 'tempo'),
    sport: 'run', type: 'tempo',
    name: `Tempo Run – ${tempoMins} min`,
    description: `Continuous tempo effort at comfortably hard pace. "7/10 effort" — you can speak in short phrases only.`,
    durationMinutes: Math.round(wuCd / 2 * 6 + tempoMins + wuCd / 2 * 6),
    distanceKm: totalKm,
    primaryZone: 'Zone 3–4',
    targetPace: pace,
    targetHR: '155–165 bpm',
    humanReadable: `Warm-up: 2km easy Z1-2 (12 min)\nMain: ${tempoMins} min continuous @ ${pace}\nCool-down: 2km easy Z1 (12 min)\nFocus: Smooth, controlled — if HR exceeds 166, ease off slightly`,
    completed: false,
  };
}

function vo2Intervals(weekNum, dayAbbr, totalKm, reps, repDist, pace = '4:28–4:35/km') {
  return {
    id: uid(weekNum, dayAbbr, 'vo2'),
    sport: 'run', type: 'intervals',
    name: `VO₂max Intervals – ${reps}×${repDist}m`,
    description: `Hard VO₂max intervals. These hurt but build your speed ceiling. Full recovery between.`,
    durationMinutes: Math.round(totalKm * 6.5),
    distanceKm: totalKm,
    primaryZone: 'Zone 5b',
    targetPace: pace,
    targetHR: '> 167 bpm during reps',
    humanReadable: `Warm-up: 2km easy + 4×100m strides (15 min)\nMain: ${reps}×${repDist}m @ ${pace}, 2:30 min jog recovery\nCool-down: 2km easy (10 min)\nFocus: Hit pace from rep 1. If fading badly after rep 4, take extra rest.`,
    completed: false,
  };
}

function thresholdIntervals(weekNum, dayAbbr, totalKm, sets, repKm, pace = '4:48–4:55/km') {
  return {
    id: uid(weekNum, dayAbbr, 'thresh'),
    sport: 'run', type: 'intervals',
    name: `Threshold Intervals – ${sets}×${repKm}km`,
    description: `Cruise intervals at half-marathon threshold effort. Controlled and purposeful.`,
    durationMinutes: Math.round(totalKm * 6.0),
    distanceKm: totalKm,
    primaryZone: 'Zone 4',
    targetPace: pace,
    targetHR: '157–166 bpm',
    humanReadable: `Warm-up: 2km easy Z2 (12 min)\nMain: ${sets}×${repKm}km @ ${pace}, 90 sec jog recovery\nCool-down: 2km easy (12 min)\nFocus: Smooth sustained effort. Each rep should feel the same.`,
    completed: false,
  };
}

function racePaceWork(weekNum, dayAbbr, totalKm, raceReps, repKm, pace = '4:44/km') {
  return {
    id: uid(weekNum, dayAbbr, 'rp'),
    sport: 'run', type: 'intervals',
    name: `Race Pace Intervals – ${raceReps}×${repKm}km`,
    description: `Sub-1:40 race pace rehearsal. Lock in 4:44/km so it feels natural on race day.`,
    durationMinutes: Math.round(totalKm * 5.8),
    distanceKm: totalKm,
    primaryZone: 'Zone 4–5a',
    targetPace: pace,
    targetHR: '160–167 bpm',
    humanReadable: `Warm-up: 2km easy Z2\nMain: ${raceReps}×${repKm}km @ ${pace}, 2 min easy jog recovery\nCool-down: 2km easy\nFocus: This is your goal race pace — it should feel hard but controlled.`,
    completed: false,
  };
}

function sharpener(weekNum, dayAbbr, totalKm, reps = 3) {
  return {
    id: uid(weekNum, dayAbbr, 'sharp'),
    sport: 'run', type: 'intervals',
    name: `Race Sharpener – ${reps}×1km`,
    description: `Short race-pace sharpener to stay sharp during taper. Low volume, high quality.`,
    durationMinutes: Math.round(totalKm * 5.8),
    distanceKm: totalKm,
    primaryZone: 'Zone 4–5a',
    targetPace: '4:44/km',
    targetHR: '160–167 bpm',
    humanReadable: `Warm-up: 2km easy + 4×strides\nMain: ${reps}×1km @ 4:44/km, 2 min jog recovery\nCool-down: 1.5km easy\nFocus: Remind your legs what race pace feels like. Don't overdo it.`,
    completed: false,
  };
}

function taperEasy(weekNum, dayAbbr, km) {
  const mins = Math.round(km * 6.0);
  return {
    id: uid(weekNum, dayAbbr, 'taper'),
    sport: 'run', type: 'easy',
    name: 'Taper Easy Run',
    description: 'Short easy run during taper. Trust the training — do NOT add extra miles.',
    durationMinutes: mins,
    distanceKm: km,
    primaryZone: 'Zone 1–2',
    targetPace: '5:50–6:20/km',
    humanReadable: `${km}km easy Z1-2. Stay relaxed, don't push. Your job is to arrive at the start line fresh.`,
    completed: false,
  };
}

function race() {
  return {
    id: 'w16-sun-race',
    sport: 'run', type: 'race',
    name: '🏁 Half Marathon – RACE DAY',
    description: 'Half Marathon. Goal: Sub 1:40:00. Pacing strategy: even splits at 4:44/km with slight negative (last 5km a touch faster).',
    distanceKm: 21.1,
    durationMinutes: 99,
    primaryZone: 'Zone 4–5a',
    targetPace: '4:44/km',
    targetHR: '160–167 bpm',
    humanReadable: `Pre-race: Breakfast 3hr before (oats + banana + coffee)\nWarm-up: 10 min easy jog + 4×strides 30 min before gun\nKm 1–3: 4:50–4:55/km (conservative start, let the pack go)\nKm 4–15: 4:44/km (lock in rhythm, run YOUR race)\nKm 16–21: Push — if feeling strong, negative split to 4:38–4:42/km\nNutrition: 1 gel at km 7, 1 gel at km 14. Sip water at every station.\nMantras: "Smooth, strong, controlled."`,
    completed: false,
  };
}

// ─── WEEK DEFINITIONS ────────────────────────────────────────────────────────
// Each entry: { phase, focus, isRecovery, days: [{date, dayOfWeek, workouts:[...]}] }

function addDays(startDate, n) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildWeeks() {
  const weeks = [];
  const start = '2026-06-01'; // Monday W1

  // W1 (Jun 1-7) Recovery | ~40km
  weeks.push({
    weekNumber: 1, phase: 'Recovery',
    focus: 'Return to routine after Copenhagen Marathon. All easy.',
    isRecoveryWeek: true,
    startDate: addDays(start, 0), endDate: addDays(start, 6), targetKm: 40,
    days: [
      { date: addDays(start, 0), dayOfWeek: 'Monday',    workouts: [rest(1,'mon')] },
      { date: addDays(start, 1), dayOfWeek: 'Tuesday',   workouts: [easyRun(1,'tue',6,'Stay in Z1-2. This week is about moving, not training.')] },
      { date: addDays(start, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(1,'wed',6), strength(1,'wed','Light loads — no heavy squats or plyometrics yet.')] },
      { date: addDays(start, 3), dayOfWeek: 'Thursday',  workouts: [easyRun(1,'thu',7)] },
      { date: addDays(start, 4), dayOfWeek: 'Friday',    workouts: [strength(1,'fri','Mobility focus. Hip flexors, hamstrings, calves.')] },
      { date: addDays(start, 5), dayOfWeek: 'Saturday',  workouts: [rest(1,'sat')] },
      { date: addDays(start, 6), dayOfWeek: 'Sunday',    workouts: [longRun(1,'sun',13)] },
    ],
  });

  // W2 (Jun 8-14) Recovery | ~45km + first strides
  const w2 = addDays(start, 7);
  weeks.push({
    weekNumber: 2, phase: 'Recovery',
    focus: 'Ease back in. First strides to wake up fast-twitch without stress.',
    isRecoveryWeek: false, startDate: w2, endDate: addDays(w2, 6), targetKm: 45,
    days: [
      { date: addDays(w2, 0), dayOfWeek: 'Monday',    workouts: [rest(2,'mon')] },
      { date: addDays(w2, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(2,'tue',7,4)] },
      { date: addDays(w2, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(2,'wed',6), strength(2,'wed')] },
      { date: addDays(w2, 3), dayOfWeek: 'Thursday',  workouts: [easyRun(2,'thu',7)] },
      { date: addDays(w2, 4), dayOfWeek: 'Friday',    workouts: [strength(2,'fri')] },
      { date: addDays(w2, 5), dayOfWeek: 'Saturday',  workouts: [rest(2,'sat')] },
      { date: addDays(w2, 6), dayOfWeek: 'Sunday',    workouts: [longRun(2,'sun',13)] },
    ],
  });

  // W3 (Jun 15-21) Base 1 | ~52km
  const w3 = addDays(start, 14);
  weeks.push({
    weekNumber: 3, phase: 'Base',
    focus: 'Establish aerobic base. Strides Tuesday, first short threshold Thursday.',
    isRecoveryWeek: false, startDate: w3, endDate: addDays(w3, 6), targetKm: 52,
    days: [
      { date: addDays(w3, 0), dayOfWeek: 'Monday',    workouts: [rest(3,'mon')] },
      { date: addDays(w3, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(3,'tue',8,6)] },
      { date: addDays(w3, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(3,'wed',7), strength(3,'wed')] },
      { date: addDays(w3, 3), dayOfWeek: 'Thursday',  workouts: [thresholdIntervals(3,'thu',9,3,1,'5:05–5:15/km')] },
      { date: addDays(w3, 4), dayOfWeek: 'Friday',    workouts: [strength(3,'fri')] },
      { date: addDays(w3, 5), dayOfWeek: 'Saturday',  workouts: [rest(3,'sat')] },
      { date: addDays(w3, 6), dayOfWeek: 'Sunday',    workouts: [longRun(3,'sun',15)] },
    ],
  });

  // W4 (Jun 22-28) Base 2 | ~58km + progressive long
  const w4 = addDays(start, 21);
  weeks.push({
    weekNumber: 4, phase: 'Base',
    focus: 'Build volume. Strides Tuesday, tempo Thursday, progressive long run Sunday.',
    isRecoveryWeek: false, startDate: w4, endDate: addDays(w4, 6), targetKm: 58,
    days: [
      { date: addDays(w4, 0), dayOfWeek: 'Monday',    workouts: [rest(4,'mon')] },
      { date: addDays(w4, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(4,'tue',9,6)] },
      { date: addDays(w4, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(4,'wed',8), strength(4,'wed')] },
      { date: addDays(w4, 3), dayOfWeek: 'Thursday',  workouts: [tempoRun(4,'thu',9,20,'5:10–5:20/km')] },
      { date: addDays(w4, 4), dayOfWeek: 'Friday',    workouts: [strength(4,'fri')] },
      { date: addDays(w4, 5), dayOfWeek: 'Saturday',  workouts: [rest(4,'sat')] },
      { date: addDays(w4, 6), dayOfWeek: 'Sunday',    workouts: [longRun(4,'sun',17, 4)] },
    ],
  });

  // W5 (Jun 29-Jul 5) Recovery | ~42km
  const w5 = addDays(start, 28);
  weeks.push({
    weekNumber: 5, phase: 'Base',
    focus: 'Recovery week. Back off — this is where adaptation happens.',
    isRecoveryWeek: true, startDate: w5, endDate: addDays(w5, 6), targetKm: 42,
    days: [
      { date: addDays(w5, 0), dayOfWeek: 'Monday',    workouts: [rest(5,'mon')] },
      { date: addDays(w5, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(5,'tue',6,4)] },
      { date: addDays(w5, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(5,'wed',6), strength(5,'wed','Full intensity — recovery week is for legs, not gym.')] },
      { date: addDays(w5, 3), dayOfWeek: 'Thursday',  workouts: [easyRun(5,'thu',6)] },
      { date: addDays(w5, 4), dayOfWeek: 'Friday',    workouts: [strength(5,'fri')] },
      { date: addDays(w5, 5), dayOfWeek: 'Saturday',  workouts: [rest(5,'sat')] },
      { date: addDays(w5, 6), dayOfWeek: 'Sunday',    workouts: [longRun(5,'sun',12)] },
    ],
  });

  // W6 (Jul 6-12) Base 3 | ~61km — TEMPO + THRESHOLD
  const w6 = addDays(start, 35);
  weeks.push({
    weekNumber: 6, phase: 'Base',
    focus: 'Two quality days: tempo Tuesday + threshold cruise intervals Thursday.',
    isRecoveryWeek: false, startDate: w6, endDate: addDays(w6, 6), targetKm: 61,
    days: [
      { date: addDays(w6, 0), dayOfWeek: 'Monday',    workouts: [rest(6,'mon')] },
      { date: addDays(w6, 1), dayOfWeek: 'Tuesday',   workouts: [tempoRun(6,'tue',10,20,'5:10–5:20/km')] },
      { date: addDays(w6, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(6,'wed',8), strength(6,'wed')] },
      { date: addDays(w6, 3), dayOfWeek: 'Thursday',  workouts: [thresholdIntervals(6,'thu',9,3,1,'5:00–5:10/km')] },
      { date: addDays(w6, 4), dayOfWeek: 'Friday',    workouts: [strength(6,'fri')] },
      { date: addDays(w6, 5), dayOfWeek: 'Saturday',  workouts: [rest(6,'sat')] },
      { date: addDays(w6, 6), dayOfWeek: 'Sunday',    workouts: [longRun(6,'sun',18, 3)] },
    ],
  });

  // W7 (Jul 13-19) Base 4 | ~65km — Tempo + threshold
  const w7 = addDays(start, 42);
  weeks.push({
    weekNumber: 7, phase: 'Base',
    focus: 'Two quality days: longer tempo Tuesday + threshold intervals Thursday.',
    isRecoveryWeek: false, startDate: w7, endDate: addDays(w7, 6), targetKm: 65,
    days: [
      { date: addDays(w7, 0), dayOfWeek: 'Monday',    workouts: [rest(7,'mon')] },
      { date: addDays(w7, 1), dayOfWeek: 'Tuesday',   workouts: [tempoRun(7,'tue',11,25,'5:05–5:15/km')] },
      { date: addDays(w7, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(7,'wed',8), strength(7,'wed')] },
      { date: addDays(w7, 3), dayOfWeek: 'Thursday',  workouts: [thresholdIntervals(7,'thu',10,4,1,'4:55–5:05/km')] },
      { date: addDays(w7, 4), dayOfWeek: 'Friday',    workouts: [strength(7,'fri')] },
      { date: addDays(w7, 5), dayOfWeek: 'Saturday',  workouts: [rest(7,'sat')] },
      { date: addDays(w7, 6), dayOfWeek: 'Sunday',    workouts: [longRun(7,'sun',20, 4)] },
    ],
  });

  // W8 (Jul 20-26) Base 5 (Peak Base) | ~69km
  const w8 = addDays(start, 49);
  weeks.push({
    weekNumber: 8, phase: 'Base',
    focus: 'Peak base week. Longest tempo Tuesday + threshold intervals Thursday.',
    isRecoveryWeek: false, startDate: w8, endDate: addDays(w8, 6), targetKm: 69,
    days: [
      { date: addDays(w8, 0), dayOfWeek: 'Monday',    workouts: [rest(8,'mon')] },
      { date: addDays(w8, 1), dayOfWeek: 'Tuesday',   workouts: [tempoRun(8,'tue',12,30,'5:00–5:10/km')] },
      { date: addDays(w8, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(8,'wed',8), strength(8,'wed')] },
      { date: addDays(w8, 3), dayOfWeek: 'Thursday',  workouts: [thresholdIntervals(8,'thu',10,4,1,'4:52–5:02/km')] },
      { date: addDays(w8, 4), dayOfWeek: 'Friday',    workouts: [strength(8,'fri')] },
      { date: addDays(w8, 5), dayOfWeek: 'Saturday',  workouts: [rest(8,'sat')] },
      { date: addDays(w8, 6), dayOfWeek: 'Sunday',    workouts: [longRun(8,'sun',21, 5)] },
    ],
  });

  // W9 (Jul 27-Aug 2) BUILD 1 — VO2max enters | ~64km
  const w9 = addDays(start, 56);
  weeks.push({
    weekNumber: 9, phase: 'Build',
    focus: 'Build begins. VO₂max intervals + tempo. This is where the sub-1:40 is forged.',
    isRecoveryWeek: false, startDate: w9, endDate: addDays(w9, 6), targetKm: 64,
    days: [
      { date: addDays(w9, 0), dayOfWeek: 'Monday',    workouts: [rest(9,'mon')] },
      { date: addDays(w9, 1), dayOfWeek: 'Tuesday',   workouts: [vo2Intervals(9,'tue',10,5,1000,'4:30–4:38/km')] },
      { date: addDays(w9, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(9,'wed',8), strength(9,'wed')] },
      { date: addDays(w9, 3), dayOfWeek: 'Thursday',  workouts: [tempoRun(9,'thu',11,25,'5:00–5:10/km')] },
      { date: addDays(w9, 4), dayOfWeek: 'Friday',    workouts: [strength(9,'fri')] },
      { date: addDays(w9, 5), dayOfWeek: 'Saturday',  workouts: [rest(9,'sat')] },
      { date: addDays(w9, 6), dayOfWeek: 'Sunday',    workouts: [longRun(9,'sun',20, 5)] },
    ],
  });

  // W10 (Aug 3-9) BUILD 2 — Threshold + VO2 | ~66km
  const w10 = addDays(start, 63);
  weeks.push({
    weekNumber: 10, phase: 'Build',
    focus: 'Two quality days: threshold Tuesday + VO₂max intervals Thursday.',
    isRecoveryWeek: false, startDate: w10, endDate: addDays(w10, 6), targetKm: 66,
    days: [
      { date: addDays(w10, 0), dayOfWeek: 'Monday',    workouts: [rest(10,'mon')] },
      { date: addDays(w10, 1), dayOfWeek: 'Tuesday',   workouts: [thresholdIntervals(10,'tue',12,4,2,'4:52–5:00/km')] },
      { date: addDays(w10, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(10,'wed',8), strength(10,'wed')] },
      { date: addDays(w10, 3), dayOfWeek: 'Thursday',  workouts: [vo2Intervals(10,'thu',9,5,800,'4:28–4:35/km')] },
      { date: addDays(w10, 4), dayOfWeek: 'Friday',    workouts: [strength(10,'fri')] },
      { date: addDays(w10, 5), dayOfWeek: 'Saturday',  workouts: [rest(10,'sat')] },
      { date: addDays(w10, 6), dayOfWeek: 'Sunday',    workouts: [longRun(10,'sun',20, 6)] },
    ],
  });

  // W11 (Aug 10-16) Recovery | ~48km
  const w11 = addDays(start, 70);
  weeks.push({
    weekNumber: 11, phase: 'Build',
    focus: 'Recovery week. You are absorbing the training. Do NOT skip this.',
    isRecoveryWeek: true, startDate: w11, endDate: addDays(w11, 6), targetKm: 48,
    days: [
      { date: addDays(w11, 0), dayOfWeek: 'Monday',    workouts: [rest(11,'mon')] },
      { date: addDays(w11, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(11,'tue',7,6)] },
      { date: addDays(w11, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(11,'wed',6), strength(11,'wed')] },
      { date: addDays(w11, 3), dayOfWeek: 'Thursday',  workouts: [easyRun(11,'thu',7)] },
      { date: addDays(w11, 4), dayOfWeek: 'Friday',    workouts: [strength(11,'fri')] },
      { date: addDays(w11, 5), dayOfWeek: 'Saturday',  workouts: [rest(11,'sat')] },
      { date: addDays(w11, 6), dayOfWeek: 'Sunday',    workouts: [longRun(11,'sun',15)] },
    ],
  });

  // W12 (Aug 17-23) BUILD 3 — Peak quality | ~65km
  const w12 = addDays(start, 77);
  weeks.push({
    weekNumber: 12, phase: 'Build',
    focus: 'Peak build week. VO₂max + race pace. This is the hardest week — embrace it.',
    isRecoveryWeek: false, startDate: w12, endDate: addDays(w12, 6), targetKm: 65,
    days: [
      { date: addDays(w12, 0), dayOfWeek: 'Monday',    workouts: [rest(12,'mon')] },
      { date: addDays(w12, 1), dayOfWeek: 'Tuesday',   workouts: [vo2Intervals(12,'tue',10,6,1000,'4:28–4:35/km')] },
      { date: addDays(w12, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(12,'wed',8), strength(12,'wed')] },
      { date: addDays(w12, 3), dayOfWeek: 'Thursday',  workouts: [thresholdIntervals(12,'thu',10,3,2,'4:48–4:55/km')] },
      { date: addDays(w12, 4), dayOfWeek: 'Friday',    workouts: [strength(12,'fri')] },
      { date: addDays(w12, 5), dayOfWeek: 'Saturday',  workouts: [rest(12,'sat')] },
      { date: addDays(w12, 6), dayOfWeek: 'Sunday',    workouts: [longRun(12,'sun',20, 7)] },
    ],
  });

  // W13 (Aug 24-30) Peak/Race-specific | ~61km
  const w13 = addDays(start, 84);
  weeks.push({
    weekNumber: 13, phase: 'Build',
    focus: 'Race-pace Tuesday + tempo Thursday. Maximum race specificity before taper.',
    isRecoveryWeek: false, startDate: w13, endDate: addDays(w13, 6), targetKm: 61,
    days: [
      { date: addDays(w13, 0), dayOfWeek: 'Monday',    workouts: [rest(13,'mon')] },
      { date: addDays(w13, 1), dayOfWeek: 'Tuesday',   workouts: [racePaceWork(13,'tue',12,3,3,'4:44/km')] },
      { date: addDays(w13, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(13,'wed',8), strength(13,'wed')] },
      { date: addDays(w13, 3), dayOfWeek: 'Thursday',  workouts: [tempoRun(13,'thu',9,25,'4:55–5:05/km')] },
      { date: addDays(w13, 4), dayOfWeek: 'Friday',    workouts: [strength(13,'fri')] },
      { date: addDays(w13, 5), dayOfWeek: 'Saturday',  workouts: [rest(13,'sat')] },
      { date: addDays(w13, 6), dayOfWeek: 'Sunday',    workouts: [longRun(13,'sun',18, 6)] },
    ],
  });

  // W14 (Aug 31-Sep 6) TAPER 1 | ~46km
  const w14 = addDays(start, 91);
  weeks.push({
    weekNumber: 14, phase: 'Taper',
    focus: 'Taper begins. Volume drops, quality stays. Trust the process.',
    isRecoveryWeek: false, startDate: w14, endDate: addDays(w14, 6), targetKm: 46,
    days: [
      { date: addDays(w14, 0), dayOfWeek: 'Monday',    workouts: [rest(14,'mon')] },
      { date: addDays(w14, 1), dayOfWeek: 'Tuesday',   workouts: [racePaceWork(14,'tue',9,4,1,'4:44/km')] },
      { date: addDays(w14, 2), dayOfWeek: 'Wednesday', workouts: [easyRun(14,'wed',6), strength(14,'wed','Reduce loads 20-30%. Last heavy strength week.')] },
      { date: addDays(w14, 3), dayOfWeek: 'Thursday',  workouts: [easyRun(14,'thu',7)] },
      { date: addDays(w14, 4), dayOfWeek: 'Friday',    workouts: [strength(14,'fri','Light session — mobility focus.')] },
      { date: addDays(w14, 5), dayOfWeek: 'Saturday',  workouts: [rest(14,'sat')] },
      { date: addDays(w14, 6), dayOfWeek: 'Sunday',    workouts: [longRun(14,'sun',13, 4)] },
    ],
  });

  // W15 (Sep 7-13) TAPER 2 | ~30km
  const w15 = addDays(start, 98);
  weeks.push({
    weekNumber: 15, phase: 'Taper',
    focus: 'Sharp taper. Stay sharp, sleep more, eat well. The work is done.',
    isRecoveryWeek: false, startDate: w15, endDate: addDays(w15, 6), targetKm: 30,
    days: [
      { date: addDays(w15, 0), dayOfWeek: 'Monday',    workouts: [rest(15,'mon')] },
      { date: addDays(w15, 1), dayOfWeek: 'Tuesday',   workouts: [sharpener(15,'tue',6.5,3)] },
      { date: addDays(w15, 2), dayOfWeek: 'Wednesday', workouts: [taperEasy(15,'wed',5), strength(15,'wed','15-20 min only. Bodyweight, activation only. No heavy loads.')] },
      { date: addDays(w15, 3), dayOfWeek: 'Thursday',  workouts: [stridesRun(15,'thu',5,4)] },
      { date: addDays(w15, 4), dayOfWeek: 'Friday',    workouts: [rest(15,'fri')] },
      { date: addDays(w15, 5), dayOfWeek: 'Saturday',  workouts: [rest(15,'sat')] },
      { date: addDays(w15, 6), dayOfWeek: 'Sunday',    workouts: [taperEasy(15,'sun',8)] },
    ],
  });

  // W16 (Sep 14-20) RACE WEEK
  const w16 = addDays(start, 105);
  weeks.push({
    weekNumber: 16, phase: 'Taper',
    focus: 'Race week. Be calm. Trust the training. You are ready.',
    isRecoveryWeek: false, startDate: w16, endDate: addDays(w16, 6), targetKm: 0,
    days: [
      { date: addDays(w16, 0), dayOfWeek: 'Monday',    workouts: [rest(16,'mon')] },
      { date: addDays(w16, 1), dayOfWeek: 'Tuesday',   workouts: [stridesRun(16,'tue',4,4)] },
      { date: addDays(w16, 2), dayOfWeek: 'Wednesday', workouts: [rest(16,'wed')] },
      { date: addDays(w16, 3), dayOfWeek: 'Thursday',  workouts: [{ ...taperEasy(16,'thu',3), name: 'Pre-race Shakeout', description: 'Very easy 3km + 2 strides. Stay off your feet the rest of the day.' }] },
      { date: addDays(w16, 4), dayOfWeek: 'Friday',    workouts: [rest(16,'fri')] },
      { date: addDays(w16, 5), dayOfWeek: 'Saturday',  workouts: [{ id: 'w16-sat-pre', sport: 'run', type: 'easy', name: 'Day-Before Activation', description: '10 min easy jog + 2 strides. Eat pasta tonight.', durationMinutes: 15, distanceKm: 2, primaryZone: 'Zone 1', completed: false }] },
      { date: addDays(w16, 6), dayOfWeek: 'Sunday',    workouts: [race()] },
    ],
  });

  return weeks;
}

// ─── SUMMARIES ───────────────────────────────────────────────────────────────
function computeSummary(days) {
  let totalKm = 0, totalMins = 0, runSessions = 0, strengthSessions = 0;
  for (const day of days) {
    for (const w of day.workouts) {
      if (w.sport === 'run') { totalKm += (w.distanceKm || 0); totalMins += (w.durationMinutes || 0); runSessions++; }
      if (w.sport === 'strength') strengthSessions++;
    }
  }
  return { totalKm: Math.round(totalKm * 10) / 10, totalHours: Math.round(totalMins / 60 * 10) / 10, runSessions, strengthSessions };
}

// ─── ASSEMBLE PLAN ───────────────────────────────────────────────────────────
const weeks = buildWeeks();
for (const w of weeks) { w.summary = computeSummary(w.days); }

const plan = {
  version: '1.0',
  meta: {
    id: 'half-marathon-sep-2026-tomas',
    athlete,
    event,
    eventDate,
    planStartDate,
    planEndDate: eventDate,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalWeeks: 16,
    generatedBy: 'Claude Coach',
    goalTime,
    racePacePerKm,
    notes: 'Post-Copenhagen Marathon. Goal: Sub 1:40. 6 days running + 2-3x strength/week.',
  },
  preferences: {
    run: 'kilometers',
    firstDayOfWeek: 'monday',
  },
  assessment: {
    foundation: {
      raceHistory: [
        'Copenhagen Marathon May 2026 (4:21, 42.7km)',
        'Half Marathon Vasco da Gama Oct 2025 (1:54, 5:22/km)',
        '10km race Apr 2026 (50:42, 4:57/km)',
        '78 runs, 685km lifetime on Strava',
      ],
      peakTrainingLoad: 68,
      foundationLevel: 'advanced',
      yearsInSport: 2,
    },
    currentForm: {
      weeklyKmAvg: 45,
      longestRunKm: 42.7,
      recentRuns: '3 weeks post-marathon, resuming with easy runs + tempo',
      consistency: 'Very high — regular running through marathon block',
    },
    strengths: [
      { sport: 'run', evidence: 'Marathon finisher, 30km training runs at easy HR 150' },
      { sport: 'strength', evidence: 'Regular CrossFit & weight training' },
    ],
    limiters: [
      { sport: 'run', evidence: 'Speed — HM PR 5:22/km, goal is 4:44/km. Big but achievable gap.' },
    ],
    constraints: [],
  },
  zones: zones,
  phases,
  weeks,
  raceStrategy: {
    event: { name: 'Half Marathon', date: '2026-09-20', distances: { run: 21.1 } },
    goal: { A: 'Sub 1:40:00', B: 'Sub 1:45:00', C: 'Sub 1:50:00 (guaranteed PB)' },
    pacing: {
      km1to3: '4:50–4:55/km (controlled start, ignore early crowd surge)',
      km4to15: '4:44/km (your race — lock in the rhythm, use HR as guide: 160-167)',
      km16to21: 'Push — run by feel. If you have it, negative split to 4:38–4:42/km',
    },
    nutrition: {
      preRace: '3hr before: Oats, banana, coffee. 1hr before: 1 gel + 200ml water.',
      during: { gel1: 'At km 7–8', gel2: 'At km 13–14', water: 'Sip at every station' },
      notes: 'Do not try anything new on race day. Use only what you trained with.',
    },
    warmUp: '10-min easy jog starting 30 min before gun + 4 strides. Do NOT stand in queue.',
    taper: { startDate: '2026-08-31', volumeReduction: 40, notes: 'Volume drops ~40% over 3 weeks. Intensity maintained via sharpeners.' },
  },
};

const json = JSON.stringify(plan, null, 2);
await writeFile('half-marathon-sep-2026.json', json);
console.log(`✓ Plan written: half-marathon-sep-2026.json`);
console.log(`  ${plan.weeks.length} weeks | ${plan.weeks.reduce((s,w)=>s+(w.summary?.totalKm||0),0).toFixed(0)}km total volume`);
console.log('\nNext: node coach-scripts/render.mjs');
