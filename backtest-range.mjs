#!/usr/bin/env node
/**
 * JPN225 Range Breakout Backtest — MCP data files processor
 *
 * Input:  ./rb-data/dayYYYY-MM-DD.json  (one per trading day, raw mt5_get_candles JSON)
 * Output: Backtest results + chart-objects payload
 *
 * Strategy rules:
 *  - First 20 M1 bars of session = range (rangeHigh / rangeLow)
 *  - Scan from bar 21: valid break = >50% of candle BODY outside range boundary
 *  - LONG:  entry = rangeHigh, SL = break-candle low,  TP1/2/3 = entry +1R/+2R/+3R
 *  - SHORT: entry = rangeLow,  SL = break-candle high, TP1/2/3 = entry -1R/-2R/-3R
 *  - Trade sim: scan candles after break candle (SL checked before TP on same bar)
 */

import fs   from 'fs';
import path from 'path';

const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'rb-data');

// ── helpers ──────────────────────────────────────────────────────────────────
function parseCandles(raw) {
  const arr = raw[''] ?? raw.candles ?? [];
  if (!Array.isArray(arr)) throw new Error('Cannot parse candle array from JSON');
  return arr.map(c => ({ t:c.t, o:+c.o, h:+c.h, l:+c.l, c:+c.c, v:+c.v }));
}

function r2(n) { return Math.round(n * 100) / 100; }

// ── breakout check ───────────────────────────────────────────────────────────
function findBreakout(candles, hi, lo) {
  for (let i = 20; i < candles.length; i++) {
    const b       = candles[i];
    const bodyTop = Math.max(b.o, b.c);
    const bodyBot = Math.min(b.o, b.c);
    const size    = bodyTop - bodyBot;
    if (size < 0.01) continue;           // doji – skip

    // LONG
    if (bodyTop > hi) {
      const out = bodyTop - Math.max(bodyBot, hi);
      if (out / size > 0.5) return { dir:'LONG', idx:i, bar:b };
    }
    // SHORT
    if (bodyBot < lo) {
      const out = Math.min(bodyTop, lo) - bodyBot;
      if (out / size > 0.5) return { dir:'SHORT', idx:i, bar:b };
    }
  }
  return null;
}

// ── trade simulation ─────────────────────────────────────────────────────────
function simulate(candles, startIdx, dir, sl, tp1, tp2, tp3) {
  for (let i = startIdx; i < candles.length; i++) {
    const b = candles[i];
    if (dir === 'LONG') {
      if (b.l <= sl)   return { result:'SL',  rr:-1, exitTime:b.t };
      if (b.h >= tp3)  return { result:'TP3', rr: 3, exitTime:b.t };
      if (b.h >= tp2)  return { result:'TP2', rr: 2, exitTime:b.t };
      if (b.h >= tp1)  return { result:'TP1', rr: 1, exitTime:b.t };
    } else {
      if (b.h >= sl)   return { result:'SL',  rr:-1, exitTime:b.t };
      if (b.l <= tp3)  return { result:'TP3', rr: 3, exitTime:b.t };
      if (b.l <= tp2)  return { result:'TP2', rr: 2, exitTime:b.t };
      if (b.l <= tp1)  return { result:'TP1', rr: 1, exitTime:b.t };
    }
  }
  return { result:'OPEN', rr:0, exitTime:null };
}

// ── process one day ───────────────────────────────────────────────────────────
function processDay(date, candles) {
  const base = { date };
  if (candles.length < 22)
    return { ...base, signal:false, reason:`only ${candles.length} bars` };

  const rangeBars = candles.slice(0, 20);
  const hi = Math.max(...rangeBars.map(b=>b.h));
  const lo = Math.min(...rangeBars.map(b=>b.l));

  const bo = findBreakout(candles, hi, lo);
  if (!bo)
    return { ...base, signal:false, reason:'no valid breakout', rangeHigh:r2(hi), rangeLow:r2(lo),
             rangeStart:rangeBars[0].t, rangeEnd:rangeBars[19].t };

  const entry = bo.dir === 'LONG' ? hi : lo;
  const sl    = bo.dir === 'LONG' ? bo.bar.l : bo.bar.h;
  const R     = Math.abs(entry - sl);
  const s     = bo.dir === 'LONG' ? 1 : -1;
  const tp1   = entry + s*R;
  const tp2   = entry + s*2*R;
  const tp3   = entry + s*3*R;

  const sim = simulate(candles, bo.idx + 1, bo.dir, sl, tp1, tp2, tp3);

  return {
    ...base,
    signal       : true,
    dir          : bo.dir,
    rangeStart   : rangeBars[0].t,
    rangeEnd     : rangeBars[19].t,
    rangeHigh    : r2(hi),
    rangeLow     : r2(lo),
    entry        : r2(entry),
    sl           : r2(sl),
    R            : r2(R),
    tp1          : r2(tp1),
    tp2          : r2(tp2),
    tp3          : r2(tp3),
    breakoutTime : bo.bar.t,
    breakoutO    : bo.bar.o,
    breakoutH    : bo.bar.h,
    breakoutL    : bo.bar.l,
    breakoutC    : bo.bar.c,
    result       : sim.result,
    rr           : sim.rr,
    exitTime     : sim.exitTime
  };
}

