/**
 * A chart, from a fenced block the model wrote.
 *
 * ## Why there is no chart library here
 *
 * The same argument the PDF export makes for using the browser's own printer:
 * the dependency is large, it arrives with its own opinions about fonts and
 * colours, and what is actually wanted is small. A bar chart is a rectangle per
 * value; a line chart is a polyline; a pie is a handful of arcs. Recharts is
 * half a megabyte to draw those, and every one of them would then have to be
 * dragged back into this app's palette by hand.
 *
 * So this is the arithmetic, and it is pure: given a spec it returns the
 * geometry, and the component draws it. Which means the part that is easy to
 * get wrong -- the scale, the ticks, where a bar starts when the data crosses
 * zero -- can be checked with numbers rather than by looking at a picture.
 *
 * ## The spec
 *
 * A fenced ```chart block holding JSON:
 *
 *     { "type": "bar", "title": "…", "labels": [...], "series": [{ "name": "…", "data": [...] }] }
 *
 * `type` is `bar`, `line`, `area` or `pie`. A single unnamed series may be
 * written as `"data": [...]` at the top level. Everything except the numbers is
 * optional -- a model that writes only `data` still gets a chart.
 *
 * ## A curve, rather than a list of numbers
 *
 * `{"type":"function","fn":"r = 4cos3θ"}` draws the equation itself, sampled
 * here. It is a separate shape because it has no labels and no series: there is
 * a domain and an expression, and the points come from evaluating one over the
 * other. `r = …` is drawn in polar coordinates, which is the only way a rose or
 * a spiral is anything but a wave.
 */

import { compile, rightHandSide, looksPolar } from './mathExpr.js';

export const TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'horizontalBar', 'radar', 'heatmap', 'function'];

/* What a model calls a curve when it is not told the word. All the same thing. */
const FUNCTION_TYPES = ['function', 'plot', 'graph', 'curve', 'polar', 'equation', 'math'];

/* The palette. The accent first, because a one-series chart should look like it
   belongs to this app rather than to a charting library; the rest are chosen to
   stay apart at a glance and to survive being printed in grey. */
export const COLOURS = [
  '#d97757', '#4a8fb5', '#7ba05b', '#c9a227', '#8d6cab', '#4fa8a0', '#c4657f', '#6b7a8f',
];

/* A value as a number, and null for anything that is not one.
 *
 * The explicit checks first, because `Number(null)`, `Number('')` and
 * `Number([])` are all 0 and all finite -- so a missing point in a series would
 * become a real zero and the line would dive to the axis instead of breaking.
 * The same trap has cost this codebase an evening three times over. */
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean' || Array.isArray(value)) return null;
  const n = typeof value === 'string' ? Number(value.replace(/[, ]/g, '')) : Number(value);
  return Number.isFinite(n) ? n : null;
};

/* The expressions a block holds, in the order they were written.
 *
 * Every key a model reaches for, because there is no way for it to find out
 * which one this reads and a refused block looks to the reader like the feature
 * does not exist. One expression, a list of them, or a list of objects with
 * names on them -- all three are written in practice. */
const expressionsIn = (raw) => {
  const written = [];
  const take = (value, name = '') => {
    if (typeof value === 'string' && value.trim()) written.push({ text: value.trim(), name: String(name || '').trim() });
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value.fn ?? value.expr ?? value.expression ?? value.equation ?? value.f ?? value.y ?? value.r;
      take(inner, value.name ?? value.label ?? name);
    }
  };
  for (const key of ['functions', 'curves', 'fn', 'fns', 'expr', 'expression', 'equation', 'equations', 'f', 'y', 'r', 'formula']) {
    const value = raw[key];
    if (Array.isArray(value)) value.forEach(v => take(v));
    else take(value);
    if (written.length) break;
  }
  return written;
};

/* A domain as written: `[0, 6.28]`, `{"min":-5,"max":5}`, or nothing. */
const domainIn = (raw, fallback) => {
  const given = raw.domain ?? raw.range ?? raw.x ?? raw.xRange ?? raw.x_range ?? raw.theta ?? raw.t;
  const pair = Array.isArray(given) ? given
    : (given && typeof given === 'object' ? [given.min ?? given.from, given.max ?? given.to] : null);
  if (!pair) return fallback;
  const min = num(pair[0]);
  const max = num(pair[1]);
  if (min === null || max === null || !(max > min)) return fallback;
  // A domain wider than this is a mistake nobody meant, and it turns every
  // curve into a flat line through the middle of the box.
  const span = Math.min(max - min, 1e6);
  return { min, max: min + span };
};

