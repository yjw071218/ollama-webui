import React, { useEffect, useMemo, useState } from 'react';
import { Cpu, MemoryStick, Server, RefreshCcw, TriangleAlert } from 'lucide-react';
import { useI18n } from './i18n.jsx';

const HISTORY = 60;          // samples kept for the sparklines
const POLL_MS = 2000;

const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/* =========================================================================
   Shared poller
   =========================================================================
   The compact strip and the full panel can both be on screen. A module-level
   store keeps that to a single request per interval, and lets the strip
   inherit the history the panel has already collected.
   ========================================================================= */

const store = {
  stats: null,
  error: '',
  history: { cpu: [], gpu: [] },
  listeners: new Set(),
  timer: null,
};

const emit = () => { store.listeners.forEach(fn => fn()); };

const poll = async () => {
  try {
    const res = await fetch('/system/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unavailable');

    if (data.cpu.usage !== null) {
      store.history.cpu = [...store.history.cpu, data.cpu.usage].slice(-HISTORY);
    }
    const primaryGpu = data.gpus?.[0];
    if (primaryGpu && primaryGpu.utilization !== null) {
      store.history.gpu = [...store.history.gpu, primaryGpu.utilization].slice(-HISTORY);
    }

    store.stats = data;
    store.error = '';
  } catch (e) {
    store.error = e.message || String(e);
  }
  emit();
};

/** Subscribes to the shared stats; polling runs only while someone is listening. */
export const useSystemStats = (active = true) => {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;

    const listener = () => tick(n => n + 1);
    store.listeners.add(listener);

    if (!store.timer) {
      poll();
      store.timer = setInterval(poll, POLL_MS);
    } else if (store.stats) {
      listener();
    }

    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0 && store.timer) {
        clearInterval(store.timer);
        store.timer = null;
      }
    };
  }, [active]);

  return { stats: store.stats, error: store.error, history: store.history };
};

