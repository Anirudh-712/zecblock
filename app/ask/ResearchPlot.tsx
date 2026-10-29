'use client';
import {ResponsiveContainer,BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis} from 'recharts';
import {shortLabel,supportsLine,chartLabel,chartSeries,chartValues,axisFor,SERIES_COLORS} from '@/lib/ask/research-display';
import {ChartTooltip} from '@/components/charts/ChartTooltip';
import type {ResearchResult,ResearchChart} from '@/lib/ask/research-contract';
const compact=(value:unknown)=>new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(Number(value));
const tick={fill:'var(--color-text-muted)',fontSize:12};
export default function ResearchPlot({result,chart}:{result:ResearchResult;chart:ResearchChart}){
 if(chart.view==='line'&&!supportsLine(result,chart.x))return <p className="text-sm text-secondary">Choose an ordered date or numeric label column, or use a bar chart.</p>;
 const values=chartValues(result,chart);
 if(!values.length)return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const many=values.length>1;
 // One value: bars carry every text column in their label ("deshield · ironwood")
 // and are coloured by a small categorical column (shield/deshield…). Several
 // values: one colour per value column, as grouped bars or lines.
 const series=chart.view==='bar'&&!many?chartSeries(result,chart.x):null;
 const axes=axisFor(result,values),right=axes.includes('right');
 const data=result.rows.map(row=>({x:chart.view==='bar'?chartLabel(result,row,chart.x,series?.column):row[chart.x]??'Unavailable',...Object.fromEntries(values.map(i=>[`v${i}`,row[i]===null?null:Number(row[i])])),fill:series?series.colorFor(row[series.column]):SERIES_COLORS[0]}));
 if(data.some(d=>values.some(i=>{const v=(d as Record<string,unknown>)[`v${i}`];return v!==null&&!Number.isFinite(v);})))return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const name=(i:number,k:number)=>`${result.columns[i].label.replaceAll('_',' ')}${axes[k]==='right'?' (right axis)':''}`;
 // Long or many bar labels are angled so every bar keeps a readable label.
 const crowded=chart.view==='bar'&&(data.length>6||data.some(d=>String(d.x).length>12));
 const children=<><XAxis dataKey="x" tick={tick} interval={chart.view==='bar'?0:'preserveStartEnd'} minTickGap={24} tickFormatter={shortLabel} angle={crowded?-30:0} textAnchor={crowded?'end':'middle'} height={crowded?72:45}/><YAxis yAxisId="left" tick={tick} width={70} tickFormatter={compact}/>{right?<YAxis yAxisId="right" orientation="right" tick={tick} width={70} tickFormatter={compact}/>:null}<ChartTooltip contentStyle={{maxWidth:'min(420px,80vw)',overflowWrap:'anywhere'}}/></>;
 const legend=series?series.legend.map(item=>({value:item.value,color:item.color})):many?values.map((i,k)=>({value:name(i,k),color:SERIES_COLORS[k]})):[];
 const label=values.map(i=>result.columns[i].label).join(', ');
 return <div role="img" aria-label={`${chart.view} chart of ${label} by ${result.columns[chart.x]?.label}; exact values in the table`}>
  {legend.length?<ul className="flex flex-wrap justify-end gap-4 mb-1 text-xs text-secondary" aria-hidden="true">{legend.map(item=><li key={item.value} className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{background:item.color}}/>{item.value}</li>)}</ul>:null}
  <ResponsiveContainer width="100%" height={260}>{chart.view==='bar'?<BarChart data={data}>{children}{values.map((i,k)=><Bar key={i} yAxisId={axes[k]} isAnimationActive={false} dataKey={`v${i}`} name={name(i,k)} fill={SERIES_COLORS[k]} radius={[3,3,0,0]}>{series?data.map((d,n)=><Cell key={n} fill={d.fill}/>):null}</Bar>)}</BarChart>:<LineChart data={data}>{children}{values.map((i,k)=><Line key={i} yAxisId={axes[k]} isAnimationActive={false} dataKey={`v${i}`} name={name(i,k)} stroke={SERIES_COLORS[k]} dot={false} connectNulls={false}/>)}</LineChart>}</ResponsiveContainer>
 </div>;
}
