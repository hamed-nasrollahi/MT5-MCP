/**
 * tools.js — every MCP tool exposed to Claude.
 * Each entry: { name, description, inputSchema, handler(bridge, args) }
 */
import { buildTradeAnnotations, runStrategyBacktest, validateStrategyDefinition, warmupStart } from "./strategyBacktest.js";


// ── helpers ───────────────────────────────────────────────────────────────────
const str = (desc) => ({ type: "string", description: desc });
const num = (desc) => ({ type: "number", description: desc });
const bool = (desc) => ({ type: "boolean", description: desc });
const int = (desc) => ({ type: "integer", description: desc });

function schema(props, required = []) {
  return { type: "object", properties: props, required };
}

function parseMt5Date(value) {
  const text = String(value).replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3");
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (parts) return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4] ?? 0), Number(parts[5] ?? 0), Number(parts[6] ?? 0));
  return Date.parse(text);
}

function formatMt5Date(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function normalizeMqlDate(value) {
  const ms = parseMt5Date(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date/time: ${value}`);
  return formatMt5Date(ms);
}

async function getStrategyHistory(bridge, { symbol, timeframe, fromDate, toDate, strategy, currentBarStartMs, endBarStartMs }) {
  if (currentBarStartMs != null && !Number.isFinite(currentBarStartMs)) throw new Error("MT5 returned an invalid current bar time");
  if (endBarStartMs != null && endBarStartMs !== Infinity && !Number.isFinite(endBarStartMs)) {
    throw new Error("MT5 returned an invalid bar time for the requested end date");
  }
  const requestedFrom = warmupStart(fromDate, timeframe, strategy);
  const endMs = toDate ? parseMt5Date(toDate) : Infinity;
  if (toDate && !Number.isFinite(endMs)) throw new Error(`Invalid to_date: ${toDate}`);
  let cursor = requestedFrom;
  const candles = [];
  const seen = new Set();
  const pageSize = 50000;
  const maxCandles = 2000000;
  for (let page = 0; page < maxCandles / pageSize; page++) {
    const params = { symbol, timeframe, from_date: cursor, count: pageSize };
    if (toDate) params.to_date = formatMt5Date(endMs);
    const data = await bridge.send("get_candles", params);
    const rows = Array.isArray(data.candles) ? data.candles : [];
    for (const row of rows) {
      if (!seen.has(row.t)) { seen.add(row.t); candles.push(row); }
    }
    if (rows.length < pageSize) break;
    const lastMs = parseMt5Date(rows.at(-1).t);
    if (!Number.isFinite(lastMs)) throw new Error(`Invalid MT5 candle time: ${rows.at(-1).t}`);
    if (lastMs + 1000 >= endMs) break;
    cursor = formatMt5Date(lastMs + 1000);
    if (page === maxCandles / pageSize - 1) throw new Error(`History exceeds the ${maxCandles.toLocaleString()}-candle limit`);
  }
  const completedBeforeMs = Math.min(currentBarStartMs ?? Infinity, endBarStartMs ?? Infinity);
  const completed = !Number.isFinite(completedBeforeMs)
    ? candles
    : candles.filter((bar) => parseMt5Date(bar.t) < completedBeforeMs);
  completed.sort((a, b) => parseMt5Date(a.t) - parseMt5Date(b.t));
  return { symbol, timeframe, count: completed.length, candles: completed };
}

// ── tools array ───────────────────────────────────────────────────────────────
export const tools = [
  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS / CONNECTIVITY
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_status",
    description:
      "Check whether the MT5 EA bridge is online and return basic terminal info (broker, account, version, ping).",
    inputSchema: schema({}),
    handler: async (bridge) => {
      if (!bridge.connected) return { online: false, reason: "Socket not connected" };
      const data = await bridge.send("status");
      return { online: true, ...data };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART / PRICE DATA
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_get_candles",
    description:
      "Fetch OHLCV candlestick data for a symbol/timeframe. Use large `count` for backtesting (up to 100 000 bars).",
    inputSchema: schema(
      {
        symbol: str("e.g. EURUSD, XAUUSD, BTCUSD"),
        timeframe: str("M1 M5 M15 M30 H1 H4 D1 W1 MN1"),
        count: int("Number of bars to fetch (newest first). Default 500."),
        from_date: str("ISO date string to start from (optional, overrides count)"),
        to_date: str("ISO date string to end at (optional)"),
      },
      ["symbol", "timeframe"]
    ),
    handler: async (bridge, args) => bridge.send("get_candles", args),
  },

  {
    name: "mt5_get_tick",
    description: "Get the latest bid/ask/spread/time for a symbol.",
    inputSchema: schema({ symbol: str("Trading symbol") }, ["symbol"]),
    handler: async (bridge, args) => bridge.send("get_tick", args),
  },

  {
    name: "mt5_get_chart_info",
    description:
      "Return the currently active chart's symbol, timeframe, first/last bar times, and visible range.",
    inputSchema: schema({
      chart_id: int("Chart ID (0 = current/active chart)"),
    }),
    handler: async (bridge, args) => bridge.send("get_chart_info", args),
  },

  {
    name: "mt5_list_symbols",
    description: "List all symbols available in the terminal (optionally filtered by group).",
    inputSchema: schema({ group: str("Filter e.g. '*USD*', leave empty for all") }),
    handler: async (bridge, args) => bridge.send("list_symbols", args),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART OBJECTS  (lines, shapes, Fibonacci, etc.)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_add_object",
    description: `Add any supported chart object.
Object types:
  Lines       : HLINE, VLINE, TRENDLINE, RAY, EXTENDED
  Channels    : CHANNEL, STDDEVCHANNEL, REGRESSION
  Geometric   : RECTANGLE, TRIANGLE, ELLIPSE
  Fibonacci   : FIBO, FIBOARC, FIBOFAN, FIBOCHANNEL, FIBOTIMEZONES, FIBOEXPANSION
  Gann        : GANNLINE, GANNGRID, GANNFAN
  Text/Labels : TEXT, LABEL, BUTTON, BITMAP, BITMAP_LABEL, EDIT, RECTANGLE_LABEL
  Arrows      : ARROW, ARROW_CHECK, ARROW_STOPLOSS, ARROW_TAKEPROFIT, etc.
  Elliott     : ELLIOTWAVE3, ELLIOTWAVE5
`,
    inputSchema: schema(
      {
        chart_id: int("0 = active chart"),
        subwindow: int("0 = main chart, 1+ = indicator subwindow"),
        name: str("Unique object name (used for later updates/delete)"),
        type: str("Object type string, e.g. TRENDLINE, RECTANGLE, FIBO"),
        time1: str("Anchor 1 ISO datetime"),
        price1: num("Anchor 1 price"),
        time2: str("Anchor 2 ISO datetime (if needed)"),
        price2: num("Anchor 2 price (if needed)"),
        time3: str("Anchor 3 ISO datetime (if needed)"),
        price3: num("Anchor 3 price (if needed)"),
        color: str("Color name or #RRGGBB, e.g. 'Red', '#FF0000'"),
        width: int("Line width 1-5"),
        style: str("SOLID DASH DOT DASHDOT DASHDOTDOT"),
        fill: bool("Fill object (rectangles etc.)"),
        back: bool("Draw behind candles"),
        description: str("Tooltip / label text shown on chart"),
      },
      ["name", "type", "time1", "price1"]
    ),
    handler: async (bridge, args) => bridge.send("add_object", args),
  },

  {
    name: "mt5_add_objects",
    description: `Add up to 250 chart objects in one MT5 command. Use this for backtest review marks so a batch of signals does not require one MCP round trip per object. Each object uses the same fields as mt5_add_object; chart_id applies to the whole batch. The result reports each created object and any per-object failures.`,
    inputSchema: schema(
      {
        chart_id: int("0 = chart that hosts the MT5 MCP bridge"),
        objects: {
          type: "array",
          minItems: 1,
          maxItems: 250,
          items: {
            type: "object",
            properties: {
              subwindow: int("0 = main chart, 1+ = indicator subwindow"),
              name: str("Unique object name"),
              type: str("Object type string, e.g. TRENDLINE, RECTANGLE, FIBO"),
              time1: str("Anchor 1 ISO datetime"),
              price1: num("Anchor 1 price"),
              time2: str("Anchor 2 ISO datetime (if needed)"),
              price2: num("Anchor 2 price (if needed)"),
              time3: str("Anchor 3 ISO datetime (if needed)"),
              price3: num("Anchor 3 price (if needed)"),
              color: str("Color name or #RRGGBB"),
              width: int("Line width 1-5"),
              style: str("SOLID DASH DOT DASHDOT DASHDOTDOT"),
              fill: bool("Fill object (rectangles etc.)"),
              back: bool("Draw behind candles"),
              selectable: bool("Whether the user can select the object"),
              description: str("Tooltip / label text shown on chart"),
            },
            required: ["name", "type", "time1", "price1"],
          },
        },
      },
      ["objects"]
    ),
    handler: async (bridge, args) => bridge.send("add_objects", args),
  },

  {
    name: "mt5_modify_object",
    description: "Modify properties of an existing chart object by name.",
    inputSchema: schema(
      {
        chart_id: int("0 = active chart"),
        name: str("Object name to modify"),
        properties: {
          type: "object",
          description:
            "Key/value pairs of properties to change (same keys as mt5_add_object)",
        },
      },
      ["name", "properties"]
    ),
    handler: async (bridge, args) => bridge.send("modify_object", args),
  },

  {
    name: "mt5_delete_object",
    description: "Delete a chart object by name.",
    inputSchema: schema(
      {
        chart_id: int("0 = active chart"),
        name: str("Object name to delete"),
      },
      ["name"]
    ),
    handler: async (bridge, args) => bridge.send("delete_object", args),
  },

  {
    name: "mt5_list_objects",
    description: "List chart objects with names, types, anchors, style, text, and Fibonacci levels. Results are bounded by default; use name_filter and type_filter to narrow the list, or offset to page through it.",
    inputSchema: schema({
      chart_id: int("0 = active chart"),
      subwindow: int("-1 = all subwindows"),
      type_filter: str("Optional: filter by object type e.g. FIBO"),
      name_filter: str("Optional, case-insensitive substring matched against object names"),
      offset: int("Number of matching objects to skip; defaults to 0"),
      limit: int("Maximum objects to return, 1-20; defaults to 8"),
    }),
    handler: async (bridge, args) => {
      const result = await bridge.send("list_objects", {
        chart_id: args.chart_id,
        subwindow: args.subwindow,
        type_filter: args.type_filter,
      });
      const all = Array.isArray(result.objects) ? result.objects : [];
      const nameFilter = String(args.name_filter ?? "").toLocaleLowerCase();
      const matching = nameFilter
        ? all.filter((item) => String(item.name ?? "").toLocaleLowerCase().includes(nameFilter))
        : all;
      const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
      const limit = Math.min(20, Math.max(1, Math.trunc(Number(args.limit) || 8)));
      const objects = matching.slice(offset, offset + limit);
      return {
        objects,
        total: matching.length,
        offset,
        returned: objects.length,
        has_more: offset + objects.length < matching.length,
      };
    },
  },

  {
    name: "mt5_clear_objects",
    description: "Remove all (or a named-prefix group of) objects from a chart.",
    inputSchema: schema({
      chart_id: int("0 = active chart"),
      prefix: str("Only delete objects whose name starts with this prefix"),
    }),
    handler: async (bridge, args) => bridge.send("clear_objects", args),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INDICATORS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_add_indicator",
    description: `Add a built-in or custom indicator to a chart and return a handle.
Built-in names: MA, EMA, MACD, RSI, BBANDS, STOCH, ATR, ADX, CCI, DEMA, TEMA,
                ICHIMOKU, SAR, WILLIAMS, MOMENTUM, MFI, OBV, VOLUMES, ZIGZAG, FRACTALS.
For custom: pass full path relative to MQL5/Indicators/ folder.`,
    inputSchema: schema(
      {
        chart_id: int("0 = active chart"),
        symbol: str("Symbol (empty = chart symbol)"),
        timeframe: str("Timeframe (empty = chart timeframe)"),
        indicator: str("Indicator name (see description)"),
        params: {
          type: "array",
          items: {},
          description: "Ordered parameter list for the indicator constructor",
        },
        subwindow: int("Subwindow to attach (0=main, -1=auto-new)"),
      },
      ["indicator"]
    ),
    handler: async (bridge, args) => bridge.send("add_indicator", args),
  },

  {
    name: "mt5_get_indicator_values",
    description:
      "Read buffer values from a previously added indicator handle for N bars.",
    inputSchema: schema(
      {
        handle: int("Indicator handle returned by mt5_add_indicator"),
        buffer_index: int("Buffer index (0 = main line, 1 = signal, etc.)"),
        start_pos: int("Start position from newest bar (0 = latest)"),
        count: int("Number of values to return"),
      },
      ["handle", "buffer_index", "count"]
    ),
    handler: async (bridge, args) => bridge.send("get_indicator_values", args),
  },

  {
    name: "mt5_remove_indicator",
    description: "Release an indicator handle and remove it from the chart.",
    inputSchema: schema({ handle: int("Handle to release") }, ["handle"]),
    handler: async (bridge, args) => bridge.send("remove_indicator", args),
  },

  {
    name: "mt5_list_indicators",
    description: "List all active indicator handles and their metadata.",
    inputSchema: schema({ chart_id: int("0 = active chart") }),
    handler: async (bridge, args) => bridge.send("list_indicators", args),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTESTING HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_backtest_rules",
    description: `Backtest a declarative, bar-close strategy and optionally draw trades on the bridge chart. The strategy shape is entry_long/entry_short and optional exit_long/exit_short condition trees, plus optional sl_pips, tp_pips, and spread_points. Conditions support all:[...], any:[...], not:{...}, time_between:{from:"HH:mm",to:"HH:mm"}, or {op:"gt|gte|lt|lte|eq|cross_above|cross_below",left:<operand>,right:<operand>}. Operands are {series:"open|high|low|close|volume",offset:0}, {indicator:"sma|ema|rsi|atr|highest_high|lowest_low",period:14,source:"close",offset:0}, or {value:70}. Offsets look back completed bars. Signal conditions are evaluated after a completed bar; entries and condition exits execute at the next bar open. The current forming candle and any partial candle at the requested end time are excluded. There is one open trade at a time and no pyramiding. Intrabar stop/target ties assume stop first; gaps through a stop fill at the bar open. Spread is zero unless strategy.spread_points is specified; commission and slippage are not modeled. A pip_size override can be supplied for symbols with nonstandard pip conventions. Candle history includes indicator warmup bars and is fetched in pages up to two million bars. Drawing includes the most recent 1000 trades by default, configurable up to 10000; the response reports omitted marks.`,
    inputSchema: schema(
      {
        symbol: str("Exact MT5 symbol, for example EURUSD"),
        timeframe: str("MT5 timeframe, for example M1 or H1"),
        from_date: str("Inclusive test start date/time in MT5 server time"),
        to_date: str("Exclusive test end date/time in MT5 server time; empty means current terminal time"),
        strategy: {
          type: "object",
          description: `Define entry_long and/or entry_short condition trees. Example:
{ "entry_long": { "all": [
  { "op": "cross_above", "left": { "indicator": "ema", "period": 9 }, "right": { "indicator": "ema", "period": 21 } },
  { "op": "gt", "left": { "indicator": "rsi", "period": 14 }, "right": { "value": 50 } }
] }, "sl_pips": 20, "tp_pips": 40 }
Indicators: SMA, EMA, Wilder RSI, Wilder ATR, highest high, lowest low. Condition exits execute at next bar open.`,
        },
        pip_size: num("Optional override: price value of one pip; otherwise inferred from symbol digits"),
        draw_on_chart: bool("Draw entry/exit arrows, trade rectangles, and SL/TP levels (default true)"),
        clear_previous: bool("Clear existing objects with this prefix before drawing"),
        chart_id: int("MT5 chart id; 0 is the chart hosting the bridge EA"),
        prefix: str("Chart-object prefix, letters/digits/underscore only; default RULE_BT_"),
        max_trades_to_draw: int("Maximum number of most recent trades to annotate (default 1000, maximum 10000)"),
        max_trade_records: int("Maximum trade records included in the response (default 500, maximum 5000)"),
      },
      ["symbol", "timeframe", "from_date", "strategy"]
    ),
    handler: async (bridge, args) => {
      validateStrategyDefinition(args.strategy);
      const maxRows = Number(args.max_trade_records ?? 500);
      if (!Number.isInteger(maxRows) || maxRows < 0 || maxRows > 5000) {
        throw new Error("max_trade_records must be an integer from 0 to 5000");
      }
      const maxTradesToDraw = Number(args.max_trades_to_draw ?? 1000);
      if (args.draw_on_chart !== false && (!Number.isInteger(maxTradesToDraw) || maxTradesToDraw < 0 || maxTradesToDraw > 10000)) {
        throw new Error("max_trades_to_draw must be an integer from 0 to 10000");
      }
      const drawOnChart = args.draw_on_chart !== false;
      const chartId = Number(args.chart_id ?? 0);
      const basePrefix = args.prefix ?? "RULE_BT_";
      let chart = null;
      if (drawOnChart) {
        if (!Number.isSafeInteger(chartId) || chartId < 0) throw new Error("chart_id must be a nonnegative safe integer");
        if (!/^[A-Za-z0-9_]{1,16}$/.test(basePrefix)) throw new Error("prefix must contain 1-16 letters, digits, or underscores");
        chart = await bridge.send("get_chart_info", { chart_id: chartId });
        if (String(chart.symbol).toUpperCase() !== String(args.symbol).toUpperCase()) {
          throw new Error(`Chart ${chartId || "hosting the bridge"} is ${chart.symbol}; open a ${args.symbol} chart before drawing backtest annotations`);
        }
      }
      const [symbolInfo, currentBar, endBar] = await Promise.all([
        bridge.send("symbol_info", { symbol: args.symbol }),
        bridge.send("get_current_bar_time", { symbol: args.symbol, timeframe: args.timeframe }),
        args.to_date
          ? bridge.send("get_partial_bar_start_at", { symbol: args.symbol, timeframe: args.timeframe, time: normalizeMqlDate(args.to_date) })
          : Promise.resolve({ time: "" }),
      ]);
      const point = Number(symbolInfo.point);
      const digits = Number(symbolInfo.digits);
      if (!(point > 0) || !Number.isFinite(digits)) throw new Error(`Could not read MT5 symbol specification for ${args.symbol}`);
      const inferredPip = point * ([3, 5].includes(digits) ? 10 : 1);
      const pipSize = Number(args.pip_size) > 0 ? Number(args.pip_size) : inferredPip;
      const history = await getStrategyHistory(bridge, {
        symbol: args.symbol,
        timeframe: args.timeframe,
        fromDate: args.from_date,
        toDate: args.to_date,
        strategy: args.strategy,
        currentBarStartMs: parseMt5Date(currentBar.time),
        endBarStartMs: endBar.time ? parseMt5Date(endBar.time) : Infinity,
      });
      const result = runStrategyBacktest(history, args.strategy, {
        fromDate: args.from_date,
        toDate: args.to_date,
        pipSize,
        point,
      });

      let drawing = { requested: 0, created: 0, failed: 0 };
      if (drawOnChart && result.trades.length) {
        if (args.clear_previous) await bridge.send("clear_objects", { chart_id: chartId, prefix: basePrefix });
        const runPrefix = `${basePrefix}${Date.now()}_`;
        const drawnTrades = result.trades.slice(-maxTradesToDraw);
        const objects = buildTradeAnnotations(drawnTrades, runPrefix, args.timeframe);
        drawing.requested = objects.length;
        drawing.trades_requested = result.trades.length;
        drawing.trades_drawn = drawnTrades.length;
        drawing.trades_omitted = result.trades.length - drawnTrades.length;
        drawing.first_drawn_trade = drawnTrades[0]?.open_time;
        drawing.last_drawn_trade = drawnTrades.at(-1)?.open_time;
        for (let i = 0; i < objects.length; i += 250) {
          const batch = await bridge.send("add_objects", { chart_id: chartId, objects: objects.slice(i, i + 250) });
          drawing.created += Number(batch.created ?? 0);
          drawing.failed += Number(batch.failed ?? 0);
        }
        drawing.chart_id = chart.chart_id ?? chartId;
        drawing.symbol = chart.symbol;
        drawing.timeframe = chart.timeframe;
        drawing.prefix = runPrefix;
      }

      const { trades, ...report } = result;
      return {
        ...report,
        trades: trades.slice(0, maxRows),
        trades_returned: Math.min(trades.length, maxRows),
        trades_truncated: trades.length > maxRows,
        history: { symbol: args.symbol, timeframe: args.timeframe, bars: history.count, first: history.candles[0]?.t, last: history.candles.at(-1)?.t, pip_size: pipSize },
        drawing,
      };
    },
  },

  {
    name: "mt5_backtest_strategy",
    description: `Backtest the implemented SMA crossover strategy on historical bars. Supported fields: fast_ma (10), slow_ma (30), rsi_period (14), use_rsi (true by default), rsi_ob (70), rsi_os (30), sl_pips (30), and tp_pips (60). Entry/exit expressions are not evaluated. Entries use the signal bar close; fixed SL/TP are checked against later bar highs/lows. If both levels are touched on one bar, SL is assumed first. Results exclude spread, commission, and slippage. Optional drawing adds entry arrows and outcome rectangles on the bridge EA chart.`,
    inputSchema: schema(
      {
        symbol: str("Symbol to test"),
        timeframe: str("Timeframe e.g. H1"),
        from_date: str("ISO start date of test range"),
        to_date: str("ISO end date (empty = now)"),
        strategy: {
          type: "object",
          description: `Implemented fields only: fast_ma (default 10), slow_ma (default 30), rsi_period (default 14), use_rsi (true unless false), rsi_ob (70), rsi_os (30), sl_pips (30), tp_pips (60). Signals are SMA crossovers optionally filtered by RSI.`,
        },
        draw_on_chart: bool("Annotate chart with signals and trade boxes"),
        clear_previous: bool("Remove previous backtest annotations first"),
        prefix: str("Name prefix for drawn objects, default 'BT_'"),
      },
      ["symbol", "timeframe", "from_date", "strategy"]
    ),
    handler: async (bridge, args) => bridge.send("backtest_strategy", {
      ...args,
      from_date: normalizeMqlDate(args.from_date),
      to_date: args.to_date ? normalizeMqlDate(args.to_date) : "",
    }),
  },

  {
    name: "mt5_backtest_indicator_cross",
    description:
      "Quick SMA crossover backtest without an RSI filter: buy on fast/slow upward cross, sell on downward cross. Fixed stop/target distances. Gross results exclude spread, fees, and slippage.",
    inputSchema: schema(
      {
        symbol: str("Symbol"),
        timeframe: str("Timeframe"),
        from_date: str("ISO start date"),
        to_date: str("ISO end date"),
        fast_period: int("Fast MA period"),
        slow_period: int("Slow MA period"),
        sl_pips: num("Stop-loss in pips"),
        tp_pips: num("Take-profit in pips"),
        draw_on_chart: bool("Draw signals on chart"),
      },
      ["symbol", "timeframe", "from_date", "fast_period", "slow_period"]
    ),
    handler: async (bridge, args) => bridge.send("backtest_indicator_cross", {
      ...args,
      from_date: normalizeMqlDate(args.from_date),
      to_date: args.to_date ? normalizeMqlDate(args.to_date) : "",
    }),
  },

  {
    name: "mt5_scroll_chart",
    description: "Scroll the visible chart to a specific datetime (useful during backtest review).",
    inputSchema: schema(
      {
        chart_id: int("0 = active chart"),
        datetime: str("ISO datetime to scroll to"),
        bars_shift: int("Additional bars offset after scroll"),
      },
      ["datetime"]
    ),
    handler: async (bridge, args) => bridge.send("scroll_chart", args),
  },

  {
    name: "mt5_navigate_chart",
    description: `Navigate the MT5 chart view forward, backward, or to extremes — and control zoom level.

Actions:
  "forward"   — move N bars toward newer (more recent) data; wraps at the last bar
  "backward"  — move N bars toward older (historical) data; wraps at the first bar
  "begin"     — jump to the oldest available bar on the chart
  "end"       — jump to the most recent bar (live edge)
  "zoom_in"   — increase bar scale by 1 step (larger candles, fewer bars visible)
  "zoom_out"  — decrease bar scale by 1 step (smaller candles, more bars visible)
  "set_zoom"  — set zoom to an exact level (0 = most bars visible … 5 = largest candles)

Returns the updated visible-window: first/last bar datetime, zoom level, visible bar count.`,
    inputSchema: schema(
      {
        chart_id: int("Chart ID (0 = active chart)"),
        action: str("forward | backward | begin | end | zoom_in | zoom_out | set_zoom"),
        bars: int("Bars to move for forward/backward actions (default 50)"),
        zoom: int("Zoom level 0-5 for set_zoom action"),
      },
      ["action"]
    ),
    handler: async (bridge, args) => bridge.send("navigate_chart", args),
  },

  {
    name: "mt5_take_screenshot",
    description:
      "Capture the current MT5 chart as a PNG image and return it inline. " +
      "Useful after drawing objects, navigating, or running a backtest to visually confirm the result.",
    inputSchema: schema({
      chart_id: int("Chart ID (0 = active/current chart)"),
      width:    int("Image width in pixels (default 1280)"),
      height:   int("Image height in pixels (default 720)"),
    }),
    handler: async (bridge, args) => {
      const data = await bridge.send("take_screenshot", args);
      // Return as MCP image content so Claude can see the chart
      return {
        _mcpImageContent: {
          type: "image",
          data: data.image_base64,
          mimeType: data.mime_type ?? "image/png",
        },
        symbol:    data.symbol,
        timeframe: data.timeframe,
        width:     data.width,
        height:    data.height,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ACCOUNT / MARKET INFO  (read-only, no order placement)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_account_info",
    description:
      "Return account details: balance, equity, margin, free margin, leverage, currency, broker.",
    inputSchema: schema({}),
    handler: async (bridge) => bridge.send("account_info"),
  },

  {
    name: "mt5_symbol_info",
    description: "Return detailed specification for a trading symbol (spreads, digits, lot size, swap rates…).",
    inputSchema: schema({ symbol: str("Symbol name") }, ["symbol"]),
    handler: async (bridge, args) => bridge.send("symbol_info", args),
  },

  {
    name: "mt5_open_positions",
    description: "List currently open positions (read-only, no modification).",
    inputSchema: schema({
      symbol: str("Filter by symbol (empty = all)"),
    }),
    handler: async (bridge, args) => bridge.send("open_positions", args),
  },

  {
    name: "mt5_order_history",
    description: "Fetch closed-order history within a date range.",
    inputSchema: schema(
      {
        from_date: str("ISO start date"),
        to_date: str("ISO end date (empty = now)"),
        symbol: str("Filter by symbol (empty = all)"),
      },
      ["from_date"]
    ),
    handler: async (bridge, args) => bridge.send("order_history", args),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FUTURE: ORDER PLACEMENT (requirements documented, not yet activated)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "mt5_order_requirements",
    description:
      "Return a checklist of what is needed to enable live order placement (not yet implemented). Use this to understand prerequisites.",
    inputSchema: schema({}),
    handler: async (_bridge) => ({
      status: "NOT_IMPLEMENTED — read only mode",
      requirements: [
        "1. EA must run with 'Allow Live Trading' checked in MT5 options",
        "2. Account must have 'Trade' permission enabled",
        "3. Add mt5_place_order / mt5_modify_order / mt5_close_order tools in tools.js",
        "4. Implement OrderSend() / OrderModify() / OrderClose() in the MQL5 EA",
        "5. Add risk-guard: max lot size, max daily loss, drawdown circuit-breaker",
        "6. Require explicit user confirmation flag in every order call",
        "7. Recommended: paper-trade mode toggle before going live",
      ],
    }),
  },
];
