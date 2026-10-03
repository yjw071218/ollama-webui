// Tags quoted in code stay text: on screen, in history, in exports.
import { parseAssistantMessage } from '../src/messageParts.js';
import { forHistory } from '../src/wireHistory.js';
import { stripThinking, insideCode } from '../src/codeAware.js';

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; };
const F = '```';
const T = '<' + 'think>';
const TC = '</' + 'think>';

// The message that was cut off: a change card whose diff quotes the tag.
const card = `설명입니다.\n\n📝 **\`src/App.jsx\`** (+0 −1)\n${F}diff\n--- a/App.jsx\n+++ b/App.jsx\n-/* drawn open: its content without the ${T}\n-   blocks */\n${F}\n\n이후 내용도 보여야 합니다.`;
const blocks = parseAssistantMessage(card);
check('a tag inside a diff opens no thinking block', blocks.every(b => b.type === 'text'));
check('  and the text after the diff survives', blocks.map(b => b.content).join('').includes('이후 내용도'));
check('history keeps the whole answer', forHistory(card).includes('이후 내용도'));
check('inline code is code too', stripThinking(`태그는 \`${T}\` 입니다. 끝.`).includes('끝.'));

// Real reasoning is still removed.
const real = `${T}\n생각\n${TC}\n\n답 ${F}js\nx\n${F}`;
check('a real block is still parsed', parseAssistantMessage(real)[0]?.type === 'think');
check('  and stripped from history', !forHistory(real).includes('생각') && forHistory(real).includes('답'));
check('an unterminated real block is stripped', stripThinking(`${T}\n멈춘 생각`).trim() === '');
// A fence left open inside thinking does not hide what follows.
check('a fence open inside thinking hides nothing after it',
  parseAssistantMessage(`${T}\n${F}\n${TC}\n\n${T}\n둘째\n${TC}\n답`).filter(b => b.type === 'think').length === 2);
check('streaming: an open fence keeps the tag as text', insideCode(`앞\n${F}diff\n-x`));

if (failed) { console.log(`${failed} failed`); process.exit(1); }