/**
 * A curve, from an equation.
 *
 * The expression is compiled once here rather than at every sample, and a spec
 * whose expression does not compile is not a chart at all -- the block falls
 * back to being shown as the code it is, which at least lets the reader see
 * what was written.
 */
const parseFunction = (raw, asked, written) => {
  const polar = raw.polar !== undefined ? !!raw.polar
    : (asked === 'polar' || written.some(w => looksPolar(w.text)));

  const curves = written
    .map((w, i) => {
      const body = rightHandSide(w.text);
      const fn = compile(body);
      return fn ? {
        name: w.name || w.text,
        source: body,
        fn,
        colour: COLOURS[i % COLOURS.length],
      } : null;
    })
    .filter(Boolean);
  if (!curves.length) return null;

  return {
    type: 'function',
    title: String(raw.title || '').trim(),
    unit: String(raw.unit || '').trim(),
    polar,
    // A full turn for a polar curve, so a rose closes; the usual window either
    // side of the origin for the rest.
    domain: domainIn(raw, polar ? { min: 0, max: Math.PI * 2 } : { min: -10, max: 10 }),
    curves,
    labels: [],
    series: [],
  };
};

/**
 * The spec a fenced block holds, or null if it is not one.
 *
 * Forgiving on purpose: a model writing JSON gets trailing commas, single
 * quotes and stray prose around it often enough that refusing them would make
 * the feature work three times in four. What it will not do is guess at
 * numbers -- a series whose values do not parse is not a chart.
 */
export const parseChart = (source) => {
  // Generated JSON can be syntactically valid but contain uncoercible objects.
  // Treat it like an invalid chart so the caller can display the source.
  try { return parseChartSpec(source); } catch { return null; }
};

