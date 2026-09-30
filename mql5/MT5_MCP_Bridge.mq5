//+------------------------------------------------------------------+
//|  MT5_MCP_Bridge.mq5                                              |
//|  Connects to the Node.js MCP server on TCP 127.0.0.1:6789,      |
//|  processes JSON commands and returns JSON responses.             |
//|                                                                  |
//|  Architecture: Node.js is the TCP *server*; this EA is the      |
//|  *client*.  MQL5 has no SocketBind/Listen/Accept — it only      |
//|  supports outbound (client) connections.                         |
//|                                                                  |
//|  Version: 1.0.0                                                  |
//|  Place in: MQL5/Experts/MT5_MCP/MT5_MCP_Bridge.mq5              |
//+------------------------------------------------------------------+
#property copyright "MT5 MCP Bridge"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <JAson.mqh>          // MQL5 JSON library (see install notes)

input int    InpPort          = 6789;         // Node.js bridge port
input string InpHost          = "127.0.0.1";  // Node.js bridge host
input bool   InpDebugLog      = true;         // Verbose logging
input int    InpReconnSec     = 3;            // Reconnect interval (seconds)

const int    TIMER_MS         = 10;            // Check for commands with a high-resolution timer

//--- globals
int      g_socket       = INVALID_HANDLE;
bool     g_connected    = false;
string   g_version      = "1.0.0";
int      g_reconnTick   = 0;     // timer-tick counter for reconnect throttle
int      g_reconnLimit  = 0;     // computed from InpReconnSec in OnInit
string   g_lineBuf      = "";    // streaming line buffer — accumulates partial TCP chunks

//--- status-dot object names (created on the chart)
#define DOT_OBJ   "MCP_Dot"
#define TEXT_OBJ  "MCP_Text"

// Connection states
enum EConnState { CONN_CONNECTING, CONN_CONNECTED, CONN_OFFLINE };

//+------------------------------------------------------------------+
//| Status-dot helpers                                               |
//+------------------------------------------------------------------+

// Draw (or update) the two-label status indicator in the top-right corner.
// Uses a filled circle from the Wingdings font so it renders as a solid dot.
void SetStatusDot(EConnState state)
  {
   long  cid  = ChartID();
   color col  = (state == CONN_CONNECTED)  ? clrLimeGreen
              : (state == CONN_CONNECTING) ? clrGold
              :                              clrRed;
   string lbl = (state == CONN_CONNECTED)  ? "MCP  Connected"
              : (state == CONN_CONNECTING) ? "MCP  Connecting\x2026"
              :                              "MCP  Offline";

   // ── Dot (Wingdings 108 = filled circle) ────────────────────────
   if(ObjectFind(cid, DOT_OBJ) < 0)
     {
      ObjectCreate(cid, DOT_OBJ, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_CORNER,    CORNER_RIGHT_UPPER);
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_XDISTANCE, 15);    // just right of the text
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_YDISTANCE, 25);   // same line as text
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_FONTSIZE,  9);    // match text visual size
      ObjectSetString (cid, DOT_OBJ, OBJPROP_FONT,      "Wingdings");
      ObjectSetString (cid, DOT_OBJ, OBJPROP_TEXT,      "l"); // char 108 = ● in Wingdings
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_BACK,      false);
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_SELECTABLE,false);
      ObjectSetInteger(cid, DOT_OBJ, OBJPROP_HIDDEN,    true);
     }
   ObjectSetInteger(cid, DOT_OBJ, OBJPROP_COLOR, col);

   // ── Status text ────────────────────────────────────────────────
   if(ObjectFind(cid, TEXT_OBJ) < 0)
     {
      ObjectCreate(cid, TEXT_OBJ, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_CORNER,    CORNER_RIGHT_UPPER);
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_XDISTANCE, 17);   // right-aligned
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_YDISTANCE, 26);   // same line as dot
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_FONTSIZE,  7);
      ObjectSetString (cid, TEXT_OBJ, OBJPROP_FONT,      "Arial");
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_BACK,      false);
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_SELECTABLE,false);
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_HIDDEN,    true);
      ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_ANCHOR,    ANCHOR_RIGHT_UPPER);
     }
   ObjectSetString (cid, TEXT_OBJ, OBJPROP_TEXT,  lbl);
   ObjectSetInteger(cid, TEXT_OBJ, OBJPROP_COLOR, col);

   ChartRedraw(cid);
  }

void RemoveStatusDot()
  {
   long cid = ChartID();
   ObjectDelete(cid, DOT_OBJ);
   ObjectDelete(cid, TEXT_OBJ);
   ChartRedraw(cid);
  }

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   // Compute how many timer events equal the configured reconnect interval.
   g_reconnLimit = MathMax(1, InpReconnSec * 1000 / TIMER_MS);
   g_reconnTick  = g_reconnLimit; // fire immediately on first tick

   SetStatusDot(CONN_CONNECTING);   // yellow on startup

   Print("MT5_MCP_Bridge v", g_version,
         " — will connect to Node.js bridge at ", InpHost, ":", InpPort);
   EventSetMillisecondTimer(TIMER_MS);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_socket != INVALID_HANDLE) SocketClose(g_socket);
   g_socket    = INVALID_HANDLE;
   g_connected = false;
   RemoveStatusDot();
   Print("MT5_MCP_Bridge stopped.");
  }

//+------------------------------------------------------------------+
//| Timer — reconnect if needed, then read & dispatch messages       |
//+------------------------------------------------------------------+
void OnTimer()
  {
   // ── (Re)connect ─────────────────────────────────────────────────
   if(!g_connected)
     {
      g_reconnTick++;
      if(g_reconnTick < g_reconnLimit) return;
      g_reconnTick = 0;

      if(g_socket != INVALID_HANDLE)
        {
         SocketClose(g_socket);
         g_socket = INVALID_HANDLE;
        }

      g_socket = SocketCreate();
      if(g_socket == INVALID_HANDLE)
        {
         Print("ERROR: SocketCreate failed — ", GetLastError());
         return;
        }

      if(!SocketConnect(g_socket, InpHost, InpPort, 500))
        {
         // Not yet available; close immediately so the handle is never leaked
         SocketClose(g_socket);
         g_socket = INVALID_HANDLE;
         if(InpDebugLog)
            Print("Waiting for Node.js bridge on ", InpHost, ":", InpPort, "…");
         SetStatusDot(CONN_CONNECTING);   // yellow — still waiting
         return;
        }

      g_connected = true;
      g_lineBuf   = "";                   // discard any stale partial data
      SetStatusDot(CONN_CONNECTED);       // green — handshake complete
      Print("MT5_MCP_Bridge connected to Node.js bridge at ", InpHost, ":", InpPort);
      return; // skip read on the same tick we connected
     }

   // ── Read available bytes ─────────────────────────────────────────
   uint avail = SocketIsReadable(g_socket);
   if(avail == 0) return;

   uchar buf[];
   ArrayResize(buf, (int)avail);
   int nRead = SocketRead(g_socket, buf, avail, 0);
   if(nRead <= 0)
     {
      g_connected = false;
      SocketClose(g_socket);              // free the handle — otherwise it
                                          // leaks and SocketCreate eventually
                                          // fails with 5271 (too many sockets)
      g_socket    = INVALID_HANDLE;
      SetStatusDot(CONN_OFFLINE);         // red — lost connection
      Print("MT5_MCP_Bridge disconnected — will reconnect.");
      return;
     }

   string raw = CharArrayToString(buf, 0, nRead, CP_UTF8);

   // Protocol: newline-delimited JSON.
   // Append to the persistent line buffer so that messages split across
   // multiple TCP reads are reassembled correctly before parsing.
   g_lineBuf += raw;

   // Extract and dispatch every complete newline-terminated line.
   int nlPos;
   while((nlPos = StringFind(g_lineBuf, "\n")) >= 0)
     {
      string line = StringSubstr(g_lineBuf, 0, nlPos);
      g_lineBuf   = StringSubstr(g_lineBuf, nlPos + 1);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringLen(line) == 0) continue;
      ProcessMessage(line);
     }
  }