// ── load all days ─────────────────────────────────────────────────────────────
const files = fs.readdirSync(dir)
  .filter(f => f.startsWith('day') && f.endsWith('.json'))
  .sort();

const dayResults = files.map(f => {
  const date    = f.replace(/^day/,'').replace(/\.json$/,'');
  const raw     = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  const candles = parseCandles(raw);
  return processDay(date, candles);
});

// ── summary stats ─────────────────────────────────────────────────────────────
const signals  = dayResults.filter(d=>d.signal);
const resolved = signals.filter(d=>d.result !== 'OPEN');
const wins     = resolved.filter(d=>d.result !== 'SL');
const losses   = resolved.filter(d=>d.result === 'SL');

const grossWin  = wins.reduce((s,d)=>s+d.rr,0);
const grossLoss = losses.length;
const pf        = grossLoss===0 ? Infinity : r2(grossWin/grossLoss);
const avgR      = resolved.length ? r2(resolved.reduce((s,d)=>s+d.rr,0)/resolved.length) : 0;
const winRate   = resolved.length ? r2(wins.length/resolved.length*100) : 0;

const summary = {
  totalDays    : dayResults.length,
  signalDays   : signals.length,
  noSignalDays : dayResults.length - signals.length,
  resolved     : resolved.length,
  openTrades   : signals.filter(d=>d.result==='OPEN').length,
  wins         : wins.length,
  losses       : losses.length,
  winRate_pct  : winRate,
  tp1hits      : resolved.filter(d=>d.result==='TP1').length,
  tp2hits      : resolved.filter(d=>d.result==='TP2').length,
  tp3hits      : resolved.filter(d=>d.result==='TP3').length,
  grossWinR    : r2(grossWin),
  grossLossR   : r2(grossLoss),
  netR         : r2(grossWin - grossLoss),
  profitFactor : isFinite(pf) ? pf : 'inf',
  avgR
};

// ── chart-objects payload ─────────────────────────────────────────────────────
const objects = [];
for (const d of dayResults) {
  if (!d.rangeStart) continue;
  const ds  = d.date.replace(/-/g,'');
  const pfx = 'RB_' + ds;

  // Range rectangle (grey dashed)
  objects.push({
    op:'add', name:`${pfx}_RNG`, type:'RECTANGLE',
    time1:d.rangeStart, price1:d.rangeLow,
    time2:d.rangeEnd,   price2:d.rangeHigh,
    color:'#808080', style:'DASH', fill:false, back:true
  });

  if (!d.signal) continue;

  // Arrow at break candle
  objects.push({
    op:'add',
    name :`${pfx}_ARR`,
    type : d.dir==='LONG' ? 'ARROW_BUY' : 'ARROW_SELL',
    time1: d.breakoutTime,
    price1: d.dir==='LONG' ? d.breakoutL : d.breakoutH,
    color: d.dir==='LONG' ? '#00AA00' : '#CC0000',
    width: 2
  });

  // FIBO  (price1=SL/0%, price2=Entry/100% → 200%=TP1, 300%=TP2, 400%=TP3)
  const fiboEnd = d.exitTime ?? d.breakoutTime;
  objects.push({
    op:'add',
    name  :`${pfx}_FIB`,
    type  :'FIBO',
    time1 : d.breakoutTime,
    price1: d.sl,          // 0%
    time2 : fiboEnd,
    price2: d.entry,       // 100%
    color : d.dir==='LONG' ? '#2255FF' : '#FF5522',
    description: `${d.dir} ${d.result}`
  });

  // Fibo custom levels modification (5 levels: 0%,100%,200%,300%,400%)
  objects.push({
    op:'modify', name:`${pfx}_FIB`,
    properties:{
      OBJPROP_LEVELS       : 5,
      OBJPROP_LEVELVALUE_0 : 0,
      OBJPROP_LEVELVALUE_1 : 1,
      OBJPROP_LEVELVALUE_2 : 2,
      OBJPROP_LEVELVALUE_3 : 3,
      OBJPROP_LEVELVALUE_4 : 4
    }
  });
}

// ── output ────────────────────────────────────────────────────────────────────
const out = { summary, dayResults, objects };
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
