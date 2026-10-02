import React from 'react';
import { RefreshCcw, RotateCw, TriangleAlert, Server, Wrench, FileText, MessageSquarePlus, ShieldCheck } from 'lucide-react';
import { useI18n } from './i18n.jsx';

/**
 * What the model can reach, and what it cannot.
 *
 * This panel is read-only on purpose. Editing `mcp.json` from the browser
 * would mean a web page that can choose which programs the server spawns on
 * the next request, which is a remote code execution feature with a settings
 * icon on it — and this app is routinely opened from a phone over the house
 * network. The file is the permission; a text editor is how permission is
 * granted. Restarting a server the file already names grants nothing, so that
 * much is here.
 *
 * What the panel owes the reader instead is an honest account of what happened
 * when those servers were contacted, because every failure mode here is
 * invisible from the chat. A server that will not start costs the model its
 * tools and says nothing; the model then answers without them, perfectly
 * fluently, and the only evidence is an answer that could have been better.
 * So a failure is a line with the reason in it, kept beside the tools that did
 * come back.
 *
 * A server's prompts are listed too: they are templates for the reader, not
 * tools for the model, and one is dropped into the message box to be read
 * before it is sent.
 */
export const McpPanel = ({ tools, problems, config, loading, onRefresh, onRestart, onInsertPrompt }) => {
  const { t } = useI18n();

  const byServer = new Map();
  for (const tool of tools || []) {
    if (!byServer.has(tool.server)) byServer.set(tool.server, []);
    byServer.get(tool.server).push(tool);
  }
  const statusOf = new Map((config?.servers || []).map(server => [server.name, server]));
  // Every server the config names, running or not, in the order it was listed.
  const names = [...new Set([...(config?.servers || []).map(s => s.name), ...byServer.keys()])];

  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
  const badge = {
    fontSize: '0.65rem', padding: '0 0.35rem', borderRadius: '999px',
    border: '1px solid var(--border-color)', color: 'var(--text-muted)', whiteSpace: 'nowrap',
  };

  /* The arguments a prompt needs, asked for one at a time. A form per prompt
     would be a page of fields for something used once in a while. */
  const choosePrompt = (server, prompt) => {
    const args = {};
    for (const arg of prompt.arguments || []) {
      const value = window.prompt(t('mcp.promptArg', {
        name: arg.name,
        hint: arg.description ? ` — ${arg.description}` : '',
      }), '');
      if (value === null) return;               // cancelled
      if (value === '' && arg.required) return;
      if (value !== '') args[arg.name] = value;
    }
    onInsertPrompt?.(server, prompt.name, args);
  };

  const imported = (config?.imports || []).filter(found => !found.error);

  return (
    <div className="settings-group">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Server size={14} /> {t('mcp.title')}
        </label>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
            <RefreshCcw size={14} className={loading ? 'spin' : undefined} style={{ marginRight: '0.35rem' }} />
            {t('mcp.refresh')}
          </button>
          {onRestart && names.length > 0 && (
            <button className="btn-ghost" onClick={() => onRestart('')} disabled={loading} title={t('mcp.restartAll')}>
              <RotateCw size={14} />
            </button>
          )}
        </div>
      </div>

      <div style={muted}>{t('mcp.help')}</div>

      {/* No file at all is the ordinary state, not an error, so it reads as an
          instruction rather than a warning. The path is named because "put it
          in the right place" is the whole of the difficulty. */}
      {config?.missing && (
        <div style={{ ...muted, marginTop: '0.5rem' }}>
          {t('mcp.noConfig', { file: config.file })}
          <pre style={{
            marginTop: '0.4rem', padding: '0.6rem', overflowX: 'auto',
            background: 'var(--surface-sunken)', borderRadius: '6px', fontSize: '0.7rem',
          }}>
{`{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "D:/notes.db"]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${DOCS_TOKEN}" }
    }
  },
  "import": ["claude-code", "codex"]
}`}
          </pre>
        </div>
      )}

      {config && !config.missing && (
        <div style={{ ...muted, marginTop: '0.4rem' }}>
          {imported.length
            ? t('mcp.imported', { list: imported.map(found => `${found.source} (${found.count})`).join(', ') })
            : t('mcp.importHelp')}
        </div>
      )}

      {!config && !loading && <div style={{ ...muted, marginTop: '0.5rem' }}>{t('mcp.noServer')}</div>}

      {config && !config.missing && names.length === 0 && problems?.length === 0 && !loading && (
        <div style={{ ...muted, marginTop: '0.5rem' }}>{t('mcp.noneConfigured')}</div>
      )}

      {names.map((server) => {
        const list = byServer.get(server) || [];
        const status = statusOf.get(server);
        const state = status?.state || 'running';
        return (
          <div key={server} style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{server}</span>
              <span style={{
                ...badge,
                color: state === 'failed' ? 'var(--danger)' : state === 'running' ? 'var(--success)' : 'var(--text-muted)',
              }}>
                {t(`mcp.state.${state}`)}
              </span>
              {status?.transport && <span style={badge}>{status.transport}</span>}
              {status?.source && status.source !== 'mcp.json' && <span style={badge}>{t('mcp.from', { source: status.source })}</span>}
              {state === 'running' && (
                <span style={muted}>
                  · {t('mcp.toolCount', { count: list.length })}
                  {status?.resources ? ` · ${t('mcp.resourceCount', { count: status.resources })}` : ''}
                </span>
              )}
              {onRestart && state !== 'disabled' && (
                <button
                  className="btn-ghost"
                  style={{ marginLeft: 'auto', padding: '0.1rem 0.35rem' }}
                  onClick={() => onRestart(server)}
                  disabled={loading}
                  title={t('mcp.restart')}
                  aria-label={`${t('mcp.restart')} ${server}`}
                >
                  <RotateCw size={12} />
                </button>
              )}
            </div>
            {status?.serverInfo?.name && (
              <div style={muted}>
                {status.serverInfo.title || status.serverInfo.name}
                {status.serverInfo.version ? ` ${status.serverInfo.version}` : ''}
              </div>
            )}
            {/* How it has been used since the server started, and the last
                thing that went wrong -- the failures the chat never shows. */}
            {(status?.stats || status?.startedAt) && (
              <div style={{ ...muted, display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                {status.startedAt && <span>{t('mcp.upSince', { time: new Date(status.startedAt).toLocaleTimeString() })}</span>}
                {status.stats && <span>{t('mcp.calls', { n: status.stats.calls })}</span>}
                {status.stats?.errors > 0 && <span style={{ color: 'var(--danger)' }}>{t('mcp.errors', { n: status.stats.errors })}</span>}
                {status.stats?.calls > 0 && <span>{t('mcp.avg', { ms: Math.round(status.stats.ms / status.stats.calls) })}</span>}
              </div>
            )}
            {status?.stats?.lastError && (
              <div style={{ ...muted, color: 'var(--danger)', display: 'flex', gap: '0.3rem', marginTop: '0.15rem', wordBreak: 'break-word' }}>
                <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                <span>{t('mcp.lastError', { time: new Date(status.stats.lastErrorAt).toLocaleTimeString() })} {status.stats.lastError}</span>
              </div>
            )}

            {list.map(tool => (
              <div key={tool.qualified} style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
                {tool.synthetic
                  ? <FileText size={12} style={{ marginTop: '0.2rem', flexShrink: 0, color: 'var(--text-muted)' }} />
                  : <Wrench size={12} style={{ marginTop: '0.2rem', flexShrink: 0, color: 'var(--text-muted)' }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono, monospace)', display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    {tool.name}
                    {tool.annotations?.readOnlyHint && <span style={badge}>{t('mcp.readOnly')}</span>}
                    {tool.annotations?.destructiveHint && !tool.annotations?.readOnlyHint && (
                      <span style={{ ...badge, color: 'var(--danger)' }}>{t('mcp.destructive')}</span>
                    )}
                    {status?.stats?.tools?.[tool.name] && (
                      <span style={badge} title={t('mcp.avg', { ms: Math.round(status.stats.tools[tool.name].ms / status.stats.tools[tool.name].calls) })}>
                        ×{status.stats.tools[tool.name].calls}
                        {status.stats.tools[tool.name].errors > 0 && <span style={{ color: 'var(--danger)' }}> · ✕{status.stats.tools[tool.name].errors}</span>}
                      </span>
                    )}
                  </div>
                  {/* One line. A server author writes these for a tool browser
                      and some of them are a page of Markdown. */}
                  <div style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {String(tool.description || '').split(/\r?\n/)[0]}
                  </div>
                </div>
              </div>
            ))}

            {(status?.prompts || []).length > 0 && (
              <div style={{ marginTop: '0.4rem' }}>
                <div style={muted}>{t('mcp.prompts')}</div>
                {status.prompts.map(prompt => (
                  <div key={prompt.name} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.25rem' }}>
                    <button
                      className="btn-ghost"
                      style={{ padding: '0.1rem 0.35rem' }}
                      onClick={() => choosePrompt(server, prompt)}
                      title={t('mcp.promptInsert')}
                      aria-label={`${t('mcp.promptInsert')}: ${prompt.name}`}
                    >
                      <MessageSquarePlus size={12} />
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono, monospace)' }}>{prompt.title || prompt.name}</span>
                      {prompt.description && (
                        <span style={{ ...muted, marginLeft: '0.4rem' }}>{prompt.description.split(/\r?\n/)[0]}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {(problems || []).map((problem, i) => (
        <div
          key={`${problem.server || 'config'}-${i}`}
          style={{
            display: 'flex', gap: '0.4rem', marginTop: '0.6rem',
            fontSize: '0.75rem', color: 'var(--danger)',
          }}
        >
          <TriangleAlert size={13} style={{ marginTop: '0.1rem', flexShrink: 0 }} />
          <div style={{ wordBreak: 'break-word' }}>
            {problem.server ? <strong>{problem.server}: </strong> : null}
            {problem.error}
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * The workbench's permissions, narrowed from here (server/workbenchState.js).
 *
 * Not an exception to "the file is the permission": `mcp.json` still says
 * the most the workbench may do, and nothing here can go past it -- a folder
 * outside what it names counts for nothing, and commands turned off there
 * stay off. What this adds is the everyday dimmer: only this project today,
 * no commands while reviewing, read-only while away. Approval rules only
 * answer ahead of time a question the reader could answer anyway.
 */
export const WorkbenchPolicy = () => {
  const { t } = useI18n();
  const [data, setData] = React.useState(null);
  const [rootsText, setRootsText] = React.useState('');
  const [rulesText, setRulesText] = React.useState('');
  const [message, setMessage] = React.useState('');

  const apply = (d) => {
    if (!d?.success) { setMessage(d?.error || 'failed'); return; }
    setData(d);
    setRootsText(d.policy.roots.join('\n'));
    setRulesText(d.policy.autoApprove.join('\n'));
  };
  React.useEffect(() => { fetch('/cli/workbench/policy').then(r => r.json()).then(apply).catch(() => {}); }, []);

  if (!data?.configured) return null;
  const save = async (patch) => {
    setMessage('');
    const d = await fetch('/cli/workbench/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    apply(d);
    if (d?.success) setMessage(t('mcp.wb.saved'));
  };
  const lines = (text) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const { policy, allowed, effective, noCommands } = data;
  const wide = effective.roots.some(r => /^[a-zA-Z]:\\?$|^\/$/.test(r));
  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
  const mono = { fontFamily: 'var(--font-mono, monospace)', fontSize: '0.75rem' };

  return (
    <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', display: 'grid', gap: '0.5rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><ShieldCheck size={14} /> {t('mcp.wb.title')}</label>
      <div style={muted}>{t('mcp.wb.help')}</div>

      <div style={muted}>
        {t('mcp.wb.allowed')}: <span style={mono}>{allowed.join(', ')}</span>
      </div>
      <div style={{ ...muted, color: wide ? 'var(--warning, #d97706)' : muted.color, display: 'flex', gap: '0.3rem' }}>
        {wide && <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: '0.1rem' }} />}
        <span>{t('mcp.wb.effective')}: <span style={mono}>{effective.roots.join(', ') || '—'}</span>{wide ? ` — ${t('mcp.wb.wide')}` : ''}</span>
      </div>

      <div>
        <div style={muted}>{t('mcp.wb.roots')}</div>
        <textarea
          rows={3} value={rootsText} onChange={e => setRootsText(e.target.value)} style={{ ...mono, width: '100%' }}
          placeholder={'C:\\Artificial_Intelligence\\ollama-webui'}
        />
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={() => save({ roots: lines(rootsText) })}>{t('mcp.wb.saveRoots')}</button>
          {policy.roots.length > 0 && <button className="btn-ghost" onClick={() => save({ roots: [] })}>{t('mcp.wb.allRoots')}</button>}
        </div>
      </div>

      <label style={{ ...muted, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <input type="checkbox" checked={effective.commands} disabled={noCommands || policy.readOnly}
          onChange={e => save({ commands: e.target.checked })} />
        {t('mcp.wb.commands')}{noCommands ? ` (${t('mcp.wb.offInFile')})` : ''}
      </label>
      <label style={{ ...muted, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <input type="checkbox" checked={policy.readOnly} onChange={e => save({ readOnly: e.target.checked })} />
        {t('mcp.wb.readOnly')}
      </label>

      <div>
        <div style={muted}>{t('mcp.wb.rules')}</div>
        <textarea
          rows={3} value={rulesText} onChange={e => setRulesText(e.target.value)} style={{ ...mono, width: '100%' }}
          placeholder={'npm test\ngit status\n/^npm run (lint|build)$/'}
        />
        <button className="btn-ghost" onClick={() => save({ autoApprove: lines(rulesText) })}>{t('mcp.wb.saveRules')}</button>
        <div style={muted}>{t('mcp.wb.rulesHelp')}</div>
      </div>
      {message && <div style={muted}>{message}</div>}
    </div>
  );
};

export default McpPanel;
