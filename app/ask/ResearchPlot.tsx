'use client';
import {ResponsiveContainer,BarChart,Bar,LineChart,Line,XAxis,YAxis} from 'recharts';
import {ChartTooltip} from '@/components/charts/ChartTooltip';
import type {ResearchResult,ResearchChart} from '@/lib/ask/research-contract';
export default function ResearchPlot({result,chart}:{result:ResearchResult;chart:ResearchChart}){
 const data=result.rows.map(row=>({x:row[chart.x]??'Unavailable',y:row[chart.y]===null?null:Number(row[chart.y])}));
 if(result.columns[chart.y]?.type!=='number'||data.some(d=>d.y!==null&&!Number.isFinite(d.y)))return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const children=<><XAxis dataKey="x" tick={{fill:'var(--color-text-muted)',fontSize:12}} minTickGap={40}/><YAxis tick={{fill:'var(--color-text-muted)',fontSize:12}} width={70}/><ChartTooltip/></>;
 return <div role="img" aria-label={`${chart.view} chart of ${result.columns[chart.y]?.label} by ${result.columns[chart.x]?.label}; exact values in the table`}><ResponsiveContainer width="100%" height={260}>{chart.view==='bar'?<BarChart data={data}>{children}<Bar isAnimationActive={false} dataKey="y" name={result.columns[chart.y]?.label} fill="var(--color-gold)"/></BarChart>:<LineChart data={data}>{children}<Line isAnimationActive={false} dataKey="y" name={result.columns[chart.y]?.label} stroke="var(--color-gold)" dot={false} connectNulls={false}/></LineChart>}</ResponsiveContainer></div>;
}
