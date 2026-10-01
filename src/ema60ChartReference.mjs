import fs from 'node:fs';

const dateMs = value => Date.parse(String(value).replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T') + 'Z');
const iso = value => new Date(value).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3 ').slice(0, 19);
const reviewDay = time => /^2026\.09\.(29|30) /.test(time ?? '');

export function extractChartReference(snapshot, candleSource) {
  const objects = snapshot.objects ?? [];
  const ranges = objects.filter(o => o.type === 'OBJ_RECTANGLE' && reviewDay(o.anchors?.[0]?.time))
    .map(o => {
      const anchors = o.anchors ?? [];
      const dated = anchors.filter(a => reviewDay(a.time));
      if (dated.length < 2) return null;
      const start = dated.reduce((a, b) => dateMs(a.time) < dateMs(b.time) ? a : b).time;
      const end = dated.reduce((a, b) => dateMs(a.time) > dateMs(b.time) ? a : b).time;
      return { id: o.name, start, end,
        high: Math.max(...anchors.map(a => +a.price)), low: Math.min(...anchors.map(a => +a.price)),
        valid: !/^(?:H1OB_|H1-OB_)/.test(o.name),
        origin: /^(?:SR-OB_|H1-OB_)/.test(o.name) ? 'manual_rectangle' : 'corrected_existing_rectangle' };
    }).filter(Boolean);

  const trades = objects.filter(o => o.type === 'OBJ_FIBO' && /^(?:WB|LB|WS|LS)_/.test(o.name))
    .map(o => {
      const [sl, entry] = o.anchors ?? [];
      if (!sl || !entry || !reviewDay(entry.time)) return null;
      const setupCandles = Math.round((dateMs(entry.time) - dateMs(sl.time)) / 60000);
      return { name: o.name, side: /^[WL]B_/.test(o.name) ? 'BUY' : 'SELL',
        outcome: /^W/.test(o.name) ? 'W' : 'L',
        entry_time: entry.time, entry_price: +entry.price,
        sl_time: sl.time, sl: +sl.price,
        keybar_time: iso(dateMs(entry.time) - 60000), setup_candles: setupCandles,
        fib_levels: o.levels?.map(({ value, text }) => ({ value, text })) };
    }).filter(Boolean).sort((a, b) => dateMs(a.entry_time) - dateMs(b.entry_time));

  return { symbol: 'EURUSD', timeframe: 'M1', candles: candleSource.candles ?? [], ranges, trades,
    reference: { source: 'Live corrected EURUSD M1 chart objects', chart_id: snapshot.chart_id,
      captured_date: snapshot.captured_date, one_candle_anchor_exceptions: trades.filter(t => t.setup_candles < 2).map(t => t.name) } };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const [snapshotPath, candlesPath, outputPath] = process.argv.slice(2);
  if (!snapshotPath || !candlesPath || !outputPath) throw Error('Usage: node src/ema60ChartReference.mjs <chart-snapshot.json> <candles.json> <output.json>');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8').replace(/^\uFEFF/, ''));
  const candleSource = JSON.parse(fs.readFileSync(candlesPath, 'utf8').replace(/^\uFEFF/, ''));
  const reference = extractChartReference(snapshot, candleSource);
  fs.writeFileSync(outputPath, JSON.stringify(reference, null, 2) + '\n');
  console.log(JSON.stringify({ candles: reference.candles.length, ranges: reference.ranges.length,
    trades: reference.trades.length, setup_candles: reference.trades.reduce((a, t) => (a[t.setup_candles] = (a[t.setup_candles] ?? 0) + 1, a), {}),
    one_candle_anchor_exceptions: reference.reference.one_candle_anchor_exceptions }));
}