const parseChartSpec = (source) => {
  const text = String(source || '').trim();
  if (!text) return null;

  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    /* One retry, for the JSON models actually write: trailing commas before a
       closing brace, and single-quoted keys. Anything past that is not a near
       miss and is left to fail. */
    try {
      raw = JSON.parse(text
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'/g, '"'));
    } catch (e2) {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  /* A curve, if there is an expression to draw. Also when the block says it is
     one and the expression is under some other key, because `fn`, `expr`,
     `equation` and `f` are all names a model reaches for. */
  const asked = String(raw.type || '').toLowerCase();
  const written = expressionsIn(raw);
  if (written.length && (FUNCTION_TYPES.includes(asked) || !Array.isArray(raw.data))) {
    return parseFunction(raw, asked, written);
  }

  /* Past here there is no expression, so a block claiming to be a curve is a
     list of numbers that called itself one. Those are drawn as a line, never as
     a curve: the shape below has no `curves` for the renderer to draw. */
  const type = asked === 'horizontalbar' ? 'horizontalBar' : asked === 'doughnut' ? 'donut' : asked === 'function' ? 'line'
    : TYPES.includes(asked) ? asked
      : 'bar';

  /* One unnamed series may be written as `data` at the top level, which is what
     a model writes when asked for "a chart of these five numbers". */
  const given = Array.isArray(raw.series) && raw.series.length
    ? raw.series
    : (Array.isArray(raw.data) ? [{ name: raw.name || '', data: raw.data }] : []);

  const series = given
    .map((s, i) => ({
      name: String(s?.name ?? `Series ${i + 1}`),
      data: (Array.isArray(s?.data) ? s.data : []).map(num),
      colour: typeof s?.colour === 'string' ? s.colour
        : typeof s?.color === 'string' ? s.color
          : COLOURS[i % COLOURS.length],
    }))
    .filter(s => s.data.some(v => v !== null));

  if (!series.length) return null;

  const longest = Math.max(...series.map(s => s.data.length));
  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .slice(0, longest)
    .map(l => String(l ?? ''));
  while (labels.length < longest) labels.push('');

  return {
    type,
    title: String(raw.title || '').trim(),
    // What the numbers are, for the axis: "%", "원", "ms".
    unit: String(raw.unit || '').trim(),
    labels,
    series: series.map(s => ({
      ...s,
      // Every series the length of the longest, so a point lines up with its
      // label whichever series it is in.
      data: Array.from({ length: longest }, (_, i) => s.data[i] ?? null),
    })),
    stacked: !!raw.stacked,
  };
};

/* ------------------------------------------------------------- the scale */

/**
 * A round number at or above `value`, for the top of an axis.
 *
 * An axis that ends at 8,347 has a top gridline nobody can read against. The
 * usual 1-2-5 ladder gives 10,000 instead, and the gridlines below it land on
 * numbers that mean something.
 */
export const niceCeiling = (value) => {
  const v = Math.abs(Number(value) || 0);
  if (v === 0) return 1;
  const power = 10 ** Math.floor(Math.log10(v));
  const scaled = v / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * power * Math.sign(Number(value) || 1);
};

/**
 * The range an axis covers.
 *
 * Zero is in it, unless the caller says otherwise: a bar chart whose axis
 * starts at 95 turns a two per cent difference into a fourfold one, which is
 * the oldest way there is to mislead with a chart, and it is done by accident
 * far more often than on purpose.
 *
 * `zero: false` is for a line chart, where the shape of the change is the
 * point and a flat line pinned to the bottom of a tall empty box says nothing.
 * Only line charts ask for it.
 */
export const axisRange = (values, { zero = true } = {}) => {
  const numbers = values.filter(v => v !== null && Number.isFinite(v));
  if (!numbers.length) return { min: 0, max: 1 };
  let min = Infinity, max = -Infinity;
  for (const value of numbers) { min = Math.min(min, value); max = Math.max(max, value); }
  if (zero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    // A flat series still needs a box to be drawn in.
    if (max === 0) return { min: 0, max: 1 };
    return max > 0 ? { min: 0, max: niceCeiling(max) } : { min: niceCeiling(min), max: 0 };
  }
  /* Rounded outward only where zero is in the range: that is the case where
     the axis is a scale of magnitude and a round top makes the gridlines
     readable. A line chart hugging its own data would be pushed back down to
     a flat line by rounding, which is the thing `zero: false` exists to
     avoid. */
  if (!zero) return { min, max };
  return {
    min: min < 0 ? niceCeiling(min) : min,
    max: max > 0 ? niceCeiling(max) : max,
  };
};

/** Where the gridlines go: round numbers, four or five of them. */
export const ticksFor = ({ min, max }, count = 4) => {
  if (!(max > min)) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round((min + step * i) * 1e6) / 1e6);
};

/** A number as an axis label: short, and without a tail of decimals. */
export const tickLabel = (value, unit = '') => {
  const v = Number(value) || 0;
  const abs = Math.abs(v);
  const text = abs >= 1_000_000 ? `${Math.round(v / 100_000) / 10}M`
    : abs >= 10_000 ? `${Math.round(v / 1000)}k`
      : abs >= 1000 ? `${Math.round(v / 100) / 10}k`
        : Math.round(v * 100) / 100;
  return `${text}${unit}`;
};

/* ------------------------------------------------------------ the geometry

   All of it in one coordinate space: a 0..W by 0..H box the component puts in a
   `viewBox`, so the chart scales to whatever width it is given without any of
   these numbers changing. */

export const BOX = { w: 640, h: 320, top: 16, right: 16, bottom: 34, left: 46 };

const plotOf = (box) => ({
  x: box.left,
  y: box.top,
  w: box.w - box.left - box.right,
  h: box.h - box.top - box.bottom,
});

/**
 * Where every mark goes, for a chart with an axis.
 *
 * Returned rather than drawn, so the arithmetic can be read back as numbers:
 * `bars[0].y` is a number a test can check, where "the first bar looks right"
 * is not.
 */
export const plotAxes = (chart, box = BOX) => {
  const plot = plotOf(box);
  const all = chart.series.flatMap(s => s.data);
  const stackedTotals = chart.stacked
    ? chart.labels.map((_, i) => chart.series.reduce((sum, s) => sum + (s.data[i] || 0), 0))
    : [];
  const range = axisRange(chart.stacked ? stackedTotals : all, { zero: chart.type !== 'line' });
  const span = range.max - range.min || 1;
  const yOf = (value) => plot.y + plot.h - ((value - range.min) / span) * plot.h;
  const zeroY = yOf(Math.min(Math.max(0, range.min), range.max));

  const slots = Math.max(chart.labels.length, 1);
  const slotW = plot.w / slots;

  const ticks = ticksFor(range).map(value => ({ value, y: yOf(value), label: tickLabel(value, chart.unit) }));

  /* Bars share their slot; a stacked chart puts them on top of each other
     instead. The gap is a fifth of the slot so that neighbouring groups are
     told apart without the bars becoming threads. */
  const groups = chart.stacked ? 1 : chart.series.length;
  const barW = (slotW * 0.8) / groups;

  const bars = [];
  const lines = [];
  chart.series.forEach((s, si) => {
    const points = [];
    let running = chart.labels.map(() => 0);
    s.data.forEach((value, i) => {
      if (value === null) { points.push(null); return; }
      const cx = plot.x + slotW * i + slotW / 2;
      points.push({ x: cx, y: yOf(value), value, label: chart.labels[i] });
      if (chart.type === 'bar') {
        const below = chart.stacked
          ? chart.series.slice(0, si).reduce((sum, prev) => sum + (prev.data[i] || 0), 0)
          : 0;
        const top = yOf(below + value);
        const bottom = chart.stacked ? yOf(below) : zeroY;
        bars.push({
          series: si,
          colour: s.colour,
          x: chart.stacked ? cx - barW / 2 : plot.x + slotW * i + slotW * 0.1 + barW * si,
          y: Math.min(top, bottom),
          w: barW,
          h: Math.max(1, Math.abs(bottom - top)),
          value,
          label: chart.labels[i],
        });
      }
      running = running.map((r, n) => (n === i ? r + value : r));
    });
    lines.push({ series: si, colour: s.colour, name: s.name, points });
  });

  return {
    box,
    plot,
    range,
    ticks,
    slotW,
    zeroY,
    bars,
    lines,
    labels: chart.labels.map((text, i) => ({ text, x: plot.x + slotW * i + slotW / 2, y: box.h - box.bottom + 16 })),
  };
};

/** A polyline through the points a series has, skipping the gaps. */
export const pathOf = (points) => points
  .filter(Boolean)
  .map((p, i) => `${i === 0 ? 'M' : 'L'}${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`)
  .join(' ');

/** The same, closed down to the baseline, for an area chart. */
export const areaOf = (points, baseY) => {
  const kept = points.filter(Boolean);
  if (!kept.length) return '';
  const line = pathOf(kept);
  const first = kept[0];
  const last = kept[kept.length - 1];
  return `${line} L${Math.round(last.x * 100) / 100} ${baseY} L${Math.round(first.x * 100) / 100} ${baseY} Z`;
};

/* ---------------------------------------------------------------- a curve

   Sampled rather than solved: the expression is evaluated at a few hundred
   places and the points joined up, which is what every plotter does and is
   exact enough at the size a chart is drawn. */

/** How many places a curve is evaluated at. Half a degree, for a polar turn. */
export const SAMPLES = 721;

/** The curve, as `{ at, value }` pairs, with null where it is undefined. */
export const sampleCurve = (fn, { min, max }, count = SAMPLES) => {
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const at = min + step * i;
    const value = fn(at);
    return value === null ? null : { at, value };
  });
};

