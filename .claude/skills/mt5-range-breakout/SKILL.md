---
name: mt5-range-breakout
description: |
  Runs a session range-breakout backtest directly on the live MT5 chart, day by day, using MT5 MCP tools.
  Works for ANY symbol (EURUSD, XAUUSD, JPN225, NAS100, BTCUSD, …), any timeframe, and any range-candle count.

  Use this skill whenever the user asks to:
  - Run a range breakout backtest on any MT5 symbol
  - Test a "first N candles = session range, scan for breakout" strategy on any instrument
  - Backtest a session-open range strategy with TP1/TP2/TP3 R-multiple targets
  - Draw RB_ range rectangles, Fibonacci trade levels, or breakout arrows on the chart
  - Replay or review a range-breakout strategy day by day on a live chart
  - Change the symbol, range period, or breakout threshold (e.g. "try on EURUSD H1 with 10-candle range")

  Trigger on any mention of: range breakout, session range, opening range, RB_ objects, N-candle range, breakout with Fibonacci targets, ORB strategy.
---

# MT5 Range Breakout Backtest Skill

## Overview

Runs a **session range-breakout strategy** on M1 data, one trading day at a time:

1. **Step 0** — confirm config, clear all `RB_` objects once, build trading-day list
2. **Per day** — fetch ≤ 300 bars via `from_date`/`to_date`, define range from first N candles, scan for breakout, draw objects, simulate trade, report result
3. **Final** — print summary table and stats after all days

**No screenshots. No MQL scripts. JSON data only via MCP tools.**

---

## Configuration Parameters

Read from the user's prompt. Defaults shown:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `symbol` | *(ask user)* | Any MT5 symbol — EURUSD, XAUUSD, JPN225, NAS100, BTCUSD, etc. |
| `timeframe` | `"M1"` | Chart timeframe — M1, M5, M15, M30, H1, H4, D1 |
| `days` | `30` | Number of trading days to backtest |
| `range_candles` | `20` | Candles that define the opening session range |
| `breakout_threshold` | `0.5` | Min fraction of candle body outside range for a valid break |
| `sim_bars` | `50` | Max bars after breakout to scan for SL/TP hits |

**If `symbol` is not specified, ask the user** — there is no meaningful default since the strategy parameters (especially `range_candles`) depend heavily on the instrument's session length and volatility.

Confirm any non-default values, then print config before starting:
```
⚙️  symbol={symbol} | tf={timeframe} | days={days} | range={range_candles} bars | breakout>{breakout_threshold*100:.0f}% body | sim={sim_bars} bars
```

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| `mcp__mt5-mcp-server__mt5_get_candles` | Fetch OHLCV bars (`from_date`/`to_date` + `count` cap) |
| `mcp__mt5-mcp-server__mt5_clear_objects` | Bulk-clear all `RB_` objects at startup |
| `mcp__mt5-mcp-server__mt5_add_object` | Draw RECTANGLE, FIBO, ARROW_BUY/SELL |
| `mcp__mt5-mcp-server__mt5_modify_object` | Set custom FIBO level count and values |
| `mcp__mt5-mcp-server__mt5_scroll_chart` | Navigate chart to each day |

If tools are unavailable: ask the user to start `node D:\GitHub\MT5-MCP\src\server.js` and confirm the MT5_MCP_Bridge EA is running on **a chart of the target symbol** (or any chart — the EA serves all symbols).

---

## Step 0 — Initialise (Run Once)

### 0a. Clear the chart

Remove all previous backtest objects in one sweep:

```
mt5_clear_objects:
  prefix: "RB_"
```

This is the **only** time `mt5_clear_objects` is called. The loop never clears; each day only *adds* its three objects on top of prior days, so the user can see the full history on the chart simultaneously.

### 0b. Build the trading-day list

Fetch a small probe to confirm connection and identify recent dates:

```
mt5_get_candles:
  symbol:    {symbol}
  timeframe: {timeframe}
  count:     50
```

From the returned candles extract the unique calendar dates (newest first). Use these and continue walking backwards through calendar days to find `days` actual trading days.

> A calendar day is a trading day if a per-day fetch (Step 2 below) returns at least `range_candles + 1` bars. Weekend / holiday days return 0 bars — just skip them silently without counting toward the `days` total.

Store the list sorted **oldest → newest** so the backtest plays forward in time.

---

## Step 2 — Process Each Day (Loop, Oldest → Newest)

### 2a. Fetch This Day's Candles

Fetch only this calendar day — keep the payload small (≤ 300 bars):

```
mt5_get_candles:
  symbol:    {symbol}
  timeframe: {timeframe}
  from_date: "{DATE}T00:00:00"
  to_date:   "{DATE}T23:59:59"
  count:     300
```

Candles are returned **oldest-first** when using `from_date`/`to_date`. Index 0 = first candle of the day.

