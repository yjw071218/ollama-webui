// What of a long document the model is shown: src/docContext.js.
import {
  estimateTokens, promptBudget, fitsWhole, passageBudget, isOverviewQuestion,
  joinOverlap, assemblePassages, coverageSections, documentParts, formatSections,
  MIN_INLINE_CHARS, CLI_PROMPT_TOKENS,
} from '../src/docContext.js';
import { chunkPages } from '../src/rag.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- sizes
check('Korean counts about a token a character', Math.abs(estimateTokens('가'.repeat(1100)) - 1000) < 5);
check('English counts about a token per 3.6 characters', Math.abs(estimateTokens('a'.repeat(3600)) - 1000) < 5);
check('empty is zero', estimateTokens('') === 0 && estimateTokens(null) === 0);
check('prompt budget leaves room for the answer', promptBudget({ numCtx: 16384, maxTokens: 8192 }) === 16384 - Math.floor(16384 / 3));
check('a small answer budget leaves the rest to read', promptBudget({ numCtx: 32768, maxTokens: 2048 }) === 30720);
check('a CLI model reads far more', promptBudget({ cli: true }) === CLI_PROMPT_TOKENS);
check('never less than before: 30,000 characters still go whole', fitsWhole('가'.repeat(MIN_INLINE_CHARS), { numCtx: 2048 }));
const big = '가나다라 '.repeat(20000); // 100,000 characters
check('a long Korean document is indexed at the default context', !fitsWhole(big, { numCtx: 16384, maxTokens: 8192 }));
check('... and sent whole to a CLI model', fitsWhole(big, { cli: true }));
check('... and sent whole with a large num_ctx', fitsWhole(big, { numCtx: 262144, maxTokens: 8192 }));
check('passage budget grows with the context', passageBudget({ numCtx: 65536 }) > passageBudget({ numCtx: 16384 }));

// ------------------------------------------------------------- questions
for (const q of ['이 문서 요약해줘', '전체 내용 정리해줘', '이 파일 무슨 내용이야?', '핵심만 알려줘', '줄거리 알려줘', 'Summarize this PDF', "what's this document about", 'TL;DR please', 'give me the main points'])
  check(`overview: ${q}`, isOverviewQuestion(q));
for (const q of ['3장에서 말하는 환불 기준이 뭐야?', '계약 기간은 언제까지야', 'What is the error code on page 4?', ''])
  check(`specific: ${q || '(empty)'}`, !isOverviewQuestion(q));

// ---------------------------------------------------------------- joining
check('overlap is written once', joinOverlap('alpha beta gamma delta epsilon zeta', 'gamma delta epsilon zeta eta theta') === 'alpha beta gamma delta epsilon zeta eta theta');
check('no overlap: a paragraph break', joinOverlap('one two three', 'four five six') === 'one two three\n\nfour five six');

// A real document through the real chunker: joining every piece gives the document back.
const paragraphs = Array.from({ length: 120 }, (_, i) => `제${i + 1}조 (항목 ${i + 1}) ${'본문 내용이 이어집니다. '.repeat(12)}끝${i + 1}.`);
const source = paragraphs.join('\n\n');
const chunks = chunkPages([{ page: 1, text: source }]);
const doc = { id: 'd1', name: 'contract.pdf', chunks };
check('the chunker made several overlapping pieces', chunks.length > 5);
const all = coverageSections(doc, 1e9);
check('a document that fits comes back as one passage', all.length === 1 && all[0].from === 0 && all[0].to === chunks.length - 1);
check('... with no sentence repeated at the seams', all[0].text.replace(/\s+/g, ' ') === source.replace(/\s+/g, ' '),
  `${all[0].text.length} vs ${source.length}`);
check('... and labelled as the whole document', formatSections([{ ...all[0], kind: 'whole', score: null }]).includes('whole document'));

// -------------------------------------------------------------- retrieval
const hit = (index, score) => ({ docId: 'd1', index, score });
const sections = assemblePassages({ hits: [hit(10, 0.8), hit(3, 0.6)], docs: [doc], budgetTokens: 1e9, neighbours: 1 });
check('neighbours come with each hit', sections.length === 2 && sections[0].from === 2 && sections[0].to === 4 && sections[1].from === 9 && sections[1].to === 11,
  JSON.stringify(sections.map(s => [s.from, s.to])));
check('passages are in reading order, not score order', sections[0].from < sections[1].from);
check('a joined run keeps its best score', sections[1].score === 0.8 && sections[0].score === 0.6);
const adjacent = assemblePassages({ hits: [hit(5, 0.7), hit(6, 0.5)], docs: [doc], budgetTokens: 1e9, neighbours: 0 });
check('adjacent hits become one passage', adjacent.length === 1 && adjacent[0].from === 5 && adjacent[0].to === 6);
const one = estimateTokens(chunks[0].text);
const tight = assemblePassages({ hits: [hit(10, 0.8), hit(3, 0.6)], docs: [doc], budgetTokens: one * 2.5, neighbours: 2 });
const taken = tight.reduce((n, s) => n + (s.to - s.from + 1), 0);
check('the budget is respected, hits before neighbours', taken === 2 && tight.some(s => s.from === 10) && tight.some(s => s.from === 3), JSON.stringify(tight.map(s => [s.from, s.to])));
check('the first hit is always shown, however small the budget', assemblePassages({ hits: [hit(0, 0.9)], docs: [doc], budgetTokens: 1 }).length === 1);
check('hits from documents not given are ignored', assemblePassages({ hits: [{ docId: 'gone', index: 0, score: 1 }], docs: [doc], budgetTokens: 1e9 }).length === 0);
const formatted = formatSections(sections);
check('a gap between passages is marked', formatted.includes('[…]'));
check('passages are numbered for citation', /^\[1\] contract\.pdf/.test(formatted) && formatted.includes('\n[2] contract.pdf'));

// ---------------------------------------------------- whole-document questions
const spread = coverageSections(doc, one * 6);
const covered = spread.flatMap(s => [s.from, s.to]);
check('a sample covers the start and the end', Math.min(...covered) === 0 && Math.max(...covered) === chunks.length - 1);
check('... within the budget', spread.reduce((n, s) => n + estimateTokens(s.text), 0) <= one * 7);
const parts = documentParts(doc, one * 4);
check('parts cover every piece exactly once, in order',
  parts.every((p, i) => i === 0 || p.from === parts[i - 1].to + 1) && parts[0].from === 0 && parts.at(-1).to === chunks.length - 1);
check('each part fits its size', parts.every(p => estimateTokens(p.text) <= one * 4.5));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
