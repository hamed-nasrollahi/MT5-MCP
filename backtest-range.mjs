// Range Breakout Backtest — JPN225 M1, 20-candle range, 30 trading days
// Live version: pulls data directly from MT5 via MCP HTTP server

// Node.js 18+ has built-in fetch — no import needed

const SESSION_ID = '9c250b25-8202-488b-8d1c-597a1954d0d5';
const BASE       = 'http://127.0.0.1:3000/mcp';
const SYMBOL     = 'JPN225';
const TF         = 'M1';
const RANGE_N    = 20;
const SIM_BARS   = 50;
const BO_THRESH  = 0.5;
const DAYS_WANT  = 30;

// ─── MCP helper ───────────────────────────────────────────────────────────────
async function tool(name, args) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': SESSION_ID
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } })
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error(`No data line in response for ${name}`);
  const json = JSON.parse(line.replace('data:', '').trim());
  if (json.error) throw new Error(json.error.message);
  const content = json.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : json.result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function r2(n) { return Math.round(n * 100) / 100; }

function addMinutes(tStr, mins) {
  // tStr format: "2026.05.25 13:00"
  const [datePart, timePart] = tStr.split(' ');
  const [y, mo, d] = datePart.split('.');
  const [h, mi] = timePart.split(':');
  const dt = new Date(Date.UTC(+y, +mo-1, +d, +h, +mi) + mins * 60000);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}.${pad(dt.getUTCMonth()+1)}.${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

function dateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function getCandidateDates(startFromDate, count) {
  // Returns `count` weekdays going backwards from startFromDate (exclusive)
  const dates = [];
  const d = new Date(startFromDate);
  while (dates.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(dateStr(d));
  }
  return dates.reverse(); // oldest-first
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log(`⚙️  ${SYMBOL} | tf=${TF} | days=${DAYS_WANT} | range=${RANGE_N} bars | breakout>${BO_THRESH*100}% body | sim=${SIM_BARS} bars\n`);

// Step 0a already done (clear objects). Step 0b: build day list.
// Candidates: ~45 weekdays back from 2026-05-26 to cover 30 trading days
const candidates = getCandidateDates(new Date('2026-05-26T00:00:00Z'), 45);

console.log('📋 Building trading day list — fetching each candidate day...\n');

const collected = []; // { date, candles[] }

for (const date of candidates) {
  if (collected.length >= DAYS_WANT) break;
  try {
    // MQL5 StringToTime format: "YYYY.MM.DD HH:MM:SS"
    const mqlDate = date.replace(/-/g, '.');
    const data = await tool('mt5_get_candles', {
      symbol: SYMBOL, timeframe: TF,
      from_date: `${mqlDate} 00:00:00`,
      to_date:   `${mqlDate} 23:59:59`,
      count: 300
    });
    const candles = (data[''] || data.candles || []).map(c => ({
      t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v
    }));
    if (candles.length === 0) continue; // weekend / holiday
    collected.push({ date, candles });
  } catch(e) {
    console.error(`  ⚠️  Error ${date}: ${e.message}`);
  }
}

console.log(`✅ Found ${collected.length} trading days\n`);
console.log('═'.repeat(70));

// ─── Stats accumulators ───────────────────────────────────────────────────────
const results = [];
let noSignal = 0, skipped = 0, tp1 = 0, tp2 = 0, tp3 = 0, slHit = 0, openTrades = 0, sumR = 0;

// ─── Day loop ─────────────────────────────────────────────────────────────────
for (let di = 0; di < collected.length; di++) {
  const { date, candles } = collected[di];
  const dayN = di + 1;

  // ── Not enough bars? ──────────────────────────────────────────────────────
  if (candles.length < RANGE_N + 1) {
    console.log(`⚠️  Day ${dayN}/${collected.length} | ${date} | SKIPPED (${candles.length} bars < ${RANGE_N+1})`);
    skipped++;
    results.push({ day: dayN, date, dir: '—', bar: '—', entry: '—', sl: '—', R: '—', outcome: 'SKIPPED', r: '—' });
    continue;
  }

  // ── 2b. Session range ─────────────────────────────────────────────────────
  const rangeBars = candles.slice(0, RANGE_N);
  const rangeHigh = Math.max(...rangeBars.map(c => c.h));
  const rangeLow  = Math.min(...rangeBars.map(c => c.l));
  const rangeTimeStart = rangeBars[0].t;
  const rangeTimeEnd   = rangeBars[RANGE_N - 1].t;

  // ── 2c. Draw range rectangle ──────────────────────────────────────────────
  await tool('mt5_add_object', {
    name: `RB_Range_${date}`, type: 'RECTANGLE',
    time1: rangeTimeStart, price1: rangeHigh,
    time2: rangeTimeEnd,   price2: rangeLow,
    color: '#808080', style: 'DASH', fill: false, back: true, width: 1
  }).catch(() => {});

  // ── 2d. Scroll chart ──────────────────────────────────────────────────────
  await tool('mt5_scroll_chart', { datetime: rangeTimeStart, bars_shift: -10 }).catch(() => {});

  console.log(`\n📅 Day ${dayN}/${collected.length} — ${date} | Range (${RANGE_N} bars): ${rangeLow.toFixed(2)} – ${rangeHigh.toFixed(2)} | Width: ${(rangeHigh - rangeLow).toFixed(2)}`);

  // ── 2e. Scan for first valid breakout ─────────────────────────────────────
  let signal = null;
  for (let i = RANGE_N; i < candles.length; i++) {
    const c = candles[i];
    const bodyHigh = Math.max(c.o, c.c);
    const bodyLow  = Math.min(c.o, c.c);
    const bodySize = bodyHigh - bodyLow;
    if (bodySize < 0.01) continue; // doji

    const portionAbove = Math.max(0, bodyHigh - Math.max(bodyLow, rangeHigh));
    const portionBelow = Math.max(0, Math.min(bodyHigh, rangeLow) - bodyLow);
    const longFrac  = portionAbove / bodySize;
    const shortFrac = portionBelow / bodySize;

    if (longFrac > BO_THRESH || shortFrac > BO_THRESH) {
      const dir = longFrac >= shortFrac ? 'LONG' : 'SHORT';
      signal = { candle: c, idx: i, dir };
      break;
    }
  }

  if (!signal) {
    console.log(`⏭️  Day ${dayN} | ${date} | NO SIGNAL`);
    noSignal++;
    results.push({ day: dayN, date, dir: '—', bar: '—', entry: '—', sl: '—', R: '—', outcome: 'NONE', r: '—' });
    continue;
  }

  // ── 3a. Trade levels ──────────────────────────────────────────────────────
  const { candle: bc, idx: bIdx, dir } = signal;
  let entry, sl, tp1v, tp2v, tp3v, R;

  if (dir === 'LONG') {
    entry = rangeHigh; sl = bc.l;
    R = entry - sl;
    tp1v = entry + R; tp2v = entry + 2*R; tp3v = entry + 3*R;
  } else {
    entry = rangeLow; sl = bc.h;
    R = sl - entry;
    tp1v = entry - R; tp2v = entry - 2*R; tp3v = entry - 3*R;
  }

  if (R < 0.01) {
    console.log(`⚠️  Day ${dayN} | ${date} | SKIPPED (R≈0)`);
    skipped++;
    results.push({ day: dayN, date, dir, bar: bIdx+1, entry: r2(entry), sl: r2(sl), R: '~0', outcome: 'SKIPPED(R=0)', r: '—' });
    continue;
  }

  console.log(`🎯 ${dir} | bar ${bIdx+1} @ ${bc.t} | Entry: ${r2(entry)} | SL: ${r2(sl)} | R: ${R.toFixed(2)} | TP1: ${r2(tp1v)} TP2: ${r2(tp2v)} TP3: ${r2(tp3v)}`);

  // ── 3b. Arrow ─────────────────────────────────────────────────────────────
  await tool('mt5_add_object', {
    name: `RB_Arrow_${date}`,
    type: dir === 'LONG' ? 'ARROW_BUY' : 'ARROW_SELL',
    time1: bc.t,
    price1: dir === 'LONG' ? bc.l : bc.h,
    color: dir === 'LONG' ? '#00AA00' : '#FF0000',
    width: 2
  }).catch(() => {});

  // ── 3c. FIBO ──────────────────────────────────────────────────────────────
  await tool('mt5_add_object', {
    name: `RB_Fibo_${date}`, type: 'FIBO',
    time1: bc.t, price1: sl,
    time2: addMinutes(bc.t, 60), price2: entry,
    color: '#AAAAFF', width: 1
  }).catch(() => {});

  // ── 3d. Custom FIBO levels ────────────────────────────────────────────────
  await tool('mt5_modify_object', {
    name: `RB_Fibo_${date}`,
    properties: {
      OBJPROP_LEVELS: 5,
      OBJPROP_LEVELVALUE_0: 0.0, OBJPROP_LEVELVALUE_1: 1.0,
      OBJPROP_LEVELVALUE_2: 2.0, OBJPROP_LEVELVALUE_3: 3.0,
      OBJPROP_LEVELVALUE_4: 4.0
    }
  }).catch(() => {});

  // ── 4. Simulate outcome ───────────────────────────────────────────────────
  let simCandles = candles.slice(bIdx + 1);
  if (simCandles.length < SIM_BARS && di + 1 < collected.length) {
    const extra = collected[di + 1].candles.slice(0, SIM_BARS - simCandles.length);
    simCandles = simCandles.concat(extra);
  }
  simCandles = simCandles.slice(0, SIM_BARS);

  let outcome = 'OPEN', outcomeR = 0;
  for (const sc of simCandles) {
    if (dir === 'LONG') {
      if      (sc.l <= sl)   { outcome = 'SL';  outcomeR = -1; break; }
      else if (sc.h >= tp3v) { outcome = 'TP3'; outcomeR = +3; break; }
      else if (sc.h >= tp2v) { outcome = 'TP2'; outcomeR = +2; break; }
      else if (sc.h >= tp1v) { outcome = 'TP1'; outcomeR = +1; break; }
    } else {
      if      (sc.h >= sl)   { outcome = 'SL';  outcomeR = -1; break; }
      else if (sc.l <= tp3v) { outcome = 'TP3'; outcomeR = +3; break; }
      else if (sc.l <= tp2v) { outcome = 'TP2'; outcomeR = +2; break; }
      else if (sc.l <= tp1v) { outcome = 'TP1'; outcomeR = +1; break; }
    }
  }

  // ── 5. Day result ─────────────────────────────────────────────────────────
  sumR += outcomeR;
  if      (outcome === 'TP1') tp1++;
  else if (outcome === 'TP2') tp2++;
  else if (outcome === 'TP3') tp3++;
  else if (outcome === 'SL')  slHit++;
  else                         openTrades++;

  const icon = outcome.startsWith('TP') ? '✅' : outcome === 'SL' ? '❌' : '⏳';
  const rStr = outcomeR > 0 ? `+${outcomeR}R` : outcomeR < 0 ? `${outcomeR}R` : '0R';
  console.log(`${icon} Day ${dayN} | ${date} | ${dir.padEnd(5)} | R=${R.toFixed(0)} | ${outcome.padEnd(4)} (${rStr})`);
  results.push({ day: dayN, date, dir, bar: bIdx+1, entry: r2(entry), sl: r2(sl), R: R.toFixed(2), outcome, r: rStr });
}

// ─── Final Summary ────────────────────────────────────────────────────────────
const signals = tp1 + tp2 + tp3 + slHit + openTrades;
const wins    = tp1 + tp2 + tp3;
const grossW  = tp1*1 + tp2*2 + tp3*3;
const grossL  = slHit*1;
const pf      = grossL === 0 ? '∞' : (grossW / grossL).toFixed(2);
const wr      = signals ? (wins / signals * 100).toFixed(1) : '0.0';
const avgR    = signals ? (sumR / signals).toFixed(2) : '0.00';

console.log('\n' + '═'.repeat(65));
console.log(`  JPN225 RANGE BREAKOUT — ${DAYS_WANT} DAYS | range=${RANGE_N} bars`);
console.log('═'.repeat(65));
console.log(`  Total Days Scanned : ${collected.length}`);
console.log(`  Signals            : ${signals}  |  No Signal: ${noSignal}  |  Skipped: ${skipped}`);
console.log('');
console.log(`  Win Rate (TP1+)    : ${wr}%  (${wins}/${signals})`);
console.log(`  TP1 Hits           : ${tp1}  (${signals?((tp1/signals)*100).toFixed(1):0}%)`);
console.log(`  TP2 Hits           : ${tp2}  (${signals?((tp2/signals)*100).toFixed(1):0}%)`);
console.log(`  TP3 Hits           : ${tp3}  (${signals?((tp3/signals)*100).toFixed(1):0}%)`);
console.log(`  SL  Hits           : ${slHit}   (${signals?((slHit/signals)*100).toFixed(1):0}%)`);
console.log(`  Open               : ${openTrades}`);
console.log('');
console.log(`  Total R            : ${sumR >= 0 ? '+' : ''}${sumR.toFixed(1)}R`);
console.log(`  Avg R / Trade      : ${Number(avgR) >= 0 ? '+' : ''}${avgR}R`);
console.log(`  Profit Factor      : ${pf}`);
console.log('═'.repeat(65));

// Day-by-day table
console.log('\n| #  | Date       | Dir   | Bar | Entry    | SL       | R       | Outcome | R      |');
console.log('|----|------------|-------|-----|----------|----------|---------|---------|--------|');
for (const r of results) {
  const n   = String(r.day).padStart(2);
  const dir = String(r.dir).padEnd(5);
  const bar = String(r.bar).padStart(3);
  const ent = String(r.entry).padStart(8);
  const sl  = String(r.sl).padStart(8);
  const rv  = String(r.R).padStart(7);
  const out = String(r.outcome).padEnd(7);
  const rr  = String(r.r).padStart(6);
  console.log(`| ${n} | ${r.date} | ${dir} | ${bar} | ${ent} | ${sl} | ${rv} | ${out} | ${rr} |`);
}
