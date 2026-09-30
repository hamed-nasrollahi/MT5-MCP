const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume"]);
const OPERATORS = new Set(["gt", "gte", "lt", "lte", "eq", "cross_above", "cross_below"]);
const INDICATORS = new Set(["sma", "ema", "rsi", "atr", "highest_high", "lowest_low"]);
const STRATEGY_FIELDS = new Set(["entry_long", "entry_short", "exit_long", "exit_short", "sl_pips", "tp_pips", "spread_points"]);
const MAX_RULE_NODES = 128;
const MAX_PERIOD = 5000;

function parseTime(value) {
  const text = String(value ?? "");
  const normalized = text.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3");
  const wallClock = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(normalized);
  if (wallClock) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "0"] = wallClock;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(`0.${fraction}`) * 1000);
  }
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error(`Invalid MT5 candle time: ${text}`);
  return ms;
}

function normalizeCandles(payload) {
  const rows = payload?.candles;
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("At least two historical candles are required");
  const bars = rows.map((row) => ({
    time: String(row.t),
    ms: parseTime(row.t),
    open: Number(row.o), high: Number(row.h), low: Number(row.l),
    close: Number(row.c), volume: Number(row.v ?? 0),
  }));
  for (const bar of bars) {
    if (!Number.isFinite(bar.ms)) throw new Error(`Invalid candle time: ${bar.time}`);
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) {
      throw new Error(`Invalid OHLC values at ${bar.time}`);
    }
    if (bar.high < bar.low) throw new Error(`Candle high is below low at ${bar.time}`);
  }
  bars.sort((a, b) => a.ms - b.ms);
  return bars;
}

function validateCondition(node, state = { nodes: 0 }, depth = 0) {
  if (depth > 12 || ++state.nodes > MAX_RULE_NODES) throw new Error("Strategy condition tree is too large or deeply nested");
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("Each strategy condition must be an object");
  if (Number(Array.isArray(node.all)) + Number(Array.isArray(node.any)) + Number(Boolean(node.not)) > 1) {
    throw new Error("Use only one of all, any, or not in a condition node");
  }
  if (Array.isArray(node.all) || Array.isArray(node.any)) {
    const group = node.all ?? node.any;
    if (group.length === 0) throw new Error("Condition groups cannot be empty");
    group.forEach((child) => validateCondition(child, state, depth + 1));
    return;
  }
  if (node.not) return validateCondition(node.not, state, depth + 1);
  if (node.op === "time_between") {
    if (!/^\d{2}:\d{2}$/.test(node.from ?? "") || !/^\d{2}:\d{2}$/.test(node.to ?? "")) {
      throw new Error("time_between requires from and to in HH:mm format");
    }
    for (const value of [node.from, node.to]) {
      const [hour, minute] = value.split(":").map(Number);
      if (hour > 23 || minute > 59) throw new Error("time_between values must be valid clock times");
    }
    return;
  }
  if (!OPERATORS.has(node.op)) throw new Error(`Unsupported condition operator: ${node.op}`);
  validateOperand(node.left);
  validateOperand(node.right);
}

function validateOperand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Condition operands must be objects");
  if (Object.hasOwn(value, "value")) {
    if (!Number.isFinite(Number(value.value))) throw new Error("Constant operands must be numeric");
    return;
  }
  const offset = Number(value.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PERIOD) throw new Error("Operand offset must be an integer from 0 to 5000");
  if (value.series) {
    if (!PRICE_FIELDS.has(value.series)) throw new Error(`Unsupported candle series: ${value.series}`);
    return;
  }
  if (!INDICATORS.has(value.indicator)) throw new Error(`Unsupported indicator: ${value.indicator}`);
  if (value.indicator !== "atr" && !PRICE_FIELDS.has(value.source ?? "close")) {
    throw new Error(`Unsupported indicator source: ${value.source}`);
  }
  const period = Number(value.period);
  if (!Number.isInteger(period) || period < 1 || period > MAX_PERIOD) throw new Error("Indicator period must be an integer from 1 to 5000");
}

function rollingAverage(values, period) {
  const out = Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function exponentialAverage(values, period) {
  const out = Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let current = seed / period;
  out[period - 1] = current;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current += alpha * (values[i] - current);
    out[i] = current;
  }
  return out;
}

function wilderAverage(values, period) {
  const out = Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) sum += values[i];
    if (i === period - 1) out[i] = sum / period;
    else if (i >= period) out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