/**
 * The window a curve should be drawn in.
 *
 * Not simply its smallest and largest value: `tan` reaches ten million next to
 * its asymptote, and an axis that holds that draws every other part of the
 * curve as a flat line on zero. So where the extremes are far outside the bulk
 * of the curve, the bulk wins and the extremes run off the top -- which is how
 * a tangent is drawn on paper too.
 */
export const curveRange = (values) => {
  const sorted = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { min: 0, max: 1 };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const lo = at(0.02);
  const hi = at(0.98);
  let min = sorted[0];
  let max = sorted[sorted.length - 1];
  if (hi > lo && (max - min) > (hi - lo) * 4) { min = lo; max = hi; }
  if (!(max > min)) { min -= 1; max += 1; }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
};

/** A step on the 1-2-5 ladder, for gridlines that land on readable numbers. */
export const niceStep = (raw) => {
  const v = Math.abs(raw) || 1;
  const power = 10 ** Math.floor(Math.log10(v));
  const scaled = v / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power;
};

/**
 * Gridlines at round numbers inside a range.
 *
 * Different from `ticksFor`, which divides the range into equal parts: that is
 * right for a bar chart, whose axis was itself rounded, and wrong here, where
 * the range comes from the curve and dividing it by four gives gridlines at
 * 1.083 and 2.166. Zero is always one of these when it is in range, which is
 * what makes a graph readable.
 */
export const niceTicks = ({ min, max }, count = 4) => {
  const lines = (step) => {
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      out.push(Math.round(v * 1e6) / 1e6);
    }
    return out;
  };
  const step = niceStep((max - min) / count);
  /* Rounding the step up can leave a range with one gridline in it -- ±4.32
     rounds to a step of 5 and draws only the origin. Half a round step is still
     a round step. */
  const first = lines(step);
  return first.length >= 3 ? first : lines(step / 2);
};

