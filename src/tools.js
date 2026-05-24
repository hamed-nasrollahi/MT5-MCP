/**
 * tools.js — every MCP tool exposed to Claude.
 * Each entry: { name, description, inputSchema, handler(bridge, args) }
 */

// ── helpers ───────────────────────────────────────────────────────────────────
const str = (desc) => ({ type: "string", description: desc });
const num = (desc) => ({ type: "number", description: desc });
const bool = (desc) => ({ type: "boolean", description: desc });
const int = (desc) => ({ type: "integer", description: desc });

function schema(props, required = []) {
  return { type: "object", properties: props, required };
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
    description: "List all objects currently on a chart.",
    inputSchema: schema({
      chart_id: int("0 = active chart"),
      subwindow: int("-1 = all subwindows"),
      type_filter: str("Optional: filter by object type e.g. FIBO"),
    }),
    handler: async (bridge, args) => bridge.send("list_objects", args),
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
    name: "mt5_backtest_strategy",
    description: `Run a strategy backtest over historical bars and annotate the chart.
Claude sends the strategy rules as JSON; the EA simulates bar-by-bar and returns
trade signals + equity curve.  Chart objects are automatically drawn:
  • Blue up-arrow  → BUY signal
  • Red  down-arrow → SELL signal
  • Green/Red boxes → trade outcome (win/loss)
  • Dashed lines   → entry / SL / TP levels
Returns: list of trades { open_time, close_time, type, entry, sl, tp, profit, pips }
         + summary { trades, win_rate, profit_factor, max_dd, net_pips }`,
    inputSchema: schema(
      {
        symbol: str("Symbol to test"),
        timeframe: str("Timeframe e.g. H1"),
        from_date: str("ISO start date of test range"),
        to_date: str("ISO end date (empty = now)"),
        strategy: {
          type: "object",
          description: `Strategy definition object:
{
  "entry_long":  { condition expression string or indicator rules },
  "entry_short": { ... },
  "exit_long":   { ... },
  "exit_short":  { ... },
  "sl_pips": 30,
  "tp_pips": 60,
  "risk_pct": 1.0
}`,
        },
        draw_on_chart: bool("Annotate chart with signals and trade boxes"),
        clear_previous: bool("Remove previous backtest annotations first"),
        prefix: str("Name prefix for drawn objects, default 'BT_'"),
      },
      ["symbol", "timeframe", "from_date", "strategy"]
    ),
    handler: async (bridge, args) => bridge.send("backtest_strategy", args),
  },

  {
    name: "mt5_backtest_indicator_cross",
    description:
      "Quick backtest: buy when fast MA crosses above slow MA, sell on reverse. Returns trade list and summary.",
    inputSchema: schema(
      {
        symbol: str("Symbol"),
        timeframe: str("Timeframe"),
        from_date: str("ISO start date"),
        to_date: str("ISO end date"),
        fast_period: int("Fast MA period"),
        slow_period: int("Slow MA period"),
        ma_type: str("SMA EMA WMA (default SMA)"),
        sl_pips: num("Stop-loss in pips"),
        tp_pips: num("Take-profit in pips"),
        draw_on_chart: bool("Draw signals on chart"),
      },
      ["symbol", "timeframe", "from_date", "fast_period", "slow_period"]
    ),
    handler: async (bridge, args) => bridge.send("backtest_indicator_cross", args),
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
