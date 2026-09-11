import React, { useMemo, useState } from 'react';
import {
  MessageSquare, Cpu, Clock, Flame, TrendingDown, TrendingUp, Layers,
  Trash2, Archive, ExternalLink,
} from 'lucide-react';
import { useI18n } from './i18n.jsx';
import {
  usageSummary, activityByDay, byModel, byHour, speedDrift, biggestChats, streaks,
} from './usage.js';
import { suggestions, wouldRecover } from './housekeeping.js';

/**
 * The other half of the monitor: not what the machine is doing, but what has
 * been done with it.
 *
 * Everything here is derived from the chats already in storage — nothing new
 * is recorded and nothing leaves the browser, which is the only defensible
 * arrangement for a page whose subject is the person reading it. Deleting a
 * chat removes its contribution, because the chat *is* the record.
 *
 * The figures were chosen for being unguessable. Nobody can recall which of
 * eight installed models they actually use, or that the same model has been
 * getting slower for a fortnight, and both change what you would do next.
 */

const WINDOWS = [30, 90];

const number = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '—');

const Stat = ({ icon, label, value, hint }) => (
  <div className="usage-stat" title={hint || undefined}>
    <div className="usage-stat-label">{icon}{label}</div>
    <div className="usage-stat-value">{value}</div>
    {hint && <div className="usage-stat-hint">{hint}</div>}
  </div>
);

/**
 * Days as bars, including the empty ones.
 *
 * The gaps are the whole point. Drawn from only the days that have data, a
 * fortnight of three sessions looks exactly like a fortnight of daily use.
 */
const DayChart = ({ days }) => {
  const { t } = useI18n();
  const peak = Math.max(1, ...days.map(d => d.messages));
  return (
    <div className="usage-days">
      {days.map(day => (
        <span
          key={day.day}
          className={`usage-day ${day.messages === 0 ? 'is-empty' : ''}`}
          title={`${day.day} · ${t('usage.messagesOn', { count: day.messages, chats: day.chats })}`}
          style={{ '--fill': `${(day.messages / peak) * 100}%` }}
        />
      ))}
    </div>
  );
};

