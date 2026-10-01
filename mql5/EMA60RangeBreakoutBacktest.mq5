#property strict
#property script_show_inputs
#property version "2.00"
#property description "Ten completed days of EMA60 two/three-candle range breakout review. Generated objects never replace manual chart marks."

input string          InpSymbol                  = "";             // Empty = chart symbol
input ENUM_TIMEFRAMES InpTimeframe               = PERIOD_CURRENT;
input int             InpLookbackDays            = 10;             // Completed chart days only
input int             InpTradingStartHour        = 8;
input int             InpTradingEndHour          = 23;             // Review setting; later corrected entries exist
input int             InpEmaPeriod               = 60;             // EMA of OPEN, as on the EURUSD M1 chart
input int             InpAtrPeriod               = 14;
input int             InpPivotRadius             = 5;
input int             InpMinSwingGapBars         = 8;
input int             InpMaxSwingGapBars         = 120;
input double          InpDoubleTouchToleranceATR = 0.25;
input double          InpMinRangeHeightATR       = 1.50;
input int             InpMaxRetestBars           = 90;
input double          InpKeyBarOutsidePct        = 0.51;
input double          InpMinKeyBarToRange        = 0.17;           // Calibrated preview threshold, not a fixed strategy rule
input double          InpMaxBreakoutWickPct      = 0.40;           // Pin-bar signal may qualify as an exception
input double          InpSignalEdgeTolerance    = 0.50;           // Fraction of TR height
input double          InpSmallSignalToRange     = 0.35;           // For a combined two-candle signal
input int             InpMaxReviewMarks          = 200;
input bool            InpDrawOnChart             = true;
input bool            InpDrawTradingRanges       = true;
input bool            InpDrawUnresolvedFibos     = true;
input bool            InpClearPriorAutoMarks     = true;           // Deletes only generated objects, identified by name or tooltip
input bool            InpWriteCsv                = true;
input bool            InpUseChartReferenceRanges = true;           // Corrected user boxes for calibration dates
input string          InpReferenceFirstDay       = "2026.09.29";
input string          InpReferenceLastDay        = "2026.09.30";

struct RangeSetup
{
   int first;
   int second;
   double high;
   double low;
   bool double_top;
   bool manual;
   int id;
};

struct TradeSetup
{
   int signalbar;
   int keybar;
   int entrybar;
   int range_index;
   bool is_buy;
   double entry;
   double stop;
   double outside_pct;
   string outcome;
   datetime exit_time;
   string exit_reason;
};

bool SwingHigh(const MqlRates &rates[],int i,int radius)
{
   for(int k=1;k<=radius;k++)
      if(rates[i].high<=rates[i-k].high || rates[i].high<rates[i+k].high) return false;
   return true;
}

bool SwingLow(const MqlRates &rates[],int i,int radius)
{
   for(int k=1;k<=radius;k++)
      if(rates[i].low>=rates[i-k].low || rates[i].low>rates[i+k].low) return false;
   return true;
}

void BuildIndicators(const MqlRates &rates[],int count,double &ema[],double &atr[])
{
   ArrayResize(ema,count);
   ArrayResize(atr,count);
   const double alpha=2.0/(InpEmaPeriod+1.0);
   ema[0]=rates[0].open;
   atr[0]=rates[0].high-rates[0].low;
   for(int i=1;i<count;i++)
   {
      ema[i]=alpha*rates[i].open+(1.0-alpha)*ema[i-1];
      double sum=0.0;
      int n=0;
      for(int j=MathMax(1,i-InpAtrPeriod+1);j<=i;j++)
      {
         double tr=MathMax(rates[j].high-rates[j].low,
                    MathMax(MathAbs(rates[j].high-rates[j-1].close),
                            MathAbs(rates[j].low-rates[j-1].close)));
         sum+=tr;
         n++;
      }
      atr[i]=n>0 ? sum/n : atr[0];
   }
}

void PushRange(RangeSetup &ranges[],int first,int second,double high,double low,bool is_top,bool manual=false)
{
   int n=ArraySize(ranges);
   ArrayResize(ranges,n+1);
   ranges[n].first=first;
   ranges[n].second=second;
   ranges[n].high=high;
   ranges[n].low=low;
   ranges[n].double_top=is_top;
   ranges[n].manual=manual;
   ranges[n].id=n+1;
}

