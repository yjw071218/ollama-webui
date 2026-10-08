/**
 * Drawing what `chart.js` worked out.
 *
 * Every number here comes from that file; this only turns them into SVG. The
 * split is deliberate: the arithmetic is the part that is easy to get subtly
 * wrong and impossible to check by looking, and it is now checkable.
 *
 * SVG rather than canvas because it scales to the width it is given, it prints,
 * it can be selected and read by a screen reader, and it costs nothing to draw
 * again when the theme changes.
 */

import React, { useState } from 'react';
import { parseChart, plotAxes, plotPie, plotFunction, pathOf, areaOf, sharePercent, BOX } from './chart.js';
import { chartCSV } from './chart.js';
import { Infographic } from './Infographic.jsx';
import { useI18n } from './i18n.jsx';

/** A value as it should read in a tooltip: whole where it is whole. */
const shown = (value, unit) => `${Math.round(value * 1000) / 1000}${unit ? ` ${unit}` : ''}`;

const Legend = ({ items }) => (
  <div className="chart-legend">
    {items.map((item, i) => (
      <span className="chart-legend-item" key={i}>
        <i className="chart-swatch" style={{ background: item.colour }} aria-hidden="true" />
        {item.name}
      </span>
    ))}
  </div>
);

/**
 * A curve, drawn on axes that cross at the origin.
 *
 * Its own component because almost nothing is shared with a bar chart: there
 * are no labels, no slots and no baseline, and both axes carry numbers. What it
 * does share is the box, so a graph and a bar chart in the same answer are the
 * same size.
 */
