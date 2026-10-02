/**
 * The gallery's items, from the chats and from the Studio's history.
 *
 * Pure and apart from the component so it can be tested without a DOM.
 */

/**
 * What an upscaled or edited picture was made from, as something an <img> can
 * show; '' when it was not made from another picture.
 *
 * A chat picture keeps `before: { filename, input }` rather than a second copy
 * of the original's bytes: `filename` is the picture it came from when that is
 * one of this conversation's (found among `pictures`), and `input` the copy
 * that was handed to ComfyUI to work from, which is still in its input folder
 * when the original has since been deleted from the conversation. A Studio job
 * keeps a URL already.
 */
export const beforeUrlOf = (picture, pictures = []) => {
  const before = picture?.before;
  if (!before) return '';
  if (typeof before === 'string') return before;
  const source = before.filename
    && pictures.find(p => p && p !== picture && p.filename === before.filename && p.dataUrl && !p.video);
  if (source) return source.dataUrl;
  return before.input ? `/studio/view?${new URLSearchParams({ filename: before.input, type: 'input' })}` : '';
};

/**
 * Where a chat picture can be fetched from, small.
 *
 * A generated picture is kept in the message as a data URL -- the whole PNG,
 * at the size it was saved, which for these workflows is around 2600 x 3500.
 * Rendered in a grid at 160 pixels that is not merely wasteful, it is the
 * reason a long-running tab gets slow: the browser decodes each one to a
 * bitmap of about thirty-five megabytes and holds it while the card is on
 * screen. Thirty pictures is a gigabyte of decoded image, and the number only
 * goes up as more are made.
 *
 * The Studio never had this problem because its cards ask the server for a
 * WebP copy (see `thumbOf`). A chat picture has the same address now -- it is
 * the same file, in the same folder -- so it can ask for the same copy.
 *
 * Null for a picture with no address: one the reader attached from their own
 * camera roll has no copy on the server, and its own bytes are all there is.
 */
export const chatPictureUrl = (picture) => {
  if (typeof picture?.url === 'string' && picture.url.startsWith('/studio/view?')) return picture.url;
  const filename = picture?.filename || picture?.file?.filename;
  if (!filename || typeof filename !== 'string' || /[\\/]/.test(filename)) return null;
  // Everything these workflows save goes under `webui/` -- see `stampOutputs`.
  return `/studio/view?${new URLSearchParams({ filename, subfolder: 'webui', type: 'output' })}`;
};

/**
 * Every picture in the chats, as gallery items. Pure, for tests.
 *
 * `thumbOf` turns an address into the light copy of it; without one the
 * pictures come back at full size, which is what the grid used to do.
 */
export const chatPictures = (sessions = [], thumbOf = (url) => url) => {
  const items = [];
  for (const session of sessions) {
    const drawn = (session.messages || []).flatMap(message => message.generated || []);
    (session.messages || []).forEach((message, index) => {
      (message.generated || []).forEach((picture, n) => {
        if (!picture?.dataUrl) return;
        /* The light copy for the card, the real one for the viewer. A film is
           left alone: there is no lighter copy of a video, and the element
           only streams what it needs to show a poster frame. */
        const address = picture.video ? null : chatPictureUrl(picture);
        items.push({
          key: `${session.id}:${index}:${n}`,
          source: 'chat',
          src: address ? thumbOf(address) : picture.dataUrl,
          full: picture.dataUrl,
          video: !!picture.video,
          prompt: picture.prompt || '',
          filename: picture.filename || '',
          // What it was drawn with, for the viewer's caption.
          model: picture.model || '',
          seed: picture.seed,
          // What it was upscaled or edited from, for the viewer's comparison.
          ...(!picture.video && picture.before ? { before: beforeUrlOf(picture, drawn) } : {}),
          // Which file ComfyUI wrote a film as, so its frames can be judged.
          ...(picture.video ? { file: picture.file || (picture.filename ? { filename: picture.filename } : null), duration: picture.duration } : {}),
          at: message.at || session.updatedAt || session.createdAt || 0,
          sessionId: session.id,
          sessionTitle: session.title || '',
          index,
          n,
        });
      });
    });
  }
  return items;
};

const isTemp = (output) => output?.type === 'temp' || /[?&]type=temp(?:&|$)/.test(String(output?.url || ''));

/**
 * A job's results, without the previews of what it also saved.
 *
 * The same rule as `outputsOf` in server/studio.js, applied again here for the
 * history already in the browser: jobs saved before the server learnt it carry
 * each picture three times, two of them in ComfyUI's temp folder -- which it
 * empties when it starts, leaving cards with nothing but a prompt.
 */
export const keptOutputs = (outputs) => {
  const list = (Array.isArray(outputs) ? outputs : []).filter(Boolean);
  const saved = new Set(list.filter(output => !isTemp(output)).map(output => output.media));
  return list.filter(output => !isTemp(output) || !saved.has(output.media));
};

/** Every finished picture in the Studio's history. `thumbOf` makes the lighter copy. */
export const studioPictures = (jobs = [], thumbOf = (url) => url) => {
  const items = [];
  for (const job of jobs) {
    if (job?.state !== 'done') continue;
    keptOutputs(job.outputs).forEach((output, n) => {
      if (!output?.url || output.media === 'audio') return;
      items.push({
        key: `studio:${job.id}:${n}`,
        source: 'studio',
        src: output.media === 'video' ? output.url : thumbOf(output.url),
        full: output.url,
        video: output.media === 'video',
        prompt: job.prompt || '',
        filename: output.filename || '',
        model: job.modelLabel || job.model || '',
        size: job.size,
        seed: job.seed,
        ...(output.media === 'image' && job.before ? { before: job.before } : {}),
        ...(output.media === 'video' ? { file: { url: output.url }, duration: job.duration } : {}),
        at: job.finishedAt || job.startedAt || 0,
        job,
      });
    });
  }
  return items;
};