function rsi(bars, period, source) {
  const out = Array(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i][source] - bars[i - 1][source];
    avgGain += Math.max(0, change);
    avgLoss += Math.max(0, -change);
  }
  avgGain /= period;
  avgLoss /= period;
  const value = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = value();
  for (let i = period + 1; i < bars.length; i++) {
    const change = bars[i][source] - bars[i - 1][source];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
    out[i] = value();
  }
  return out;
}

function atr(bars, period) {
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close));
  });
  return wilderAverage(tr, period);
}

function rollingExtreme(values, period, highest) {
  const out = Array(values.length).fill(NaN);
  const queue = [];
  let head = 0;
  for (let i = 0; i < values.length; i++) {
    while (queue.length > head && (highest ? values[queue.at(-1)] <= values[i] : values[queue.at(-1)] >= values[i])) queue.pop();
    queue.push(i);
    while (queue[head] <= i - period) head++;
    if (i >= period - 1) out[i] = values[queue[head]];
    if (head > 1024 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
  }
  return out;
}

function createEvaluator(bars) {
  const cache = new Map();
  const series = new Map([...PRICE_FIELDS].map((key) => [key, bars.map((bar) => bar[key])]));
  function getSeries(spec) {
    if (Object.hasOwn(spec, "value")) return null;
    if (spec.series) return series.get(spec.series);
    const key = JSON.stringify(spec);
    if (cache.has(key)) return cache.get(key);
    const period = Number(spec.period);
    const src = spec.source ?? "close";
    const values = series.get(src);
    let result;
    switch (spec.indicator) {
      case "sma": result = rollingAverage(values, period); break;
      case "ema": result = exponentialAverage(values, period); break;
      case "rsi": result = rsi(bars, period, src); break;
      case "atr": result = atr(bars, period); break;
      case "highest_high": result = rollingExtreme(series.get("high"), period, true); break;
      case "lowest_low": result = rollingExtreme(series.get("low"), period, false); break;
      default: throw new Error(`Unsupported indicator: ${spec.indicator}`);
    }
    cache.set(key, result);
    return result;
  }
  function valueAt(spec, index) {
    if (Object.hasOwn(spec, "value")) return Number(spec.value);
    const values = getSeries(spec);
    return values[index - Number(spec.offset ?? 0)];
  }
  function evaluate(node, index) {
    if (Array.isArray(node.all)) return node.all.every((child) => evaluate(child, index));
    if (Array.isArray(node.any)) return node.any.some((child) => evaluate(child, index));
    if (node.not) return !evaluate(node.not, index);
    if (node.op === "time_between") {
      const hm = new Date(bars[index].ms).toISOString().slice(11, 16);
      return node.from <= node.to ? hm >= node.from && hm <= node.to : hm >= node.from || hm <= node.to;
    }
    const left = valueAt(node.left, index), right = valueAt(node.right, index);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    switch (node.op) {
      case "gt": return left > right;
      case "gte": return left >= right;
      case "lt": return left < right;
      case "lte": return left <= right;
      case "eq": return left === right;
      case "cross_above": return index > 0 && valueAt(node.left, index - 1) <= valueAt(node.right, index - 1) && left > right;
      case "cross_below": return index > 0 && valueAt(node.left, index - 1) >= valueAt(node.right, index - 1) && left < right;
      default: return false;
    }
  }
  return { evaluate };
}

function normalizeTimeframeSeconds(timeframe) {
  if (String(timeframe).toUpperCase() === "MN1") return 30 * 86400;
  const match = /^(M|H|D|W)(\d+)$/.exec(String(timeframe).toUpperCase());
  if (!match) return 60;
  const scale = { M: 60, H: 3600, D: 86400, W: 604800 }[match[1]];
  return scale * Number(match[2]);
}

function conditionLookback(node) {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node.all)) return Math.max(0, ...node.all.map(conditionLookback));
  if (Array.isArray(node.any)) return Math.max(0, ...node.any.map(conditionLookback));
  if (node.not) return conditionLookback(node.not);
  const required = (operand) => Number(operand?.offset ?? 0) + Number(operand?.period ?? 0);
  return Math.max(required(node.left), required(node.right));
}

function getEntryIndex(signalIndex, bars, startMs) {
  const next = signalIndex + 1;
  return next < bars.length && bars[signalIndex].ms >= startMs ? next : -1;
}

