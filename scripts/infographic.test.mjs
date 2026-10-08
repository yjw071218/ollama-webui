import assert from 'node:assert/strict';
import { parseChart, plotInfographic, plotPie, chartCSV, axisRange } from '../src/chart.js';
import { activityOf, activitySummary } from '../src/agentActivity.js';
import { parseAssistantMessage } from '../src/messageParts.js';

for (const type of ['donut', 'horizontalBar', 'radar', 'heatmap']) {
  const chart = parseChart(JSON.stringify({ type, labels: ['A', 'B', 'C'], data: [-5, null, 10] }));
  assert.equal(chart.type, type);
  const g = plotInfographic(chart);
  assert.equal(g.bars.length, 2);
  assert.equal(g.polygons[0].points[1], null);
  assert.equal(g.cells[1].opacity, 0);
  assert.ok(g.bars[0].x < g.zero);
  assert.equal(g.bars[1].x, g.zero);
  assert.ok(g.bars.every(b => Number.isFinite(b.w) && b.w >= 0));
}
const donut = parseChart('{"type":"donut","data":[1,3]}');
assert.equal(plotPie(donut).slices[1].share, .75);
const zeros = plotInfographic(parseChart('{"type":"radar","data":[0,0,0]}'));
assert.ok(zeros.polygons[0].points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
const csv = chartCSV(parseChart(JSON.stringify({ labels: ['=SUM(A1)', 'a,"b'], data: [null, -5] })));
assert.ok(csv.startsWith('\uFEFF'));
assert.ok(csv.includes('"\'=SUM(A1)"'));
assert.ok(csv.includes('"a,""b"'));
assert.ok(csv.includes('"-5"'));
assert.ok(!csv.includes('null'));

// Multiple tool legs form one timeline, including blocks containing only steps.
const blocks = parseAssistantMessage('<think>[tool: read_file · a]</think>\n<think>[running: npm test]\n[command: npm test → exit 0]\n[/output]</think>\nFinished.');
const text = blocks.filter(b => b.type === 'think').map(b => b.content).join('\n[/output]\n');
const summary = activitySummary(activityOf(text));
assert.equal(summary.steps, 2);
assert.equal(summary.running, false);
console.log('PASS infographic geometry, CSV and combined activity regressions');
assert.equal(parseChart('{"data":[{"toString":null}]}'), null);
assert.equal(parseChart('{"data":[1],"title":{"toString":null}}'), null);
assert.deepEqual(axisRange(Array(200000).fill(1)), { min: 0, max: 1 });
console.log('PASS invalid generated objects and large chart range do not throw');
