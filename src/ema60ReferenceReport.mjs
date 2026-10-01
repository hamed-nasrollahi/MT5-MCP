import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ms = t => Date.parse(t.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T') + 'Z');
const bars = new Map(data.candles.map(b => [b.t.length === 16 ? `${b.t}:00` : b.t, b]));
const atrAt = time => {
  const i = data.candles.findIndex(b => ms(b.t) === ms(time));
  if (i < 14) return null;
  let sum = 0;
  for (let j = i - 13; j <= i; j++) {
    const b = data.candles[j], prev = data.candles[j - 1];
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  return sum / 14;
};
const keyMetrics = (trade, range) => {
  const key = bars.get(trade.keybar_time);
  if (!key) return null;
  const span = key.high - key.low, height = range.high - range.low;
  const buy = trade.side === 'BUY';
  return { spanRatio: height ? span / height : 0,
    outside: span ? (buy ? Math.max(0, key.high - Math.max(key.low, range.high)) :
    Math.max(0, Math.min(key.high, range.low) - key.low)) / span : 0,
    breakRatio: height ? (buy ? key.close - range.high : range.low - key.close) / height : 0,
    wick: span ? (buy ? key.high - Math.max(key.open, key.close) : Math.min(key.open, key.close) - key.low) / span : 0 };
};
const ranges = data.ranges.map(r => {
  const inside = data.candles.filter(b => ms(b.t) >= ms(r.start) && ms(b.t) <= ms(r.end));
  const max = Math.max(...inside.map(b => b.high)), min = Math.min(...inside.map(b => b.low));
  return { name: r.id, start: r.start, end: r.end, minutes: (ms(r.end) - ms(r.start)) / 60000,
    type: r.valid ? 'SROB' : 'H1OB', origin: r.origin,
    heightATR: atrAt(r.end) ? Math.round((r.high - r.low) / atrAt(r.end) * 10) / 10 : null,
    topDifferencePips: Math.round((r.high - max) * 100000) / 10,
    bottomDifferencePips: Math.round((min - r.low) * 100000) / 10 };
});
const trades = data.trades.map(t => {
  const candidate = data.ranges.filter(r => r.valid && ms(r.start) < ms(t.sl_time) && ms(r.end) <= ms(t.entry_time) &&
    ms(t.entry_time) - ms(r.end) <= 40 * 60000)
    .map(r => ({ r, dt: ms(t.entry_time) - ms(r.end), metrics: keyMetrics(t, r) }))
    .sort((a, b) => a.dt - b.dt)[0];
  const signal = bars.get(t.sl_time);
  const middleTime = t.setup_candles === 3 ? new Date(ms(t.sl_time) + 60000).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3 ').slice(0, 19) : null;
  const middle = middleTime ? bars.get(middleTime) : null;
  const height = candidate ? candidate.r.high - candidate.r.low : 0;
  const edge = signal && candidate ? (t.side === 'BUY' ? candidate.r.high - signal.high : signal.low - candidate.r.low) / height : null;
  const signalStop = signal ? (t.side === 'BUY' ? signal.low : signal.high) : null;
  const combinedStop = signal && middle ? (t.side === 'BUY' ? Math.min(signal.low, middle.low) : Math.max(signal.high, middle.high)) : null;
  const entryBar = bars.get(t.entry_time);
  const immediatelyBeforeKey = bars.get(new Date(ms(t.keybar_time) - 60000).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3 ').slice(0, 19));
  const twoBeforeKey = bars.get(new Date(ms(t.keybar_time) - 120000).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3 ').slice(0, 19));
  const shape = b => b && height ? {
    body: Math.round(Math.abs(b.close-b.open)/height*100),
    directionalBody: Math.round((t.side==='BUY'?b.close-b.open:b.open-b.close)/height*100),
    closeBeyond: Math.round((t.side==='BUY'?b.close-candidate.r.high:candidate.r.low-b.close)/height*100),
    wick: Math.round((t.side==='BUY'?b.high-Math.max(b.open,b.close):Math.min(b.open,b.close)-b.low)/(b.high-b.low||1)*100)
  } : null;
  return { name: t.name, setupCandles: t.setup_candles, signal: t.sl_time, keybar: t.keybar_time,
    entry: t.entry_time, range: candidate?.r.id ?? null, rangeEndLag: candidate?.dt / 60000 ?? null,
    signalSpanRatio: signal && height ? Math.round((signal.high - signal.low) / height * 100) : null,
    middleSpanRatio: middle && height ? Math.round((middle.high - middle.low) / height * 100) : null,
    edgeGapRatio: edge == null ? null : Math.round(edge * 100),
    signalStopDifferencePips: signalStop == null ? null : Math.round(Math.abs(t.sl - signalStop) * 100000) / 10,
    combinedStopDifferencePips: combinedStop == null ? null : Math.round(Math.abs(t.sl - combinedStop) * 100000) / 10,
    entryOpenDifferencePips: entryBar ? Math.round(Math.abs(t.entry_price - entryBar.open) * 100000) / 10 : null,
    firstShape: shape(signal), penultimateShape: shape(immediatelyBeforeKey),
    olderStopAdvantagePips: immediatelyBeforeKey && twoBeforeKey ? Math.round((t.side==='BUY'
      ? immediatelyBeforeKey.low-twoBeforeKey.low : twoBeforeKey.high-immediatelyBeforeKey.high)*100000)/10 : null,
    outside: candidate?.metrics ? Math.round(candidate.metrics.outside * 100) : null,
    keySpanRatio: candidate?.metrics ? Math.round(candidate.metrics.spanRatio * 100) : null,
    breakRatio: candidate?.metrics ? Math.round(candidate.metrics.breakRatio * 100) : null,
    wick: candidate?.metrics ? Math.round(candidate.metrics.wick * 100) : null };
});
console.log(JSON.stringify({ ranges, trades }, null, 2));
