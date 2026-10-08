/**
 * The right-click menu on the page: there was none, so nothing happened on a
 * right click -- no copy, no paste, no spelling suggestions.
 *
 * `menuItems` is pure (tested in tests/desktop-features.test.mjs); main.mjs
 * turns its actions into what they do.
 */
import { tr } from './i18n.mjs';

const http = url => /^https?:\/\//i.test(String(url || ''));

/** The menu for Electron's context-menu `params`, as `{ label, action, arg?, enabled? }` and separators. */
export function menuItems(p = {}) {
  const items = [];
  const flags = p.editFlags || {};
  const group = list => { if (list.length) { if (items.length) items.push({ type: 'separator' }); items.push(...list); } };

  // Spelling first, where the word is.
  if (p.isEditable && p.misspelledWord) {
    const fixes = (p.dictionarySuggestions || []).slice(0, 5).map(word => ({ label: word, action: 'replace', arg: word }));
    group([...(fixes.length ? fixes : [{ label: tr('추천 단어 없음', 'No suggestions'), action: 'none', enabled: false }]),
      { label: tr('사전에 추가', 'Add to dictionary'), action: 'learn', arg: p.misspelledWord }]);
  }
  if (http(p.linkURL)) group([
    { label: tr('브라우저에서 링크 열기', 'Open link in browser'), action: 'openLink', arg: p.linkURL },
    { label: tr('링크 주소 복사', 'Copy link address'), action: 'copyText', arg: p.linkURL },
  ]);
  if (p.mediaType === 'image' && p.srcURL) group([
    { label: tr('이미지 복사', 'Copy image'), action: 'copyImage' },
    { label: tr('이미지 저장…', 'Save image…'), action: 'saveImage', arg: p.srcURL },
  ]);
  if (p.isEditable) group([
    { label: tr('실행 취소', 'Undo'), action: 'undo', enabled: !!flags.canUndo },
    { label: tr('다시 실행', 'Redo'), action: 'redo', enabled: !!flags.canRedo },
    { type: 'separator' },
    { label: tr('잘라내기', 'Cut'), action: 'cut', enabled: !!flags.canCut },
    { label: tr('복사', 'Copy'), action: 'copy', enabled: !!flags.canCopy },
    { label: tr('붙여넣기', 'Paste'), action: 'paste', enabled: !!flags.canPaste },
    { label: tr('모두 선택', 'Select all'), action: 'selectAll' },
  ]);
  else if (String(p.selectionText || '').trim()) group([{ label: tr('복사', 'Copy'), action: 'copy' }]);
  return items;
}
