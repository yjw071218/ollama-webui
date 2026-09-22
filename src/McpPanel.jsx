import React from 'react';
import { RefreshCcw, TriangleAlert, Server, Wrench } from 'lucide-react';
import { useI18n } from './i18n.jsx';

/**
 * What the model can reach, and what it cannot.
 *
 * This panel is read-only on purpose. Editing `mcp.json` from the browser
 * would mean a web page that can choose which programs the server spawns on
 * the next request, which is a remote code execution feature with a settings
 * icon on it — and this app is routinely opened from a phone over the house
 * network. The file is the permission; a text editor is how permission is
 * granted.
 *
 * What the panel owes the reader instead is an honest account of what happened
 * when those servers were contacted, because every failure mode here is
 * invisible from the chat. A server that will not start costs the model its
 * tools and says nothing; the model then answers without them, perfectly
 * fluently, and the only evidence is an answer that could have been better.
 * So a failure is a line with the reason in it, kept beside the tools that did
 * come back.
 */
export const McpPanel = ({ tools, problems, config, loading, onRefresh }) => {
  const { t } = useI18n();

  const byServer = new Map();
  for (const tool of tools || []) {
    if (!byServer.has(tool.server)) byServer.set(tool.server, []);
    byServer.get(tool.server).push(tool);
  }

  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };

  return (
    <div className="settings-group">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Server size={14} /> {t('mcp.title')}
        </label>
        <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCcw size={14} className={loading ? 'spin' : undefined} style={{ marginRight: '0.35rem' }} />
          {t('mcp.refresh')}
        </button>
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
    }
  }
}`}
          </pre>
        </div>
      )}

      {!config && !loading && <div style={{ ...muted, marginTop: '0.5rem' }}>{t('mcp.noServer')}</div>}

      {config && !config.missing && byServer.size === 0 && problems?.length === 0 && !loading && (
        <div style={{ ...muted, marginTop: '0.5rem' }}>{t('mcp.noneConfigured')}</div>
      )}

      {[...byServer.entries()].map(([server, list]) => (
        <div key={server} style={{ marginTop: '0.75rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
            {server} <span style={muted}>· {t('mcp.toolCount', { count: list.length })}</span>
          </div>
          {list.map(tool => (
            <div key={tool.qualified} style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
              <Wrench size={12} style={{ marginTop: '0.2rem', flexShrink: 0, color: 'var(--text-muted)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono, monospace)' }}>{tool.name}</div>
                {/* One line. A server author writes these for a tool browser
                    and some of them are a page of Markdown. */}
                <div style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {String(tool.description || '').split(/\r?\n/)[0]}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {(problems || []).map((problem, i) => (
        <div
          key={`${problem.server || 'config'}-${i}`}
          style={{
            display: 'flex', gap: '0.4rem', marginTop: '0.6rem',
            fontSize: '0.75rem', color: 'var(--danger)',
          }}
        >
          <TriangleAlert size={13} style={{ marginTop: '0.1rem', flexShrink: 0 }} />
          <div>
            {problem.server ? <strong>{problem.server}: </strong> : null}
            {problem.error}
          </div>
        </div>
      ))}
    </div>
  );
};

export default McpPanel;
