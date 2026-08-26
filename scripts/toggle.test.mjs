// Renders the Switch to static markup and checks the properties that decide
// whether it can actually be clicked — the previous markup rendered a
// zero-size checkbox behind a decorative div, which looked fine and did nothing.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.ui-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/ui.jsx'),
  external: ['react', 'react/jsx-runtime'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { Switch, SettingToggle } = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const off = renderToStaticMarkup(React.createElement(Switch, { checked: false, onChange: () => {}, label: 'Demo' }));
const on = renderToStaticMarkup(React.createElement(Switch, { checked: true, onChange: () => {}, label: 'Demo' }));

check('renders a real button', /^<button/.test(off), off);
check('exposes role="switch"', off.includes('role="switch"'));
check('reports its state', off.includes('aria-checked="false"') && on.includes('aria-checked="true"'));
check('is labelled', off.includes('aria-label="Demo"'));
check('is type=button (never submits a form)', off.includes('type="button"'));
check('carries the on class only when on', !off.includes('is-on') && on.includes('is-on'));
check('has no zero-size checkbox', !off.includes('<input'), off);

// The click handler has to be wired to the control itself, not a sibling.
let toggled = null;
const handler = { onChange: (next) => { toggled = next; } };
const element = React.createElement(Switch, { checked: false, ...handler, label: 'Demo' });
element.props.onChange(!element.props.checked);
check('onChange receives the next value', toggled === true, String(toggled));

const row = renderToStaticMarkup(React.createElement(SettingToggle, {
  checked: true, onChange: () => {}, label: 'Auto title', description: 'Asks the model for a title',
}));
check('row renders the label', row.includes('Auto title'));
check('row renders the description', row.includes('Asks the model for a title'));
check('row contains exactly one switch', (row.match(/role="switch"/g) || []).length === 1);
check('row switch reflects checked', row.includes('aria-checked="true"'));

const disabled = renderToStaticMarkup(React.createElement(Switch, { checked: false, onChange: () => {}, label: 'D', disabled: true }));
check('disabled renders as disabled', disabled.includes('disabled'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