void BuildRanges(const MqlRates &rates[],const double &atr[],int count,double point,RangeSetup &ranges[])
{
   int highs[],lows[];
   ArrayResize(ranges,0);
   for(int i=InpPivotRadius;i<count-InpPivotRadius;i++)
   {
      if(SwingHigh(rates,i,InpPivotRadius))
      {
         int n=ArraySize(highs);
         ArrayResize(highs,n+1);
         highs[n]=i;
      }
      if(SwingLow(rates,i,InpPivotRadius))
      {
         int n=ArraySize(lows);
         ArrayResize(lows,n+1);
         lows[n]=i;
      }
   }
   for(int h=0;h<ArraySize(highs);h++)
   {
      int first=highs[h];
      for(int q=h+1;q<ArraySize(highs);q++)
      {
         int second=highs[q],gap=second-first;
         if(gap>InpMaxSwingGapBars) break;
         if(gap<InpMinSwingGapBars) continue;
         if(MathAbs(rates[first].high-rates[second].high)>
            InpDoubleTouchToleranceATR*MathMax(atr[first],atr[second])) continue;
         double high=MathMax(rates[first].high,rates[second].high);
         double low=rates[first].low;
         for(int k=first+1;k<=second;k++) low=MathMin(low,rates[k].low);
         if(high-low>=MathMax(InpMinRangeHeightATR*MathMax(atr[first],atr[second]),point))
         {
            PushRange(ranges,first,second,high,low,true);
            h=q;
         }
         break;
      }
   }
   for(int h=0;h<ArraySize(lows);h++)
   {
      int first=lows[h];
      for(int q=h+1;q<ArraySize(lows);q++)
      {
         int second=lows[q],gap=second-first;
         if(gap>InpMaxSwingGapBars) break;
         if(gap<InpMinSwingGapBars) continue;
         if(MathAbs(rates[first].low-rates[second].low)>
            InpDoubleTouchToleranceATR*MathMax(atr[first],atr[second])) continue;
         double low=MathMin(rates[first].low,rates[second].low);
         double high=rates[first].high;
         for(int k=first+1;k<=second;k++) high=MathMax(high,rates[k].high);
         if(high-low>=MathMax(InpMinRangeHeightATR*MathMax(atr[first],atr[second]),point))
         {
            PushRange(ranges,first,second,high,low,false);
            h=q;
         }
         break;
      }
   }
   for(int i=0;i<ArraySize(ranges)-1;i++)
      for(int j=i+1;j<ArraySize(ranges);j++)
         if(ranges[j].second<ranges[i].second)
         {
            RangeSetup tmp=ranges[i];
            ranges[i]=ranges[j];
            ranges[j]=tmp;
         }
   for(int i=0;i<ArraySize(ranges);i++) ranges[i].id=i+1;
}

bool SameDate(datetime a,datetime b)
{
   return TimeToString(a,TIME_DATE)==TimeToString(b,TIME_DATE);
}

int FindBar(const MqlRates &rates[],int count,datetime time)
{
   for(int i=0;i<count;i++) if(rates[i].time==time) return i;
   return -1;
}

bool ReferenceDay(datetime time)
{
   string day=TimeToString(time,TIME_DATE);
   return day>=InpReferenceFirstDay && day<=InpReferenceLastDay;
}

void AddManualRanges(const MqlRates &rates[],int count,RangeSetup &ranges[])
{
   if(!InpUseChartReferenceRanges) return;
   for(int i=0;i<ObjectsTotal(0,0,-1);i++)
   {
      string name=ObjectName(0,i,0,-1);
      if(StringFind(name,"SR-OB_")!=0 && StringFind(name,"SROB_TR_")!=0) continue;
      if((ENUM_OBJECT)ObjectGetInteger(0,name,OBJPROP_TYPE)!=OBJ_RECTANGLE) continue;
      datetime a=(datetime)ObjectGetInteger(0,name,OBJPROP_TIME,0);
      datetime b=(datetime)ObjectGetInteger(0,name,OBJPROP_TIME,1);
      datetime start=MathMin(a,b),end=MathMax(a,b);
      if(!ReferenceDay(start) || !SameDate(start,end)) continue;
      int first=FindBar(rates,count,start),second=FindBar(rates,count,end);
      if(first<0 || second<first+InpMinSwingGapBars) continue;
      double p0=ObjectGetDouble(0,name,OBJPROP_PRICE,0);
      double p1=ObjectGetDouble(0,name,OBJPROP_PRICE,1);
      double high=MathMax(p0,p1),low=MathMin(p0,p1);
      if(high<=low) continue;
      PushRange(ranges,first,second,high,low,false,true);
   }
}

