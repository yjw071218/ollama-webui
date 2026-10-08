/**
 * The app's own words -- menus, dialogs, the tray -- in Korean or English.
 *
 * The page has twelve languages of its own; what the app says around it was
 * Korean only. The app follows Windows' display language: Korean on a Korean
 * system, English on any other. Each string is written where it is used, as
 * `tr('한국어', 'English')`, so nothing can fall out of step with a table.
 */
let korean = true;

/** Set from `app.getLocale()` once the app is ready. */
export const setLanguage = (locale) => { korean = /^ko\b/i.test(String(locale || '')); return korean ? 'ko' : 'en'; };
export const language = () => (korean ? 'ko' : 'en');
export const tr = (ko, en) => (korean ? ko : en);