/** A polyline that stops and starts again at every gap. */
export const brokenPathOf = (points) => {
  let d = '';
  let drawing = false;
  for (const p of points) {
    if (!p) { drawing = false; continue; }
    const x = Math.round(p.x * 100) / 100;
    const y = Math.round(p.y * 100) / 100;
    d += `${d ? ' ' : ''}${drawing ? 'L' : 'M'}${x} ${y}`;
    drawing = true;
  }
  return d;
};

/**
 * Where a curve goes.
 *
 * Polar is not a different kind of chart, only a different way of reading the
 * same samples: `r = f(θ)` is the point `(r·cosθ, r·sinθ)`, and the one thing
 * that must not be got wrong is the aspect -- a circle drawn in a box twice as
 * wide as it is tall is an ellipse, and the reader has no way of telling that
 * the picture and not the equation put it there. So the two axes get the same
 * scale and the drawing is centred in whatever is left.
 */
export const plotFunction = (chart, box = BOX) => {
  const plot = plotOf(box);
  const samples = chart.curves.map(c => sampleCurve(c.fn, chart.domain));

  const traced = chart.polar
    ? samples.map(rows => rows.map(row => (row === null ? null : {
      x: row.value * Math.cos(row.at),
      y: row.value * Math.sin(row.at),
    })))
    : samples.map(rows => rows.map(row => (row === null ? null : { x: row.at, y: row.value })));

  const every = traced.flat().filter(Boolean);
  let xRange;
  let yRange;
  if (chart.polar) {
    // Square and centred on the origin: that is what makes a circle a circle.
    // Folded rather than spread: a few thousand samples is more arguments than
    // `Math.max(...)` is safe with, and it fails as a stack overflow.
    const reach = every.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y)), 1e-6) * 1.08;
    xRange = { min: -reach, max: reach };
    yRange = { min: -reach, max: reach };
  } else {
    xRange = { ...chart.domain };
    yRange = curveRange(every.map(p => p.y));
  }

  const spanX = xRange.max - xRange.min || 1;
  const spanY = yRange.max - yRange.min || 1;
  const scale = chart.polar
    ? Math.min(plot.w / spanX, plot.h / spanY)
    : null;
  const sx = scale ?? plot.w / spanX;
  const sy = scale ?? plot.h / spanY;
  const left = plot.x + (plot.w - spanX * sx) / 2;
  const bottom = plot.y + (plot.h + spanY * sy) / 2;
  const xOf = (v) => left + (v - xRange.min) * sx;
  const yOf = (v) => bottom - (v - yRange.min) * sy;

  const curves = chart.curves.map((c, i) => {
    const screen = [];
    let last = null;
    for (const p of traced[i]) {
      // Outside the window is a gap, not a point pinned to the edge: pinning
      // one draws a false flat line along the top of an asymptote.
      if (!p || p.y < yRange.min || p.y > yRange.max) { screen.push(null); last = null; continue; }
      const point = { x: xOf(p.x), y: yOf(p.y), at: p.x, value: p.y };
      // And a jump of more than the whole box between neighbouring samples is
      // an asymptote the sampling stepped over rather than a line to draw.
      if (last && Math.abs(point.y - last.y) > plot.h) screen.push(null);
      screen.push(point);
      last = point;
    }
    return { name: c.name, colour: c.colour, source: c.source, points: screen, path: brokenPathOf(screen) };
  });

  return {
    box,
    plot,
    polar: !!chart.polar,
    xRange,
    yRange,
    xTicks: niceTicks(xRange).map(value => ({ value, x: xOf(value), label: tickLabel(value) })),
    yTicks: niceTicks(yRange).map(value => ({ value, y: yOf(value), label: tickLabel(value, chart.unit) })),
    // Where the axes cross, kept inside the box so they are always drawable.
    axisX: Math.min(Math.max(yOf(0), plot.y), plot.y + plot.h),
    axisY: Math.min(Math.max(xOf(0), plot.x), plot.x + plot.w),
    curves,
  };
};

/* ------------------------------------------------------------------ a pie */