bool HasManualRangeOnDate(const RangeSetup &ranges[],const MqlRates &rates[],datetime time)
{
   for(int i=0;i<ArraySize(ranges);i++)
      if(ranges[i].manual && SameDate(rates[ranges[i].first].time,time)) return true;
   return false;
}

bool TradeHour(datetime time)
{
   MqlDateTime dt;
   TimeToStruct(time,dt);
   return dt.hour>=InpTradingStartHour && dt.hour<InpTradingEndHour;
}

bool NearEdge(const MqlRates &bar,const RangeSetup &range,bool buy)
{
   double allowance=InpSignalEdgeTolerance*(range.high-range.low);
   return buy ? bar.high>=range.high-allowance : bar.low<=range.low+allowance;
}

bool TrySetup(const MqlRates &rates[],const double &ema[],const RangeSetup &range,
              int keybar,int count,double point,int range_index,TradeSetup &trade)
{
   int entrybar=keybar+1;
   if(entrybar>=count || (!range.manual && keybar<range.second+1) || keybar<2) return false;
   if(!TradeHour(rates[entrybar].time) || !SameDate(rates[range.second].time,rates[entrybar].time)) return false;
   double height=range.high-range.low;
   double span=rates[keybar].high-rates[keybar].low;
   if(height<=point || span<=0 || span/height<InpMinKeyBarToRange) return false;

   bool buy=(range.manual || range.double_top) && rates[keybar].high>range.high &&
            rates[keybar].close>=range.high-point &&
            rates[keybar].close>ema[keybar];
   bool sell=(range.manual || !range.double_top) && rates[keybar].low<range.low &&
             rates[keybar].close<=range.low+point &&
             rates[keybar].close<ema[keybar];
   if(!buy && !sell) return false;
   if(buy && sell) return false;
   double outside=buy
      ? MathMax(0.0,rates[keybar].high-MathMax(rates[keybar].low,range.high))/span
      : MathMax(0.0,MathMin(rates[keybar].high,range.low)-rates[keybar].low)/span;
   if(outside<InpKeyBarOutsidePct) return false;

   int signal=keybar-1;
   bool combined=keybar>=2 &&
      NearEdge(rates[keybar-2],range,buy) &&
      NearEdge(rates[keybar-1],range,buy) &&
      (rates[keybar-2].high-rates[keybar-2].low)/height<=InpSmallSignalToRange &&
      (rates[keybar-1].high-rates[keybar-1].low)/height<=InpSmallSignalToRange;
   if(combined) signal=keybar-2;
   else if(!NearEdge(rates[signal],range,buy)) return false;

   double signal_span=rates[signal].high-rates[signal].low;
   double signal_wick=signal_span<=0 ? 0.0 :
      (buy ? rates[signal].high-MathMax(rates[signal].open,rates[signal].close)
           : MathMin(rates[signal].open,rates[signal].close)-rates[signal].low)/signal_span;
   double key_wick=buy
      ? (rates[keybar].high-MathMax(rates[keybar].open,rates[keybar].close))/span
      : (MathMin(rates[keybar].open,rates[keybar].close)-rates[keybar].low)/span;
   if(key_wick>InpMaxBreakoutWickPct && signal_wick<0.35) return false;

   double entry=rates[entrybar].open;
   double stop=buy ? rates[signal].low : rates[signal].high;
   if((buy && stop>=entry) || (!buy && stop<=entry)) return false;
   trade.signalbar=signal;
   trade.keybar=keybar;
   trade.entrybar=entrybar;
   trade.range_index=range_index;
   trade.is_buy=buy;
   trade.entry=entry;
   trade.stop=stop;
   trade.outside_pct=outside;
   trade.outcome="REVIEW";
   trade.exit_time=0;
   trade.exit_reason="unresolved";
   return true;
}

