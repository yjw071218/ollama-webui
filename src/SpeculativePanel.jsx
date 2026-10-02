/* Draft models for llama.cpp, per model. See server/speculative.js.
 *
 * Shown only when the server is on the llama.cpp backend: the route that feeds
 * it exists only then, so a 404 is the whole of the "is this relevant" check.
 *
 * The screen says three different things and keeps them apart:
 *   configured  what the preset file says (what the next load will use)
 *   active      what the loaded model is running with now (from its argv)
 *   measured    the acceptance rate, under each answer
 * because a change here only takes effect when llama-server next loads the
 * model, and a panel that showed the setting as if it were already running
 * would be the kind of lie that makes a speed-up look like it did nothing. */
import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Gauge, RefreshCcw } from 'lucide-react';

const get = async () => {
  const res = await fetch('/api/llamacpp/speculative', { credentials: 'same-origin' });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

const post = async (body) => {
  const res = await fetch('/api/llamacpp/speculative', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

export default function SpeculativePanel({ t, toast, copyText }) {
  const [state, setState] = useState(undefined);
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    try { setState(await get()); } catch (e) { setState(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!state) return null;

  const choose = async (model, choice) => {
    setBusy(model.id);
    try {
      const out = await post({ model: model.id, ...choice });
      if (out.written) {
        setState(out);
        toast?.(t('spec.saved'), 'success', 6000);
      } else {
        setPending({ model: model.id, ini: out.ini });
      }
    } catch (e) {
      toast?.(e.message, 'error', 7000);
    } finally {
      setBusy('');
    }
  };

  // Only models big enough for a draft to matter, and every model that
  // already has one configured.
  const rows = state.models.filter(m => m.suggestions.length || m.configured.mode !== 'off' || (m.params || 0) >= 7);

  return (
    <div className="settings-group">
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Gauge size={15} /> {t('spec.title')}
        <button className="icon-btn" title={t('spec.refresh')} onClick={load} style={{ marginLeft: 'auto' }}>
          <RefreshCcw size={13} />
        </button>
      </label>
      <div className="setting-desc">{t('spec.help')}</div>
      {!state.preset && <div className="setting-desc" style={{ marginTop: '0.4rem' }}>{t('spec.noPreset')}</div>}
      {state.preset && !state.writable && (
        <div className="setting-desc" style={{ marginTop: '0.4rem' }}>{t('spec.readOnly', { path: state.preset })}</div>
      )}

      {rows.length === 0 && <div className="setting-desc" style={{ marginTop: '0.6rem' }}>{t('spec.none')}</div>}

      <div className="share-list" style={{ marginTop: '0.6rem' }}>
        {rows.map((m) => {
          const c = m.configured;
          const value = c.mode === 'draft' ? `draft:${c.draft}` : c.mode;
          const options = [
            { value: 'off', label: t('spec.off') },
            { value: 'ngram', label: t('spec.ngram') },
            ...m.suggestions.map((name) => {
              const entry = state.models.find(x => x.id === name);
              return { value: `draft:${entry?.path || name}`, label: `${t('spec.draft')}: ${name}` };
            }),
          ];
          // A draft configured by hand that is not among the suggestions is
          // still shown as what it is, rather than as "off".
          if (c.mode === 'draft' && !options.some(o => o.value === value)) {
            options.push({ value, label: `${t('spec.draft')}: ${baseName(c.draft)}` });
          }
          const running = m.active?.draft ? baseName(m.active.draft) : m.active?.type || null;
          return (
            <div key={m.id} className="share-row">
              <div className="share-row-main">
                <div className="share-row-title">{m.id}</div>
                <div className="share-row-meta">
                  {m.loaded
                    ? (running ? t('spec.running', { what: running }) : t('spec.loadedWithout'))
                    : t('spec.notLoaded')}
                </div>
              </div>
              <select
                className="settings-input"
                style={{ width: 'auto', maxWidth: 260 }}
                value={value}
                disabled={busy === m.id}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.startsWith('draft:')) choose(m, { mode: 'draft', draft: v.slice(6), nMax: 16 });
                  else choose(m, { mode: v });
                }}
              >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          );
        })}
      </div>

      {pending && (
        <div style={{ marginTop: '0.6rem' }}>
          <div className="setting-desc">{t('spec.pasteThis', { model: pending.model })}</div>
          <textarea className="settings-textarea" readOnly value={pending.ini} rows={8}
            style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.75rem' }} />
          <button className="btn" onClick={() => { copyText?.(pending.ini); toast?.(t('share.copied'), 'success'); }}>
            <Copy size={13} />{' '}{t('share.copy')}
          </button>
        </div>
      )}
      <div className="setting-desc" style={{ marginTop: '0.5rem' }}>{t('spec.reloadNote')}</div>
    </div>
  );
}
