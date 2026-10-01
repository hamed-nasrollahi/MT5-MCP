/**
 * Calibrate the user's EMA60/TR breakout filters against hand-reviewed MT5 trades.
 * Input JSON: { candles: [{t,open,high,low,close}], ranges: [{id,start,end,high,low}], trades: [{side,entry_time,entry_price,sl?,outcome?}] }
 * `ranges` are chart-reviewed TRs (not generated rolling windows). This deliberately
 * keeps subjective double-top/bottom recognition with the user's chart annotations.
 * Run: node src/ema60RangeCalibration.mjs --input <file> [--output <file>]
 */
import fs from 'node:fs';

const toMs = (x) => {
  if (typeof x === 'number') return x;
  let s=String(x).replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(s)) s+='Z';
  return Date.parse(s);
};
const iso = (x) => new Date(x).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3 ').slice(0, 19);
const round = (n, d = 5) => Number(n.toFixed(d));
const DEFAULT_FIB_TEMPLATE = [
  { value: 1, text: 'SL' }, { value: 0.5, text: '50%' }, { value: 0, text: 'E' },
  { value: -1, text: 'TP1' }, { value: -2, text: 'TP2' },
];

function normalize(input) {
  if (!Array.isArray(input.candles) || !Array.isArray(input.ranges)) throw Error('Input needs candles[] and ranges[]');
  const bars = input.candles.map(b => ({ ...b, ms: toMs(b.t), open:+b.open, high:+b.high, low:+b.low, close:+b.close }))
    .filter(b => Number.isFinite(b.ms) && [b.open,b.high,b.low,b.close].every(Number.isFinite))
    .sort((a,b) => a.ms-b.ms);
  if (!bars.length) throw Error('No valid candles');
  const ranges = input.ranges.map(r => ({ ...r, startMs:toMs(r.start), endMs:toMs(r.end), high:+r.high, low:+r.low }))
    .filter(r => Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.high>r.low);
  return { bars, ranges };
}

function ema(values, period) {
  const a = Array(values.length).fill(null), k=2/(period+1); let v;
  for (let i=0;i<values.length;i++) { v = v == null ? values[i] : values[i]*k+v*(1-k); a[i]=v; }
  return a;
}

function scanRange(bars, range, cfg, ema60) {
  if(range.valid===false) return null;
  // A reviewed box can include the final signal, key bar, or entry candle.
  const first = bars.findIndex(b => b.ms >= range.endMs - 3*60000);
  if (first < 1) return null;
  for (let i=first;i<bars.length;i++) {
    const b=bars[i], tr=range.high-range.low, span=b.high-b.low;
    if(iso(b.ms).slice(0,10)!==iso(range.endMs).slice(0,10)) break;
    if (b.ms-range.endMs > 180*60000 || i+1>=bars.length) break;
    const mins=new Date(b.ms).getUTCHours()*60+new Date(b.ms).getUTCMinutes();
    if (mins < (cfg.startHour??8)*60 || mins >= (cfg.endHour??23)*60 || !span || tr<=0) continue;
    const checks=[];
    if (b.close>range.high) checks.push({side:'BUY',outside:Math.max(0,b.high-Math.max(b.low,range.high))/span,
      wick:(b.high-Math.max(b.open,b.close))/span,breakRatio:(b.close-range.high)/tr});
    if (b.close<range.low) checks.push({side:'SELL',outside:Math.max(0,Math.min(b.high,range.low)-b.low)/span,
      wick:(Math.min(b.open,b.close)-b.low)/span,breakRatio:(range.low-b.close)/tr});
    for (const c of checks) {
      const directional = c.side==='BUY' ? b.close>ema60[i] : b.close<ema60[i];
      if (!directional || c.outside<cfg.outside || span/tr<(cfg.minKeySpan??.18) || c.breakRatio<cfg.minBreak) continue;
      const nearEdge=s=>c.side==='BUY' ? s.high>=range.high-(cfg.edgeTolerance??.5)*tr : s.low<=range.low+(cfg.edgeTolerance??.5)*tr;
      let signalIndex=-1;
      if(i>=2 && nearEdge(bars[i-2]) && nearEdge(bars[i-1]) &&
        (bars[i-2].high-bars[i-2].low)/tr<=(cfg.smallSignal??.35) &&
        (bars[i-1].high-bars[i-1].low)/tr<=(cfg.smallSignal??.35)) signalIndex=i-2;
      else if(i>=1 && nearEdge(bars[i-1])) signalIndex=i-1;
      if(signalIndex<0) continue;
      const signal=bars[signalIndex], signalSpan=signal.high-signal.low;
      const signalWick=signalSpan ? (c.side==='BUY' ? signal.high-Math.max(signal.open,signal.close) :
        Math.min(signal.open,signal.close)-signal.low)/signalSpan : 0;
      if(c.wick>cfg.maxWick && signalWick<.35) continue;
      return { range_id:range.id, side:c.side, signal_time:iso(signal.ms), keybar_time:iso(b.ms),
          setup_candles:i+1-signalIndex, entry_time:iso(bars[i+1].ms),
          entry:bars[i+1].open, sl:c.side==='BUY'?signal.low:signal.high,
          outside_pct:round(c.outside*100,1), keybar_vs_range:round(c.breakRatio,3), wick_pct:round(c.wick*100,1),
          range:{start:iso(range.startMs),end:iso(range.endMs),high:range.high,low:range.low},
          };
    }
  }
  return null;
}