- If returned count = 0 → weekend/holiday, skip silently (don't count toward `days`).
- If returned count < `range_candles + 1` → log `⚠️ SKIPPED (only {n} bars < {range_candles+1})`, count as skipped.

### 2b. Compute the Session Range

```
range_high       = max(candle.high  for candles[0 .. range_candles-1])
range_low        = min(candle.low   for candles[0 .. range_candles-1])
range_time_start = candles[0].time
range_time_end   = candles[range_candles - 1].time
```

### 2c. Draw the Range Rectangle

```
mt5_add_object:
  name:   "RB_Range_{DATE}"
  type:   "RECTANGLE"
  time1:  range_time_start
  price1: range_high
  time2:  range_time_end
  price2: range_low
  color:  "#808080"
  style:  "DASH"
  fill:   false
  back:   true
  width:  1
```

### 2d. Scroll Chart to This Day

```
mt5_scroll_chart:
  datetime:   range_time_start
  bars_shift: -10
```

Print:
```
📅 Day {N}/{days} — {DATE} | Range ({range_candles} bars): {range_low} – {range_high} | Width: {range_high - range_low:.1f}
```

### 2e. Scan for the First Valid Breakout (from bar index `range_candles` onward)

> **Body = open ↔ close ONLY. Wicks (high / low) are completely ignored.**  
> A candle's shadow may poke outside the range; that does NOT count. Only the filled body rectangle matters.

For each candle starting at index `range_candles`:

```
# Body boundaries — strictly open/close, never high/low
body_high = max(candle.open, candle.close)
body_low  = min(candle.open, candle.close)
body_size = body_high - body_low          # = 0 for a doji
```

Skip if `body_size == 0` (doji — no body to measure).

**LONG break** — how much of the open↔close body is above `range_high`:
```
portion_above = max(0,  body_high - max(body_low, range_high))
long_valid    = (portion_above / body_size) > breakout_threshold
```
*Example: body spans 34 990–35 020, range_high = 35 000. Body above = 20, body_size = 30 → 66 % > 50 % → valid LONG break.*

**SHORT break** — how much of the open↔close body is below `range_low`:
```
portion_below = max(0, min(body_high, range_low) - body_low)
short_valid   = (portion_below / body_size) > breakout_threshold
```
*Example: body spans 34 960–34 980, range_low = 34 975. Body below = 15, body_size = 20 → 75 % > 50 % → valid SHORT break.*

Take the **first candle** where either condition fires. If both fire on the same bar (body spans across both range_high and range_low — rare but possible on wide candles), take the side with the larger fraction. Stop scanning after the first valid breakout.

If no breakout found by end of day's candles → log `⏭️ Day {N} — {DATE} | NO SIGNAL` and move to the next day.

---

## Step 3 — Draw Breakout Objects

### 3a. Calculate Trade Levels

**LONG:**
```
direction = "LONG"
entry = range_high
sl    = candle.low        ← low of break candle
R     = entry - sl
tp1   = entry + 1×R
tp2   = entry + 2×R
tp3   = entry + 3×R
```

**SHORT:**
```
direction = "SHORT"
entry = range_low
sl    = candle.high       ← high of break candle
R     = sl - entry
tp1   = entry - 1×R
tp2   = entry - 2×R
tp3   = entry - 3×R
```

Skip if `R == 0`. Print:
```
🎯 {direction} | bar {range_candles + idx + 1} @ {candle.time} | Entry: {entry} | SL: {sl} | R: {R:.1f} | TP1: {tp1} TP2: {tp2} TP3: {tp3}
```

### 3b. Arrow

```
mt5_add_object:
  name:   "RB_Arrow_{DATE}"
  type:   "ARROW_BUY"               ← LONG; use ARROW_SELL for SHORT
  time1:  candle.time
  price1: candle.low                ← BUY below candle; SELL use candle.high
  color:  "#00AA00"                 ← green BUY / "#FF0000" red SELL
  width:  2
```

### 3c. FIBO Object

Anchors: `price1 / time1 = SL (0%)` and `price2 / time2 = Entry (100%)`.  
`time2` = break candle time + 60 minutes (as ISO string).

```
mt5_add_object:
  name:   "RB_Fibo_{DATE}"
  type:   "FIBO"
  time1:  candle.time
  price1: sl
  time2:  candle.time + 60min
  price2: entry
  color:  "#AAAAFF"
  width:  1
```

### 3d. Set Custom FIBO Levels

**Immediately** after adding the FIBO, call modify to replace the 11 default MT5 levels with exactly 5:

```
mt5_modify_object:
  name: "RB_Fibo_{DATE}"
  properties:
    OBJPROP_LEVELS:       5
    OBJPROP_LEVELVALUE_0: 0.0    ← 0%   = SL
    OBJPROP_LEVELVALUE_1: 1.0    ← 100% = Entry
    OBJPROP_LEVELVALUE_2: 2.0    ← 200% = TP1  (Entry ± 1R)
    OBJPROP_LEVELVALUE_3: 3.0    ← 300% = TP2  (Entry ± 2R)
    OBJPROP_LEVELVALUE_4: 4.0    ← 400% = TP3  (Entry ± 3R)
```

> **How the math works:** Each level value is a multiplier of the span `(price2 − price1)`.  
> 0.0 → `SL + 0×(Entry−SL) = SL` ✓   1.0 → `SL + 1×(Entry−SL) = Entry` ✓  
> 2.0 → `SL + 2×(Entry−SL) = Entry + R = TP1` ✓ — works for SHORT too because `Entry−SL` is negative.

---

## Step 4 — Simulate Trade Outcome

Scan the `sim_bars` candles after the breakout candle. For each, check (TP priority first):

| Priority | LONG | SHORT | Outcome |
|----------|------|-------|---------|
| 1st | `high >= tp3` | `low <= tp3` | TP3 (+3R) |
| 2nd | `high >= tp2` | `low <= tp2` | TP2 (+2R) |
| 3rd | `high >= tp1` | `low <= tp1` | TP1 (+1R) |
| 4th | `low <= sl`   | `high >= sl` | SL (−1R) |

If `sim_bars` exhausted without any hit → `OPEN (0R)`.

If the sim window extends beyond the fetched day's candles, fetch the next day's first `sim_bars` bars using `from_date`/`to_date` on the next date.

---

## Step 5 — Report Day Result

Print immediately, then start the next day:

```
✅ Day  3 | 2025-04-03 | LONG  | R=150 | 🏆 TP2  (+2R)
❌ Day  7 | 2025-04-09 | SHORT | R=150 | 💀 SL   (−1R)
⏭️ Day 12 | 2025-04-16 | NO SIGNAL
⚠️ Day 15 | 2025-04-21 | SKIPPED (5 bars < 21)
```

---

## Step 6 — Final Summary

```
═══════════════════════════════════════════════════════════════
  {SYMBOL} RANGE BREAKOUT — {days} DAYS | range={range_candles} bars
═══════════════════════════════════════════════════════════════
  Total Days Scanned : {days}
  Signals            : {signals}  |  No Signal: {no_signal}  |  Skipped: {skipped}

  Win Rate (TP1+)    : {wins/signals*100:.1f}%  ({wins}/{signals})
  TP1 Hits           : {tp1}  ({tp1/signals*100:.1f}%)
  TP2 Hits           : {tp2}  ({tp2/signals*100:.1f}%)
  TP3 Hits           : {tp3}  ({tp3/signals*100:.1f}%)
  SL  Hits           : {sl}   ({sl/signals*100:.1f}%)
  Open               : {open_}

  Total R            : {sum_r:+.1f}R
  Avg R / Trade      : {sum_r/signals:+.2f}R
  Profit Factor      : {gross_wins/gross_losses:.2f}
═══════════════════════════════════════════════════════════════
```

Day-by-day table:

```
| #  | Date       | Dir   | Bar | Entry  | SL     | R    | Outcome | R      |
|----|------------|-------|-----|--------|--------|------|---------|--------|
|  1 | 2025-03-18 | LONG  | 27  | 35000  | 34820  | 180  | TP1     | +1R    |
|  2 | 2025-03-19 | —     | —   | —      | —      | —    | NONE    | —      |
|  3 | 2025-03-20 | SHORT | 35  | 34600  | 34780  | 180  | SL      | −1R    |
```

---

## Error Handling

| Situation | Action |
|-----------|--------|
| `mt5_get_candles` fails entirely | Tell user to check bridge/EA; stop |
| Date returns 0 bars | Weekend/holiday — skip silently |
| Date returns < `range_candles+1` bars | Log ⚠️ SKIPPED, continue |
| `R == 0` | Log SKIPPED (zero R), continue |
| `mt5_add_object` fails | Log error, continue to next day |
| `mt5_modify_object` fails | Log error (FIBO levels may show defaults), continue |

---

## Key Rules

1. **`mt5_clear_objects prefix=RB_` runs exactly once** — at Step 0 before the loop. Never again during the loop.
2. **Each day only adds 3 new objects** (`RB_Range_{DATE}`, `RB_Fibo_{DATE}`, `RB_Arrow_{DATE}`) — old days stay on the chart.
3. **≤ 300 bars per `mt5_get_candles` call** — always use `from_date`/`to_date` per day; never bulk-fetch all days at once.
4. **One breakout per day** — first valid bar only; stop scanning.
5. **Body rule** — breakout threshold uses open-to-close body fraction, not high-to-low wicks.
6. **`range_candles` is user-configurable** — never assume 20 if the user said something different.
7. **FIBO level values are multipliers** — `2.0` = 200% of span = TP1; never pass price values to `OBJPROP_LEVELVALUE`.
