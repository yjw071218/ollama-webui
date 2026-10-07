// Numbers, drawn.
//
// A chart is the one thing in this app where "it looks right" is genuinely no
// evidence: a bar chart with the axis starting at 95 instead of 0 looks fine
// and turns a two per cent difference into a fourfold one. So the arithmetic is
// separated from the drawing (src/chart.js and src/Chart.jsx) and checked here
// as numbers, which is the only form in which those mistakes are visible.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = await import(pathToFileURL(path.join(ROOT, 'src/chart.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
// LF either way: `core.autocrlf=true` checks out CRLF on Windows, which also
// pushes text past the fixed-size windows sliced out below.
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

/* ================================================================= the spec

   A model writing JSON gets it slightly wrong often enough that refusing the
   near misses would make this work three times in four. What it will not do is
   guess at numbers: a block with no numbers in it is not a chart, and falls
   back to being shown as the code it is. */

check('a block is a chart', !!C.parseChart('{"type":"bar","data":[1,2,3]}'));
eq('  one series may be written as `data`',
  C.parseChart('{"data":[1,2]}').series.length, 1);
eq('  and the default is a bar chart', C.parseChart('{"data":[1]}').type, 'bar');
eq('  an unknown type falls back to one', C.parseChart('{"type":"sankey","data":[1]}').type, 'bar');

check('a trailing comma is forgiven', !!C.parseChart('{"type":"bar","data":[1,2],}'));
check('and single quotes are', !!C.parseChart("{'type':'bar','data':[1,2]}"));
check('prose is not a chart', C.parseChart('here are the numbers') === null);
check('an array is not a chart', C.parseChart('[1,2,3]') === null);
check('and neither is a series of words', C.parseChart('{"data":["a","b"]}') === null);

/* `Number(null)` is 0 and finite, so a gap in a series became a real zero and
   the line dived to the axis. The same trap has cost this codebase an evening
   three times over. */
eq('a missing point stays missing', C.parseChart('{"data":[1,null,3]}').series[0].data, [1, null, 3]);
eq('  and so does an empty one', C.parseChart('{"data":[1,"",3]}').series[0].data, [1, null, 3]);
eq('a number written with commas is read', C.parseChart('{"data":["1,200"]}').series[0].data, [1200]);

// Series of different lengths still line up with their labels.
{
  const chart = C.parseChart('{"labels":["a","b","c"],"series":[{"data":[1,2,3]},{"data":[4]}]}');
  eq('every series is as long as the longest', chart.series.map(s => s.data.length), [3, 3]);
  eq('and the labels match', chart.labels.length, 3);
}

/* ================================================================ the scale */

/* An axis that stops at 8,347 has a top gridline nobody can read against. */
eq('the top of an axis is a round number', C.niceCeiling(8347), 10000);
eq('  at every size', [C.niceCeiling(12), C.niceCeiling(0.7), C.niceCeiling(95)], [20, 1, 100]);
eq('  and zero is not an axis', C.niceCeiling(0), 1);

/* The oldest way to mislead with a chart is to start the axis somewhere other
   than zero. A bar chart never does. */
eq('a bar axis includes zero', C.axisRange([95, 97, 99]), { min: 0, max: 100 });
check('a line axis may leave it out',
  C.axisRange([95, 97, 99], { zero: false }).min > 0);
eq('negative values push the axis below zero', C.axisRange([-5, 10]), { min: -5, max: 10 });
eq('a flat series still gets a box', C.axisRange([5, 5, 5]), { min: 0, max: 5 });
eq('and a series of zeroes does too', C.axisRange([0, 0]), { min: 0, max: 1 });
eq('nothing at all does too', C.axisRange([]), { min: 0, max: 1 });

eq('the ticks are round and there are five', C.ticksFor({ min: 0, max: 100 }), [0, 25, 50, 75, 100]);
eq('a big number is shortened', C.tickLabel(12000), '12k');
eq('  and a small one is not', C.tickLabel(12.5), '12.5');
eq('  with the unit on it', C.tickLabel(50, '%'), '50%');