export function warmupStart(fromDate, timeframe, strategy) {
  const start = parseTime(fromDate);
  const lookback = Math.max(
    conditionLookback(strategy.entry_long), conditionLookback(strategy.entry_short),
    conditionLookback(strategy.exit_long), conditionLookback(strategy.exit_short), 0
  );
  const bars = Math.min(MAX_PERIOD * 2 + 2, Math.ceil((lookback + 2) * 2));
  return new Date(start - bars * normalizeTimeframeSeconds(timeframe) * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function validateStrategyDefinition(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) throw new Error("strategy must be an object");
  for (const key of Object.keys(strategy)) if (!STRATEGY_FIELDS.has(key)) throw new Error(`Unsupported strategy field: ${key}`);
  for (const key of ["entry_long", "entry_short", "exit_long", "exit_short"]) {
    if (strategy[key] != null) validateCondition(strategy[key]);
  }
  if (strategy.entry_long == null && strategy.entry_short == null) throw new Error("Provide entry_long, entry_short, or both");
  for (const key of ["sl_pips", "tp_pips", "spread_points"]) {
    if (strategy[key] != null && (!Number.isFinite(Number(strategy[key])) || Number(strategy[key]) < 0)) {
      throw new Error(`${key} must be a nonnegative number`);
    }
  }
}

export function runStrategyBacktest(payload, strategy, options = {}) {
  validateStrategyDefinition(strategy);
  const bars = normalizeCandles(payload);
  const evaluator = createEvaluator(bars);
  const startMs = options.fromDate ? parseTime(options.fromDate) : bars[0].ms;
  const endMs = options.toDate ? parseTime(options.toDate) : Infinity;
  const pipSize = Number(options.pipSize);
  if (!Number.isFinite(pipSize) || pipSize <= 0) throw new Error("A positive pip_size is required");
  const spreadPoints = Number(strategy.spread_points ?? 0);
  const point = Number(options.point ?? 0);
  if (!Number.isFinite(spreadPoints) || spreadPoints < 0) throw new Error("spread_points must be a nonnegative number");
  if (!Number.isFinite(point) || point < 0) throw new Error("point must be a nonnegative number");
  const spread = spreadPoints * point;
  const slDistance = Number(strategy.sl_pips ?? 0) * pipSize;
  const tpDistance = Number(strategy.tp_pips ?? 0) * pipSize;
  if (!Number.isFinite(slDistance) || !Number.isFinite(tpDistance) || slDistance < 0 || tpDistance < 0) {
    throw new Error("sl_pips and tp_pips must be nonnegative numbers");
  }
  const trades = [];
  let position = null;
  let lastTestIndex = -1;
  for (let i = 0; i < bars.length && bars[i].ms <= endMs; i++) {
    if (bars[i].ms >= startMs) lastTestIndex = i;
  }

  function closePosition(index, price, reason) {
    const bar = bars[index];
    const exitPrice = price;
    const move = position.type === "BUY" ? exitPrice - position.entry : position.entry - exitPrice;
    const pips = move / pipSize;
    trades.push({
      type: position.type, signal_time: position.signalTime, open_time: position.openTime,
      close_time: bar.time, entry: position.entry, exit: exitPrice, sl: position.sl,
      tp: position.tp, pips: Number(pips.toFixed(2)), reason,
    });
    position = null;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.ms > endMs) break;
    if (bar.ms >= startMs) lastTestIndex = i;

    if (position) {
      const shortSpread = position.type === "SELL" ? spread : 0;
      const high = bar.high + shortSpread, low = bar.low + shortSpread;
      const stopHit = position.sl != null && (position.type === "BUY" ? low <= position.sl : high >= position.sl);
      const targetHit = position.tp != null && (position.type === "BUY" ? high >= position.tp : low <= position.tp);
      if (stopHit || targetHit) {
        const gap = position.type === "BUY" ? bar.open <= position.sl : bar.open + shortSpread >= position.sl;
        closePosition(i, stopHit ? (gap ? bar.open + shortSpread : position.sl) : position.tp, stopHit ? "stop_loss" : "take_profit");
        continue;
      }
      const exitRule = position.type === "BUY" ? strategy.exit_long : strategy.exit_short;
      if (exitRule && evaluator.evaluate(exitRule, i)) {
        const exitIndex = i < lastTestIndex ? i + 1 : i;
        const exitBar = bars[exitIndex];
        const px = exitIndex === i
          ? (position.type === "BUY" ? exitBar.close : exitBar.close + spread)
          : (position.type === "BUY" ? exitBar.open : exitBar.open + spread);
        closePosition(exitIndex, px, exitIndex === i ? "rule_exit_at_end" : "rule_exit");
        continue;
      }
    }

    if (!position && bar.ms >= startMs) {
      const long = strategy.entry_long ? evaluator.evaluate(strategy.entry_long, i) : false;
      const short = strategy.entry_short ? evaluator.evaluate(strategy.entry_short, i) : false;
      if (long && short) throw new Error(`Both long and short entry rules matched at ${bar.time}`);
      if (long || short) {
        const entryIndex = getEntryIndex(i, bars, startMs);
        if (entryIndex < 0 || bars[entryIndex].ms > endMs) continue;
        const type = long ? "BUY" : "SELL";
        const entryBar = bars[entryIndex];
        const entry = type === "BUY" ? entryBar.open + spread : entryBar.open;
        position = {
          type, entry, signalTime: bar.time, openTime: entryBar.time,
          sl: slDistance > 0 ? entry + (type === "BUY" ? -slDistance : slDistance) : null,
          tp: tpDistance > 0 ? entry + (type === "BUY" ? tpDistance : -tpDistance) : null,
        };
      }
    }
  }

  if (position && lastTestIndex >= 0) {
    const finalBar = bars[lastTestIndex];
    closePosition(lastTestIndex, position.type === "BUY" ? finalBar.close : finalBar.close + spread, "end_of_data");
  }
  const winners = trades.filter((trade) => trade.pips > 0);
  const losers = trades.filter((trade) => trade.pips < 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.pips;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pips, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.pips, 0));
  return {
    bars_tested: bars.filter((bar) => bar.ms >= startMs && bar.ms <= endMs).length,
    trades,
    summary: {
      total_trades: trades.length, wins: winners.length, losses: losers.length,
      win_rate_pct: trades.length ? Number((winners.length / trades.length * 100).toFixed(2)) : 0,
      net_pips: Number(trades.reduce((sum, trade) => sum + trade.pips, 0).toFixed(2)),
      profit_factor: grossLoss ? Number((grossProfit / grossLoss).toFixed(3)) : (grossProfit ? null : 0),
      max_drawdown_pips: Number(maxDrawdown.toFixed(2)),
      costs: { spread_points: Number(strategy.spread_points ?? 0), commission: "not modeled", slippage: "not modeled" },
      execution: "signal on closed bar; market entry/condition exit at next bar open; stop wins same-bar SL/TP ties",
    },
  };
}