/** One slice's wedge, as an SVG path. */
export const wedge = (cx, cy, r, from, to) => {
  // A full circle cannot be drawn as one arc: the start and the end are the
  // same point and the renderer draws nothing at all.
  if (to - from >= Math.PI * 2 - 1e-9) {
    return `M${cx - r} ${cy} A${r} ${r} 0 1 1 ${cx + r} ${cy} A${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
  }
  const x1 = cx + r * Math.cos(from);
  const y1 = cy + r * Math.sin(from);
  const x2 = cx + r * Math.cos(to);
  const y2 = cy + r * Math.sin(to);
  const large = to - from > Math.PI ? 1 : 0;
  const p = (n) => Math.round(n * 100) / 100;
  return `M${p(cx)} ${p(cy)} L${p(x1)} ${p(y1)} A${p(r)} ${p(r)} 0 ${large} 1 ${p(x2)} ${p(y2)} Z`;
};

/**
 * The slices of a pie, starting at twelve o'clock and going clockwise.
 *
 * Only the first series: a pie of two series is two pies, and drawing them on
 * top of each other is how a chart lies. Negative values are dropped rather
 * than mirrored -- there is no such thing as a negative share of a whole.
 */
export const plotPie = (chart, box = BOX) => {
  const values = (chart.series[0]?.data || []).map(v => (v === null || v < 0 ? 0 : v));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = box.w / 2;
  const cy = box.h / 2;
  const r = Math.min(box.w, box.h) / 2 - box.top - 6;
  if (!(total > 0)) return { slices: [], cx, cy, r, total: 0 };

  let angle = -Math.PI / 2;
  const slices = values.map((value, i) => {
    const sweep = (value / total) * Math.PI * 2;
    const slice = {
      value,
      share: value / total,
      label: chart.labels[i] || '',
      colour: COLOURS[i % COLOURS.length],
      path: wedge(cx, cy, r, angle, angle + sweep),
      // Where a label would sit, halfway round and halfway out.
      mid: {
        x: cx + (r * 0.62) * Math.cos(angle + sweep / 2),
        y: cy + (r * 0.62) * Math.sin(angle + sweep / 2),
      },
    };
    angle += sweep;
    return slice;
  });
  return { slices: slices.filter(s => s.value > 0), cx, cy, r, total };
};

/** A share as a percentage, for a pie's labels. */
export const sharePercent = (share) => `${Math.round(share * 1000) / 10}%`;

/** Geometry shared by the additional infographic views. Null stays a gap. */
export const plotInfographic = (chart, box = BOX) => {
  const values = chart.series.flatMap(s => s.data).filter(v => v !== null);
  const range = axisRange(values);
  const span = range.max - range.min || 1;
  const left = 115, width = box.w - left - 20;
  const rows = chart.labels.length * chart.series.length;
  const height = Math.max(box.h, rows * 28 + 40);
  const zero = left + (0 - range.min) / span * width;
  const bars = chart.labels.flatMap((label, i) => chart.series.flatMap((s, si) => {
    const value = s.data[i];
    if (value === null) return [];
    const end = left + (value - range.min) / span * width;
    return [{ label, name: s.name, value, colour: s.colour, x: Math.min(zero, end),
      y: 20 + (i * chart.series.length + si) * ((height - 40) / rows),
      w: Math.abs(end - zero), h: Math.min(22, (height - 40) / rows - 4) }];
  }));
  const cx = box.w / 2, cy = box.h / 2, radius = 112;
  const point = (i, fraction) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / chart.labels.length;
    return { x: cx + Math.cos(angle) * radius * fraction, y: cy + Math.sin(angle) * radius * fraction };
  };
  const spokes = chart.labels.map((label, i) => ({ label, ...point(i, 1.2), end: point(i, 1) }));
  const polygons = chart.series.map(s => ({ ...s, points: s.data.map((value, i) =>
    value === null ? null : { ...point(i, (value - range.min) / span), value, label: chart.labels[i] }) }));
  const cellW = width / chart.labels.length, cellH = 36;
  const cells = chart.series.flatMap((s, si) => s.data.map((value, i) => ({
    value, label: chart.labels[i], name: s.name, colour: COLOURS[0],
    x: left + i * cellW, y: 30 + si * cellH, w: cellW, h: cellH,
    opacity: value === null ? 0 : 0.15 + 0.85 * (value - range.min) / span,
  })));
  return { range, bars, height, zero, cx, cy, spokes, polygons, cells, cellW, cellH, left };
};

export const chartCSV = (chart) => {
  const quote = (value) => {
    // Text cells must not become spreadsheet formulas when opened in Excel.
    const text = String(value ?? '');
    const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + [ ['Label', ...chart.series.map(s => s.name || 'Value')],
    ...chart.labels.map((label, i) => [label, ...chart.series.map(s => s.data[i])]) ]
    .map(row => row.map(quote).join(',')).join('\r\n');
};
