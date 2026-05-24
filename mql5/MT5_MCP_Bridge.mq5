//+------------------------------------------------------------------+
//|  MT5_MCP_Bridge.mq5                                              |
//|  Listens on TCP 127.0.0.1:6789, processes JSON commands          |
//|  from the Node.js MCP server and returns JSON responses.         |
//|                                                                  |
//|  Version: 1.0.0                                                  |
//|  Place in: MQL5/Experts/MT5_MCP/MT5_MCP_Bridge.mq5              |
//+------------------------------------------------------------------+
#property copyright "MT5 MCP Bridge"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <JAson.mqh>          // MQL5 JSON library (see install notes)

input int    InpPort       = 6789;          // TCP port to listen on
input string InpHost       = "127.0.0.1";  // Bind address
input int    InpMaxClients = 1;            // Max simultaneous connections
input bool   InpDebugLog   = true;         // Verbose logging

//--- globals
int      g_server   = INVALID_HANDLE;
int      g_client   = INVALID_HANDLE;
bool     g_running  = false;
string   g_version  = "1.0.0";

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   Print("MT5_MCP_Bridge v", g_version, " initialising on port ", InpPort);

   g_server = SocketCreate();
   if(g_server == INVALID_HANDLE)
     {
      Print("ERROR: SocketCreate failed – ", GetLastError());
      return INIT_FAILED;
     }

   if(!SocketBind(g_server, InpHost, InpPort))
     {
      Print("ERROR: SocketBind failed – ", GetLastError());
      SocketClose(g_server);
      return INIT_FAILED;
     }

   if(!SocketListen(g_server, InpMaxClients))
     {
      Print("ERROR: SocketListen failed – ", GetLastError());
      SocketClose(g_server);
      return INIT_FAILED;
     }

   g_running = true;
   EventSetMillisecondTimer(50); // poll every 50 ms
   Print("MT5_MCP_Bridge listening on ", InpHost, ":", InpPort);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   g_running = false;
   EventKillTimer();
   if(g_client != INVALID_HANDLE) SocketClose(g_client);
   if(g_server != INVALID_HANDLE) SocketClose(g_server);
   Print("MT5_MCP_Bridge stopped.");
  }