function score(predictions, trades, toleranceMinutes=5) {
  const refs=trades.filter(r=>r.side && (r.entry_time ?? r.entry) != null), used=new Set(); let matched=0, offset=0, wrongSide=0;
  for (const p of predictions) {
    const pm=toMs(p.entry_time), candidates=refs.map((r,i)=>({r,i,dt:Math.abs(toMs(r.entry_time??r.entry)-pm)}))
      .filter(x=>!used.has(x.i)&&x.dt<=toleranceMinutes*60000).sort((a,b)=>a.dt-b.dt);
    if (!candidates.length) continue;
    const x=candidates[0]; used.add(x.i); matched++; offset+=x.dt/60000;
    if (String(x.r.side).toUpperCase()!==p.side) wrongSide++;
    p.reference = x.r;
  }
  const fp=predictions.length-matched, fn=refs.length-matched;
  const precision=matched/(matched+fp||1), recall=matched/(matched+fn||1);
  return {matched,reference_count:refs.length,prediction_count:predictions.length,wrong_side:wrongSide,
    mean_entry_offset_minutes:matched?round(offset/matched,2):null,precision:round(precision,3),recall:round(recall,3),
    f1:round(2*precision*recall/(precision+recall||1),3)};
}

function classifyTp1Outcome(prediction,bars) {
  const ref=prediction.reference??{};
  const entry=+(ref.entry_price??prediction.entry), sl=+(ref.sl??prediction.sl);
  if(!Number.isFinite(entry)||!Number.isFinite(sl)||entry===sl) return;
  const target=entry+(entry-sl); // TP1 is one SL-to-E distance beyond E.
  const from=toMs(ref.entry_time??prediction.entry_time);
  for(const b of bars) {
    if(b.ms<from) continue;
    const stop=prediction.side==='BUY'?b.low<=sl:b.high>=sl;
    const tp1=prediction.side==='BUY'?b.high>=target:b.low<=target;
    if(stop||tp1) {
      prediction.outcome=stop?'L':'W';
      prediction.exit={time:iso(b.ms),reason:stop?'SL':'TP1',price:stop?sl:target};
      return;
    }
  }
}

