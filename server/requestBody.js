// Stop retaining bytes as soon as a request exceeds its limit.
export const readRequestBody = (req, limit = 32 * 1024 * 1024, timeoutMs = 30000) => new Promise((resolve, reject) => {
  /* Already read by server/cliModels.js, which had to look at `model` before
     knowing whether this request was its own. The stream is spent; the bytes
     are here. */
  if (Buffer.isBuffer(req.rawBody)) {
    if (req.rawBody.length > limit) return reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
    return resolve(req.rawBody);
  }
  let chunks = [], bytes = 0, settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    req.off('data', data); req.off('end', end);
    req.off('error', error); req.off('aborted', aborted);
  };
  const finish = (err, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    chunks = [];
    if (err) { req.resume(); reject(err); } else resolve(value);
  };
  const error = err => finish(err);
  const aborted = () => error(new Error('Request aborted'));
  const data = chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) return error(Object.assign(new Error('Request too large'), { statusCode: 413 }));
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const end = () => finish(null, Buffer.concat(chunks, bytes));
  const timer = setTimeout(() => error(Object.assign(new Error('Request body timed out'), { statusCode: 408 })), timeoutMs);
  timer.unref?.();
  req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
});