bool EntryAlreadyMarked(const TradeSetup &trades[],int entrybar)
{
   for(int i=0;i<ArraySize(trades);i++)
      if(trades[i].entrybar==entrybar) return true;
   return false;
}

void ResolveOutcome(const MqlRates &rates[],int count,TradeSetup &trade)
{
   double target=trade.entry+(trade.entry-trade.stop);
   for(int i=trade.entrybar;i<count;i++)
   {
      bool hit_stop=trade.is_buy ? rates[i].low<=trade.stop : rates[i].high>=trade.stop;
      bool hit_tp=trade.is_buy ? rates[i].high>=target : rates[i].low<=target;
      if(hit_stop || hit_tp)
      {
         trade.outcome=hit_stop ? "L" : "W";
         trade.exit_time=rates[i].time;
         trade.exit_reason=hit_stop ? "SL" : "TP1";
         return;
      }
   }
}

string BaseName(const RangeSetup &range,const MqlRates &rates[])
{
   return StringFormat("AUTO60_TR_%04d_%I64d",range.id,(long)rates[range.first].time);
}

void DrawRange(const RangeSetup &range,const TradeSetup &trade,const MqlRates &rates[])
{
   if(!InpDrawTradingRanges) return;
   string base=BaseName(range,rates),rect=base+"_BOX",label=base+"_ID";
   if(ObjectFind(0,rect)>=0)
   {
      ObjectMove(0,rect,1,rates[trade.keybar].time,range.low);
      return;
   }
   if(ObjectCreate(0,rect,OBJ_RECTANGLE,0,rates[range.first].time,range.high,
                   rates[trade.keybar].time,range.low))
   {
      ObjectSetInteger(0,rect,OBJPROP_COLOR,clrTeal);
      ObjectSetInteger(0,rect,OBJPROP_FILL,false);
      ObjectSetInteger(0,rect,OBJPROP_BACK,true);
      ObjectSetInteger(0,rect,OBJPROP_SELECTABLE,true);
      ObjectSetString(0,rect,OBJPROP_TOOLTIP,"AUTO60 weekly range candidate; compare with manual TR");
   }
   datetime mid=rates[range.first].time+(rates[trade.keybar].time-rates[range.first].time)/2;
   if(ObjectCreate(0,label,OBJ_TEXT,0,mid,range.high))
   {
      ObjectSetString(0,label,OBJPROP_TEXT,StringFormat("AUTO SROB %d",range.id));
      ObjectSetInteger(0,label,OBJPROP_COLOR,clrWhite);
      ObjectSetInteger(0,label,OBJPROP_FONTSIZE,8);
      ObjectSetInteger(0,label,OBJPROP_ANCHOR,ANCHOR_LOWER);
      ObjectSetInteger(0,label,OBJPROP_BACK,true);
   }
}

void DrawFibo(const TradeSetup &trade,const MqlRates &rates[])
{
   if(trade.outcome=="REVIEW" && !InpDrawUnresolvedFibos) return;
   string status=trade.outcome=="REVIEW" ? "REVIEW" :
      trade.outcome=="W" ? (trade.is_buy ? "WB" : "WS") : (trade.is_buy ? "LB" : "LS");
   string name=(status=="REVIEW" ? "AUTO60_REVIEW_" : status+"_")+
      TimeToString(rates[trade.entrybar].time,TIME_DATE|TIME_SECONDS);
   if(ObjectFind(0,name)>=0)
   {
      PrintFormat("EMA60RangeBacktest: Preserving existing Fibo %s",name);
      return;
   }
   if(!ObjectCreate(0,name,OBJ_FIBO,0,rates[trade.signalbar].time,trade.stop,
                    rates[trade.entrybar].time,trade.entry))
   {
      PrintFormat("EMA60RangeBacktest: Fibo create failed %s (%d)",name,GetLastError());
      return;
   }
   ObjectSetInteger(0,name,OBJPROP_COLOR,clrGold);
   ObjectSetInteger(0,name,OBJPROP_WIDTH,1);
   ObjectSetInteger(0,name,OBJPROP_BACK,true);
   ObjectSetInteger(0,name,OBJPROP_SELECTABLE,true);
   ObjectSetInteger(0,name,OBJPROP_LEVELS,5);
   double values[5]={1.0,0.5,0.0,-1.0,-2.0};
   string labels[5]={"SL","50%","E","TP1","TP2"};
   for(int i=0;i<5;i++)
   {
      ObjectSetDouble(0,name,OBJPROP_LEVELVALUE,i,values[i]);
      ObjectSetString(0,name,OBJPROP_LEVELTEXT,i,labels[i]);
   }
   ObjectSetString(0,name,OBJPROP_TOOLTIP,StringFormat(
      "AUTO60 review | %s %s | signal %s | key %s | E %s | SL %.5f | outside %.1f%%",
      trade.is_buy?"BUY":"SELL",trade.outcome,
      TimeToString(rates[trade.signalbar].time,TIME_DATE|TIME_MINUTES),
      TimeToString(rates[trade.keybar].time,TIME_DATE|TIME_MINUTES),
      TimeToString(rates[trade.entrybar].time,TIME_DATE|TIME_MINUTES),
      trade.stop,trade.outside_pct*100.0));
}

