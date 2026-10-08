import React from 'react';
import { plotInfographic, pathOf, ticksFor, tickLabel } from './chart.js';

export const Infographic = ({ chart, inspect }) => {
  const g = plotInfographic(chart);
  const height = chart.type === 'horizontalBar' ? g.height : chart.type === 'heatmap' ? Math.max(105, 65 + chart.series.length * g.cellH) : 320;
  return <svg className="chart-svg" viewBox={`0 0 640 ${height}`} role="img" aria-label={chart.title || chart.type}>
    {chart.type === 'horizontalBar' ? <>
      <line className="chart-zero" x1={g.zero} x2={g.zero} y1="10" y2={height - 20} />
      {ticksFor(g.range).map(value => <g key={value}><line className="chart-grid" x1={g.left + (value - g.range.min) / (g.range.max - g.range.min) * (620 - g.left)} x2={g.left + (value - g.range.min) / (g.range.max - g.range.min) * (620 - g.left)} y1="10" y2={height - 25} /><text className="chart-tick"
        x={g.left + (value - g.range.min) / (g.range.max - g.range.min) * (620 - g.left)}
        y={height - 3} textAnchor="middle">{tickLabel(value)}</text></g>)}
      {g.bars.map((b, i) => <g key={i}>
        <text className="chart-label" x="108" y={b.y + b.h / 2} textAnchor="end" dominantBaseline="middle">{b.label.slice(0, 15)}</text>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.colour} rx="5" {...inspect(`${b.label} · ${b.name}: ${b.value} ${chart.unit}`)} />
      </g>)}
    </> : chart.type === 'heatmap' ? <>
      {chart.labels.map((l, i) => <text key={i} className="chart-label" x={g.left + (i + .5) * g.cellW} y="18" textAnchor="middle">{l}</text>)}
      {chart.series.map((s, i) => <text key={i} className="chart-label" x="108" y={51 + i * g.cellH} textAnchor="end">{s.name.slice(0, 15)}</text>)}
      {g.cells.map((c, i) => <g key={i} {...inspect(`${c.label} · ${c.name}: ${c.value ?? '—'} ${chart.unit}`)}>
        <rect x={c.x + 2} y={c.y + 2} width={Math.max(0, c.w - 4)} height={c.h - 4} rx="5" fill={c.colour} fillOpacity={c.opacity} />
        <text className="chart-cell-label" x={c.x + c.w / 2} y={c.y + c.h / 2} textAnchor="middle" dominantBaseline="middle">{c.value ?? '—'}</text>
      </g>)}
      <text className="chart-tick" x={g.left} y={height - 8}>{g.range.min}–{g.range.max} {chart.unit}</text>
    </> : <>
      {[.25, .5, .75, 1].map(scale => <polygon key={scale} className="chart-grid" fill="none" points={g.spokes.map(s => `${g.cx + (s.end.x - g.cx) * scale},${g.cy + (s.end.y - g.cy) * scale}`).join(' ')} />)}
      {g.spokes.map((s, i) => <g key={i}>
        <line className="chart-grid" x1={g.cx} y1={g.cy} x2={s.end.x} y2={s.end.y} />
        <text className="chart-label" x={s.x} y={s.y} textAnchor="middle">{s.label}</text>
      </g>)}
      <text className="chart-tick" x="8" y="16">{g.range.min}–{g.range.max} {chart.unit}</text>
      {g.polygons.map((s, i) => <g key={i}>
        {s.points.every(Boolean) && <path d={`${pathOf(s.points)} Z`} fill={s.colour} fillOpacity="0.12" stroke={s.colour} strokeWidth="2" />}
        {s.points.filter(Boolean).map((p, j) => <circle key={j} cx={p.x} cy={p.y} r="4" fill={s.colour} {...inspect(`${p.label} · ${s.name}: ${p.value} ${chart.unit}`)} />)}
      </g>)}
    </>}
  </svg>;
};
