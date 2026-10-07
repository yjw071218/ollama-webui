/**
 * The browser keys people expect in the app window.
 *
 * The page lives in a WebContentsView inside a frameless window, so nothing
 * of the browser's own key handling is there: F5 did nothing, and only the
 * menu's Ctrl+R reloaded. The keys are read off every input event of the
 * page (any frame, the roleplay tab's included) and of the title bar.
 *
 * Returns the action for a `before-input-event` input, or null.
 */
export const shortcutFor = (input) => {
  if (!input || input.type !== 'keyDown') return null;
  const key = String(input.key || '');
  const ctrl = !!(input.control || input.meta);
  const { shift, alt } = input;
  if (alt) return null;
  if (key === 'F5') return ctrl || shift ? 'hardReload' : 'reload';
  if (ctrl && (key === 'r' || key === 'R')) return shift ? 'hardReload' : 'reload';
  if (key === 'F11' && !ctrl && !shift) return 'fullscreen';
  return null;
};

/** Wires `shortcutFor` to a window's page (`contents`) and its title bar. */
export const attachShortcuts = (win, contents) => {
  const run = (event, input) => {
    const action = shortcutFor(input);
    if (!action || contents.isDestroyed()) return;
    // Handled here: not also by the page, nor by the menu's Ctrl+R.
    event.preventDefault();
    if (action === 'reload') contents.reload();
    else if (action === 'hardReload') contents.reloadIgnoringCache();
    else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  };
  contents.on('before-input-event', run);
  win.webContents.on('before-input-event', run);
};