const Curves = ({ chart }) => {
  const geo = plotFunction(chart, BOX);
  return (
    <>
      {geo.yTicks.map((tick, i) => (
        <g key={`y${i}`}>
          <line className="chart-grid" x1={geo.plot.x} x2={geo.plot.x + geo.plot.w} y1={tick.y} y2={tick.y} />
          {tick.value !== 0 && (
            <text className="chart-tick" x={geo.plot.x - 8} y={tick.y} textAnchor="end" dominantBaseline="middle">
              {tick.label}
            </text>
          )}
        </g>
      ))}
      {geo.xTicks.map((tick, i) => (
        <g key={`x${i}`}>
          <line className="chart-grid" x1={tick.x} x2={tick.x} y1={geo.plot.y} y2={geo.plot.y + geo.plot.h} />
          {tick.value !== 0 && (
            <text className="chart-tick" x={tick.x} y={geo.plot.y + geo.plot.h + 15} textAnchor="middle">
              {tick.label}
            </text>
          )}
        </g>
      ))}

      {/* The axes themselves, drawn over the grid: on a graph they are where
          the reader looks first, and a rose is unreadable without them. */}
      <line className="chart-zero" x1={geo.plot.x} x2={geo.plot.x + geo.plot.w} y1={geo.axisX} y2={geo.axisX} />
      <line className="chart-zero" x1={geo.axisY} x2={geo.axisY} y1={geo.plot.y} y2={geo.plot.y + geo.plot.h} />

      {geo.curves.map((curve, i) => (
        <path key={i} d={curve.path} fill="none" stroke={curve.colour} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </>
  );
};

/**
 * A chart, or null if the block is not one.
 *
 * Null rather than a message: a fenced block that fails to parse should fall
 * back to being shown as the code it is, which is what the caller does. A
 * "could not draw this chart" box in the middle of an answer helps nobody and
 * hides the thing the model actually wrote.
 */
class ChartBoundary extends React.Component {
  state = { failed: false, source: this.props.source };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props, state) {
    return props.source !== state.source ? { source: props.source, failed: false } : null;
  }
  render() {
    return this.state.failed ? <pre className="chart-fallback"><code>{this.props.source}</code></pre> : this.props.children;
  }
}

export const Chart = (props) => <ChartBoundary source={props.source}><ChartContent {...props} /></ChartBoundary>;

const ChartContent = ({ source, t }) => {
  const { lang } = useI18n();
  const ko = lang === 'ko';
  const chart = parseChart(source);
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const inspect = (text) => ({
    tabIndex: 0, role: 'button', 'aria-label': text,
    onMouseEnter: () => setHover({ text }), onMouseLeave: () => setHover(null),
    onFocus: () => setHover({ text }), onBlur: () => setHover(null),
    onClick: () => setPinned({ text }),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned({ text }); } },
  });
  if (!chart) return null;

  const pie = chart.type === 'pie' || chart.type === 'donut';
  const infographic = ['horizontalBar', 'radar', 'heatmap'].includes(chart.type);
  const curve = chart.type === 'function';
  const geo = curve || infographic ? null : pie ? plotPie(chart, BOX) : plotAxes(chart, BOX);
  const many = chart.series.length > 1;
  const typeNames = ko
    ? { bar: '막대', line: '추이', area: '영역', pie: '비율', donut: '도넛', horizontalBar: '가로 막대', radar: '레이더', heatmap: '히트맵', function: '함수' }
    : { bar: 'Bar', line: 'Trend', area: 'Area', pie: 'Share', donut: 'Donut', horizontalBar: 'Horizontal bar', radar: 'Radar', heatmap: 'Heatmap', function: 'Function' };

  return (
    <figure className="chart-figure" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
      <figcaption className="chart-heading">
        <div><span className="chart-eyebrow">{typeNames[chart.type]}</span><div className="chart-title">{chart.title || (ko ? '데이터 시각화' : 'Data visualization')}</div></div>
        <span className="chart-count">{curve ? `${chart.curves.length} ${ko ? '함수' : 'curves'}` : `${chart.labels.length} ${ko ? '항목' : 'items'}`}</span>
      </figcaption>
      <div className={`chart-plot${chart.type === 'heatmap' ? ' chart-plot-scroll' : ''}`}>
      {infographic ? <Infographic chart={chart} inspect={inspect} /> : <svg
        className={`chart-svg${pie ? ' chart-svg-round' : ''}`}
        viewBox={pie ? `${(BOX.w - BOX.h) / 2} 0 ${BOX.h} ${BOX.h}` : `0 0 ${BOX.w} ${BOX.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={chart.title || chart.curves?.map(c => c.name).join(', ') || t?.('chart.label') || 'chart'}
      >
        {curve ? (
          <Curves chart={chart} />
        ) : pie ? (
          <>
            {geo.slices.map((slice, i) => (
              <g key={i} {...inspect(`${slice.label || ''}: ${shown(slice.value, chart.unit)} (${sharePercent(slice.share)})`)}>
                <path d={slice.path} fill={slice.colour} stroke="var(--surface)" strokeWidth="1.5" />
                {slice.share > 0.06 && (
                  <text className="chart-slice-label" x={geo.cx + (slice.mid.x - geo.cx) * (chart.type === 'donut' ? 1.28 : 1)} y={geo.cy + (slice.mid.y - geo.cy) * (chart.type === 'donut' ? 1.28 : 1)}
                    textAnchor="middle" dominantBaseline="middle">
                    {sharePercent(slice.share)}
                  </text>
                )}
              </g>
            ))}
            {chart.type === 'donut' && <g pointerEvents="none">
              <circle cx={geo.cx} cy={geo.cy} r={geo.r * .57} fill="var(--surface-sunken)" />
              <text className="chart-donut-caption" x={geo.cx} y={geo.cy - 10} textAnchor="middle">{ko ? '합계' : 'Total'}</text>
              <text className="chart-donut-total" x={geo.cx} y={geo.cy + 18} textAnchor="middle">{Intl.NumberFormat(ko ? 'ko' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(geo.total)}</text>
            </g>}
          </>
        ) : (
          <>
            {/* The gridlines first, so everything else is drawn over them. */}
            {geo.ticks.map((tick, i) => (
              <g key={i}>
                <line className="chart-grid" x1={geo.plot.x} x2={geo.plot.x + geo.plot.w} y1={tick.y} y2={tick.y} />
                <text className="chart-tick" x={geo.plot.x - 8} y={tick.y} textAnchor="end" dominantBaseline="middle">
                  {tick.label}
                </text>
              </g>
            ))}
            {/* Zero, where it is not the bottom of the axis: a chart with
                negative values needs to say where the line is. */}
            {geo.range.min < 0 && (
              <line className="chart-zero" x1={geo.plot.x} x2={geo.plot.x + geo.plot.w} y1={geo.zeroY} y2={geo.zeroY} />
            )}

            {chart.type === 'bar' && geo.bars.map((bar, i) => (
              <rect key={i} x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.colour} rx="2"
                {...inspect(`${bar.label || ''} · ${chart.series[bar.series].name}: ${shown(bar.value, chart.unit)}`)} />
            ))}

            {chart.type === 'area' && geo.lines.map((line, i) => (
              <path key={`a${i}`} d={areaOf(line.points, geo.zeroY)} fill={line.colour} opacity="0.18" />
            ))}

            {(chart.type === 'line' || chart.type === 'area') && geo.lines.map((line, i) => (
              <g key={`l${i}`}>
                <path d={pathOf(line.points)} fill="none" stroke={line.colour} strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
                {line.points.filter(Boolean).map((p, n) => (
                  <circle key={n} cx={p.x} cy={p.y} r="3" fill={line.colour}
                    {...inspect(`${p.label || ''} · ${line.name}: ${shown(p.value, chart.unit)}`)} />
                ))}
              </g>
            ))}

            {/* The labels along the bottom. Every other one when they would
                collide, which on a phone is most of the time. */}
            {geo.labels.map((label, i) => (
              (geo.slotW > 42 || i % 2 === 0) && label.text ? (
                <text key={i} className="chart-label" x={label.x} y={label.y} textAnchor="middle">
                  {label.text}
                </text>
              ) : null
            ))}
          </>
        )}
      </svg>}
      </div>

      {/* What the pointer is on. A line under the chart rather than a floating
          box: it never covers the data, and it works the same on a phone where
          there is no pointer and a tap sets it. */}
      {!curve && <div className={`chart-readout${hover || pinned ? ' is-selected' : ''}`} aria-live="polite"><span className="chart-readout-dot" aria-hidden="true" />{hover?.text || pinned?.text || (ko ? '차트의 항목을 선택하면 값을 볼 수 있어요' : 'Select a chart item to inspect its value')}</div>}

      {/* What was drawn, written out: the equation is the legend of a graph,
          and with two curves on one pair of axes it is the only way to tell
          which is which. */}
      {curve ? (
        <Legend items={chart.curves.map(c => ({ name: c.name, colour: c.colour }))} />
      ) : ((many && chart.type !== 'heatmap') || pie) ? (
        <Legend items={pie
          ? geo.slices.map(s => ({ name: `${s.label || ''} ${sharePercent(s.share)}`.trim(), colour: s.colour }))
          : chart.series.map(s => ({ name: s.name, colour: s.colour }))} />
      ) : null}
      {!curve && <details className="chart-data">
        <summary>{ko ? '데이터 보기' : 'View data'}</summary>
        <button type="button" className="btn-ghost" onClick={() => {
          const url = URL.createObjectURL(new Blob([chartCSV(chart)], { type: 'text/csv;charset=utf-8' }));
          const a = document.createElement('a');
          a.href = url; a.download = 'chart-data.csv'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>{ko ? 'CSV 저장' : 'Download CSV'}</button>
        <div className="chart-data-scroll"><table>
          <thead><tr><th>{ko ? '항목' : 'Label'}</th>{chart.series.map((s, i) => <th key={i}>{s.name || (ko ? '값' : 'Value')}{chart.unit && ` (${chart.unit})`}</th>)}</tr></thead>
          <tbody>{chart.labels.map((label, i) => <tr key={i}><th scope="row">{label || i + 1}</th>{chart.series.map((s, j) => <td key={j}>{s.data[i] ?? '—'}</td>)}</tr>)}</tbody>
        </table></div>
      </details>}
    </figure>
  );
};
