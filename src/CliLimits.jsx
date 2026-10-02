import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { notify, unattended } from './notify.js';

/**
 * How much of a subscription is left, and when it comes back.
 *
 * The figures are whatever the CLI last said -- Claude Code with each answer,
 * Codex with each answer and in its own logs -- so each one carries when it
 * was said. A window whose reset time has passed is shown as empty again,
 * because it is, whatever the last figure was. See server/cliModels.js.
 */

/** An API price as a subscription CLI reports it: cents are too coarse for one answer. */
export const formatUsd = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
};

/** Which CLI a model name belongs to, or null. */
export const cliOf = (model) => {
  const m = /^(claude-code|codex|agy):/.exec(String(model || ''));
  return m ? m[1] : null;
};

/* "2 hr 13 min", in the reader's language, without a translation per unit. */
export const formatDuration = (ms, lang = 'en') => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const unit = (value, name) => {
    try {
      return new Intl.NumberFormat(lang, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
    } catch {
      return `${value}${name[0]}`;
    }
  };
  if (days) return [unit(days, 'day'), hours ? unit(hours, 'hour') : ''].filter(Boolean).join(' ');
  if (hours) return [unit(hours, 'hour'), mins ? unit(mins, 'minute') : ''].filter(Boolean).join(' ');
  return unit(mins, 'minute');
};

