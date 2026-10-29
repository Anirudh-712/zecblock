'use client';
import {ResponsiveContainer,BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis} from 'recharts';
import {shortLabel,supportsLine,chartLabel,chartSeries} from '@/lib/ask/research-display';
import {ChartTooltip} from '@/components/charts/ChartTooltip';
import type {ResearchResult,ResearchChart} from '@/lib/ask/research-contract';
export default function ResearchPlot({result,chart}:{result:ResearchResult;chart:ResearchChart}){
 if(chart.view==='line'&&!supportsLine(result,chart.x))return <p className="text-sm text-secondary">Choose an ordered date or numeric label column, or use a bar chart.</p>;
 // Bars carry every text column in their label ("deshield · ironwood") and are
 // coloured by a small categorical column when there is one (shield/deshield…).
 const series=chart.view==='bar'?chartSeries(result,chart.x):null;
 const data=result.rows.map(row=>({x:chart.view==='bar'?chartLabel(result,row,chart.x):row[chart.x]??'Unavailable',y:row[chart.y]===null?null:Number(row[chart.y]),fill:series?series.colorFor(row[series.column]):'var(--color-gold)'}));
 if(result.columns[chart.y]?.type!=='number'||data.some(d=>d.y!==null&&!Number.isFinite(d.y)))return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const children=<><XAxis dataKey="x" tick={{fill:'var(--color-text-muted)',fontSize:12}} minTickGap={24} tickFormatter={shortLabel} height={45}/><YAxis tick={{fill:'var(--color-text-muted)',fontSize:12}} width={70} tickFormatter={value=>new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(Number(value))}/><ChartTooltip contentStyle={{maxWidth:'min(420px,80vw)',overflowWrap:'anywhere'}}/></>;
 return <div role="img" aria-label={`${chart.view} chart of ${result.columns[chart.y]?.label} by ${result.columns[chart.x]?.label}; exact values in the table`}>
  {series?<ul className="flex flex-wrap gap-4 mb-2 text-xs text-secondary" aria-hidden="true">{series.legend.map(item=><li key={item.value} className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{background:item.color}}/>{item.value}</li>)}</ul>:null}
  <ResponsiveContainer width="100%" height={260}>{chart.view==='bar'?<BarChart data={data}>{children}<Bar isAnimationActive={false} dataKey="y" name={result.columns[chart.y]?.label} radius={[3,3,0,0]}>{data.map((d,i)=><Cell key={i} fill={d.fill}/>)}</Bar></BarChart>:<LineChart data={data}>{children}<Line isAnimationActive={false} dataKey="y" name={result.columns[chart.y]?.label} stroke="var(--color-gold)" dot={false} connectNulls={false}/></LineChart>}</ResponsiveContainer>
 </div>;
}
