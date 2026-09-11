import React, { useEffect, useMemo, useState } from 'react';
import { Cpu, MemoryStick, Server, RefreshCcw, TriangleAlert, Gauge, Trash2, HardDrive, Layers, Activity, Thermometer } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { loadRuns, clearRuns, summarise, promptCostTrend } from './perf.js';
import {
  residency, diskUsage, speedSeries, contextSeries, contextPressure,
  alerts, thin, formatBytes, formatDuration,
} from './monitor.js';

const POLL_MS = 2000;

/* Fifteen minutes of two-second samples.
 *
 * Sixty samples was two minutes, which is long enough to see that the GPU is
 * busy and too short to see anything worth opening a panel for: a model
 * loading, a run finishing, the card settling back down. The cost of keeping
 * more is one array of 450 numbers, and `thin` puts them on a 240px line
 * without pretending to draw 450 points. */
const HISTORY = 450;

/* What the window buttons choose. Samples rather than minutes, because that is
   what the arrays are counted in and converting in two places is how the
   labels end up lying about the graph. */
export const WINDOWS = [
  { key: '2m', samples: 60 },
  { key: '5m', samples: 150 },
  { key: '15m', samples: HISTORY },
];

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
  // Memory is tracked as well as load, because they answer different
  // questions: a GPU at 100% is working, and a GPU whose VRAM is at 100% is
  // about to be very slow indeed — a model that no longer fits gets paged
  // between card and system RAM, and the tokens-per-second falls off a cliff
  // that no utilisation figure predicts.
  history: { cpu: [], gpu: [], ram: [], vram: [] },
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
    if (data.memory?.total) {
      const used = (data.memory.used / data.memory.total) * 100;
      store.history.ram = [...store.history.ram, used].slice(-HISTORY);
    }
    const primaryGpu = data.gpus?.[0];
    if (primaryGpu && primaryGpu.utilization !== null) {
      store.history.gpu = [...store.history.gpu, primaryGpu.utilization].slice(-HISTORY);
    }
    if (primaryGpu?.memoryTotal) {
      const used = (primaryGpu.memoryUsed / primaryGpu.memoryTotal) * 100;
      store.history.vram = [...store.history.vram, used].slice(-HISTORY);
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

/**
 * A series with its own scale.
 *
 * `Sparkline` is fixed to 0-100 because everything it draws is a percentage.
 * Tokens per second and prompt tokens are not, and drawing them against a
 * hundred would flatten every one of them into the same line along the floor.
 * This scales to what it was given and prints the range, because a line with
 * no numbers on it can be read as any story at all.
 */
const MiniChart = ({ points, format = (v) => String(Math.round(v)), width = 240, height = 40 }) => {
  const values = points.map(p => p.value);
  const max = Math.max(...values, 1);
  // Not zero: a speed that moves between 38 and 40 is a flat line, and a
  // y-axis starting at zero says so honestly. A tokens-per-second graph that
  // magnifies noise into a cliff is worse than no graph.
  const min = 0;
  const span = max - min || 1;

  const path = values.length === 0 ? '' : values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * width : 0;
    const y = height - ((v - min) / span) * height;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div className="mini-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {path && <path className="sparkline-area" d={`${path} L${width},${height} L0,${height} Z`} />}
        {path && <path className="sparkline-line" d={path} />}
      </svg>
      <div className="mini-chart-scale">
        <span>{format(max)}</span>
        <span>{values.length ? format(values[values.length - 1]) : '—'}</span>
      </div>
    </div>
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

/**
 * What each model has actually done on this machine.
 *
 * The panel above says what the hardware is doing now. This says what that
 * hardware means in practice, which is the question anyone choosing between
 * four local models is really asking — and it cannot be answered from the
 * model files, because whether one fits in VRAM is a property of the pair.
 *
 * Medians, not averages: generation speed has a long tail in one direction
 * only, so a mean tracks the run that happened while something else wanted the
 * GPU rather than the run you are going to get.
 */
const ModelPerformance = ({ storageKey, currentModel }) => {
  const { t } = useI18n();
  const [runs, setRuns] = useState(() => loadRuns(storageKey));

  // Refreshed when a generation ends: `webui:generation-ended` is already
  // dispatched for the sync scheduler, and one more listener is cheaper than a
  // poll for something that changes a few times an hour.
  useEffect(() => {
    const refresh = () => setRuns(loadRuns(storageKey));
    window.addEventListener('webui:generation-ended', refresh);
    return () => window.removeEventListener('webui:generation-ended', refresh);
  }, [storageKey]);

  const rows = useMemo(() => summarise(runs), [runs]);
  const trend = useMemo(
    () => (currentModel ? promptCostTrend(runs, currentModel) : null),
    [runs, currentModel],
  );

  if (rows.length === 0) {
    return (
      <section className="sysmon-block">
        <div className="sysmon-title"><Gauge size={13} /> {t('perf.title')}</div>
        <div className="usage-detail">{t('perf.empty')}</div>
      </section>
    );
  }

  const ms = (value) => (value === null || value === undefined ? '—'
    : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);

  return (
    <section className="sysmon-block">
      <div className="sysmon-title">
        <Gauge size={13} /> {t('perf.title')}
        <button
          className="sysmon-clear"
          title={t('perf.clear')}
          onClick={() => { clearRuns(storageKey); setRuns([]); }}
        >
          <Trash2 size={11} />
        </button>
      </div>

      <table className="perf-table">
        <thead>
          <tr>
            <th>{t('perf.model')}</th>
            <th title={t('perf.speedHelp')}>{t('perf.speed')}</th>
            <th title={t('perf.ttftHelp')}>{t('perf.ttft')}</th>
            <th title={t('perf.runsHelp')}>{t('perf.runs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.model} className={row.model === currentModel ? 'is-current' : ''}>
              <td className="perf-name" title={row.model}>{row.model}</td>
              <td>{row.tokensPerSec ? `${row.tokensPerSec.toFixed(1)}` : '—'}</td>
              <td>{ms(row.ttft)}</td>
              <td>{row.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Loading the weights is not the model being slow, and reporting it in
          the same number as generation speed would say it was. */}
      {rows.some(r => r.coldLoads > 0) && (
        <div className="usage-detail perf-note">
          {t('perf.loadNote', {
            model: rows.find(r => r.coldLoads > 0).model,
            time: ms(rows.find(r => r.coldLoads > 0).loadTime),
          })}
        </div>
      )}

      {/* The one piece of advice these numbers can actually support. */}
      {trend && (
        <div className="usage-detail perf-warn">
          {t('perf.promptGrowing', {
            model: currentModel,
            from: ms(trend.early),
            to: ms(trend.late),
          })}
        </div>
      )}
    </section>
  );
};

/**
 * The two or three things worth interrupting somebody about.
 *
 * At the top of the panel because they are the reason to have opened it, and
 * deliberately few: a panel with eight standing warnings is a panel whose
 * warnings are furniture. Each one names its own numbers rather than saying
 * "high", because "23.1 of 24 GB" is actionable and "high" is not.
 */
const Alerts = ({ raised }) => {
  const { t } = useI18n();
  if (raised.length === 0) return null;
  return (
    <div className="sysmon-alerts">
      {raised.map((alert, i) => (
        <div className={`sysmon-alert is-${alert.level}`} key={i}>
          {alert.kind === 'thermal' ? <Thermometer size={13} /> : <TriangleAlert size={13} />}
          <span>
            {alert.kind === 'vram' && t('sysmon.alertVram', { free: formatBytes(alert.free) })}
            {alert.kind === 'offloaded' && t('sysmon.alertOffloaded', {
              model: alert.model,
              percent: Math.round(alert.onGpu * 100),
              size: formatBytes(alert.cpu),
            })}
            {alert.kind === 'context' && t('sysmon.alertContext', {
              percent: Math.round(alert.used * 100),
              turns: alert.turnsLeft ?? '?',
            })}
            {alert.kind === 'thermal' && t('sysmon.alertThermal', { temperature: alert.temperature })}
          </span>
        </div>
      ))}
    </div>
  );
};

/**
 * Which models are loaded, and where they are actually running.
 *
 * This replaced a list of names and sizes. The size was the least interesting
 * number available: what decides whether a model is usable is the *split* --
 * Ollama puts as many layers on the card as fit and runs the rest on the CPU,
 * and a model at 60% on GPU is not 40% slower, it is several times slower. The
 * bar shows the split; the countdown shows how long it stays loaded, which is
 * the other question people open this panel with.
 */
const Residency = ({ running }) => {
  const { t } = useI18n();
  const rows = useMemo(() => residency(running), [running]);

  return (
    <section className="sysmon-block">
      <div className="sysmon-title"><Layers size={13} /> {t('sysmon.residency')}</div>
      {rows.length === 0 ? (
        <div className="usage-detail">{t('models.noneLoaded')}</div>
      ) : rows.map(row => (
        <div className="sysmon-residency" key={row.name}>
          <div className="sysmon-residency-head">
            <span className="sysmon-model-name" title={row.name}>{row.name}</span>
            {row.quantisation && <span className="sysmon-chip">{row.quantisation}</span>}
            <span className="sysmon-model-size">{formatBytes(row.total)}</span>
          </div>

          {/* One bar, two segments: what is on the card and what is not. A
              percentage on its own would need to be read twice to work out
              which way round it goes. */}
          <div className="sysmon-split" title={row.onGpu === null ? t('sysmon.splitUnknown') : ''}>
            <div
              className={`sysmon-split-gpu ${row.partial ? 'is-partial' : ''}`}
              style={{ width: `${(row.onGpu ?? 1) * 100}%` }}
            />
          </div>
          <div className="usage-detail sysmon-residency-foot">
            {row.onGpu === null
              ? t('sysmon.splitUnknown')
              : row.partial
                ? t('sysmon.offloaded', { percent: Math.round(row.onGpu * 100), size: formatBytes(row.cpu) })
                : t('sysmon.fullyOnGpu')}
            {row.expiresIn !== null && (
              <span className="sysmon-expiry">
                {row.expiresIn > 0
                  ? t('sysmon.unloadsIn', { time: formatDuration(row.expiresIn) })
                  : t('sysmon.unloadingNow')}
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
};

/**
 * What the installed models cost on disk.
 *
 * The total deduplicates by digest. Ollama shares blobs between tags, so
 * `llama3:8b` and `llama3:latest` are one 4.7GB file wearing two names, and
 * adding up the tag sizes tells somebody trying to free space that they have
 * twice as much to gain as they do.
 */
const DiskUsage = ({ models }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const disk = useMemo(() => diskUsage(models), [models]);
  if (disk.count === 0) return null;

  const shown = expanded ? disk.rows : disk.rows.slice(0, 5);
  const biggest = disk.rows[0]?.size || 1;

  return (
    <section className="sysmon-block">
      <div className="sysmon-title">
        <HardDrive size={13} /> {t('sysmon.disk')}
        <span className="sysmon-chip">{formatBytes(disk.total)}</span>
      </div>

      {shown.map(row => (
        <div className="sysmon-disk" key={row.name}>
          <div className="sysmon-disk-head">
            <span className="sysmon-model-name" title={row.name}>{row.name}</span>
            <span className="sysmon-model-size">{formatBytes(row.size)}</span>
          </div>
          <div className="usage-track">
            <div className="usage-fill" style={{ width: `${(row.size / biggest) * 100}%` }} />
          </div>
        </div>
      ))}

      {disk.rows.length > 5 && (
        <button type="button" className="sysmon-more" onClick={() => setExpanded(v => !v)}>
          {expanded ? t('common.showLess') : t('sysmon.showAllModels', { count: disk.rows.length })}
        </button>
      )}

      {disk.shared > 0 && (
        <div className="usage-detail">{t('sysmon.sharedBlobs', { size: formatBytes(disk.shared) })}</div>
      )}
    </section>
  );
};

/**
 * Speed and context over successive runs.
 *
 * The table above gives a median, which answers "how fast is this model". It
 * cannot answer "is it getting slower", and that is the question behind most
 * complaints -- a card that has throttled, another process that has taken the
 * GPU, or a conversation whose prompt has grown until reading it costs more
 * than writing the answer. Two lines say which.
 */
const Trends = ({ runs, currentModel, numCtx }) => {
  const { t } = useI18n();
  const speed = useMemo(() => speedSeries(runs, currentModel), [runs, currentModel]);
  const context = useMemo(() => contextSeries(runs, currentModel), [runs, currentModel]);
  const pressure = useMemo(
    () => contextPressure(runs, currentModel, numCtx), [runs, currentModel, numCtx],
  );

  if (speed.length < 2 && context.length < 2) return null;

  return (
    <section className="sysmon-block">
      <div className="sysmon-title"><Activity size={13} /> {t('sysmon.trends')}</div>

      {speed.length >= 2 && (
        <>
          <div className="usage-head">
            <span className="usage-label">{t('sysmon.speedOverTime')}</span>
            <span className="usage-value">{t('perf.tokensPerSec')}</span>
          </div>
          <MiniChart points={speed} format={v => v.toFixed(0)} />
        </>
      )}

      {context.length >= 2 && (
        <>
          <div className="usage-head">
            <span className="usage-label">{t('sysmon.contextPressure')}</span>
            {pressure && (
              <span className={`usage-value ${pressure.level !== 'ok' ? 'is-warn' : ''}`}>
                {Math.round(pressure.used * 100)}%
              </span>
            )}
          </div>
          <MiniChart points={context} format={v => `${Math.round(v)}`} />
          {pressure && (
            <div className="usage-detail">
              {t('sysmon.contextDetail', {
                tokens: pressure.tokens.toLocaleString(),
                numCtx: pressure.numCtx.toLocaleString(),
              })}
              {pressure.perTurn && pressure.turnsLeft !== null && (
                <> · {t('sysmon.contextRate', {
                  perTurn: Math.round(pressure.perTurn).toLocaleString(),
                  turns: pressure.turnsLeft,
                })}</>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};

export const SystemMonitor = ({ runningModels = [], perfKey = 'perfRuns', currentModel = '', models = [], numCtx = 0 }) => {
  const { t } = useI18n();
  const { stats, error, history } = useSystemStats(true);
  // The window applies to every graph at once: comparing a two-minute CPU line
  // against a fifteen-minute GPU one is how people conclude the wrong thing.
  const [windowKey, setWindowKey] = useState('5m');
  const samples = (WINDOWS.find(w => w.key === windowKey) || WINDOWS[1]).samples;
  const view = (points) => thin(points.slice(-samples), 60);

  // Read here rather than inside the performance table, because the alerts at
  // the top need the same numbers and polling storage twice for one panel is
  // the sort of thing that gets noticed on a slow machine.
  const [runs, setRuns] = useState(() => loadRuns(perfKey));
  useEffect(() => {
    const refresh = () => setRuns(loadRuns(perfKey));
    window.addEventListener('webui:generation-ended', refresh);
    return () => window.removeEventListener('webui:generation-ended', refresh);
  }, [perfKey]);

  const pressure = useMemo(
    () => contextPressure(runs, currentModel, numCtx), [runs, currentModel, numCtx],
  );
  const raised = useMemo(
    () => alerts({ stats, running: runningModels, pressure }), [stats, runningModels, pressure],
  );

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
      <Alerts raised={raised} />

      {/* One control for every graph. Fifteen minutes is the useful default
          ceiling: long enough to contain a model load and a few answers,
          short enough that the line still has shape. */}
      <div className="sysmon-window">
        <span className="usage-label">{t('sysmon.window')}</span>
        <div className="sysmon-window-buttons">
          {WINDOWS.map(w => (
            <button
              type="button"
              key={w.key}
              className={windowKey === w.key ? 'is-on' : ''}
              aria-pressed={windowKey === w.key}
              onClick={() => setWindowKey(w.key)}
            >
              {w.key}
            </button>
          ))}
        </div>
      </div>

      <section className="sysmon-block">
        <div className="sysmon-title"><Cpu size={13} /> {t('sysmon.cpu')}</div>
        <UsageBar
          value={stats.cpu.usage}
          label={stats.cpu.model || 'CPU'}
          detail={t('sysmon.cores', { count: stats.cpu.count })}
        />
        <Sparkline points={view(history.cpu)} />
        {stats.cpu.cores.length > 0 && <CoreGrid cores={stats.cpu.cores} />}
      </section>

      <section className="sysmon-block">
        <div className="sysmon-title"><MemoryStick size={13} /> {t('sysmon.memory')}</div>
        <UsageBar
          value={memoryPct}
          label={t('sysmon.systemRam')}
          detail={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`}
        />
        <Sparkline points={view(history.ram)} />
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
            {gpu.index === 0 && <Sparkline points={view(history.gpu)} />}
            <UsageBar
              value={gpu.memoryTotal ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : null}
              label={t('sysmon.vram')}
              detail={`${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)}`}
            />
            {gpu.index === 0 && <Sparkline points={view(history.vram)} />}
          </section>
        ))
      ) : (
        <section className="sysmon-block">
          <div className="sysmon-title"><Server size={13} /> {t('sysmon.gpu')}</div>
          <div className="usage-detail">{t('sysmon.noGpu')}</div>
        </section>
      )}

      <Residency running={runningModels} />

      <ModelPerformance storageKey={perfKey} currentModel={currentModel} />

      <Trends runs={runs} currentModel={currentModel} numCtx={numCtx} />

      <DiskUsage models={models} />

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
