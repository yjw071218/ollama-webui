/*
 * ```infographic blocks: small, clean visual summaries drawn in the answer.
 *
 * One block is a JSON object with a `type`, or `{ "title", "blocks": [ ... ] }`
 * for several sections under one heading. Every string is rendered as text
 * (never as HTML); `**bold**` inside a string is the only markup honoured.
 *
 *   stats     items: [{ label, value, unit?, delta?, note?, icon? }]
 *   steps     items: [{ title, text? }]
 *   timeline  items: [{ when, title, text? }]
 *   compare   columns: [{ name, items: [..], highlight? , tag? }]
 *   progress  items: [{ label, value, max?, note? }]          (max defaults to 100)
 *   cards     items: [{ icon?, title, text? }]
 *   proscons  pros: [..], cons: [..]
 *   funnel    items: [{ label, value? }]                     (widest first)
 *   callout   tone: info|tip|warn|success, title?, text
 *
 * A block that does not parse falls through and is shown as code (App.jsx).
 */
import React from 'react';
import './infoblocks.css';

const TYPES = new Set(['stats', 'steps', 'timeline', 'compare', 'progress', 'cards', 'proscons', 'funnel', 'callout']);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const list = (v) => (Array.isArray(v) ? v : []);

const validBlock = (b) => {
  if (!b || typeof b !== 'object' || !TYPES.has(String(b.type || '').toLowerCase())) return false;
  const type = String(b.type).toLowerCase();
  if (type === 'compare') return list(b.columns).length >= 2;
  if (type === 'proscons') return list(b.pros).length + list(b.cons).length > 0;
  if (type === 'callout') return !!str(b.text || b.title);
  return list(b.items).length > 0;
};

export const parseInfoBlocks = (source) => {
  let data;
  try { data = JSON.parse(String(source || '').trim()); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data) ? data : [data];
  const ok = blocks.filter(validBlock).map(b => ({ ...b, type: String(b.type).toLowerCase() }));
  if (!ok.length) return null;
  return { title: Array.isArray(data.blocks) ? str(data.title) : '', subtitle: Array.isArray(data.blocks) ? str(data.subtitle) : '', blocks: ok };
};

/* `**bold**` only. */
const Rich = ({ text }) => {
  const parts = str(text).split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (/^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : p))}</>;
};

const Head = ({ b }) => (b.title || b.subtitle ? (
  <header className="ig-head">
    {b.title && <h4 className="ig-title"><Rich text={b.title} /></h4>}
    {b.subtitle && <p className="ig-sub"><Rich text={b.subtitle} /></p>}
  </header>
) : null);

const deltaTone = (d) => {
  const s = str(d).trim();
  if (/^[+▲↑]/.test(s)) return 'up';
  if (/^[-−▼↓]/.test(s)) return 'down';
  return 'flat';
};

const Stats = ({ b }) => (
  <div className="ig-stats">
    {list(b.items).map((it, i) => (
      <div className="ig-stat" key={i} style={{ '--i': i }}>
        <div className="ig-stat-label">{it.icon && <span className="ig-icon" aria-hidden="true">{str(it.icon)}</span>}<Rich text={it.label} /></div>
        <div className="ig-stat-value">{str(it.value)}{it.unit && <span className="ig-unit">{str(it.unit)}</span>}</div>
        {(it.delta || it.note) && (
          <div className="ig-stat-foot">
            {it.delta && <span className={`ig-delta is-${deltaTone(it.delta)}`}>{str(it.delta)}</span>}
            {it.note && <span className="ig-note"><Rich text={it.note} /></span>}
          </div>
        )}
      </div>
    ))}
  </div>
);

const Steps = ({ b }) => (
  <ol className="ig-steps">
    {list(b.items).map((it, i) => (
      <li className="ig-step" key={i} style={{ '--i': i }}>
        <span className="ig-step-n">{i + 1}</span>
        <div className="ig-step-body">
          <div className="ig-step-title"><Rich text={it.title ?? it} /></div>
          {it.text && <div className="ig-text"><Rich text={it.text} /></div>}
        </div>
      </li>
    ))}
  </ol>
);

const Timeline = ({ b }) => (
  <ol className="ig-timeline">
    {list(b.items).map((it, i) => (
      <li key={i} style={{ '--i': i }}>
        <span className="ig-dot" aria-hidden="true" />
        {it.when && <div className="ig-when">{str(it.when)}</div>}
        <div className="ig-step-title"><Rich text={it.title ?? it} /></div>
        {it.text && <div className="ig-text"><Rich text={it.text} /></div>}
      </li>
    ))}
  </ol>
);

