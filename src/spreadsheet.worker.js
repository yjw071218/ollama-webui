import { spreadsheetPages } from './spreadsheetCore.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ pages: spreadsheetPages(data) }); }
  catch (error) { self.postMessage({ error: error.message || String(error) }); }
};