void ClearPriorAuto()
{
   for(int i=ObjectsTotal(0,0,-1)-1;i>=0;i--)
   {
      string name=ObjectName(0,i,0,-1);
      if(StringFind(name,"AUTO60_")==0)
      {
         ObjectDelete(0,name);
         continue;
      }
      if(ObjectGetInteger(0,name,OBJPROP_TYPE)!=OBJ_FIBO) continue;
      string tooltip=ObjectGetString(0,name,OBJPROP_TOOLTIP);
      if(StringFind(tooltip,"AUTO60 review | ")==0) ObjectDelete(0,name);
   }
}

void WriteCsv(string symbol,ENUM_TIMEFRAMES timeframe,datetime from_time,datetime to_time,
              const MqlRates &rates[],const RangeSetup &ranges[],const TradeSetup &trades[])
{
   if(!InpWriteCsv) return;
   string tf=EnumToString(timeframe);
   StringReplace(tf,"PERIOD_","");
   string from_label=TimeToString(from_time,TIME_DATE);
   string to_label=TimeToString(to_time-1,TIME_DATE);
   StringReplace(from_label,".","");
   StringReplace(to_label,".","");
   string filename=StringFormat("EMA60WeekReview_%s_%s_%s_%s.csv",symbol,tf,from_label,to_label);
   int handle=FileOpen(filename,FILE_WRITE|FILE_CSV|FILE_ANSI,',');
   if(handle==INVALID_HANDLE)
   {
      PrintFormat("EMA60RangeBacktest: CSV open failed (%d)",GetLastError());
      return;
   }
   FileWrite(handle,"range_id","range_start","range_end","range_high","range_low","side",
      "signal_time","keybar_time","entry_time","entry_price","sl","setup_candles",
      "keybar_outside_pct","outcome","exit_time","exit_reason");
   for(int i=0;i<ArraySize(trades);i++)
   {
      const TradeSetup t=trades[i];
      const RangeSetup r=ranges[t.range_index];
      FileWrite(handle,r.id,
         TimeToString(rates[r.first].time,TIME_DATE|TIME_SECONDS),
         TimeToString(rates[r.second].time,TIME_DATE|TIME_SECONDS),
         DoubleToString(r.high,_Digits),DoubleToString(r.low,_Digits),
         t.is_buy?"BUY":"SELL",
         TimeToString(rates[t.signalbar].time,TIME_DATE|TIME_SECONDS),
         TimeToString(rates[t.keybar].time,TIME_DATE|TIME_SECONDS),
         TimeToString(rates[t.entrybar].time,TIME_DATE|TIME_SECONDS),
         DoubleToString(t.entry,_Digits),DoubleToString(t.stop,_Digits),
         t.entrybar-t.signalbar,DoubleToString(t.outside_pct*100.0,1),
         t.outcome,t.exit_time>0?TimeToString(t.exit_time,TIME_DATE|TIME_SECONDS):"",
         t.exit_reason);
   }
   FileClose(handle);
   Print("EMA60RangeBacktest: wrote MQL5/Files/",filename);
}