const Compare = ({ b }) => (
  <div className="ig-compare" style={{ '--cols': Math.min(4, list(b.columns).length) }}>
    {list(b.columns).map((c, i) => (
      <div className={`ig-col${c.highlight ? ' is-hl' : ''}`} key={i} style={{ '--i': i }}>
        <div className="ig-col-head">
          <span className="ig-col-name"><Rich text={c.name} /></span>
          {c.tag && <span className="ig-tag">{str(c.tag)}</span>}
        </div>
        <ul>{list(c.items).map((p, j) => <li key={j}><Rich text={p} /></li>)}</ul>
      </div>
    ))}
  </div>
);

const Progress = ({ b }) => (
  <div className="ig-progress">
    {list(b.items).map((it, i) => {
      const max = Number(it.max) > 0 ? Number(it.max) : 100;
      const v = Number(it.value);
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
      return (
        <div className="ig-bar" key={i} style={{ '--i': i }}>
          <div className="ig-bar-top">
            <span><Rich text={it.label} /></span>
            <span className="ig-bar-val">{Number.isFinite(v) ? (max === 100 ? `${v}%` : `${v} / ${max}`) : str(it.value)}</span>
          </div>
          <div className="ig-track"><span className="ig-fill" style={{ '--w': `${pct}%` }} /></div>
          {it.note && <div className="ig-note"><Rich text={it.note} /></div>}
        </div>
      );
    })}
  </div>
);

const Cards = ({ b }) => (
  <div className="ig-cards">
    {list(b.items).map((it, i) => (
      <div className="ig-card" key={i} style={{ '--i': i }}>
        {it.icon && <div className="ig-card-icon" aria-hidden="true">{str(it.icon)}</div>}
        <div className="ig-step-title"><Rich text={it.title ?? it} /></div>
        {it.text && <div className="ig-text"><Rich text={it.text} /></div>}
      </div>
    ))}
  </div>
);

const ProsCons = ({ b }) => (
  <div className="ig-proscons">
    <div className="ig-pc is-pro">
      <div className="ig-pc-head"><span aria-hidden="true">＋</span>{str(b.prosTitle) || '장점'}</div>
      <ul>{list(b.pros).map((p, i) => <li key={i}><Rich text={p} /></li>)}</ul>
    </div>
    <div className="ig-pc is-con">
      <div className="ig-pc-head"><span aria-hidden="true">－</span>{str(b.consTitle) || '단점'}</div>
      <ul>{list(b.cons).map((p, i) => <li key={i}><Rich text={p} /></li>)}</ul>
    </div>
  </div>
);

const Funnel = ({ b }) => {
  const items = list(b.items);
  return (
    <div className="ig-funnel">
      {items.map((it, i) => (
        <div className="ig-funnel-row" key={i} style={{ '--w': `${100 - (i * 55) / Math.max(1, items.length - 1)}%`, '--i': i }}>
          <span className="ig-funnel-label"><Rich text={it.label ?? it} /></span>
          {it.value !== undefined && <span className="ig-funnel-val">{str(it.value)}</span>}
        </div>
      ))}
    </div>
  );
};

const CALLOUT_ICON = { info: 'ℹ', tip: '💡', warn: '⚠', success: '✓' };
const Callout = ({ b }) => {
  const tone = CALLOUT_ICON[b.tone] ? b.tone : 'info';
  return (
    <div className={`ig-callout is-${tone}`} role="note">
      <span className="ig-callout-icon" aria-hidden="true">{CALLOUT_ICON[tone]}</span>
      <div>
        {b.title && <div className="ig-step-title"><Rich text={b.title} /></div>}
        {b.text && <div className="ig-text"><Rich text={b.text} /></div>}
      </div>
    </div>
  );
};

const VIEW = { stats: Stats, steps: Steps, timeline: Timeline, compare: Compare, progress: Progress, cards: Cards, proscons: ProsCons, funnel: Funnel, callout: Callout };

export default function InfoBlocks({ source }) {
  const data = parseInfoBlocks(source);
  if (!data) return null;
  return (
    <figure className="infographic">
      {(data.title || data.subtitle) && (
        <header className="ig-main-head">
          {data.title && <h3 className="ig-main-title"><Rich text={data.title} /></h3>}
          {data.subtitle && <p className="ig-sub"><Rich text={data.subtitle} /></p>}
        </header>
      )}
      {data.blocks.map((b, i) => {
        const View = VIEW[b.type];
        // A callout carries its own title inside the box.
        return (
          <section className={`ig-section ig-${b.type}-wrap`} key={i}>
            {b.type !== 'callout' && <Head b={b} />}
            <View b={b} />
          </section>
        );
      })}
    </figure>
  );
}