function addReviewMark(p, fibTemplate) {
  const ref=p.reference??{};
  const outcome=String(ref.outcome??p.outcome??'').toUpperCase();
  const side=p.side==='BUY'?'B':'S';
  const exportCode=['W','WIN'].includes(outcome)?`W${side}_`:
    ['L','LOSS','LOSE'].includes(outcome)?`L${side}_`:null;
  const labels=['SL','50%','E','TP1','TP2'];
  const ratios=ref.fib_levels??fibTemplate??DEFAULT_FIB_TEMPLATE;
  const levels=Array.isArray(ratios)&&ratios.length===5&&ratios.every((x,i)=>x.text===labels[i]&&Number.isFinite(+x.value))
    ? ratios.map(x=>({text:x.text,value:+x.value}))
    : labels.map(text=>({text,value:null}));
  const entryTime=ref.entry_time??p.entry_time;
  const object={name:`${exportCode??'AUTO60_REVIEW_'}${entryTime}`,type:'FIBO',
    time1:ref.sl_time??p.signal_time,price1:ref.sl??p.sl,
    time2:entryTime,price2:ref.entry_price??p.entry,
    color:'Gold',width:1,style:'SOLID',fill:false,back:true,selectable:true,
    levels:levels.map(x=>({value:x.value,text:x.text})),
    description:`AUTO60 review | Range ${p.range_id}; ${p.side}; ${exportCode?'manual review':'outcome unresolved'}`};
  return {object,export_code:exportCode,source_name:ref.name??null,ready:Boolean(exportCode)&&levels.every(x=>Number.isFinite(x.value)),
    missing:[...(!exportCode?['outcome W/L']:[]),...(!levels.every(x=>Number.isFinite(x.value))?['Fib1 ratios']:[])]};
}

export function calibrateEma60Ranges(input, options={}) {
  const {bars,ranges}=normalize(input);
  const trades=input.trades??[];
  const e=ema(bars.map(b=>b.open),60);
  const grid=options.grid ?? {outside:[.51,.6],maxWick:[.25,.4,.6],minBreak:[0,.05,.15]};
  const scored=[];
  for (const outside of grid.outside) for (const maxWick of grid.maxWick) for (const minBreak of grid.minBreak) {
    const cfg={outside,maxWick,minBreak};
    const predictions=ranges.map(r=>scanRange(bars,r,cfg,e)).filter(Boolean);
    scored.push({config:cfg,metrics:score(predictions,trades,options.matchMinutes??5),predictions});
  }
  scored.sort((a,b)=>b.metrics.f1-a.metrics.f1 || (a.metrics.mean_entry_offset_minutes??Infinity)-(b.metrics.mean_entry_offset_minutes??Infinity) || a.metrics.wrong_side-b.metrics.wrong_side);
  const best=scored[0]??null;
  if(best) {
    for(const prediction of best.predictions) classifyTp1Outcome(prediction,bars);
    const manual=trades.map(trade=>{
      const reference={...trade};
      const prediction={side:String(trade.side).toUpperCase(),entry_time:trade.entry_time,entry:+trade.entry_price,
        sl:+trade.sl,signal_time:trade.sl_time,reference};
      classifyTp1Outcome(prediction,bars);
      return addReviewMark(prediction,input.fibTemplate);
    });
    const referencedNames=new Set(trades.map(t=>t.name).filter(Boolean));
    const additional=best.predictions.filter(p=>!p.reference||!referencedNames.has(p.reference.name)).map(p=>addReviewMark(p,input.fibTemplate));
    best.review_objects=[...manual,...additional];
    best.objects_to_add=best.review_objects.filter(x=>x.ready).map(x=>x.object);
  }
  return {symbol:input.symbol??'EURUSD',timeframe:input.timeframe??'M1',bars:bars.length,range_count:ranges.length,reference_trade_count:trades.length,
    calibration:'Best fit to supplied hand-reviewed ranges/trades. W means TP1 touched before SL; a same-bar SL/TP1 tie counts as L. Two days are calibration data, not independent validation.',
    best,top:scored.slice(0,10)};
}

async function readMcpPayload(response) {
  const body=await response.text();
  const dataLine=body.split(/\r?\n/).find(line=>line.startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(body);
}

async function mt5Call(url, session, id, name, args) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':session},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
  if(!response.ok) throw Error(`MT5 MCP ${name} failed: HTTP ${response.status}`);
  const envelope=await readMcpPayload(response);
  if(envelope.error) throw Error(envelope.error.message);
  const block=envelope.result?.content?.find(x=>x.type==='text');
  if(!block) throw Error(`MT5 MCP ${name} returned no text result`);
  return JSON.parse(block.text);
}

