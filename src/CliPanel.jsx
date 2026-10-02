import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCcw, TerminalSquare, CircleCheck, CircleAlert, CircleSlash } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { LimitBars, formatUsd } from './CliLimits.jsx';
import { CliAgentPanel } from './CliAgent.jsx';

/**
 * Claude Code, Codex and Antigravity, as the server sees them.
 *
 * Read-only for the reason the MCP panel is: which CLIs are offered, and with
 * what, is `.env`'s to say, and this page is opened from phones. What the
 * reader needs here is the answer to "why is `codex:` not in my model list"
 * and "is the tools toggle doing anything for Claude" -- installed or not,
 * signed in or not, which MCP servers a turn would hand over, and how the
 * answers since the server started have gone. See server/cliModels.js.
 */
/* The account kept in server/data/cli-usage.jsonl, for this reader: what the
   CLIs were used for over a month, per CLI and per conversation, in tokens and
   -- where the CLI says -- the API price it would have been. */
const UsageSummary = ({ sessions = [] }) => {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/cli/usage?days=30').then(r => r.json()).then((d) => { if (!cancelled && d.success) setData(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!data) return null;
  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
  const labelOf = { 'claude-code': 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
  const spans = ['today', 'week', 'month'];
  const ids = [...new Set(spans.flatMap(span => Object.keys(data.totals?.[span] || {})))];
  const line = (row) => [
    t('cli.usageRuns', { runs: row.runs }),
    `${(row.prompt + row.eval).toLocaleString()} tok`,
    row.cached > 0 ? t('cli.cached', { tokens: row.cached.toLocaleString() }) : '',
    row.costUsd > 0 ? formatUsd(row.costUsd) : '',
    row.resumed > 0 ? t('cli.usageResumed', { count: row.resumed }) : '',
    row.fallbacks > 0 ? t('cli.usageFallbacks', { count: row.fallbacks }) : '',
  ].filter(Boolean).join(' · ');
  const titleOf = (chat) => sessions.find(s => s.id === chat)?.title || chat;

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{t('cli.usageTitle')}</div>
      {!ids.length && <div style={muted}>{t('cli.usageNone')}</div>}
      {ids.map(id => (
        <div key={id} style={{ ...muted, marginTop: '0.25rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{labelOf[id] || id}</strong>
          {spans.map(span => (data.totals?.[span]?.[id]
            ? <div key={span} style={{ marginLeft: '0.8rem' }}>{t(`cli.usage.${span}`)}: {line(data.totals[span][id])}</div>
            : null))}
        </div>
      ))}
      {data.chats?.length > 0 && (
        <details style={{ marginTop: '0.35rem' }}>
          <summary style={{ ...muted, cursor: 'pointer' }}>{t('cli.usageChats')}</summary>
          {data.chats.map(row => (
            <div key={row.chat} style={{ ...muted, marginTop: '0.2rem' }}>
              <span style={{ color: 'var(--text-primary)' }}>{titleOf(row.chat)}</span>
              {' — '}{line(row)}
            </div>
          ))}
        </details>
      )}
    </div>
  );
};

export const CliPanel = ({ sessions = [], onImportChat }) => {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(refresh ? '/cli/refresh' : '/cli/status', { method: refresh ? 'POST' : 'GET' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStatus(data);
      setFailed(false);
    } catch (e) {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
  const mono = { fontFamily: 'var(--font-mono, monospace)' };

  const stateOf = (p) => {
    if (!status?.enabled) return { icon: CircleSlash, color: 'var(--text-muted)', text: t('cli.off') };
    if (!p.installed) return { icon: CircleSlash, color: 'var(--text-muted)', text: t('cli.notInstalled', { env: p.pathEnv }) };
    if (!p.offered) return { icon: CircleSlash, color: 'var(--text-muted)', text: t('cli.notOffered') };
    if (p.signedIn === false) return { icon: CircleAlert, color: 'var(--danger)', text: t('cli.signedOut', { bin: p.bin }) };
    return { icon: CircleCheck, color: 'var(--success)', text: p.how ? t('cli.signedIn', { how: p.how }) : '' };
  };

  return (
    <div className="settings-group">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <TerminalSquare size={14} /> {t('cli.title')}
        </label>
        <button className="btn-ghost" onClick={() => load(true)} disabled={loading}>
          <RefreshCcw size={14} className={loading ? 'spin' : undefined} style={{ marginRight: '0.35rem' }} />
          {t('cli.refresh')}
        </button>
      </div>

      <div style={muted}>{t('cli.help')}</div>

      {failed && <div style={{ ...muted, marginTop: '0.5rem' }}>{t('cli.noServer')}</div>}

      {/* What .env says about what happens between the models: who answers
          when one is over its limit, and whether conversations are resumed. */}
      {status?.settings && (
        <div style={{ ...muted, marginTop: '0.5rem', display: 'grid', gap: '0.15rem' }}>
          <div>
            {t('cli.fallbackSetting')}:{' '}
            {status.settings.fallback?.length
              ? <span style={mono}>{status.settings.fallback.join(' → ')}</span>
              : t('cli.fallbackNone')}
          </div>
          <div>{t('cli.resumeSetting')}: <span style={mono}>{status.settings.resume}</span></div>
        </div>
      )}

      {(status?.providers || []).map((p) => {
        const state = stateOf(p);
        const Icon = state.icon;
        const usage = p.usage;
        return (
          <div key={p.id} style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <Icon size={13} style={{ color: state.color, flexShrink: 0 }} />
              <strong style={{ fontSize: '0.85rem' }}>{p.label}</strong>
              {p.version && <span style={{ ...muted, ...mono }}>{p.version}</span>}
            </div>
            {state.text && <div style={{ ...muted, marginLeft: '1.2rem' }}>{state.text}</div>}

            {p.offered && (
              <div style={{ ...muted, marginLeft: '1.2rem', marginTop: '0.25rem', display: 'grid', gap: '0.2rem' }}>
                <div>
                  {t('cli.models')}:{' '}
                  <span style={mono}>{p.models.map(m => `${p.id}:${m}`).join(', ')}</span>
                </div>
                {p.efforts?.length > 0 && <div>{t('cli.effort', { list: p.efforts.join(' / ') })}</div>}
                <div>
                  {t('cli.tools')}:{' '}
                  {p.tools.native
                    ? [
                      p.tools.mcp.length ? t('cli.toolsMcp', { list: p.tools.mcp.join(', ') }) : t('cli.toolsNone'),
                      p.tools.web ? t('cli.toolsWeb') : '',
                    ].filter(Boolean).join(' · ')
                    : t('cli.toolsTags')}
                </div>
                {p.tools.mcpSkipped?.length > 0 && (
                  <div>{t('cli.skipped', { list: p.tools.mcpSkipped.map(s => `${s.name} (${s.why === 'name' ? t('cli.skippedName') : s.why === 'delegate' ? t('cli.skippedDelegate') : s.transport})`).join(', ') })}</div>
                )}
                <div style={{ margin: '0.3rem 0' }}>
                  <div style={{ marginBottom: '0.2rem' }}>{t('cli.limit.title')}</div>
                  <LimitBars limits={p.limits} cli={p.id} />
                </div>
                {usage && (
                  <div>
                    {t('cli.usage', {
                      runs: usage.runs,
                      failures: usage.failures,
                      tokens: (usage.promptTokens + usage.evalTokens).toLocaleString(),
                    })}
                    {usage.costUsd > 0 && ` · ${t('cli.cost', { cost: usage.costUsd.toFixed(3) })}`}
                  </div>
                )}
                {usage?.lastError && (
                  <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {t('cli.lastError', { error: usage.lastError })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {status?.enabled && <UsageSummary sessions={sessions} />}
      {status?.enabled && <CliAgentPanel providers={status.providers} onImportChat={onImportChat} />}
    </div>
  );
};

export default CliPanel;