const HourChart = ({ hours }) => {
  const { t } = useI18n();
  const peak = Math.max(1, ...hours.map(h => h.messages));
  return (
    <div className="usage-hours">
      {hours.map(hour => (
        <span
          key={hour.hour}
          className="usage-hour"
          title={`${String(hour.hour).padStart(2, '0')}:00 · ${t('usage.messagesCount', { count: hour.messages })}`}
          style={{ '--fill': `${(hour.messages / peak) * 100}%` }}
        />
      ))}
      {/* Four labels, not twenty-four: the shape is the information, and the
          numbers are only there to say which end is the morning. */}
      <div className="usage-hour-axis">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
};

/**
 * What to do about the sidebar.
 *
 * The work of tidying is not the deleting, it is the deciding — remembering
 * what four hundred conversations were. Every row here says why it is a row,
 * and nothing happens without a press.
 *
 * Archiving is offered in bulk and deleting is not. That asymmetry is the
 * whole safety design: archiving is one click to undo, and a bulk delete of a
 * list somebody skimmed is not undoable at all.
 */
const Tidy = ({ sessions, onAct, onOpenChat }) => {
  const { t } = useI18n();
  const found = useMemo(() => suggestions(sessions), [sessions]);
  const recover = useMemo(() => wouldRecover(sessions, found), [sessions, found]);
  const archivable = found.filter(entry => entry.action === 'archive');

  if (found.length === 0) {
    return (
      <section className="sysmon-block">
        <div className="sysmon-title"><Archive size={13} /> {t('tidy.title')}</div>
        <div className="usage-detail">{t('tidy.empty')}</div>
      </section>
    );
  }

  return (
    <section className="sysmon-block">
      <div className="sysmon-title">
        <Archive size={13} /> {t('tidy.title')}
        <span className="sysmon-chip">{found.length}</span>
      </div>

      {recover.worthSaying && (
        <div className="usage-detail">
          {t('tidy.recover', { chats: recover.chats, tokens: recover.tokens.toLocaleString() })}
        </div>
      )}

      {found.slice(0, 12).map(entry => (
        <div className="tidy-row" key={entry.id}>
          <span className={`tidy-kind is-${entry.kind}`}>{t(`tidy.kind.${entry.kind}`)}</span>
          <button
            type="button"
            className="tidy-title"
            title={entry.title}
            onClick={() => onOpenChat?.(entry.id)}
          >
            {entry.title || t('tidy.untitled')}
          </button>
          <span className="tidy-why">
            {entry.kind === 'stale' && t('tidy.why.stale', { days: entry.days })}
            {entry.kind === 'duplicate' && t('tidy.why.duplicate', { title: entry.otherTitle })}
            {entry.kind === 'huge' && t('tidy.why.huge', { tokens: entry.tokens.toLocaleString(), messages: entry.messages })}
          </span>

          {entry.action === 'delete' && (
            <button type="button" className="variant-btn danger" title={t('common.delete')}
              onClick={() => onAct?.('delete', entry.id)}>
              <Trash2 size={12} />
            </button>
          )}
          {entry.action === 'archive' && (
            <button type="button" className="variant-btn" title={t('sidebar.archive')}
              onClick={() => onAct?.('archive', entry.id)}>
              <Archive size={12} />
            </button>
          )}
          {entry.action === 'open' && (
            <button type="button" className="variant-btn" title={t('tidy.open')}
              onClick={() => onOpenChat?.(entry.id)}>
              <ExternalLink size={12} />
            </button>
          )}
        </div>
      ))}

      {/* In bulk because archiving is one click to undo. There is deliberately
          no equivalent for deleting. */}
      {archivable.length > 1 && (
        <button
          type="button"
          className="sysmon-more"
          onClick={() => archivable.forEach(entry => onAct?.('archive', entry.id))}
        >
          {t('tidy.archiveAll', { count: archivable.length })}
        </button>
      )}
    </section>
  );
};

export const UsagePanel = ({ sessions = [], currentModel = '', onOpenChat, onHousekeep }) => {
  const { t } = useI18n();
  const [days, setDays] = useState(30);

  const summary = useMemo(() => usageSummary(sessions), [sessions]);
  const daily = useMemo(() => activityByDay(sessions, days), [sessions, days]);
  const models = useMemo(() => byModel(sessions), [sessions]);
  const hours = useMemo(() => byHour(sessions), [sessions]);
  const drift = useMemo(() => speedDrift(sessions, currentModel), [sessions, currentModel]);
  const biggest = useMemo(() => biggestChats(sessions, 5), [sessions]);
  const streak = useMemo(() => streaks(sessions), [sessions]);

  if (summary.messages === 0) {
    return <div className="sysmon-empty"><p>{t('usage.empty')}</p></div>;
  }

  const busiest = hours.reduce((best, h) => (h.messages > best.messages ? h : best), hours[0]);

  return (
    <div className="sysmon usage-panel">
      <div className="usage-grid">
        <Stat icon={<MessageSquare size={12} />} label={t('usage.chats')} value={number(summary.chats)}
          hint={t('usage.messagesCount', { count: number(summary.messages) })} />
        <Stat icon={<Layers size={12} />} label={t('usage.written')} value={number(summary.outTokens)}
          /* A total that is part measured and part estimated is a number
             nobody should quote without knowing which. */
          hint={summary.measuredShare >= 0.999
            ? t('usage.allMeasured')
            : t('usage.estimated', { percent: Math.round((1 - summary.measuredShare) * 100) })} />
        <Stat icon={<Flame size={12} />} label={t('usage.streak')} value={`${streak.current}`}
          hint={t('usage.longestStreak', { count: streak.longest })} />
        <Stat icon={<Clock size={12} />} label={t('usage.activeDays')} value={number(summary.activeDays)}
          hint={summary.days ? t('usage.outOfDays', { count: summary.days }) : ''} />
      </div>

      {/* Only when there is something to say. A note that appears every time
          is one that is read once. */}
      {drift && (
        <div className={`sysmon-alert ${drift.direction === 'slower' ? 'is-warn' : 'is-ok'}`}>
          {drift.direction === 'slower' ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
          <span>
            {t(drift.direction === 'slower' ? 'usage.slowingDown' : 'usage.speedingUp', {
              model: currentModel,
              from: drift.early.toFixed(0),
              to: drift.late.toFixed(0),
            })}
          </span>
        </div>
      )}

      <section className="sysmon-block">
        <div className="sysmon-title">
          <MessageSquare size={13} /> {t('usage.activity')}
          <div className="sysmon-window-buttons usage-window">
            {WINDOWS.map(w => (
              <button
                type="button"
                key={w}
                className={days === w ? 'is-on' : ''}
                aria-pressed={days === w}
                onClick={() => setDays(w)}
              >
                {t('usage.dayCount', { count: w })}
              </button>
            ))}
          </div>
        </div>
        <DayChart days={daily} />
      </section>

      <section className="sysmon-block">
        <div className="sysmon-title"><Cpu size={13} /> {t('usage.byModel')}</div>
        {models.map(row => (
          <div className="usage-model-row" key={row.model}>
            <div className="usage-model-head">
              <span className="sysmon-model-name" title={row.model}>{row.model}</span>
              <span className="usage-model-share">{Math.round(row.share * 100)}%</span>
            </div>
            <div className="usage-track">
              <div className="usage-fill" style={{ width: `${row.share * 100}%` }} />
            </div>
            <div className="usage-detail">
              {t('usage.modelDetail', {
                answers: number(row.answers),
                tokens: number(row.outTokens),
              })}
              {row.medianSpeed ? ` · ${row.medianSpeed.toFixed(1)} ${t('perf.tokensPerSec')}` : ''}
            </div>
          </div>
        ))}
      </section>

      <section className="sysmon-block">
        <div className="sysmon-title">
          <Clock size={13} /> {t('usage.whenYouWork')}
          <span className="sysmon-chip">
            {t('usage.busiestHour', { hour: String(busiest.hour).padStart(2, '0') })}
          </span>
        </div>
        <HourChart hours={hours} />
      </section>

      <Tidy sessions={sessions} onAct={onHousekeep} onOpenChat={onOpenChat} />

      {/* Clickable, because the reason to look at a list of the longest chats
          is to go and deal with one of them. */}
      <section className="sysmon-block">
        <div className="sysmon-title"><Layers size={13} /> {t('usage.biggest')}</div>
        {biggest.map(row => (
          <button
            type="button"
            className="usage-chat-row"
            key={row.id}
            onClick={() => onOpenChat?.(row.id)}
          >
            <span className="usage-chat-title" title={row.title}>{row.title}</span>
            <span className="usage-chat-meta">
              {t('usage.chatMeta', { messages: row.messages, tokens: number(row.tokens) })}
            </span>
          </button>
        ))}
      </section>
    </div>
  );
};