async function openMcpSession(url) {
  const init=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ema60-range-calibration',version:'1.0.0'}}})});
  if(!init.ok) throw Error(`Cannot initialize local MT5 MCP at ${url}: HTTP ${init.status}`);
  await readMcpPayload(init);
  const session=init.headers.get('mcp-session-id');
  if(!session) throw Error('MT5 MCP did not return an mcp-session-id');
  await fetch(url,{method:'POST',headers:{'content-type':'application/json','mcp-session-id':session},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  return session;
}

async function loadFromMt5({url='http://127.0.0.1:3000/mcp',chartId=0,from=null,to=null}={}) {
  const midnight=new Date(); midnight.setHours(0,0,0,0);
  const stamp=d=>`${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} 00:00:00`;
  to??=stamp(midnight);
  from??=stamp(new Date(midnight.getTime()-7*86400000));
  const session=await openMcpSession(url);
  try {
    const candles=await mt5Call(url,session,2,'mt5_get_candles',{symbol:'EURUSD',timeframe:'M1',from_date:from,to_date:to,count:5000});
    const objectPages={FIBO:[],RECTANGLE:[]}; let id=3;
    for(const type of Object.keys(objectPages)) {
      for(let offset=0;;offset+=20) {
        const page=await mt5Call(url,session,id++,'mt5_list_objects',{chart_id:chartId,type_filter:type,offset,limit:20});
        objectPages[type].push(...(page.objects??[]));
        if(!page.has_more) break;
      }
    }
    const inDates=t=>Number.isFinite(toMs(t))&&toMs(t)>=toMs(from)&&toMs(t)<toMs(to);
    const ranges=objectPages.RECTANGLE.filter(o=>/^(BT29_|SR-OB_|H1-OB_|SROB_TR_|H1OB_TR_)/.test(o.name??''))
      .map(o=>{const a=(o.anchors??[]).filter(x=>x.time&&Number.isFinite(+x.price)); if(a.length<2)return null;
        const ordered=[...a].sort((x,y)=>toMs(x.time)-toMs(y.time));
        const rejected=/^(H1-OB_|H1OB_TR_|BT29_H1OB_)/.test(o.name??'');
        return {id:o.name,start:ordered[0].time,end:ordered.at(-1).time,high:Math.max(...a.map(x=>+x.price)),low:Math.min(...a.map(x=>+x.price)),
          valid:!rejected,description:o.text??''};})
      .filter(r=>r&&inDates(r.start)&&inDates(r.end));
    const trades=objectPages.FIBO.filter(o=>/^(?:WB|LB|WS|LS)_/.test(o.name??''))
      .map(o=>{const a=o.anchors??[]; if(a.length<2||!a[0].time||!a[1].time)return null;
        const side=/^[WL]B_/.test(o.name)?'BUY':'SELL';
        return {side,entry_time:a[1].time,entry_price:+a[1].price,sl:+a[0].price,sl_time:a[0].time,
          outcome:o.name.startsWith('W')?'W':'L',name:o.name,fib_levels:o.levels};})
      .filter(t=>t&&inDates(t.entry_time));
    const bars=(candles.candles??[]).map(b=>({t:b.t,open:b.o,high:b.h,low:b.l,close:b.c}));
    return {symbol:'EURUSD',timeframe:'M1',candles:bars,ranges,trades};
  } finally {
    await fetch(url,{method:'DELETE',headers:{'mcp-session-id':session}}).catch(()=>{});
  }
}

async function drawOnMt5(result,{url='http://127.0.0.1:3000/mcp',chartId=0,replace=false}={}) {
  const best=result.best, pending=best?.review_objects?.filter(x=>x.ready)??[];
  if(!pending.length) return {created:0,reason:'No candidates have a confirmed TP1/SL outcome.'};
  const session=await openMcpSession(url); let id=20;
  try {
    const existing=[];
    for(let offset=0;;offset+=20) {
      const page=await mt5Call(url,session,id++,'mt5_list_objects',{chart_id:chartId,type_filter:'FIBO',offset,limit:20});
      existing.push(...(page.objects??[])); if(!page.has_more)break;
    }
    const names=new Map(existing.map(x=>[x.name,x]));
    const alreadyPresent=[], toAdd=[];
    for(const item of pending) {
      const found=names.get(item.object.name);
      const anchors=found?.anchors??[];
      const exact=found&&anchors.length>=2&&
        anchors[0].time===item.object.time1&&anchors[1].time===item.object.time2&&
        Math.abs(+anchors[0].price-item.object.price1)<1e-7&&Math.abs(+anchors[1].price-item.object.price2)<1e-7&&
        found.levels?.length===5&&found.levels.every((x,i)=>x.text===item.object.levels[i].text&&Math.abs(+x.value-item.object.levels[i].value)<1e-9);
      if(exact) alreadyPresent.push(item);
      else {
        const generated=found && (found.name.startsWith('AUTO60_') ||
          String(found.description??'').startsWith('AUTO60 review | '));
        if(found && (!replace || !generated)) { alreadyPresent.push(item); continue; }
        if(generated)
          await mt5Call(url,session,id++,'mt5_delete_object',{chart_id:chartId,name:item.object.name});
        toAdd.push(item);
      }
    }
    const added=toAdd.length?await mt5Call(url,session,id++,'mt5_add_objects',{chart_id:chartId,objects:toAdd.map(x=>{
      const {levels,...object}=x.object; return object;
    })}):{created:0,failed:0,results:[]};
    if(Number(added.created)!==toAdd.length) return {created:added.created??0,failed:added.failed??toAdd.length,already_present:alreadyPresent.length,results:added.results,deleted_originals:0};
    const levelValues=[1,0.5,0,-1,-2], levelTexts=['SL','50%','E','TP1','TP2'];
    const updated=[];
    for(const item of toAdd) {
      const properties={OBJPROP_LEVELS:5};
      for(let i=0;i<5;i++){properties[`OBJPROP_LEVELVALUE_${i}`]=levelValues[i];properties[`OBJPROP_LEVELTEXT_${i}`]=levelTexts[i];}
      try { updated.push(await mt5Call(url,session,id++,'mt5_modify_object',{chart_id:chartId,name:item.object.name,properties})); }
      catch(error){ updated.push({name:item.object.name,error:error.message}); }
    }
    const allLevelsSet=updated.every(x=>x.modified===true)&&alreadyPresent.length+toAdd.length===pending.length;
    return {created:added.created,already_present:alreadyPresent.length,failed:added.failed??0,levels_set:allLevelsSet,deleted_originals:0,modified:updated};
  } finally {
    await fetch(url,{method:'DELETE',headers:{'mcp-session-id':session}}).catch(()=>{});
  }
}

async function main() {
  const args=process.argv.slice(2), get=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
  const inputPath=get('--input');
  let input;
  const referenceFixture=new URL('../data/eurusd-m1-2026-09-29-30-corrected.json',import.meta.url);
  try {
    if(inputPath) input=JSON.parse(fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/,''));
    else if(args.includes('--live')||!fs.existsSync(referenceFixture)) input=await loadFromMt5({url:get('--url')??undefined,chartId:Number(get('--chart-id')??0),from:get('--from'),to:get('--to')});
    else input=JSON.parse(fs.readFileSync(referenceFixture,'utf8').replace(/^\uFEFF/,''));
  }
  catch(error){console.error(error.message);process.exitCode=1;return;}
  const result=calibrateEma60Ranges(input);
  if(args.includes('--draw')||args.includes('--replace')) {
    try { result.chart_update=await drawOnMt5(result,{url:get('--url')??undefined,chartId:Number(get('--chart-id')??0),replace:args.includes('--replace')}); }
    catch(error){result.chart_update={error:error.message};}
  }
  const out=JSON.stringify(result,null,2), outputPath=get('--output');
  if(outputPath) fs.writeFileSync(outputPath,out+'\n'); else console.log(out);
}
if (process.argv[1] && import.meta.url===new URL(`file://${process.argv[1].replaceAll('\\','/')}`).href) await main();