const formatWhen = (ms, lang) => {
  try {
    const sameDay = new Date(ms).toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(lang, sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
};

const colorOf = (used) => (used >= 100 ? 'var(--danger)' : used >= 80 ? '#d98a1c' : 'var(--success)');

/* A window's name. Claude's and Codex's are translated outright; agy's are
   pool-and-span, like `gemini-weekly` or `3p-5h` (Claude and GPT, which it
   also serves), and are put together from the two halves. */
export const windowLabel = (t, id) => {
  const key = `cli.limit.${id}`;
  const label = t(key);
  if (label !== key) return label;
  const m = /^(.*?)[-_ ]?(5h|five_hour|weekly|week|seven_day|daily|day)$/i.exec(String(id));
  if (!m) return id;
  const span = /5h|five/i.test(m[2]) ? t('cli.limit.five_hour')
    : /week|seven/i.test(m[2]) ? t('cli.limit.seven_day')
      : t('cli.limit.daily');
  const pool = !m[1] ? '' : /^3p$/i.test(m[1]) ? t('cli.limit.thirdParty')
    : m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return pool ? `${pool} ${span}` : span;
};

/** The windows of one CLI, as bars with what is left and when it resets. */
export const LimitBars = ({ limits, cli = '', now = Date.now() }) => {
  const { t, lang } = useI18n();
  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
  if (!limits || !(limits.windows || []).length) return <div style={muted}>{t(cli === 'agy' ? 'cli.limit.noneAgy' : 'cli.limit.none')}</div>;

  return (
    <div style={{ display: 'grid', gap: '0.35rem' }}>
      {limits.status === 'rejected' && (
        <div style={{ ...muted, color: 'var(--danger)', fontWeight: 600 }}>{t('cli.limit.blocked')}</div>
      )}
      {limits.windows.map((w) => {
        const used = Number.isFinite(w.usedPercent) ? w.usedPercent : null;
        return (
          <div key={w.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', ...muted }}>
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{windowLabel(t, w.id)}</strong>
                {' · '}
                {used === null ? '—' : t('cli.limit.left', { pct: Math.max(0, Math.round(100 - used)) })}
              </span>
              <span title={w.resetsAt ? formatWhen(w.resetsAt, lang) : ''}>
                {w.reset
                  ? t('cli.limit.reset')
                  : w.resetsAt
                    ? t('cli.limit.resetsIn', { time: formatDuration(w.resetsAt - now, lang), at: formatWhen(w.resetsAt, lang) })
                    : ''}
              </span>
            </div>
            {used !== null && (
              <div
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={used}
                aria-label={windowLabel(t, w.id)}
                style={{ height: 5, borderRadius: 999, background: 'var(--border-color)', overflow: 'hidden', marginTop: 3 }}
              >
                <div style={{ width: `${Math.min(100, used)}%`, height: '100%', background: colorOf(used) }} />
              </div>
            )}
            {/* At the rate this window has been used since it opened
                (server/cliProject.js, forecastWindow). */}
            {!w.reset && w.forecast && (
              <div style={{ ...muted, marginTop: 2, color: w.forecast.exhaustsAt ? 'var(--warning, #d97706)' : muted.color }}>
                {w.forecast.exhaustsAt
                  ? t('cli.limit.forecastOut', { time: formatDuration(w.forecast.exhaustsAt - now, lang), rate: w.forecast.perHour })
                  : t('cli.limit.forecastOk', { rate: w.forecast.perHour })}
              </div>
            )}
            {w.estimated && <div style={muted}>{t('cli.limit.estimated')}</div>}
          </div>
        );
      })}
      <div style={muted}>
        {limits.overage?.using ? `${t('cli.limit.overage')} · ` : ''}
        {limits.credits && !limits.credits.unlimited && limits.credits.has ? `${t('cli.limit.credits', { balance: limits.credits.balance })} · ` : ''}
        {limits.plan ? `${limits.plan} · ` : ''}
        {limits.updatedAt ? t('cli.limit.asOf', { time: formatWhen(limits.updatedAt, lang) }) : ''}
      </div>
    </div>
  );
};

/* Every CLI's limits from the server, fetched on demand. Nothing is run to
   answer it: the server reads what the CLIs last said. */
export const useCliLimits = (active, refreshKey) => {
  const [limits, setLimits] = useState(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/cli/limits');
      const data = await res.json();
      if (data.success) setLimits(data.limits || {});
    } catch { /* no server: nothing shown */ }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [active, load, refreshKey]);
  return limits;
};

/* Where the panel goes: under the badge, but never past either edge of the
   screen. The header's own dropdown rule stretches a menu to its trigger's
   width on a phone, which for a badge this small put a 260px panel hanging
   off the right edge. Measured, and placed on the screen itself. */
const GUTTER = 12;
export const placePanel = (trigger, viewportWidth, wanted = 300) => {
  const width = Math.min(wanted, viewportWidth - GUTTER * 2);
  const left = Math.max(GUTTER, Math.min(trigger.left, viewportWidth - GUTTER - width));
  return { top: trigger.bottom + 6, left, width };
};

/**
 * The header's glance: the tightest window of the selected CLI model, as
 * "5h 58% left · resets in 2 hr", with every window a click away.
 */
export const CliLimitBadge = ({ model, refreshKey, notifyBack = false }) => {
  const { t, lang } = useI18n();
  const cli = cliOf(model);
  const all = useCliLimits(!!cli, refreshKey);
  /* Over the limit a minute ago, and not now: said out loud when the reader
     asked to be told things and is not looking. The server pushes the same
     news to a closed app (server/cliModels.js); this is the half that works
     over plain http, where there is no push. */
  const wasBlocked = useRef(null);
  useEffect(() => {
    if (!all || !cli) return;
    const blockedNow = all[cli]?.status === 'rejected';
    if (wasBlocked.current?.cli === cli && wasBlocked.current.blocked && !blockedNow && notifyBack && unattended()) {
      const name = { 'claude-code': 'Claude Code', codex: 'Codex', agy: 'Antigravity' }[cli] || cli;
      notify(t('notify.cliReset', { name }), { tag: 'ollama-webui-cli-reset' });
    }
    wasBlocked.current = { cli, blocked: blockedNow };
  }, [all, cli, notifyBack, t]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [place, setPlace] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPlace(placePanel(rect, window.innerWidth));
    };
    measure();
    // A tap anywhere else puts it away, as a menu does on a phone.
    const away = (e) => {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);
  useEffect(() => {
    if (!cli) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [cli]);
  if (!cli || !all) return null;

  const limits = all[cli];
  const windows = (limits?.windows || []).filter(w => Number.isFinite(w.usedPercent));
  // The window closest to running out decides what the badge says.
  const tightest = windows.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const blocked = limits?.status === 'rejected';
  const color = blocked ? 'var(--danger)' : tightest ? colorOf(tightest.usedPercent) : 'var(--text-muted)';

  return (
    /* Its own class, not the model picker's: on a phone every
       `.model-selector-container` in the header takes an equal share of the
       row, and this badge took half of it from the model picker -- whose menu
       is as wide as its button there, so the model list came out cramped. */
    <div className="cli-limit-badge">
      <button
        ref={triggerRef}
        className="dropdown-trigger"
        onClick={() => setOpen(!open)}
        title={t('cli.limit.title')}
        aria-label={t('cli.limit.title')}
        aria-expanded={open}
      >
        <Gauge size={14} color={color} />
        <span className="cli-limit-text" style={{ color }}>
          {!tightest
            ? '—'
            : blocked && tightest.resetsAt && !tightest.reset
              ? t('cli.limit.blockedUntil', { time: formatDuration(tightest.resetsAt - now, lang) })
              : (
                <>
                  {/* The window's name goes first when room runs out; the share left stays. */}
                  <span className="cli-limit-window">{windowLabel(t, tightest.id)} </span>
                  {t('cli.limit.left', { pct: Math.max(0, Math.round(100 - tightest.usedPercent)) })}
                </>
              )}
        </span>
      </button>
      {open && place && (
        <div
          ref={panelRef}
          className="dropdown-menu"
          role="dialog"
          aria-label={t('cli.limit.title')}
          style={{
            position: 'fixed', top: place.top, left: place.left, right: 'auto',
            width: place.width, minWidth: 0, maxWidth: 'none',
            maxHeight: `calc(100dvh - ${Math.round(place.top) + 12}px)`,
            padding: '0.75rem', cursor: 'default', zIndex: 1000, boxSizing: 'border-box',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {t('cli.limit.title')} · {cli}
          </div>
          <LimitBars limits={limits} cli={cli} now={now} />
        </div>
      )}
    </div>
  );
};

export default CliLimitBadge;