/** Percentage bar with a colour that escalates with load. */
export const UsageBar = ({ value, label, detail }) => {
  const pct = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  const level = pct === null ? '' : pct >= 90 ? 'over' : pct >= 70 ? 'warn' : '';
  return (
    <div className="usage-row">
      <div className="usage-head">
        <span className="usage-label">{label}</span>
        <span className="usage-value">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
      </div>
      <div className="usage-track">
        <div className={`usage-fill ${level}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      {detail && <div className="usage-detail">{detail}</div>}
    </div>
  );
};

/**
 * Sparkline over the recent samples. Drawn as a plain SVG path so it costs
 * nothing to render and inherits the theme colour.
 */
export const Sparkline = ({ points, width = 240, height = 34 }) => {
  const path = useMemo(() => {
    if (!points.length) return '';
    const step = points.length > 1 ? width / (points.length - 1) : width;
    return points
      .map((v, i) => {
        const x = i * step;
        const y = height - (Math.max(0, Math.min(100, v ?? 0)) / 100) * height;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points, width, height]);

  const area = path ? `${path} L${width},${height} L0,${height} Z` : '';

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {area && <path className="sparkline-area" d={area} />}
      {path && <path className="sparkline-line" d={path} />}
    </svg>
  );
};

/** Per-core blocks — a quick read on whether load is spread or pinned. */
const CoreGrid = ({ cores }) => (
  <div className="core-grid">
    {cores.map((value, i) => (
      <span
        key={i}
        className="core-cell"
        title={`core ${i}: ${Math.round(value)}%`}
        style={{ '--core-load': `${Math.max(0, Math.min(100, value))}%` }}
      />
    ))}
  </div>
);

export const SystemMonitor = ({ runningModels = [] }) => {
  const { t } = useI18n();
  const { stats, error, history } = useSystemStats(true);

  if (error && !stats) {
    return (
      <div className="sysmon-empty">
        <TriangleAlert size={18} />
        <p>{t('sysmon.unavailable')}</p>
        <code>{error}</code>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="sysmon-empty">
        <RefreshCcw size={18} className="spin" />
        <p>{t('common.loading')}…</p>
      </div>
    );
  }

  const memoryPct = stats.memory.total ? (stats.memory.used / stats.memory.total) * 100 : null;

  return (
    <div className="sysmon">
      <section className="sysmon-block">
        <div className="sysmon-title"><Cpu size={13} /> {t('sysmon.cpu')}</div>
        <UsageBar
          value={stats.cpu.usage}
          label={stats.cpu.model || 'CPU'}
          detail={t('sysmon.cores', { count: stats.cpu.count })}
        />
        <Sparkline points={history.cpu} />
        {stats.cpu.cores.length > 0 && <CoreGrid cores={stats.cpu.cores} />}
      </section>

      <section className="sysmon-block">
        <div className="sysmon-title"><MemoryStick size={13} /> {t('sysmon.memory')}</div>
        <UsageBar
          value={memoryPct}
          label={t('sysmon.systemRam')}
          detail={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`}
        />
      </section>

      {stats.gpus.length > 0 ? (
        stats.gpus.map(gpu => (
          <section className="sysmon-block" key={gpu.index}>
            <div className="sysmon-title">
              <Server size={13} /> {gpu.name}
              <span className="sysmon-chip">
                {gpu.temperature !== null ? `${gpu.temperature}°C` : ''}
                {gpu.power !== null ? ` · ${Math.round(gpu.power)}W` : ''}
              </span>
            </div>
            <UsageBar value={gpu.utilization} label={t('sysmon.gpuLoad')} />
            {gpu.index === 0 && <Sparkline points={history.gpu} />}
            <UsageBar
              value={gpu.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : null}
              label={t('sysmon.vram')}
              detail={`${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)}`}
            />
          </section>
        ))
      ) : (
        <section className="sysmon-block">
          <div className="sysmon-title"><Server size={13} /> {t('sysmon.gpu')}</div>
          <div className="usage-detail">{t('sysmon.noGpu')}</div>
        </section>
      )}

      <section className="sysmon-block">
        <div className="sysmon-title"><Cpu size={13} /> {t('sysmon.ollama')}</div>
        {runningModels.length === 0 ? (
          <div className="usage-detail">{t('models.noneLoaded')}</div>
        ) : (
          runningModels.map(m => (
            <div className="sysmon-model" key={m.name}>
              <span className="sysmon-model-name">{m.name}</span>
              <span className="sysmon-model-size">{formatBytes(m.size_vram || m.size)}</span>
            </div>
          ))
        )}
      </section>

      {error && <div className="usage-detail sysmon-stale">{t('sysmon.stale')}</div>}
    </div>
  );
};


/**
 * One-line readout for the chat view: CPU, GPU and RAM as tiny meters.
 * Renders nothing until the first successful sample, so a build served
 * without the dev server simply never shows it.
 */
export const SystemStrip = ({ onOpen, inHeader = false }) => {
  const { t } = useI18n();
  const { stats } = useSystemStats(true);

  if (!stats) return null;

  const gpu = stats.gpus?.[0];
  const memoryPct = stats.memory.total ? (stats.memory.used / stats.memory.total) * 100 : null;

  const meters = [
    { key: 'cpu', label: 'CPU', value: stats.cpu.usage, hint: stats.cpu.model },
    gpu && { key: 'gpu', label: 'GPU', value: gpu.utilization, hint: gpu.name },
    { key: 'ram', label: 'RAM', value: memoryPct, hint: `${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}` },
    gpu && gpu.memoryTotal
      ? {
          key: 'vram',
          label: 'VRAM',
          value: (gpu.memoryUsed / gpu.memoryTotal) * 100,
          hint: `${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)}`,
        }
      : null,
  ].filter(Boolean);

  return (
    <button type="button" className={`sys-strip ${inHeader ? 'in-header' : ''}`} onClick={onOpen} title={t('sysmon.title')}>
      {meters.map(meter => {
        const pct = meter.value === null || meter.value === undefined
          ? null
          : Math.max(0, Math.min(100, meter.value));
        const level = pct === null ? '' : pct >= 90 ? 'over' : pct >= 70 ? 'warn' : '';
        return (
          <span className="sys-chip" key={meter.key} title={meter.hint}>
            <span className="sys-chip-label">{meter.label}</span>
            <span className="sys-chip-track">
              <span className={`sys-chip-fill ${level}`} style={{ width: `${pct ?? 0}%` }} />
            </span>
            <span className="sys-chip-value">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
          </span>
        );
      })}
    </button>
  );
};
