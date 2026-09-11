/**
 * The gallery's items, from the chats and from the Studio's history.
 *
 * Pure and apart from the component so it can be tested without a DOM.
 */

/** Every picture in the chats, as gallery items. Pure, for tests. */
export const chatPictures = (sessions = []) => {
  const items = [];
  for (const session of sessions) {
    (session.messages || []).forEach((message, index) => {
      (message.generated || []).forEach((picture, n) => {
        if (!picture?.dataUrl) return;
        items.push({
          key: `${session.id}:${index}:${n}`,
          source: 'chat',
          src: picture.dataUrl,
          full: picture.dataUrl,
          video: !!picture.video,
          prompt: picture.prompt || '',
          filename: picture.filename || '',
          at: message.at || session.updatedAt || session.createdAt || 0,
          sessionId: session.id,
          sessionTitle: session.title || '',
          index,
        });
      });
    });
  }
  return items;
};

/** Every finished picture in the Studio's history. `thumbOf` makes the lighter copy. */
export const studioPictures = (jobs = [], thumbOf = (url) => url) => {
  const items = [];
  for (const job of jobs) {
    if (job?.state !== 'done') continue;
    (job.outputs || []).forEach((output, n) => {
      if (!output?.url || output.media === 'audio') return;
      items.push({
        key: `studio:${job.id}:${n}`,
        source: 'studio',
        src: output.media === 'video' ? output.url : thumbOf(output.url),
        full: output.url,
        video: output.media === 'video',
        prompt: job.prompt || '',
        filename: output.filename || '',
        at: job.finishedAt || job.startedAt || 0,
        job,
      });
    });
  }
  return items;
};