void OnStart()
{
   string symbol=InpSymbol=="" ? _Symbol : InpSymbol;
   ENUM_TIMEFRAMES timeframe=InpTimeframe==PERIOD_CURRENT ? (ENUM_TIMEFRAMES)_Period : InpTimeframe;
   if(InpLookbackDays<1 || InpEmaPeriod<2 || InpAtrPeriod<2 || InpPivotRadius<1 ||
      InpMaxSwingGapBars<=InpMinSwingGapBars || InpKeyBarOutsidePct<0.51 ||
      InpKeyBarOutsidePct>1 || InpMaxReviewMarks<1)
   {
      Print("EMA60RangeBacktest: invalid inputs.");
      return;
   }
   if(!SymbolSelect(symbol,true))
   {
      PrintFormat("EMA60RangeBacktest: cannot select %s",symbol);
      return;
   }
   MqlDateTime day;
   TimeToStruct(TimeCurrent(),day);
   day.hour=0; day.min=0; day.sec=0;
   datetime to_time=StructToTime(day);
   datetime from_time=to_time-(datetime)InpLookbackDays*86400;
   datetime warm_from=from_time-6*3600;
   MqlRates rates[];
   ArraySetAsSeries(rates,false);
   int count=CopyRates(symbol,timeframe,warm_from,to_time-1,rates);
   if(count<=InpEmaPeriod+2*InpPivotRadius+3)
   {
      PrintFormat("EMA60RangeBacktest: insufficient rates (%d)",count);
      return;
   }
   double ema[],atr[];
   BuildIndicators(rates,count,ema,atr);
   RangeSetup ranges[];
   BuildRanges(rates,atr,count,SymbolInfoDouble(symbol,SYMBOL_POINT),ranges);
   AddManualRanges(rates,count,ranges);
   TradeSetup trades[];
   ArrayResize(trades,0);
   if(InpClearPriorAutoMarks && InpDrawOnChart) ClearPriorAuto();

   for(int r=0;r<ArraySize(ranges);r++)
   {
      const RangeSetup range=ranges[r];
      if(!range.manual && InpUseChartReferenceRanges &&
         HasManualRangeOnDate(ranges,rates,rates[range.first].time)) continue;
      int signals_for_range=0,last_key=-1;
      bool reset=true,last_buy=false;
      int last_key_to_scan=MathMin(count-2,range.second+InpMaxRetestBars);
      int first_key=range.manual ? MathMax(range.first+InpMinSwingGapBars,2) : range.second+1;
      for(int key=first_key;key<=last_key_to_scan;key++)
      {
         if(ArraySize(trades)>=InpMaxReviewMarks) break;
         if(!SameDate(rates[range.second].time,rates[key].time)) break;
         if(last_key>=0 && !reset)
         {
            double midpoint=(range.high+range.low)/2.0;
            if(last_buy ? rates[key].close<=midpoint : rates[key].close>=midpoint) reset=true;
         }
         if(!reset) continue;
         TradeSetup trade;
         if(!TrySetup(rates,ema,range,key,count,SymbolInfoDouble(symbol,SYMBOL_POINT),r,trade)) continue;
         if(rates[trade.entrybar].time<from_time || rates[trade.entrybar].time>=to_time) continue;
         if(EntryAlreadyMarked(trades,trade.entrybar)) continue;
         ResolveOutcome(rates,count,trade);
         int n=ArraySize(trades);
         ArrayResize(trades,n+1);
         trades[n]=trade;
         if(InpDrawOnChart && !range.manual) DrawRange(range,trade,rates);
         if(InpDrawOnChart && !range.manual) DrawFibo(trade,rates);
         signals_for_range++;
         last_key=key;
         last_buy=trade.is_buy;
         reset=false;
         if(signals_for_range>=2) break;
      }
      if(ArraySize(trades)>=InpMaxReviewMarks) break;
   }
   WriteCsv(symbol,timeframe,from_time,to_time,rates,ranges,trades);
   if(InpDrawOnChart) ChartSetInteger(0,CHART_FOREGROUND,false);
   if(InpDrawOnChart) ChartRedraw(0);
   PrintFormat("EMA60RangeBacktest complete | %s %s | %s to %s | bars=%d ranges=%d review_signals=%d cap=%d | two/three-candle signal then keybar; AUTO60 objects only",
      symbol,EnumToString(timeframe),TimeToString(from_time,TIME_DATE|TIME_MINUTES),
      TimeToString(to_time,TIME_DATE|TIME_MINUTES),count,ArraySize(ranges),ArraySize(trades),InpMaxReviewMarks);
}
