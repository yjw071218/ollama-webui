/**
 * The settings a result in a conversation was made with, opened from under it.
 *
 * See `pictureSettings.js` for what is shown and why. This is the drawing of
 * it, plus the one thing that cannot be pure: a picture from before settings
 * were recorded is read for them out of its own PNG, once, when opened.
 */

import React, { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { settingsRows, settingsText } from './pictureSettings.js';
import { readGenerationInfo } from './pngInfo.js';
import { copyText } from './clipboard.js';

export const PictureSettings = ({ picture, t }) => {
  const [fromFile, setFromFile] = useState(null);
  const [copied, setCopied] = useState(false);
  /* A PNG, wherever it is being held. A generated picture is kept in the chat
     by address rather than as its own bytes, and `fetch` reads either one --
     so the test is "is there a PNG at the other end of this", not "are the
     bytes right here". A `.png` address is as good as a `data:image/png`. */
  const source = String(picture.dataUrl || '');
  const wantsFile = !picture.settings && !picture.video && (source.startsWith('data:')
    ? /^data:image\/png/i.test(source)
    : !!source && /\.png$/i.test(String(picture.filename || '')));

  useEffect(() => {
    if (!wantsFile) return undefined;
    let alive = true;
    (async () => {
      let info = null;
      try { info = readGenerationInfo(await (await fetch(picture.dataUrl)).arrayBuffer()); } catch (e) { info = null; }
      if (alive) setFromFile(info || {});
    })();
    return () => { alive = false; };
  }, [wantsFile, picture.dataUrl]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const rows = settingsRows(picture, fromFile);
  const valueOf = (row) => (row.key === 'op'
    ? `${t(`picture.${row.value}`)}${row.factor ? ` ×${row.factor}` : ''}`
    : row.value);
  const label = (row) => t(`picset.${row.key}`);
  // The workflow alone is not settings; it is what every result has.
  const recorded = rows.some(row => !['workflow', 'prompt', 'style'].includes(row.key));

  const copy = async () => {
    const text = settingsText(rows.map(row => ({ ...row, value: valueOf(row) })), label);
    if (await copyText(text)) setCopied(true);
  };

  return (
    <div className="picture-settings">
      <dl className="picture-settings-list">
        {rows.map(row => (
          <div key={row.key} className={`picture-setting ${row.long ? 'is-long' : ''}`}>
            <dt>{label(row)}</dt>
            <dd className={row.mono ? 'is-mono' : ''} title={row.title || valueOf(row)}>{valueOf(row)}</dd>
          </div>
        ))}
      </dl>
      <div className="picture-settings-foot">
        {!recorded && (wantsFile ? fromFile !== null : true) && <span>{t('picset.none')}</span>}
        {recorded && !picture.settings && fromFile && Object.keys(fromFile).length > 0 && (
          <span>{t('picset.fromFile')}</span>
        )}
        <button type="button" className="picture-settings-copy" onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('picset.copied') : t('picset.copy')}</span>
        </button>
      </div>
    </div>
  );
};
