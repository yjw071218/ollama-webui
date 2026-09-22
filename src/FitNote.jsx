import React from 'react';
import { Check, TriangleAlert, Cpu, HelpCircle } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { assess, gb } from './fit.js';

/**
 * What this context length will cost, before the model is loaded.
 *
 * One line under the context box, and it is there because nothing else in the
 * system ever objects. Ollama loads the layers that fit and runs the rest on
 * the CPU: no error, no warning, a model that works and is ten to twenty times
 * slower. The monitor can report it afterwards — `residency` in
 * `src/monitor.js` — but by then the twenty-gigabyte read has happened and the
 * answer is already arriving at three tokens a second.
 *
 * ## Why it is a sentence and not a gauge
 *
 * A bar showing 78% of VRAM used is a number to interpret, and interpreting it
 * is the task the person opening this panel has already failed at — that is
 * why they are guessing. The useful output is a verdict and, where there is
 * one, the specific thing to change: *this will put 12 of 40 layers on the
 * CPU; 8192 would fit.*
 *
 * ## Silent when it does not know
 *
 * No GPU reported, no `model_info`, a cloud model, a machine where the
 * middleware is not running — each of those renders nothing at all. A line
 * saying "could not estimate" under a settings box is a permanent apology, and
 * the panel is more useful without it.
 */
export const FitNote = ({ show, weights, gpu, context, cacheType }) => {
  const { t } = useI18n();

  const free = Number.isFinite(gpu?.memoryTotal) && Number.isFinite(gpu?.memoryUsed)
    ? gpu.memoryTotal - gpu.memoryUsed
    : null;

  const report = assess({ show, weights, free, context, cacheType });
  if (report.verdict === 'unknown') return null;

  const tone = report.verdict === 'offloaded' ? 'var(--danger)'
    : report.verdict === 'tight' ? 'var(--label, var(--text-muted))'
      : 'var(--success)';

  const Icon = report.verdict === 'offloaded' ? Cpu
    : report.verdict === 'tight' ? TriangleAlert
      : Check;

  return (
    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.35rem' }}>
        <Icon size={13} style={{ marginTop: '0.1rem', flexShrink: 0, color: tone }} />
        <div>
          {report.verdict === 'offloaded' ? (
            <span style={{ color: tone }}>
              {t('fit.offloaded', {
                layers: report.layers,
                total: report.ofLayers,
                percent: Math.round(report.onGpu * 100),
              })}
            </span>
          ) : (
            <span>
              {t(report.verdict === 'tight' ? 'fit.tight' : 'fit.fits', {
                cache: gb(report.cache),
                headroom: gb(Math.max(0, report.headroom)),
              })}
            </span>
          )}

          {/* Offered only where it would change the verdict. On a card with
              room to spare, "you could use 32k" is a fact nobody asked for. */}
          {report.suggest !== null && (
            <span> {t('fit.suggest', { context: report.suggest.toLocaleString() })}</span>
          )}

          {/* The lever the README argues for at length without ever putting a
              number on it for the model in front of you. */}
          {report.verdict === 'offloaded' && report.quantisedCache > report.best && (
            <span> {t('fit.quantised', { context: report.quantisedCache.toLocaleString() })}</span>
          )}

          {/* A different problem with the same slider: past its trained length
              a model does not fail, it gets steadily worse, and nothing else
              reports that either. */}
          {report.beyondTrained && (
            <div style={{ marginTop: '0.2rem' }}>
              {t('fit.beyondTrained', { trained: report.beyondTrained.toLocaleString() })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FitNote;