//+------------------------------------------------------------------+
//| Timer — accept connections & read data                           |
//+------------------------------------------------------------------+
void OnTimer()
  {
   if(!g_running) return;

   // Accept new client if none connected
   if(g_client == INVALID_HANDLE)
     {
      g_client = SocketAccept(g_server);
      if(g_client != INVALID_HANDLE)
         Print("MCP client connected.");
     }

   if(g_client == INVALID_HANDLE) return;

   // Read available bytes
   uint avail = SocketIsReadable(g_client);
   if(avail == 0) return;

   uchar buf[];
   ArrayResize(buf, avail);
   int read = SocketRead(g_client, buf, avail, 0);
   if(read <= 0)
     {
      SocketClose(g_client);
      g_client = INVALID_HANDLE;
      Print("MCP client disconnected.");
      return;
     }

   string raw = CharArrayToString(buf, 0, read, CP_UTF8);
   // Split on newlines (protocol is newline-delimited JSON)
   string lines[];
   int n = StringSplit(raw, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      StringTrimLeft(lines[i]);
      StringTrimRight(lines[i]);
      if(StringLen(lines[i]) == 0) continue;
      ProcessMessage(lines[i]);
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

   // ── Dispatch ────────────────────────────────────────────────────
   if(cmd == "status")            CmdStatus(msgId);
   else if(cmd == "get_candles")  CmdGetCandles(msgId, params);
   else if(cmd == "get_tick")     CmdGetTick(msgId, params);
   else if(cmd == "get_chart_info") CmdGetChartInfo(msgId, params);
   else if(cmd == "list_symbols") CmdListSymbols(msgId, params);
   else if(cmd == "add_object")   CmdAddObject(msgId, params);
   else if(cmd == "modify_object") CmdModifyObject(msgId, params);
   else if(cmd == "delete_object") CmdDeleteObject(msgId, params);
   else if(cmd == "list_objects") CmdListObjects(msgId, params);
   else if(cmd == "clear_objects") CmdClearObjects(msgId, params);
   else if(cmd == "add_indicator") CmdAddIndicator(msgId, params);
   else if(cmd == "get_indicator_values") CmdGetIndicatorValues(msgId, params);
   else if(cmd == "remove_indicator") CmdRemoveIndicator(msgId, params);
   else if(cmd == "list_indicators") CmdListIndicators(msgId, params);
   else if(cmd == "backtest_strategy") CmdBacktestStrategy(msgId, params);
   else if(cmd == "backtest_indicator_cross") CmdBacktestIndicatorCross(msgId, params);
   else if(cmd == "scroll_chart") CmdScrollChart(msgId, params);
   else if(cmd == "account_info") CmdAccountInfo(msgId);
   else if(cmd == "symbol_info")  CmdSymbolInfo(msgId, params);
   else if(cmd == "open_positions") CmdOpenPositions(msgId, params);
   else if(cmd == "order_history") CmdOrderHistory(msgId, params);
   else SendError(msgId, "Unknown command: " + cmd);
  }

//+------------------------------------------------------------------+
//| Send helpers                                                     |
//+------------------------------------------------------------------+
void SendOk(int id, CJAVal &data)
  {
   CJAVal resp;
   resp["id"]  = id;
   resp["ok"]  = true;
   resp["data"] = data;
   string out = resp.Serialize() + "\n";
   if(InpDebugLog) PrintFormat("[TX] %s", out);
   uchar bytes[];
   StringToCharArray(out, bytes, 0, StringLen(out), CP_UTF8);
   SocketSend(g_client, bytes, ArraySize(bytes) - 1);
  }

void SendError(int id, string msg)
  {
   CJAVal resp;
   resp["id"]    = id;
   resp["ok"]    = false;
   resp["error"] = msg;
   string out = resp.Serialize() + "\n";
   uchar bytes[];
   StringToCharArray(out, bytes, 0, StringLen(out), CP_UTF8);
   if(g_client != INVALID_HANDLE)
      SocketSend(g_client, bytes, ArraySize(bytes) - 1);
   Print("ERROR sent: ", msg);
  }

//+------------------------------------------------------------------+
//| ── COMMAND IMPLEMENTATIONS ────────────────────────────────────── |
//+------------------------------------------------------------------+

// STATUS ──────────────────────────────────────────────────────────
void CmdStatus(int id)
  {
   CJAVal d;
   d["version"]  = g_version;
   d["terminal"] = TerminalInfoString(TERMINAL_NAME);
   d["company"]  = AccountInfoString(ACCOUNT_COMPANY);
   d["server"]   = AccountInfoString(ACCOUNT_SERVER);
   d["login"]    = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   d["currency"] = AccountInfoString(ACCOUNT_CURRENCY);
   d["ping_ms"]  = (int)TerminalInfoInteger(TERMINAL_PING_LAST);
   d["trade_allowed"] = (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   SendOk(id, d);
  }

// GET CANDLES ─────────────────────────────────────────────────────
void CmdGetCandles(int id, CJAVal &p)
  {
   string sym       = p["symbol"].ToStr();
   string tfStr     = p["timeframe"].ToStr();
   int    count     = p["count"].ToInt();
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

   CJAVal candles;
   for(int i = 0; i < copied; i++)
     {
      CJAVal bar;
      bar["t"]  = TimeToString(rates[i].time);
      bar["o"]  = rates[i].open;
      bar["h"]  = rates[i].high;
      bar["l"]  = rates[i].low;
      bar["c"]  = rates[i].close;
      bar["v"]  = (long)rates[i].tick_volume;
      candles.Add(bar);
     }
   d["candles"] = candles;
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

   CJAVal d;
   d["chart_id"]  = cid;
   d["symbol"]    = ChartSymbol(cid);
   d["timeframe"] = TFToString((ENUM_TIMEFRAMES)ChartPeriod(cid));
   d["first_bar_time"] = TimeToString((datetime)ChartGetInteger(cid, CHART_FIRST_VISIBLE_BAR));
   d["bars_total"]     = (int)ChartGetInteger(cid, CHART_BARS_PER_CHART);
   d["visible_bars"]   = (int)ChartGetInteger(cid, CHART_VISIBLE_BARS);
   SendOk(id, d);
  }

// LIST SYMBOLS ────────────────────────────────────────────────────
void CmdListSymbols(int id, CJAVal &p)
  {
   string grp = p["group"].ToStr();
   int total = SymbolsTotal(false);
   CJAVal syms;
   for(int i = 0; i < total; i++)
     {
      string s = SymbolName(i, false);
      if(StringLen(grp) > 0 && StringFind(s, StringSubstr(grp, 1, StringLen(grp)-2)) < 0)
         continue; // simple glob filter
      syms.Add(s);
     }
   CJAVal d;
   d["symbols"] = syms;
   d["count"]   = syms.Size();
   SendOk(id, d);
  }

// ADD OBJECT ──────────────────────────────────────────────────────
void CmdAddObject(int id, CJAVal &p)
  {
   long   cid      = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   int    subwin   = p["subwindow"].ToInt();
   string name     = p["name"].ToStr();
   string typeStr  = p["type"].ToStr();
   ENUM_OBJECT otype = StringToObjType(typeStr);

   datetime t1 = StringToTime(p["time1"].ToStr());
   double   p1 = p["price1"].ToDbl();
   datetime t2 = StringLen(p["time2"].ToStr()) > 0 ? StringToTime(p["time2"].ToStr()) : 0;
   double   p2 = p["price2"].ToDbl();
   datetime t3 = StringLen(p["time3"].ToStr()) > 0 ? StringToTime(p["time3"].ToStr()) : 0;
   double   p3 = p["price3"].ToDbl();

   if(!ObjectCreate(cid, name, otype, subwin, t1, p1, t2, p2, t3, p3))
     { SendError(id, "ObjectCreate failed: " + IntegerToString(GetLastError())); return; }

   // Apply optional properties
   if(StringLen(p["color"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_COLOR, StringToColor(p["color"].ToStr()));
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

   ChartRedraw(cid);
   CJAVal d; d["name"] = name; d["type"] = typeStr;
   SendOk(id, d);
  }

// MODIFY OBJECT ───────────────────────────────────────────────────
void CmdModifyObject(int id, CJAVal &p)
  {
   long   cid  = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string name = p["name"].ToStr();

   if(ObjectFind(cid, name) < 0)
     { SendError(id, "Object not found: " + name); return; }

   CJAVal props = p["properties"];
   // iterate known modifiable props
   if(StringLen(props["color"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_COLOR, StringToColor(props["color"].ToStr()));
   if(props["width"].ToInt() > 0)
      ObjectSetInteger(cid, name, OBJPROP_WIDTH, props["width"].ToInt());
   if(StringLen(props["description"].ToStr()) > 0)
      ObjectSetString(cid, name, OBJPROP_TEXT, props["description"].ToStr());
   if(StringLen(props["time1"].ToStr()) > 0)
      ObjectSetInteger(cid, name, OBJPROP_TIME, StringToTime(props["time1"].ToStr()));
   if(props["price1"].ToDbl() != 0)
      ObjectSetDouble(cid, name, OBJPROP_PRICE, props["price1"].ToDbl());

   ChartRedraw(cid);
   CJAVal d; d["name"] = name; d["modified"] = true;
   SendOk(id, d);
  }

// DELETE OBJECT ───────────────────────────────────────────────────
void CmdDeleteObject(int id, CJAVal &p)
  {
   long   cid  = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string name = p["name"].ToStr();
   bool   ok   = ObjectDelete(cid, name);
   ChartRedraw(cid);
   CJAVal d; d["deleted"] = ok;
   SendOk(id, d);
  }

// LIST OBJECTS ────────────────────────────────────────────────────
void CmdListObjects(int id, CJAVal &p)
  {
   long cid = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string typeFilter = p["type_filter"].ToStr();
   int total = ObjectsTotal(cid, -1, -1);
   CJAVal objs;
   for(int i = 0; i < total; i++)
     {
      string n = ObjectName(cid, i, -1, -1);
      CJAVal o;
      o["name"] = n;
      ENUM_OBJECT ot = (ENUM_OBJECT)ObjectGetInteger(cid, n, OBJPROP_TYPE);
      o["type"] = EnumToString(ot);
      if(StringLen(typeFilter) > 0 && StringFind(o["type"].ToStr(), typeFilter) < 0) continue;
      objs.Add(o);
     }
   CJAVal d; d["objects"] = objs; d["count"] = objs.Size();
   SendOk(id, d);
  }

// CLEAR OBJECTS ───────────────────────────────────────────────────
void CmdClearObjects(int id, CJAVal &p)
  {
   long   cid    = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   string prefix = p["prefix"].ToStr();
   int deleted = 0;
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

// We keep a simple handle registry
int    g_iHandles[];
string g_iNames[];
int    g_iCount = 0;

void CmdAddIndicator(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr(); if(sym == "") sym = Symbol();
   string tfS = p["timeframe"].ToStr();
   ENUM_TIMEFRAMES tf = StringLen(tfS) > 0 ? StringToTF(tfS) : Period();
   string name = p["indicator"].ToStr();

   // Read params array
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
      // Try as custom indicator path
      handle = iCustom(sym, tf, name, d0, d1, d2, d3, d4);

   if(handle == INVALID_HANDLE)
     { SendError(id, "Indicator creation failed: " + IntegerToString(GetLastError())); return; }

   // Store handle
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
   CJAVal arr;
   for(int i = 0; i < ArraySize(vals); i++) arr.Add(vals[i]);
   d["values"] = arr;
   SendOk(id, d);
  }

void CmdRemoveIndicator(int id, CJAVal &p)
  {
   int handle = (int)p["handle"].ToInt();
   IndicatorRelease(handle);
   // Remove from registry
   for(int i = 0; i < g_iCount; i++)
      if(g_iHandles[i] == handle) { g_iHandles[i] = INVALID_HANDLE; break; }
   CJAVal d; d["released"] = handle;
   SendOk(id, d);
  }

void CmdListIndicators(int id, CJAVal &p)
  {
   CJAVal list;
   for(int i = 0; i < g_iCount; i++)
      if(g_iHandles[i] != INVALID_HANDLE)
        {
         CJAVal entry;
         entry["handle"] = g_iHandles[i];
         entry["name"]   = g_iNames[i];
         list.Add(entry);
        }
   CJAVal d; d["indicators"] = list;
   SendOk(id, d);
  }

//+------------------------------------------------------------------+
//| BACKTESTING                                                       |
//+------------------------------------------------------------------+
void CmdBacktestStrategy(int id, CJAVal &p)
  {
   // Full generic strategy backtester — simplified MA-cross + RSI logic
   // for demonstration.  Claude passes strategy JSON; the EA interprets it.
   string sym    = p["symbol"].ToStr();
   string tfS    = p["timeframe"].ToStr();
   ENUM_TIMEFRAMES tf = StringToTF(tfS);
   datetime dtFrom = StringToTime(p["from_date"].ToStr());
   datetime dtTo   = StringLen(p["to_date"].ToStr()) > 0
                     ? StringToTime(p["to_date"].ToStr()) : TimeCurrent();
   bool drawChart = p["draw_on_chart"].ToBool();
   bool clearPrev = p["clear_previous"].ToBool();
   string prefix  = p["prefix"].ToStr(); if(prefix == "") prefix = "BT_";
   long cid       = ChartID();

   if(clearPrev) ObjectsDeleteAll(cid, prefix);

   // Load OHLCV
   MqlRates rates[];
   int copied = CopyRates(sym, tf, dtFrom, dtTo, rates);
   if(copied <= 0) { SendError(id, "No data for range"); return; }

   // Parse strategy rules (basic: we support MA cross + RSI filter)
   CJAVal strat = p["strategy"];
   int    fastP  = strat["fast_ma"].ToInt();  if(fastP  <= 0) fastP  = 10;
   int    slowP  = strat["slow_ma"].ToInt();  if(slowP  <= 0) slowP  = 30;
   int    rsiP   = strat["rsi_period"].ToInt();if(rsiP  <= 0) rsiP   = 14;
   double rsiOB  = strat["rsi_ob"].ToDbl();   if(rsiOB  == 0) rsiOB  = 70;
   double rsiOS  = strat["rsi_os"].ToDbl();   if(rsiOS  == 0) rsiOS  = 30;
   double slPips = strat["sl_pips"].ToDbl();  if(slPips == 0) slPips = 30;
   double tpPips = strat["tp_pips"].ToDbl();  if(tpPips == 0) tpPips = 60;

   double pip = SymbolInfoDouble(sym, SYMBOL_POINT) * 10;

   // Compute simple indicators on loaded rates
   double fastMA[], slowMA[], rsiVal[];
   ArrayResize(fastMA, copied); ArrayResize(slowMA, copied); ArrayResize(rsiVal, copied);
   ArrayInitialize(fastMA, 0); ArrayInitialize(slowMA, 0); ArrayInitialize(rsiVal, 50);

   // SMA
   for(int i = slowP; i < copied; i++)
     {
      double sf=0, ss=0;
      for(int j=0;j<fastP;j++) sf+=rates[i-j].close;
      for(int j=0;j<slowP;j++) ss+=rates[i-j].close;
      fastMA[i]=sf/fastP; slowMA[i]=ss/slowP;
     }
   // RSI (Wilder)
   for(int i = rsiP+1; i < copied; i++)
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

   // Simulate trades
   CJAVal trades;
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
         bool longSig  = fastMA[i]>slowMA[i] && fastMA[i-1]<=slowMA[i-1] && rsiVal[i]<rsiOB;
         bool shortSig = fastMA[i]<slowMA[i] && fastMA[i-1]>=slowMA[i-1] && rsiVal[i]>rsiOS;

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
            double exitP  = hitTP ? tp : sl;
            double pipRes = (tradeType=="BUY") ? (exitP-entryPrice)/pip : (entryPrice-exitP)/pip;
            bool   win    = pipRes > 0;
            netPips += pipRes;
            equity  += pipRes * 10; // $10/pip
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
            trades.Add(t);

            if(drawChart)
              {
               string boxName = prefix + "BOX_" + IntegerToString(objIdx++);
               ObjectCreate(cid, boxName, OBJ_RECTANGLE, 0,
                            entryTime, entryPrice, rates[i].time, exitP);
               ObjectSetInteger(cid, boxName, OBJPROP_COLOR, win ? clrLimeGreen : clrCrimson);
               ObjectSetInteger(cid, boxName, OBJPROP_FILL, true);
               ObjectSetInteger(cid, boxName, OBJPROP_BACK, true);
               int alpha = 30; // transparency placeholder
              }

            inTrade = false;
           }
        }
     }

   ChartRedraw(cid);

   double pf = 0;
   // profit factor approximation
   if(totalTrades > 0)
     {
      double grossWin=0, grossLoss=0;
      // would need per-trade tracking; approximate:
      pf = (wins > 0 && (totalTrades-wins) > 0)
           ? (double)wins * tpPips / ((totalTrades-wins) * slPips) : 0;
     }

   CJAVal d;
   d["trades"] = trades;
   CJAVal summary;
   summary["total_trades"]  = totalTrades;
   summary["wins"]          = wins;
   summary["losses"]        = totalTrades - wins;
   summary["win_rate_pct"]  = totalTrades>0 ? NormalizeDouble((double)wins/totalTrades*100,1) : 0;
   summary["net_pips"]      = NormalizeDouble(netPips, 1);
   summary["profit_factor"] = NormalizeDouble(pf, 2);
   summary["max_drawdown_pct"] = NormalizeDouble(maxDD, 2);
   summary["bars_tested"]   = copied;
   d["summary"] = summary;
   SendOk(id, d);
  }

void CmdBacktestIndicatorCross(int id, CJAVal &p)
  {
   // Delegate to generic backtest with pre-filled strategy
   CJAVal strategy;
   strategy["fast_ma"]    = p["fast_period"].ToInt();
   strategy["slow_ma"]    = p["slow_period"].ToInt();
   strategy["sl_pips"]    = p["sl_pips"].ToDbl();
   strategy["tp_pips"]    = p["tp_pips"].ToDbl();
   strategy["rsi_period"] = 0; // disable RSI filter

   CJAVal np;
   np["symbol"]         = p["symbol"].ToStr();
   np["timeframe"]      = p["timeframe"].ToStr();
   np["from_date"]      = p["from_date"].ToStr();
   np["to_date"]        = p["to_date"].ToStr();
   np["strategy"]       = strategy;
   np["draw_on_chart"]  = p["draw_on_chart"].ToBool();
   np["clear_previous"] = true;
   np["prefix"]         = "MA_BT_";

   CmdBacktestStrategy(id, np);
  }

void CmdScrollChart(int id, CJAVal &p)
  {
   long     cid  = p["chart_id"].ToInt(); if(cid == 0) cid = ChartID();
   datetime dt   = StringToTime(p["datetime"].ToStr());
   int      shift = (int)p["bars_shift"].ToInt();
   ChartNavigate(cid, CHART_POINT_TO_BAR, iBarShift(ChartSymbol(cid), ChartPeriod(cid), dt) + shift);
   ChartRedraw(cid);
   CJAVal d; d["scrolled_to"] = TimeToString(dt);
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
   d["trade_mode"]   = (int)AccountInfoInteger(ACCOUNT_TRADE_MODE); // 0=real,1=demo,2=contest
   SendOk(id, d);
  }

// SYMBOL INFO ─────────────────────────────────────────────────────
void CmdSymbolInfo(int id, CJAVal &p)
  {
   string sym = p["symbol"].ToStr();
   CJAVal d;
   d["symbol"]       = sym;
   d["digits"]       = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   d["spread"]       = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   d["point"]        = SymbolInfoDouble(sym, SYMBOL_POINT);
   d["tick_size"]    = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   d["contract_size"]= SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   d["min_lot"]      = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   d["max_lot"]      = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   d["lot_step"]     = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   d["swap_long"]    = SymbolInfoDouble(sym, SYMBOL_SWAP_LONG);
   d["swap_short"]   = SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT);
   d["currency_base"]  = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE);
   d["currency_profit"]= SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
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
   datetime dtFrom = StringToTime(p["from_date"].ToStr());
   datetime dtTo   = StringLen(p["to_date"].ToStr())>0
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
      deal["ticket"]  = (long)ticket;
      deal["symbol"]  = s;
      deal["type"]    = HistoryDealGetInteger(ticket,DEAL_TYPE)==DEAL_TYPE_BUY?"BUY":"SELL";
      deal["volume"]  = HistoryDealGetDouble(ticket,DEAL_VOLUME);
      deal["price"]   = HistoryDealGetDouble(ticket,DEAL_PRICE);
      deal["profit"]  = HistoryDealGetDouble(ticket,DEAL_PROFIT);
      deal["time"]    = TimeToString((datetime)HistoryDealGetInteger(ticket,DEAL_TIME));
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
      default: return "H1";
     }
  }

ENUM_OBJECT StringToObjType(string s)
  {
   if(s=="HLINE")          return OBJ_HLINE;
   if(s=="VLINE")          return OBJ_VLINE;
   if(s=="TRENDLINE")      return OBJ_TREND;
   if(s=="RAY")            return OBJ_TRENDBYANGLE;
   if(s=="CHANNEL")        return OBJ_CHANNEL;
   if(s=="REGRESSION")     return OBJ_REGRESSION;
   if(s=="STDDEVCHANNEL")  return OBJ_STDDEVCHANNEL;
   if(s=="RECTANGLE")      return OBJ_RECTANGLE;
   if(s=="TRIANGLE")       return OBJ_TRIANGLE;
   if(s=="ELLIPSE")        return OBJ_ELLIPSE;
   if(s=="FIBO")           return OBJ_FIBO;
   if(s=="FIBOARC")        return OBJ_FIBOARC;
   if(s=="FIBOFAN")        return OBJ_FIBOFAN;
   if(s=="FIBOCHANNEL")    return OBJ_FIBOCHANNEL;
   if(s=="FIBOTIMEZONES")  return OBJ_FIBOTIMES;
   if(s=="FIBOEXPANSION")  return OBJ_EXPANSION;
   if(s=="GANNLINE")       return OBJ_GANNLINE;
   if(s=="GANNGRID")       return OBJ_GANNGRID;
   if(s=="GANNFAN")        return OBJ_GANNFAN;
   if(s=="TEXT")           return OBJ_TEXT;
   if(s=="LABEL")          return OBJ_LABEL;
   if(s=="ARROW")          return OBJ_ARROW;
   if(s=="ARROW_BUY")      return OBJ_ARROW_BUY;
   if(s=="ARROW_SELL")     return OBJ_ARROW_SELL;
   if(s=="ARROW_CHECK")    return OBJ_ARROW_CHECK;
   if(s=="ELLIOTWAVE3")    return OBJ_ELLIOTWAVE3;
   if(s=="ELLIOTWAVE5")    return OBJ_ELLIOTWAVE5;
   if(s=="BUTTON")         return OBJ_BUTTON;
   if(s=="BITMAP")         return OBJ_BITMAP;
   if(s=="RECTANGLE_LABEL") return OBJ_RECTANGLE_LABEL;
   return OBJ_TREND; // default
  }

ENUM_LINE_STYLE StringToLineStyle(string s)
  {
   if(s=="DASH")      return STYLE_DASH;
   if(s=="DOT")       return STYLE_DOT;
   if(s=="DASHDOT")   return STYLE_DASHDOT;
   if(s=="DASHDOTDOT") return STYLE_DASHDOTDOT;
   return STYLE_SOLID;
  }

color StringToColor(string s)
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
   if(StringLen(s)>0 && s[0]=='#')
     {
      // #RRGGBB
      uint r=0,g=0,b=0;
      StringToInteger(StringSubstr(s,1,2)); // hex not natively — use workaround
      // Full hex parse omitted for brevity; return white
      return clrWhite;
     }
   return clrDodgerBlue;
  }