export function buildTradeAnnotations(trades, prefix = "RULE_BT_", timeframe = "M1") {
  const objects = [];
  let index = 0;
  for (const trade of trades) {
    const buy = trade.type === "BUY";
    const color = trade.pips >= 0 ? "LimeGreen" : "Crimson";
    const suffix = String(index++).padStart(6, "0");
    const openMs = parseTime(trade.open_time), closeMs = parseTime(trade.close_time);
    const endMs = closeMs <= openMs ? openMs + normalizeTimeframeSeconds(timeframe) * 1000 : closeMs;
    const endTime = new Date(endMs).toISOString().replace("T", " ").slice(0, 19);
    objects.push({ name: `${prefix}ENTRY_${suffix}`, type: buy ? "ARROW_BUY" : "ARROW_SELL", time1: trade.open_time, price1: trade.entry, color: buy ? "Blue" : "Red", description: `${trade.type} entry; signal ${trade.signal_time}` });
    objects.push({ name: `${prefix}EXIT_${suffix}`, type: "ARROW", time1: trade.close_time, price1: trade.exit, color, description: `${trade.reason}: ${trade.pips} pips` });
    objects.push({ name: `${prefix}RESULT_${suffix}`, type: "RECTANGLE", time1: trade.open_time, price1: trade.entry, time2: endTime, price2: trade.exit, color, fill: true, back: true, description: `${trade.type} ${trade.pips} pips (${trade.reason})` });
    for (const [level, price, style] of [["SL", trade.sl, "DASH"], ["TP", trade.tp, "DOT"]]) {
      if (price == null) continue;
      objects.push({ name: `${prefix}${level}_${suffix}`, type: "TRENDLINE", time1: trade.open_time, price1: price, time2: endTime, price2: price, color: level === "SL" ? "Crimson" : "LimeGreen", style, description: `${level} ${price}` });
    }
  }
  return objects;
}
