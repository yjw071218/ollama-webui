export const extractSpreadsheet = async (buffer, onProgress) => {
  if (buffer.byteLength > 50 * 1024 * 1024) throw new Error('Spreadsheet exceeds 50 MB. Split it into smaller files.');
  let pages;
  if (typeof Worker === 'undefined') {
    throw new Error('Spreadsheet reading requires a browser with Web Worker support.');
  } else {
    pages = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./spreadsheet.worker.js', import.meta.url), { type: 'module' });
      const finish = (error, result) => {
        clearTimeout(timer);
        worker.terminate();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Spreadsheet reading timed out. Split it into smaller files.')), 60_000);
      worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.pages);
      worker.onerror = () => finish(new Error('Could not read this spreadsheet. Check the file and try again.'));
      worker.onmessageerror = () => finish(new Error('Could not receive spreadsheet data.'));
      try { worker.postMessage(buffer, [buffer]); }
      catch (error) { finish(error); }
    });
  }
  onProgress?.(pages.length, pages.length);
  return pages;
};