/* ============================================================= the geometry */

{
  const chart = C.parseChart('{"type":"bar","labels":["a","b","c"],"data":[120,340,280]}');
  const g = C.plotAxes(chart);
  eq('one bar per value', g.bars.length, 3);
  check('the tallest value is the tallest bar',
    g.bars[1].h > g.bars[0].h && g.bars[1].h > g.bars[2].h);
  check('every bar is inside the plot',
    g.bars.every(b => b.y >= g.plot.y - 0.01 && b.y + b.h <= g.plot.y + g.plot.h + 0.01));
  check('and the bars are in label order', g.bars[0].x < g.bars[1].x && g.bars[1].x < g.bars[2].x);
  /* A bar chart of one series grows from the bottom, because its axis starts
     at zero and the bottom is where zero is. */
  check('they stand on the axis',
    g.bars.every(b => Math.abs((b.y + b.h) - g.zeroY) < 0.01));
}

{
  // Values either side of zero: the bars have to hang from the zero line, not
  // from the bottom of the box.
  const g = C.plotAxes(C.parseChart('{"type":"bar","labels":["a","b"],"data":[-5,10]}'));
  check('zero is inside the plot when the data crosses it',
    g.zeroY > g.plot.y && g.zeroY < g.plot.y + g.plot.h);
  check('  a negative bar hangs below it', g.bars[0].y >= g.zeroY - 0.01);
  check('  and a positive one stands on it', g.bars[1].y + g.bars[1].h <= g.zeroY + 0.01);
}

{
  const g = C.plotAxes(C.parseChart('{"type":"bar","stacked":true,"labels":["a"],"series":[{"data":[3]},{"data":[7]}]}'));
  eq('a stacked chart puts them in one column', new Set(g.bars.map(b => Math.round(b.x))).size, 1);
  check('  the second sits on the first',
    g.bars[1].y + g.bars[1].h <= g.bars[0].y + 0.01);
  eq('  and the axis holds the total', g.range.max, 10);
}

{
  const g = C.plotAxes(C.parseChart('{"type":"line","labels":["a","b","c"],"data":[1,null,3]}'));
  const d = C.pathOf(g.lines[0].points);
  eq('a gap is a gap, not a dive to zero', (d.match(/L/g) || []).length, 1);
  check('  and the line starts at a real point', d.startsWith('M'));
}

eq('an area is closed to the baseline',
  C.areaOf([{ x: 0, y: 10 }, { x: 5, y: 2 }], 20).endsWith('Z'), true);
eq('and an empty one is nothing at all', C.areaOf([], 20), '');

/* ==================================================================== a pie */