//+------------------------------------------------------------------+
//| Parse and dispatch one JSON message                              |
//+------------------------------------------------------------------+
void ProcessMessage(string raw)
  {
   if(InpDebugLog) PrintFormat("[RX] %s", raw);

   CJAVal doc;
   if(!doc.Deserialize(raw))
     {
      SendError(0, "JSON parse error");
      return;
     }

   int    msgId = (int)doc["id"].ToInt();
   string cmd   = doc["cmd"].ToStr();
   CJAVal params = doc["params"];

   // ── Dispatch ─────────────────────────────────────────────────────
   if(cmd == "status")                    CmdStatus(msgId);
   else if(cmd == "get_candles")          CmdGetCandles(msgId, params);
   else if(cmd == "get_current_bar_time") CmdGetCurrentBarTime(msgId, params);
   else if(cmd == "get_partial_bar_start_at") CmdGetPartialBarStartAt(msgId, params);
   else if(cmd == "get_tick")             CmdGetTick(msgId, params);
   else if(cmd == "get_chart_info")       CmdGetChartInfo(msgId, params);
   else if(cmd == "list_symbols")         CmdListSymbols(msgId, params);
   else if(cmd == "add_object")           CmdAddObject(msgId, params);
   else if(cmd == "add_objects")          CmdAddObjects(msgId, params);
   else if(cmd == "modify_object")        CmdModifyObject(msgId, params);
   else if(cmd == "delete_object")        CmdDeleteObject(msgId, params);
   else if(cmd == "list_objects")         CmdListObjects(msgId, params);
   else if(cmd == "clear_objects")        CmdClearObjects(msgId, params);
   else if(cmd == "add_indicator")        CmdAddIndicator(msgId, params);
   else if(cmd == "get_indicator_values") CmdGetIndicatorValues(msgId, params);
   else if(cmd == "remove_indicator")     CmdRemoveIndicator(msgId, params);
   else if(cmd == "list_indicators")      CmdListIndicators(msgId, params);
   else if(cmd == "backtest_strategy")    CmdBacktestStrategy(msgId, params);
   else if(cmd == "backtest_indicator_cross") CmdBacktestIndicatorCross(msgId, params);
   else if(cmd == "scroll_chart")         CmdScrollChart(msgId, params);
   else if(cmd == "navigate_chart")       CmdNavigateChart(msgId, params);
   else if(cmd == "take_screenshot")      CmdTakeScreenshot(msgId, params);
   else if(cmd == "account_info")         CmdAccountInfo(msgId);
   else if(cmd == "symbol_info")          CmdSymbolInfo(msgId, params);
   else if(cmd == "open_positions")       CmdOpenPositions(msgId, params);
   else if(cmd == "order_history")        CmdOrderHistory(msgId, params);
   else SendError(msgId, "Unknown command: " + cmd);
  }

//+------------------------------------------------------------------+
//| Send helpers                                                     |
//+------------------------------------------------------------------+
// Build the JSON envelope manually to work around the CJAVal nested-object
// assignment bug: resp["key"] = cjval produces "" as the key name instead of
// "key" in some JAson library versions, which breaks JSON.parse on the Node side.
bool SocketSendAll(const uchar &payload[], int payloadSize)
  {
   int offset = 0;
   uint started = GetTickCount();
   uchar chunk[];
   while(offset < payloadSize)
     {
      if(g_socket == INVALID_HANDLE || !g_connected) return false;
      int chunkSize = MathMin(65536, payloadSize - offset);
      ArrayResize(chunk, chunkSize);
      if(ArrayCopy(chunk, payload, 0, offset, chunkSize) != chunkSize)
        {
         Print("SocketSendAll: failed to prepare response chunk");
         return false;
        }
      int written = SocketSend(g_socket, chunk, chunkSize);
      if(written < 0)
        {
         Print("SocketSendAll: SocketSend failed ", GetLastError());
         break;
        }
      if(written == 0)
        {
         if((uint)(GetTickCount() - started) >= 10000)
           {
            Print("SocketSendAll: timed out after 10 seconds");
            break;
           }
         Sleep(1);
         continue;
        }
      offset += written;
     }

   if(offset == payloadSize) return true;
   g_connected = false;
   if(g_socket != INVALID_HANDLE) SocketClose(g_socket);
   g_socket = INVALID_HANDLE;
   SetStatusDot(CONN_OFFLINE);
   return false;
  }

void SendOkJson(int id, string dataJson)
  {
   string out = "{\"id\":" + IntegerToString(id) +
                ",\"ok\":true"  +
                ",\"data\":"    + dataJson +
                "}\n";
   if(InpDebugLog) PrintFormat("[TX] %s", out);
   uchar bytes[];
   // StringToCharArray with explicit count does NOT append a null terminator,
   // so ArraySize(bytes) == StringLen(out) and the last byte IS the '\n'.
   // Send ALL bytes — do NOT subtract 1 or the newline delimiter is stripped.
   StringToCharArray(out, bytes, 0, StringLen(out), CP_UTF8);
   SocketSendAll(bytes, ArraySize(bytes));
  }

void SendOk(int id, CJAVal &data)
  {
   SendOkJson(id, data.Serialize());
  }

void SendError(int id, string errMsg)
  {
   // Escape backslashes and double-quotes inside the error message so the
   // resulting JSON stays valid.
   string safe = errMsg;
   StringReplace(safe, "\\", "\\\\");
   StringReplace(safe, "\"", "\\\"");
   string out = "{\"id\":"  + IntegerToString(id) +
                ",\"ok\":false"  +
                ",\"error\":\"" + safe + "\"" +
                "}\n";
   if(InpDebugLog) PrintFormat("[TX-ERR] %s", out);
   uchar bytes[];
   // Same fix: send all bytes including the '\n' delimiter.
   StringToCharArray(out, bytes, 0, StringLen(out), CP_UTF8);
   if(g_socket != INVALID_HANDLE && g_connected)
      SocketSendAll(bytes, ArraySize(bytes));
   Print("ERROR sent: ", errMsg);
  }

//+------------------------------------------------------------------+
//| ── COMMAND IMPLEMENTATIONS ────────────────────────────────────── |
//+------------------------------------------------------------------+

