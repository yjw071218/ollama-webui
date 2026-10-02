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
export const Chart = ({ source, t }) => {
  const chart = parseChart(source);
  const [hover, setHover] = useState(null);
  if (!chart) return null;

  const pie = chart.type === 'pie';
  const curve = chart.type === 'function';
  const geo = curve ? null : pie ? plotPie(chart, BOX) : plotAxes(chart, BOX);
  const many = chart.series.length > 1;

  return (
    <figure className="chart-figure">
      {chart.title && <figcaption className="chart-title">{chart.title}</figcaption>}
      <svg
        className="chart-svg"
        viewBox={`0 0 ${BOX.w} ${BOX.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={chart.title || chart.curves?.map(c => c.name).join(', ') || t?.('chart.label') || 'chart'}
      >
        {curve ? (
          <Curves chart={chart} />
        ) : pie ? (
          <>
            {geo.slices.map((slice, i) => (
              <g key={i}
                onMouseEnter={() => setHover({ text: `${slice.label || ''} ${sharePercent(slice.share)}`.trim() })}
                onMouseLeave={() => setHover(null)}>
                <path d={slice.path} fill={slice.colour} stroke="var(--surface)" strokeWidth="1.5" />
                {slice.share > 0.06 && (
                  <text className="chart-slice-label" x={slice.mid.x} y={slice.mid.y}
                    textAnchor="middle" dominantBaseline="middle">
                    {sharePercent(slice.share)}
                  </text>
                )}
              </g>
            ))}
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
                onMouseEnter={() => setHover({ text: `${bar.label ? `${bar.label}: ` : ''}${shown(bar.value, chart.unit)}` })}
                onMouseLeave={() => setHover(null)} />
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
                    onMouseEnter={() => setHover({ text: `${p.label ? `${p.label}: ` : ''}${shown(p.value, chart.unit)}` })}
                    onMouseLeave={() => setHover(null)} />
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
      </svg>

      {/* What the pointer is on. A line under the chart rather than a floating
          box: it never covers the data, and it works the same on a phone where
          there is no pointer and a tap sets it. */}
      {!curve && <div className="chart-readout" aria-live="polite">{hover?.text || ''}</div>}

      {/* What was drawn, written out: the equation is the legend of a graph,
          and with two curves on one pair of axes it is the only way to tell
          which is which. */}
      {curve ? (
        <Legend items={chart.curves.map(c => ({ name: c.name, colour: c.colour }))} />
      ) : (many || pie) ? (
        <Legend items={pie
          ? geo.slices.map(s => ({ name: `${s.label || ''} ${sharePercent(s.share)}`.trim(), colour: s.colour }))
          : chart.series.map(s => ({ name: s.name, colour: s.colour }))} />
      ) : null}
    </figure>
  );
};