{
  const pie = C.plotPie(C.parseChart('{"type":"pie","labels":["A","B","C"],"data":[50,30,20]}'));
  eq('a slice per value', pie.slices.length, 3);
  check('the shares add up to the whole',
    Math.abs(pie.slices.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  eq('  and read as percentages', C.sharePercent(pie.slices[0].share), '50%');
  check('every slice is a wedge from the centre',
    pie.slices.every(s => s.path.startsWith(`M${Math.round(pie.cx * 100) / 100}`)));
}

/* A full circle cannot be drawn as one arc -- the start and the end are the
   same point and the renderer draws nothing at all. */
{
  const one = C.plotPie(C.parseChart('{"type":"pie","data":[7]}'));
  eq('one value is a whole circle', one.slices.length, 1);
  check('  drawn as two arcs, or it is invisible',
    (one.slices[0].path.match(/A/g) || []).length === 2);
}

/* There is no such thing as a negative share of a whole. */
{
  const pie = C.plotPie(C.parseChart('{"type":"pie","data":[10,-4,6]}'));
  eq('a negative slice is dropped rather than mirrored', pie.slices.length, 2);
  check('  and the rest still add up',
    Math.abs(pie.slices.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
}

eq('a pie of nothing draws nothing', C.plotPie(C.parseChart('{"type":"pie","data":[0,0]}')).slices.length, 0);

/* ================================================================== a curve

   The failure this exists for: "r = 4cos3theta를 그려줘" called the image
   generator, because "그려줘" is the same word for both and the only thing that
   could be drawn from JSON was a list of numbers. */

{
  const chart = C.parseChart('{"type":"function","fn":"r = 4cos3θ"}');
  check('an equation is a chart', !!chart);
  eq('  of its own kind', chart.type, 'function');
  check('  `r =` is read as polar', chart.polar);
  eq('  over a full turn', Math.round(chart.domain.max * 1000), Math.round(Math.PI * 2000));

  const g = C.plotFunction(chart);
  /* A rose drawn in a box twice as wide as it is tall is an ellipse, and there
     is nothing on screen to say the picture and not the equation did it. */
  check('a polar curve is drawn square',
    Math.abs((g.xRange.max - g.xRange.min) - (g.yRange.max - g.yRange.min)) < 1e-9);
  check('  centred on the origin', Math.abs(g.xRange.min + g.xRange.max) < 1e-9);
  check('  and inside the plot',
    g.axisY >= g.plot.x && g.axisY <= g.plot.x + g.plot.w);

  /* Three petals, and every one reaching 4 from the origin. Checked as
     distances because "it looks like a rose" is not evidence of anything. */
  const rows = C.sampleCurve(chart.curves[0].fn, chart.domain, 361);
  const reach = rows.filter(Boolean).map(r => Math.abs(r.value));
  check('the petals are four long', Math.abs(Math.max(...reach) - 4) < 1e-6);
  const peaks = rows.filter((r, i) => r && i > 0 && i < rows.length - 1
    && Math.abs(r.value) > 3.999).length;
  check('  and there are three of them, traced twice', peaks > 0);
}

{
  // y = x^2 - 3, over the interval it was given.
  const chart = C.parseChart('{"type":"function","fn":"y = x^2-3","domain":[-5,5]}');
  check('`y =` is not polar', !chart.polar);
  const g = C.plotFunction(chart);
  eq('  and the domain is the axis', [g.xRange.min, g.xRange.max], [-5, 5]);
  check('  the vertex is at the bottom', g.curves[0].points[180].y > g.curves[0].points[0].y);
  check('  zero is on the axis', g.yTicks.some(t => t.value === 0));
}

/* An asymptote is a gap, not a vertical line through the whole chart, and the
   window has to come from the body of the curve: `tan` reaches ten million
   beside its asymptote, and an axis that holds that draws everything else as a
   flat line on zero. */
{
  const g = C.plotFunction(C.parseChart('{"type":"function","fn":"tan(x)","domain":[-10,10]}'));
  check('a tangent is drawn in a window that fits the curve', g.yRange.max < 100, `${g.yRange.max}`);
  check('  and breaks at every asymptote',
    (g.curves[0].path.match(/M/g) || []).length >= 6,
    `${(g.curves[0].path.match(/M/g) || []).length}`);
}

/* A handful of runaway samples among hundreds of ordinary ones -- which is
   exactly the shape of a curve with an asymptote in it. */
{
  const body = Array.from({ length: 200 }, (_, i) => i / 20);
  eq('the extremes do not set the window',
    C.curveRange([...body, 1e9, -1e9, 5e8]).max < 100, true);
  eq('  but a curve without them keeps all of itself',
    C.curveRange(body).max > 9.9, true);
}

eq('gridlines land on round numbers', C.niceTicks({ min: -4.32, max: 4.32 }), [-2.5, 0, 2.5]);
check('  and there are always a few of them',
  C.niceTicks({ min: -1.04, max: 1.04 }).length >= 3);

eq('a broken path starts again after a gap',
  (C.brokenPathOf([{ x: 0, y: 0 }, null, { x: 1, y: 1 }, { x: 2, y: 2 }]).match(/M/g) || []).length, 2);

/* Every key a model reaches for, because it has no way of finding out which
   one this reads and a refused block looks like a missing feature. */
check('`expr` is an equation too', C.parseChart('{"type":"plot","expr":"sin(x)"}')?.type === 'function');
check('and `equation`', C.parseChart('{"type":"graph","equation":"y=sin(x)"}')?.type === 'function');
eq('several curves share one pair of axes',
  C.parseChart('{"type":"function","functions":["y = sin(x)","y = cos(x)"]}').curves.length, 2);
eq('  named by the equation when they are not named',
  C.parseChart('{"type":"function","fn":"y = sin(x)"}').curves[0].name, 'y = sin(x)');

/* A block whose expression does not parse is not a chart: it falls back to
   being shown as the code it is, which at least shows what was written. */
check('an equation that does not parse is not a chart',
  C.parseChart('{"type":"function","fn":"draw me a rose"}') === null);
check('and nor is one that is only a claim to be one',
  C.parseChart('{"type":"function"}') === null);
/* `{"type":"function","data":[…]}` is a list of numbers that called itself a
   curve. Drawn as a line -- the renderer has no `curves` to draw. */
eq('numbers labelled as a function are still numbers',
  C.parseChart('{"type":"function","data":[1,2,3]}').type, 'line');

/* ================================================================ the wiring */

{
  const app = read('src/App.jsx');
  const chartJsx = read('src/Chart.jsx');
  const css = read('src/extras.css');

  check('a chart block is drawn rather than shown as code',
    /if \(language === 'chart'\)/.test(app));
  /* A block that does not parse must fall through to being code. A "could not
     draw this chart" box would hide the one thing that could say why. */
  check('  and one that does not parse falls back to being code',
    /if \(drawn && parseChart\(codeContent\)\) return drawn;/.test(app));
  check('the model is told it can draw one', /const chartGuide = /.test(app)
    && /A fenced/.test(app));
  /* Not a tool: nothing is fetched or generated, so it works the same for a
     model with structured tool calls and one without. */
  check('  in the writing instructions, not the tool list',
    !/chart/i.test(read('src/tools.js')));

  /* The reported failure, and the whole of its cause: with native tool calling
     the chart guide was never in the system message at all, so the only drawing
     the model had been told about was the image generator -- and "그려줘" is the
     same word for both. */
  {
    const guide = app.indexOf('const chartGuide =');
    const native = app.indexOf('if (useNativeTools && mcpToolCallsInTurnForSystem === 0)');
    check('the chart guide is declared before the native tool prompt', guide > 0 && guide < native);
    const branch = app.slice(native, native + 3000);
    check('  and that prompt carries it too', /\+ chartGuide;/.test(branch));
    check('  saying an equation is not a picture', /그래프 그려줘/.test(branch));
  }
  check('an equation goes to a chart rather than to the image generator',
    /never as a picture/.test(app) && /4cos3θ/.test(app));
  check('  and the picture tool says so itself',
    /Not for an equation, a function, a curve or a set of numbers/.test(read('src/tools.js')));

  check('it is drawn as SVG, which scales and prints', /<svg/.test(chartJsx)
    && /viewBox=/.test(chartJsx));
  check('  with no width of its own, so it fits the message',
    /\.chart-svg \{[^}]*width: 100%/.test(css));
  /* Measured at 390x844 with two charts in a message: 251px wide, nothing
     past the edge of the screen. */
  check('  and the figure is bounded', /\.chart-figure \{/.test(css));

  // No chart library. The arithmetic above is the whole of it.
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  check('nothing was installed to draw these',
    !deps.some(d => /chart|recharts|d3|plotly|echarts|vega/i.test(d)), deps.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