// STATUS ──────────────────────────────────────────────────────────
void CmdStatus(int id)
  {
   CJAVal d;
   d["version"]      = g_version;
   d["terminal"]     = TerminalInfoString(TERMINAL_NAME);
   d["company"]      = AccountInfoString(ACCOUNT_COMPANY);
   d["server"]       = AccountInfoString(ACCOUNT_SERVER);
   d["login"]        = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   d["currency"]     = AccountInfoString(ACCOUNT_CURRENCY);
   d["ping_ms"]      = (int)(TerminalInfoInteger(TERMINAL_PING_LAST) / 1000);
   d["trade_allowed"]= (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   SendOk(id, d);
  }

// GET CANDLES ─────────────────────────────────────────────────────
void CmdGetCandles(int id, CJAVal &p)
  {
   string sym   = p["symbol"].ToStr();
   string tfStr = p["timeframe"].ToStr();
   int    count = (int)p["count"].ToInt();
   if(count <= 0) count = 500;

   ENUM_TIMEFRAMES tf = StringToTF(tfStr);

   MqlRates rates[];
   int copied;

   string fromStr = p["from_date"].ToStr();
   string toStr   = p["to_date"].ToStr();

   if(StringLen(fromStr) > 0)
     {
      datetime dtFrom = StringToTime(fromStr);
      datetime dtTo   = StringLen(toStr) > 0 ? StringToTime(toStr) : TimeCurrent();
      copied = CopyRates(sym, tf, dtFrom, dtTo, rates);
      // Honour the count cap even in date-range mode so large sessions don't
      // flood the socket buffer. Default cap = 300 when not specified.
      if(count <= 0) count = 300;
      if(copied > count) copied = count;
     }
   else
     {
      copied = CopyRates(sym, tf, 0, count, rates);
     }

   if(copied <= 0)
     { SendError(id, "CopyRates failed: " + IntegerToString(GetLastError())); return; }

   CJAVal d;
   d["symbol"]    = sym;
   d["timeframe"] = tfStr;
   d["count"]     = copied;

   for(int i = 0; i < copied; i++)
     {
      CJAVal bar;
      bar["t"] = TimeToString(rates[i].time);
      bar["o"] = rates[i].open;
      bar["h"] = rates[i].high;
      bar["l"] = rates[i].low;
      bar["c"] = rates[i].close;
      bar["v"] = (long)rates[i].tick_volume;
      d["candles"].Add(bar);
     }
   SendOk(id, d);
  }

// GET TICK ────────────────────────────────────────────────────────
void CmdGetTick(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr();
   MqlTick tick;
   if(!SymbolInfoTick(sym, tick))
     { SendError(id, "SymbolInfoTick failed"); return; }
   CJAVal d;
   d["symbol"] = sym;
   d["bid"]    = tick.bid;
   d["ask"]    = tick.ask;
   d["last"]   = tick.last;
   d["spread"] = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   d["time"]   = TimeToString(tick.time);
   SendOk(id, d);
  }

// GET CHART INFO ──────────────────────────────────────────────────
void CmdGetChartInfo(int id, CJAVal &p)
  {
   long cid = p["chart_id"].ToInt();
   if(cid == 0) cid = ChartID();

   string sym = ChartSymbol(cid);
   ENUM_TIMEFRAMES tf = (ENUM_TIMEFRAMES)ChartPeriod(cid);

   CJAVal d;
   d["chart_id"]       = cid;
   d["symbol"]         = sym;
   d["timeframe"]      = TFToString(tf);
   d["first_bar_time"] = TimeToString((datetime)ChartGetInteger(cid, CHART_FIRST_VISIBLE_BAR, 0));
   d["bars_total"]     = Bars(sym, tf);         // total bars loaded for this symbol/tf
   d["visible_bars"]   = (int)ChartGetInteger(cid, CHART_VISIBLE_BARS, 0);
   SendOk(id, d);
  }

// LIST SYMBOLS ────────────────────────────────────────────────────
void CmdListSymbols(int id, CJAVal &p)
  {
   string grp   = p["group"].ToStr();
   int    total = SymbolsTotal(false);
   CJAVal d;
   int symbolCount = 0;
   for(int i = 0; i < total; i++)
     {
      string s = SymbolName(i, false);
      if(StringLen(grp) > 0 && StringFind(s, StringSubstr(grp, 1, StringLen(grp)-2)) < 0)
         continue; // simple glob filter
      d["symbols"].Add(s);
      symbolCount++;
     }
   d["count"] = symbolCount;
   SendOk(id, d);
  }

// ADD OBJECT ──────────────────────────────────────────────────────
bool CreateChartObject(long cid, CJAVal &p, int &errorCode)
  {
   int    subwin  = (int)p["subwindow"].ToInt();
   string name    = p["name"].ToStr();
   string typeStr = p["type"].ToStr();
   ENUM_OBJECT otype = StringToObjType(typeStr);

   if(StringLen(name) == 0)
     {
      errorCode = -1;
      return false;
     }
   if((int)otype == WRONG_VALUE)
     {
      errorCode = -2;
      return false;
     }

   datetime t1 = StringToTime(p["time1"].ToStr());
   double   p1 = p["price1"].ToDbl();
   datetime t2 = StringLen(p["time2"].ToStr()) > 0 ? StringToTime(p["time2"].ToStr()) : 0;
   double   p2 = p["price2"].ToDbl();
   datetime t3 = StringLen(p["time3"].ToStr()) > 0 ? StringToTime(p["time3"].ToStr()) : 0;
   double   p3 = p["price3"].ToDbl();

   ResetLastError();
   if(!ObjectCreate(cid, name, otype, subwin, t1, p1, t2, p2, t3, p3))
     {
      errorCode = GetLastError();
      return false;
     }

   if(StringLen(p["color"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_COLOR, ColorFromString(p["color"].ToStr()));
   if(p["width"].ToInt() > 0)
      ObjectSetInteger(cid, name, OBJPROP_WIDTH, p["width"].ToInt());
   if(StringLen(p["style"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_STYLE, StringToLineStyle(p["style"].ToStr()));
   if(StringLen(p["description"].ToStr()) > 0)
      ObjectSetString(cid, name, OBJPROP_TEXT, p["description"].ToStr());
   if(p["fill"].ToBool())
      ObjectSetInteger(cid, name, OBJPROP_FILL, true);
   if(p["back"].ToBool())
      ObjectSetInteger(cid, name, OBJPROP_BACK, true);

   string selStr = p["selectable"].ToStr();
   bool sel = (selStr == "false" || selStr == "0") ? false : true;
   ObjectSetInteger(cid, name, OBJPROP_SELECTABLE, sel);
   ObjectSetInteger(cid, name, OBJPROP_HIDDEN, false);
   errorCode = 0;
   return true;
  }

void CmdAddObject(int id, CJAVal &p)
  {
   long cid = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   int errorCode = 0;
   if(!CreateChartObject(cid, p, errorCode))
     {
      string reason = errorCode == -1 ? "Object name is empty" :
                      errorCode == -2 ? "Unsupported chart object type: " + p["type"].ToStr() :
                      "ObjectCreate failed: " + IntegerToString(errorCode);
      SendError(id, reason);
      return;
     }

   ChartRedraw(cid);
   CJAVal d; d["name"] = p["name"].ToStr(); d["type"] = p["type"].ToStr();
   SendOk(id, d);
  }

void CmdGetCurrentBarTime(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr();
   string tfStr = p["timeframe"].ToStr();
   ENUM_TIMEFRAMES tf = StringToTF(tfStr);
   datetime barTime = iTime(sym, tf, 0);
   if(barTime <= 0)
     { SendError(id, "Could not get current bar time for " + sym + " " + tfStr); return; }
   CJAVal d;
   d["symbol"] = sym;
   d["timeframe"] = tfStr;
   d["time"] = TimeToString(barTime, TIME_DATE | TIME_SECONDS);
   SendOk(id, d);
  }

void CmdGetPartialBarStartAt(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr();
   string tfStr = p["timeframe"].ToStr();
   datetime endTime = StringToTime(p["time"].ToStr());
   ENUM_TIMEFRAMES tf = StringToTF(tfStr);
   int shift = iBarShift(sym, tf, endTime, false);
   if(endTime <= 0 || shift < 0)
     { SendError(id, "Could not locate candle at requested end time for " + sym + " " + tfStr); return; }
   datetime barStart = iTime(sym, tf, shift);
   if(barStart <= 0)
     { SendError(id, "Could not read candle start at requested end time for " + sym + " " + tfStr); return; }
   CJAVal d;
   d["symbol"] = sym;
   d["timeframe"] = tfStr;
   d["time"] = (endTime < BacktestCandleEnd(barStart, tf))
      ? TimeToString(barStart, TIME_DATE | TIME_SECONDS) : "";
   SendOk(id, d);
  }

void CmdAddObjects(int id, CJAVal &p)
  {
   long cid = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   CJAVal objects = p["objects"];
   int count = objects.Size();
   if(count <= 0)
     { SendError(id, "add_objects requires a non-empty objects array"); return; }
   if(count > 250)
     { SendError(id, "add_objects accepts at most 250 objects per command"); return; }

   string resultsJson = "[";
   int created = 0;
   for(int i = 0; i < count; i++)
     {
      CJAVal item = objects[i];
      CJAVal result;
      string name = item["name"].ToStr();
      string typeStr = item["type"].ToStr();
      int errorCode = 0;
      bool ok = CreateChartObject(cid, item, errorCode);
      result["name"] = name;
      result["type"] = typeStr;
      result["success"] = ok;
      if(ok)
         created++;
      else
        {
         result["error_code"] = errorCode;
         result["error"] = errorCode == -1 ? "Object name is empty" :
                            errorCode == -2 ? "Unsupported chart object type" :
                            "ObjectCreate failed";
        }
      if(i > 0) resultsJson += ",";
      resultsJson += result.Serialize();
     }

   ChartRedraw(cid);
   resultsJson += "]";
   string dataJson = "{\"requested\":" + IntegerToString(count) +
                     ",\"created\":" + IntegerToString(created) +
                     ",\"failed\":" + IntegerToString(count - created) +
                     ",\"results\":" + resultsJson + "}";
   SendOkJson(id, dataJson);
  }

// MODIFY OBJECT ───────────────────────────────────────────────────
void CmdModifyObject(int id, CJAVal &p)
  {
   long   cid  = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string name = p["name"].ToStr();

   if(ObjectFind(cid, name) < 0)
     { SendError(id, "Object not found: " + name); return; }

   CJAVal props = p["properties"];
   if(StringLen(props["color"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_COLOR, ColorFromString(props["color"].ToStr()));
   if(props["width"].ToInt() > 0)
      ObjectSetInteger(cid, name, OBJPROP_WIDTH, props["width"].ToInt());
   if(StringLen(props["description"].ToStr()) > 0)
      ObjectSetString(cid, name, OBJPROP_TEXT, props["description"].ToStr());
   if(StringLen(props["time1"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_TIME, StringToTime(props["time1"].ToStr()));
   if(props["price1"].ToDbl() != 0)
      ObjectSetDouble(cid, name, OBJPROP_PRICE, props["price1"].ToDbl());

   // ── Fibonacci levels ─────────────────────────────────────────────
   // OBJPROP_LEVELS sets the total count; OBJPROP_LEVELVALUE_N sets each multiplier.
   // OBJPROP_LEVELTEXT_N sets the display label for each level line.
   // Example: OBJPROP_LEVELS=5, OBJPROP_LEVELVALUE_0=0.0 .. OBJPROP_LEVELVALUE_4=4.0
   //          OBJPROP_LEVELTEXT_0="SL", OBJPROP_LEVELTEXT_1="Entry", etc.
   int nLev = (int)props["OBJPROP_LEVELS"].ToInt();
   if(nLev > 0)
     {
      ObjectSetInteger(cid, name, OBJPROP_LEVELS, nLev);
      for(int li = 0; li < nLev && li < 32; li++)
        {
         string lvKey = "OBJPROP_LEVELVALUE_" + IntegerToString(li);
         string lvStr = props[lvKey].ToStr();
         if(StringLen(lvStr) > 0)   // key was present in the JSON payload
            ObjectSetDouble(cid, name, OBJPROP_LEVELVALUE, li, props[lvKey].ToDbl());
        }
     }
   // ── Fibonacci level text labels (independent of nLev — can set labels without resizing) ──
   for(int li = 0; li < 32; li++)
     {
      string ltKey = "OBJPROP_LEVELTEXT_" + IntegerToString(li);
      string ltStr = props[ltKey].ToStr();
      if(StringLen(ltStr) > 0)
         ObjectSetString(cid, name, OBJPROP_LEVELTEXT, li, ltStr);
     }

   ChartRedraw(cid);
   CJAVal d; d["name"] = name; d["modified"] = true;
   SendOk(id, d);
  }

// DELETE OBJECT ───────────────────────────────────────────────────
void CmdDeleteObject(int id, CJAVal &p)
  {
   long   cid  = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string name = p["name"].ToStr();
   bool   res  = ObjectDelete(cid, name);
   ChartRedraw(cid);
   CJAVal d; d["deleted"] = res;
   SendOk(id, d);
  }

// LIST OBJECTS ────────────────────────────────────────────────────
void CmdListObjects(int id, CJAVal &p)
  {
   long   cid        = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string typeFilter = p["type_filter"].ToStr();
   int    total      = ObjectsTotal(cid, -1, -1);
   CJAVal d;
   int objectsCount = 0;
   for(int i = 0; i < total; i++)
     {
      string n  = ObjectName(cid, i, -1, -1);
      CJAVal o;
      o["name"] = n;
      ENUM_OBJECT ot = (ENUM_OBJECT)ObjectGetInteger(cid, n, OBJPROP_TYPE);
      o["type"] = EnumToString(ot);
      if(StringLen(typeFilter) > 0 && StringFind(o["type"].ToStr(), typeFilter) < 0) continue;
      o["color"]      = (long)ObjectGetInteger(cid, n, OBJPROP_COLOR);
      o["style"]      = (int)ObjectGetInteger(cid, n, OBJPROP_STYLE);
      o["width"]      = (int)ObjectGetInteger(cid, n, OBJPROP_WIDTH);
      o["back"]       = (bool)ObjectGetInteger(cid, n, OBJPROP_BACK);
      o["fill"]       = (bool)ObjectGetInteger(cid, n, OBJPROP_FILL);
      o["selectable"] = (bool)ObjectGetInteger(cid, n, OBJPROP_SELECTABLE);
      o["description"] = ObjectGetString(cid, n, OBJPROP_TOOLTIP);
      o["text"]        = ObjectGetString(cid, n, OBJPROP_TEXT);
   for(int point = 0; point < 3; point++)
        {
         datetime anchorTime = (datetime)ObjectGetInteger(cid, n, OBJPROP_TIME, point);
         double anchorPrice = ObjectGetDouble(cid, n, OBJPROP_PRICE, point);
         if(anchorTime <= 0 && anchorPrice == 0.0) continue;
         CJAVal anchor;
         anchor["point"] = point;
         if(anchorTime > 0) anchor["time"] = TimeToString(anchorTime, TIME_DATE | TIME_SECONDS);
         if(anchorPrice != 0.0) anchor["price"] = anchorPrice;
         o["anchors"].Add(anchor);
        }
      int levelCount = (int)ObjectGetInteger(cid, n, OBJPROP_LEVELS);
      if(levelCount > 0)
        {
         for(int level = 0; level < levelCount; level++)
           {
            CJAVal item;
            item["value"] = ObjectGetDouble(cid, n, OBJPROP_LEVELVALUE, level);
            item["text"] = ObjectGetString(cid, n, OBJPROP_LEVELTEXT, level);
            o["levels"].Add(item);
           }
        }
      d["objects"].Add(o);
      objectsCount++;
     }
   d["count"] = objectsCount;
   SendOk(id, d);
  }

// CLEAR OBJECTS ───────────────────────────────────────────────────
void CmdClearObjects(int id, CJAVal &p)
  {
   long   cid    = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string prefix = p["prefix"].ToStr();
   int    deleted = 0;
   if(StringLen(prefix) == 0)
     {
      deleted = ObjectsDeleteAll(cid);
     }
   else
     {
      int total = ObjectsTotal(cid, -1, -1);
      for(int i = total - 1; i >= 0; i--)
        {
         string n = ObjectName(cid, i, -1, -1);
         if(StringFind(n, prefix) == 0)
           { ObjectDelete(cid, n); deleted++; }
        }
     }
   ChartRedraw(cid);
   CJAVal d; d["deleted"] = deleted;
   SendOk(id, d);
  }

//+------------------------------------------------------------------+
//| INDICATORS                                                        |
//+------------------------------------------------------------------+
int    g_iHandles[];
string g_iNames[];
int    g_iCount = 0;

void CmdAddIndicator(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr(); if(sym == "") sym = Symbol();
   string tfS = p["timeframe"].ToStr();
   ENUM_TIMEFRAMES tf = StringLen(tfS) > 0 ? StringToTF(tfS) : Period();
   string name = p["indicator"].ToStr();

   CJAVal pa = p["params"];
   double d0=0,d1=0,d2=0,d3=0,d4=0;
   if(pa.Size() > 0) d0 = pa[0].ToDbl();
   if(pa.Size() > 1) d1 = pa[1].ToDbl();
   if(pa.Size() > 2) d2 = pa[2].ToDbl();
   if(pa.Size() > 3) d3 = pa[3].ToDbl();
   if(pa.Size() > 4) d4 = pa[4].ToDbl();

   int handle = INVALID_HANDLE;

   if(name == "MA" || name == "SMA")
      handle = iMA(sym, tf, (int)d0, (int)d1, MODE_SMA, PRICE_CLOSE);
   else if(name == "EMA")
      handle = iMA(sym, tf, (int)d0, 0, MODE_EMA, PRICE_CLOSE);
   else if(name == "MACD")
      handle = iMACD(sym, tf, (int)d0, (int)d1, (int)d2, PRICE_CLOSE);
   else if(name == "RSI")
      handle = iRSI(sym, tf, (int)d0, PRICE_CLOSE);
   else if(name == "BBANDS")
      handle = iBands(sym, tf, (int)d0, (int)d1, d2, PRICE_CLOSE);
   else if(name == "STOCH")
      handle = iStochastic(sym, tf, (int)d0, (int)d1, (int)d2, MODE_SMA, STO_LOWHIGH);
   else if(name == "ATR")
      handle = iATR(sym, tf, (int)d0);
   else if(name == "ADX")
      handle = iADX(sym, tf, (int)d0);
   else if(name == "CCI")
      handle = iCCI(sym, tf, (int)d0, PRICE_CLOSE);
   else if(name == "ICHIMOKU")
      handle = iIchimoku(sym, tf, (int)d0, (int)d1, (int)d2);
   else if(name == "SAR")
      handle = iSAR(sym, tf, d0, d1);
   else if(name == "WILLIAMS")
      handle = iWPR(sym, tf, (int)d0);
   else if(name == "MOMENTUM")
      handle = iMomentum(sym, tf, (int)d0, PRICE_CLOSE);
   else if(name == "OBV")
      handle = iOBV(sym, tf, VOLUME_TICK);
   else if(name == "VOLUMES")
      handle = iVolumes(sym, tf, VOLUME_TICK);
   else if(name == "ZIGZAG")
      handle = iCustom(sym, tf, "Examples\\ZigZag", d0, d1, d2);
   else if(name == "FRACTALS")
      handle = iFractals(sym, tf);
   else
      handle = iCustom(sym, tf, name, d0, d1, d2, d3, d4);

   if(handle == INVALID_HANDLE)
     { SendError(id, "Indicator creation failed: " + IntegerToString(GetLastError())); return; }

   ArrayResize(g_iHandles, g_iCount + 1);
   ArrayResize(g_iNames,   g_iCount + 1);
   g_iHandles[g_iCount] = handle;
   g_iNames[g_iCount]   = name + "_" + IntegerToString(handle);
   g_iCount++;

   CJAVal d;
   d["handle"] = handle;
   d["name"]   = name;
   SendOk(id, d);
  }

void CmdGetIndicatorValues(int id, CJAVal &p)
  {
   int handle = (int)p["handle"].ToInt();
   int bufIdx = (int)p["buffer_index"].ToInt();
   int start  = (int)p["start_pos"].ToInt();
   int count  = (int)p["count"].ToInt();

   double vals[];
   if(CopyBuffer(handle, bufIdx, start, count, vals) <= 0)
     { SendError(id, "CopyBuffer failed: " + IntegerToString(GetLastError())); return; }

   CJAVal d;
   d["handle"]       = handle;
   d["buffer_index"] = bufIdx;
   for(int i = 0; i < ArraySize(vals); i++) d["values"].Add(vals[i]);
   SendOk(id, d);
  }

void CmdRemoveIndicator(int id, CJAVal &p)
  {
   int handle = (int)p["handle"].ToInt();
   IndicatorRelease(handle);
   for(int i = 0; i < g_iCount; i++)
      if(g_iHandles[i] == handle) { g_iHandles[i] = INVALID_HANDLE; break; }
   CJAVal d; d["released"] = handle;
   SendOk(id, d);
  }

void CmdListIndicators(int id, CJAVal &p)
  {
   CJAVal d;
   int indicatorCount = 0;
   for(int i = 0; i < g_iCount; i++)
      if(g_iHandles[i] != INVALID_HANDLE)
        {
         CJAVal entry;
         entry["handle"] = g_iHandles[i];
         entry["name"]   = g_iNames[i];
         d["indicators"].Add(entry);
         indicatorCount++;
        }
   d["count"] = indicatorCount;
   SendOk(id, d);
  }

//+------------------------------------------------------------------+
//| BACKTESTING                                                       |
//+------------------------------------------------------------------+
datetime BacktestCandleEnd(datetime barTime, ENUM_TIMEFRAMES tf)
  {
   if(tf == PERIOD_MN1)
     {
      MqlDateTime parts;
      TimeToStruct(barTime, parts);
      parts.day = 1;
      parts.hour = 0;
      parts.min = 0;
      parts.sec = 0;
      if(parts.mon == 12)
        { parts.mon = 1; parts.year++; }
      else
         parts.mon++;
      return StructToTime(parts);
     }
   int seconds = PeriodSeconds(tf);
   return (seconds > 0) ? barTime + seconds : barTime;
  }

void CmdBacktestStrategy(int id, CJAVal &p)
  {
   string sym    = p["symbol"].ToStr();
   string tfS    = p["timeframe"].ToStr();
   ENUM_TIMEFRAMES tf = StringToTF(tfS);
   datetime dtFrom = StringToTime(p["from_date"].ToStr());
   datetime dtTo   = StringLen(p["to_date"].ToStr()) > 0
                     ? StringToTime(p["to_date"].ToStr()) : TimeCurrent();
   bool   drawChart = p["draw_on_chart"].ToBool();
   bool   clearPrev = p["clear_previous"].ToBool();
   string prefix    = p["prefix"].ToStr(); if(prefix == "") prefix = "BT_";
   long   cid       = ChartID();

   if(clearPrev) ObjectsDeleteAll(cid, prefix);

   MqlRates rates[];
   int copied = CopyRates(sym, tf, dtFrom, dtTo, rates);
   if(copied <= 0) { SendError(id, "No data for range"); return; }
   // Never use the still-forming candle at the right edge of the requested test.
   while(copied > 0 && BacktestCandleEnd(rates[copied-1].time, tf) > dtTo)
      copied--;
   if(copied <= 0) { SendError(id, "No completed candles for range"); return; }

   CJAVal strat = p["strategy"];
   int    fastP  = (int)strat["fast_ma"].ToInt();  if(fastP  <= 0) fastP  = 10;
   int    slowP  = (int)strat["slow_ma"].ToInt();  if(slowP  <= 0) slowP  = 30;
   if(fastP >= slowP)
     { SendError(id, "fast_ma must be less than slow_ma"); return; }
   int    rsiP   = (int)strat["rsi_period"].ToInt();if(rsiP  <= 0) rsiP   = 14;
   string useRsiText = strat["use_rsi"].ToStr();
   bool   useRsi = !(useRsiText == "false" || useRsiText == "0");
   double rsiOB  = strat["rsi_ob"].ToDbl();        if(rsiOB  == 0) rsiOB  = 70;
   double rsiOS  = strat["rsi_os"].ToDbl();        if(rsiOS  == 0) rsiOS  = 30;
   double slPips = strat["sl_pips"].ToDbl();       if(slPips == 0) slPips = 30;
   double tpPips = strat["tp_pips"].ToDbl();       if(tpPips == 0) tpPips = 60;

   double pip = SymbolInfoDouble(sym, SYMBOL_POINT) * 10;

   double fastMA[], slowMA[], rsiVal[];
   ArrayResize(fastMA, copied); ArrayResize(slowMA, copied); ArrayResize(rsiVal, copied);
   ArrayInitialize(fastMA, 0);  ArrayInitialize(slowMA, 0);  ArrayInitialize(rsiVal, 50);

   for(int i = slowP; i < copied; i++)
     {
      double sf=0, ss=0;
      for(int j=0;j<fastP;j++) sf+=rates[i-j].close;
      for(int j=0;j<slowP;j++) ss+=rates[i-j].close;
      fastMA[i]=sf/fastP; slowMA[i]=ss/slowP;
     }
   for(int i = rsiP+1; useRsi && i < copied; i++)
     {
      double gains=0, losses=0;
      for(int j=0;j<rsiP;j++)
        {
         double ch = rates[i-j].close - rates[i-j-1].close;
         if(ch>0) gains+=ch; else losses-=ch;
        }
      double rs = (losses==0)?100:(gains/rsiP)/(losses/rsiP);
      rsiVal[i] = 100 - 100/(1+rs);
     }

   CJAVal d;
   int    totalTrades=0, wins=0;
   double netPips=0, maxDD=0, equity=10000, peakEq=10000;
   bool   inTrade=false; string tradeType="";
   double entryPrice=0, sl=0, tp=0; datetime entryTime=0;
   int    objIdx=0;

   for(int i = slowP+1; i < copied; i++)
     {
      double c = rates[i].close;
      double h = rates[i].high;
      double l = rates[i].low;

      if(!inTrade)
        {
         bool longSig  = fastMA[i]>slowMA[i] && fastMA[i-1]<=slowMA[i-1] && (!useRsi || rsiVal[i]<rsiOB);
         bool shortSig = fastMA[i]<slowMA[i] && fastMA[i-1]>=slowMA[i-1] && (!useRsi || rsiVal[i]>rsiOS);

         if(longSig || shortSig)
           {
            inTrade    = true;
            tradeType  = longSig ? "BUY" : "SELL";
            entryPrice = c;
            entryTime  = rates[i].time;
            sl = longSig ? c - slPips*pip : c + slPips*pip;
            tp = longSig ? c + tpPips*pip : c - tpPips*pip;

            if(drawChart)
              {
               string arName = prefix + "AR_" + IntegerToString(objIdx++);
               ObjectCreate(cid, arName,
                            longSig ? OBJ_ARROW_BUY : OBJ_ARROW_SELL,
                            0, entryTime, entryPrice);
               ObjectSetInteger(cid, arName, OBJPROP_COLOR, longSig ? clrBlue : clrRed);
               ObjectSetInteger(cid, arName, OBJPROP_WIDTH, 2);
              }
           }
        }
      else
        {
         bool hitSL = (tradeType=="BUY" && l<=sl) || (tradeType=="SELL" && h>=sl);
         bool hitTP = (tradeType=="BUY" && h>=tp) || (tradeType=="SELL" && l<=tp);

         if(hitSL || hitTP)
           {
            // With OHLC bars we cannot know which level was touched first. Use the
            // adverse outcome when both levels fall inside the same candle.
            double exitP  = (hitSL ? sl : tp);
            double pipRes = (tradeType=="BUY") ? (exitP-entryPrice)/pip : (entryPrice-exitP)/pip;
            bool   win    = pipRes > 0;
            netPips += pipRes;
            equity  += pipRes * 10;
            if(equity > peakEq) peakEq = equity;
            double dd = (peakEq - equity) / peakEq * 100;
            if(dd > maxDD) maxDD = dd;
            if(win) wins++;
            totalTrades++;

            CJAVal t;
            t["type"]       = tradeType;
            t["open_time"]  = TimeToString(entryTime);
            t["close_time"] = TimeToString(rates[i].time);
            t["entry"]      = entryPrice;
            t["exit"]       = exitP;
            t["sl"]         = sl;
            t["tp"]         = tp;
            t["pips"]       = NormalizeDouble(pipRes, 1);
            t["win"]        = win;
            d["trades"].Add(t);

            if(drawChart)
              {
               string boxName = prefix + "BOX_" + IntegerToString(objIdx++);
               ObjectCreate(cid, boxName, OBJ_RECTANGLE, 0,
                            entryTime, entryPrice, rates[i].time, exitP);
               ObjectSetInteger(cid, boxName, OBJPROP_COLOR, win ? clrLimeGreen : clrCrimson);
               ObjectSetInteger(cid, boxName, OBJPROP_FILL, true);
               ObjectSetInteger(cid, boxName, OBJPROP_BACK, true);
              }

            inTrade = false;
           }
        }
     }

   ChartRedraw(cid);

   double pf = 0;
   if(totalTrades > 0 && wins > 0 && (totalTrades-wins) > 0)
      pf = (double)wins * tpPips / ((totalTrades-wins) * slPips);

   d["summary"]["total_trades"]     = totalTrades;
   d["summary"]["wins"]             = wins;
   d["summary"]["losses"]           = totalTrades - wins;
   d["summary"]["win_rate_pct"]     = totalTrades>0 ? NormalizeDouble((double)wins/totalTrades*100,1) : 0;
   d["summary"]["net_pips"]         = NormalizeDouble(netPips, 1);
   d["summary"]["profit_factor"]    = NormalizeDouble(pf, 2);
   d["summary"]["max_drawdown_pct"] = NormalizeDouble(maxDD, 2);
   d["summary"]["bars_tested"]      = copied;
   SendOk(id, d);
  }

void CmdBacktestIndicatorCross(int id, CJAVal &p)
  {
   CJAVal np;
   np["symbol"]         = p["symbol"].ToStr();
   np["timeframe"]      = p["timeframe"].ToStr();
   np["from_date"]      = p["from_date"].ToStr();
   np["to_date"]        = p["to_date"].ToStr();
   np["strategy"]["fast_ma"] = (int)p["fast_period"].ToInt();
   np["strategy"]["slow_ma"] = (int)p["slow_period"].ToInt();
   np["strategy"]["sl_pips"] = p["sl_pips"].ToDbl();
   np["strategy"]["tp_pips"] = p["tp_pips"].ToDbl();
   np["strategy"]["use_rsi"] = false;
   np["draw_on_chart"]  = p["draw_on_chart"].ToBool();
   np["clear_previous"] = true;
   np["prefix"]         = "MA_BT_";

   CmdBacktestStrategy(id, np);
  }

// SCROLL CHART ────────────────────────────────────────────────────
void CmdScrollChart(int id, CJAVal &p)
  {
   long     cid   = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   datetime dt    = StringToTime(p["datetime"].ToStr());
   int      shift = (int)p["bars_shift"].ToInt();

   // Disable auto-scroll BEFORE navigation so ticks don't snap back.
   ChartSetInteger(cid, CHART_AUTOSCROLL, false);

   // Compute bar offset using time difference — avoids iBarShift chart-buffer limitation.
   // iBarShift only works within the chart's loaded buffer; time-diff works for any date.
   ENUM_TIMEFRAMES chartTF = (ENUM_TIMEFRAMES)ChartPeriod(cid);
   int periodSec = PeriodSeconds(chartTF);
   if(periodSec <= 0) periodSec = 60; // fallback to M1
   datetime currentTime = TimeCurrent();
   int barShift = (currentTime > dt) ? (int)((currentTime - dt) / periodSec) : 0;

   // Per MQL5 docs: positive shift from CHART_END = toward newer (right/empty space).
   // NEGATIVE shift from CHART_END = toward older (left/history). We need negative to scroll back.
   // bars_shift parameter: negative value = how many extra bars AFTER dt are visible on the right.
   // e.g. bars_shift=-50 → right edge is 50 bars after dt → dt is 50 bars from right edge.
   int navShift = -(barShift + shift); // shift is negative (e.g. -50), so navShift = -(barShift-50) = -barShift+50 → negative overall
   ChartNavigate(cid, CHART_END, navShift);

   // Re-apply autoscroll=false AFTER navigate (CHART_END,0 can re-enable it).
   ChartSetInteger(cid, CHART_AUTOSCROLL, false);
   ChartRedraw(cid);
   CJAVal d; d["scrolled_to"] = TimeToString(dt); d["bar_shift"] = barShift; d["nav_offset"] = navShift;
   SendOk(id, d);
  }

// NAVIGATE CHART ──────────────────────────────────────────────────
// action: "forward"  — move N bars toward newer data (right)
//         "backward" — move N bars toward older data (left)
//         "begin"    — jump to the oldest available bar
//         "end"      — jump to the most recent bar
//         "zoom_in"  — increase bar scale (larger candles)
//         "zoom_out" — decrease bar scale (smaller candles, more bars visible)
//         "set_zoom" — set zoom level directly (0-5)
void CmdNavigateChart(int id, CJAVal &p)
  {
   long   cid    = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string action = p["action"].ToStr();
   int    bars   = (int)p["bars"].ToInt(); if(bars <= 0) bars = 50; // default
   int    zoom   = (int)p["zoom"].ToInt();

   // Read state before navigation so we can report it
   int  scaleBefore  = (int)ChartGetInteger(cid, CHART_SCALE, 0);
   // CHART_FIRST_VISIBLE_BAR = index of leftmost visible bar counted from
   // bar-0 (the most recent bar).  Higher value = further into the past.
   long currentShift = ChartGetInteger(cid, CHART_FIRST_VISIBLE_BAR, 0);

   // Disable auto-scroll FIRST so ticks don't snap the chart back to the
   // live edge immediately after we move it.
   ChartSetInteger(cid, CHART_AUTOSCROLL, false);

   if(action == "forward")
     {
      // Move toward newer (right) — reduce distance from CHART_END.
      // Per MQL5 docs: negative = toward beginning; so less negative = newer.
      long newShift = MathMax(currentShift - bars, 0);
      ChartNavigate(cid, CHART_END, -(int)newShift);
     }
   else if(action == "backward")
     {
      // Move toward older (left) — increase distance from CHART_END (more negative).
      ChartNavigate(cid, CHART_END, -(int)(currentShift + bars));
     }
   else if(action == "begin")
     {
      ChartNavigate(cid, CHART_BEGIN, 0);
     }
   else if(action == "end")
     {
      ChartNavigate(cid, CHART_END, 0);
      // Re-apply autoscroll=false — CHART_END,0 re-enables it in MT5
      ChartSetInteger(cid, CHART_AUTOSCROLL, false);
     }
   else if(action == "zoom_in")
     {
      int newScale = MathMin(scaleBefore + 1, 5);
      ChartSetInteger(cid, CHART_SCALE, newScale);
     }
   else if(action == "zoom_out")
     {
      int newScale = MathMax(scaleBefore - 1, 0);
      ChartSetInteger(cid, CHART_SCALE, newScale);
     }
   else if(action == "set_zoom")
     {
      int clamped = MathMin(MathMax(zoom, 0), 5);
      ChartSetInteger(cid, CHART_SCALE, clamped);
     }
   else
     {
      SendError(id, "navigate_chart: unknown action '" + action +
                "'. Use forward|backward|begin|end|zoom_in|zoom_out|set_zoom");
      return;
     }

   ChartRedraw(cid);

   // Collect post-navigation state
   string   sym     = ChartSymbol(cid);
   ENUM_TIMEFRAMES tf = (ENUM_TIMEFRAMES)ChartPeriod(cid);
   long  firstAfter  = ChartGetInteger(cid, CHART_FIRST_VISIBLE_BAR, 0);
   int   visibleBars = (int)ChartGetInteger(cid, CHART_VISIBLE_BARS, 0);
   int   scaleAfter  = (int)ChartGetInteger(cid, CHART_SCALE, 0);

   // Convert the first-visible-bar index to a datetime
   // firstAfter = bar shift from the newest bar (0 = newest)
   datetime dtFirst = 0;
   datetime dtLast  = 0;
   if(firstAfter >= 0)
     {
      datetime arr[];
      if(CopyTime(sym, tf, (int)firstAfter, 1, arr) > 0) dtFirst = arr[0];
      int lastIdx = MathMax((int)firstAfter - visibleBars + 1, 0);
      if(CopyTime(sym, tf, lastIdx, 1, arr) > 0) dtLast = arr[0];
     }

   CJAVal d;
   d["action"]            = action;
   d["bars_moved"]        = bars;
   d["chart_id"]          = cid;
   d["symbol"]            = sym;
   d["timeframe"]         = TFToString(tf);
   d["zoom_scale"]        = scaleAfter;   // 0 (most zoomed out) … 5 (most zoomed in)
   d["visible_bars"]      = visibleBars;
   d["first_visible_time"]= TimeToString(dtFirst);
   d["last_visible_time"] = TimeToString(dtLast);
   SendOk(id, d);
  }

// TAKE SCREENSHOT ─────────────────────────────────────────────────
// Captures the chart as a PNG, reads the file, base64-encodes it,
// and sends the encoded data in the JSON response.
void CmdTakeScreenshot(int id, CJAVal &p)
  {
   long   cid    = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   int    width  = (int)p["width"].ToInt();  if(width  <= 0) width  = 1280;
   int    height = (int)p["height"].ToInt(); if(height <= 0) height = 720;

   // ChartScreenShot saves to the terminal's MQL5\Files\ folder
   string fname = "mcp_shot_" + IntegerToString((int)TimeCurrent()) + ".png";

   if(!ChartScreenShot(cid, fname, width, height, ALIGN_LEFT))
     {
      SendError(id, "ChartScreenShot failed: " + IntegerToString(GetLastError()));
      return;
     }

   // Open and read the file
   int fh = FileOpen(fname, FILE_READ | FILE_BIN | FILE_COMMON);
   if(fh == INVALID_HANDLE)
     {
      // Try without FILE_COMMON (saves in data folder root)
      fh = FileOpen(fname, FILE_READ | FILE_BIN);
      if(fh == INVALID_HANDLE)
        {
         SendError(id, "Cannot open screenshot file: " + IntegerToString(GetLastError()));
         return;
        }
     }

   ulong  fsize = FileSize(fh);
   uchar  raw[];
   ArrayResize(raw, (int)fsize);
   FileReadArray(fh, raw, 0, (int)fsize);
   FileClose(fh);
   FileDelete(fname);           // clean up
   FileDelete(fname, FILE_COMMON);

   // Base64-encode (CryptEncode adds CRLF every 76 chars — strip them)
   uchar  encoded[];
   uchar  dummy[];
   if(CryptEncode(CRYPT_BASE64, raw, dummy, encoded) <= 0)
     {
      SendError(id, "Base64 encode failed: " + IntegerToString(GetLastError()));
      return;
     }
   string b64 = CharArrayToString(encoded);
   StringReplace(b64, "\r\n", "");
   StringReplace(b64, "\n",   "");
   StringReplace(b64, "\r",   "");

   CJAVal d;
   d["image_base64"] = b64;
   d["mime_type"]    = "image/png";
   d["width"]        = width;
   d["height"]       = height;
   d["symbol"]       = ChartSymbol(cid);
   d["timeframe"]    = TFToString((ENUM_TIMEFRAMES)ChartPeriod(cid));
   SendOk(id, d);
  }

// ACCOUNT INFO ────────────────────────────────────────────────────
void CmdAccountInfo(int id)
  {
   CJAVal d;
   d["balance"]      = AccountInfoDouble(ACCOUNT_BALANCE);
   d["equity"]       = AccountInfoDouble(ACCOUNT_EQUITY);
   d["margin"]       = AccountInfoDouble(ACCOUNT_MARGIN);
   d["free_margin"]  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   d["margin_level"] = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   d["profit"]       = AccountInfoDouble(ACCOUNT_PROFIT);
   d["leverage"]     = (int)AccountInfoInteger(ACCOUNT_LEVERAGE);
   d["currency"]     = AccountInfoString(ACCOUNT_CURRENCY);
   d["broker"]       = AccountInfoString(ACCOUNT_COMPANY);
   d["login"]        = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   d["trade_mode"]   = (int)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   SendOk(id, d);
  }

// SYMBOL INFO ─────────────────────────────────────────────────────
void CmdSymbolInfo(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr();
   CJAVal d;
   d["symbol"]          = sym;
   d["digits"]          = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   d["spread"]          = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   d["point"]           = SymbolInfoDouble(sym, SYMBOL_POINT);
   d["tick_size"]       = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   d["contract_size"]   = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   d["min_lot"]         = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   d["max_lot"]         = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   d["lot_step"]        = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   d["swap_long"]       = SymbolInfoDouble(sym, SYMBOL_SWAP_LONG);
   d["swap_short"]      = SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT);
   d["currency_base"]   = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE);
   d["currency_profit"] = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   SendOk(id, d);
  }

// OPEN POSITIONS ──────────────────────────────────────────────────
void CmdOpenPositions(int id, CJAVal &p)
  {
   string symFilter = p["symbol"].ToStr();
   CJAVal list;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket)) continue;
      string s = PositionGetString(POSITION_SYMBOL);
      if(StringLen(symFilter) > 0 && s != symFilter) continue;
      CJAVal pos;
      pos["ticket"]     = (long)ticket;
      pos["symbol"]     = s;
      pos["type"]       = PositionGetInteger(POSITION_TYPE)==0?"BUY":"SELL";
      pos["volume"]     = PositionGetDouble(POSITION_VOLUME);
      pos["open_price"] = PositionGetDouble(POSITION_PRICE_OPEN);
      pos["sl"]         = PositionGetDouble(POSITION_SL);
      pos["tp"]         = PositionGetDouble(POSITION_TP);
      pos["profit"]     = PositionGetDouble(POSITION_PROFIT);
      pos["open_time"]  = TimeToString((datetime)PositionGetInteger(POSITION_TIME));
      list.Add(pos);
     }
   CJAVal d; d["positions"] = list; d["count"] = list.Size();
   SendOk(id, d);
  }

// ORDER HISTORY ───────────────────────────────────────────────────
void CmdOrderHistory(int id, CJAVal &p)
  {
   datetime dtFrom  = StringToTime(p["from_date"].ToStr());
   datetime dtTo    = StringLen(p["to_date"].ToStr())>0
                      ? StringToTime(p["to_date"].ToStr()) : TimeCurrent();
   string symFilter = p["symbol"].ToStr();
   HistorySelect(dtFrom, dtTo);
   CJAVal list;
   for(int i = 0; i < HistoryDealsTotal(); i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      string s = HistoryDealGetString(ticket, DEAL_SYMBOL);
      if(StringLen(symFilter)>0 && s!=symFilter) continue;
      CJAVal deal;
      deal["ticket"] = (long)ticket;
      deal["symbol"] = s;
      deal["type"]   = HistoryDealGetInteger(ticket,DEAL_TYPE)==DEAL_TYPE_BUY?"BUY":"SELL";
      deal["volume"] = HistoryDealGetDouble(ticket,DEAL_VOLUME);
      deal["price"]  = HistoryDealGetDouble(ticket,DEAL_PRICE);
      deal["profit"] = HistoryDealGetDouble(ticket,DEAL_PROFIT);
      deal["time"]   = TimeToString((datetime)HistoryDealGetInteger(ticket,DEAL_TIME));
      list.Add(deal);
     }
   CJAVal d; d["deals"] = list; d["count"] = list.Size();
   SendOk(id, d);
  }

//+------------------------------------------------------------------+
//| UTILITY FUNCTIONS                                                 |
//+------------------------------------------------------------------+

ENUM_TIMEFRAMES StringToTF(string s)
  {
   if(s=="M1")  return PERIOD_M1;
   if(s=="M5")  return PERIOD_M5;
   if(s=="M15") return PERIOD_M15;
   if(s=="M30") return PERIOD_M30;
   if(s=="H1")  return PERIOD_H1;
   if(s=="H4")  return PERIOD_H4;
   if(s=="D1")  return PERIOD_D1;
   if(s=="W1")  return PERIOD_W1;
   if(s=="MN1") return PERIOD_MN1;
   return PERIOD_H1;
  }

string TFToString(ENUM_TIMEFRAMES tf)
  {
   switch(tf)
     {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      case PERIOD_D1:  return "D1";
      case PERIOD_W1:  return "W1";
      case PERIOD_MN1: return "MN1";
      default:         return "H1";
     }
  }

ENUM_OBJECT StringToObjType(string s)
  {
   if(s=="HLINE")           return OBJ_HLINE;
   if(s=="VLINE")           return OBJ_VLINE;
   if(s=="TRENDLINE")       return OBJ_TREND;
   if(s=="RAY")             return OBJ_TRENDBYANGLE;
   if(s=="CHANNEL")         return OBJ_CHANNEL;
   if(s=="REGRESSION")      return OBJ_REGRESSION;
   if(s=="STDDEVCHANNEL")   return OBJ_STDDEVCHANNEL;
   if(s=="RECTANGLE")       return OBJ_RECTANGLE;
   if(s=="TRIANGLE")        return OBJ_TRIANGLE;
   if(s=="ELLIPSE")         return OBJ_ELLIPSE;
   if(s=="FIBO")            return OBJ_FIBO;
   if(s=="FIBOARC")         return OBJ_FIBOARC;
   if(s=="FIBOFAN")         return OBJ_FIBOFAN;
   if(s=="FIBOCHANNEL")     return OBJ_FIBOCHANNEL;
   if(s=="FIBOTIMEZONES")   return OBJ_FIBOTIMES;
   if(s=="FIBOEXPANSION")   return OBJ_EXPANSION;
   if(s=="GANNLINE")        return OBJ_GANNLINE;
   if(s=="GANNGRID")        return OBJ_GANNGRID;
   if(s=="GANNFAN")         return OBJ_GANNFAN;
   if(s=="TEXT")            return OBJ_TEXT;
   if(s=="LABEL")           return OBJ_LABEL;
   if(s=="ARROW")           return OBJ_ARROW;
   if(s=="ARROW_BUY")       return OBJ_ARROW_BUY;
   if(s=="ARROW_SELL")      return OBJ_ARROW_SELL;
   if(s=="ARROW_CHECK")     return OBJ_ARROW_CHECK;
   if(s=="ELLIOTWAVE3")     return OBJ_ELLIOTWAVE3;
   if(s=="ELLIOTWAVE5")     return OBJ_ELLIOTWAVE5;
   if(s=="BUTTON")          return OBJ_BUTTON;
   if(s=="BITMAP")          return OBJ_BITMAP;
   if(s=="RECTANGLE_LABEL") return OBJ_RECTANGLE_LABEL;
   return (ENUM_OBJECT)WRONG_VALUE;
  }

ENUM_LINE_STYLE StringToLineStyle(string s)
  {
   if(s=="DASH")       return STYLE_DASH;
   if(s=="DOT")        return STYLE_DOT;
   if(s=="DASHDOT")    return STYLE_DASHDOT;
   if(s=="DASHDOTDOT") return STYLE_DASHDOTDOT;
   return STYLE_SOLID;
  }

// Named ColorFromString to avoid shadowing the built-in StringToColor()
color ColorFromString(string s)
  {
   if(s=="Red")       return clrRed;
   if(s=="Blue")      return clrBlue;
   if(s=="Green")     return clrGreen;
   if(s=="LimeGreen") return clrLimeGreen;
   if(s=="Crimson")   return clrCrimson;
   if(s=="Gold")      return clrGold;
   if(s=="Orange")    return clrOrange;
   if(s=="White")     return clrWhite;
   if(s=="Black")     return clrBlack;
   if(s=="Yellow")    return clrYellow;
   if(s=="Aqua")      return clrAqua;
   if(s=="Magenta")   return clrMagenta;
   if(s=="Purple")    return clrPurple;
   if(s=="Coral")     return clrCoral;
   if(s=="Lime")      return clrLime;
   if(s=="Navy")      return clrNavy;
   if(s=="Teal")      return clrTeal;
   if(s=="Silver")    return clrSilver;
   if(s=="Gray" || s=="Grey") return clrGray;
   // Try the built-in for any other named colour
   color c = StringToColor(s);
   if(c != CLR_NONE) return c;
   return clrDodgerBlue; // fallback
  }
//+------------------------------------------------------------------+
