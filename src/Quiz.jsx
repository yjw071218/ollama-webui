import React, { useMemo, useState } from 'react';
import { Check, X, RotateCcw, Lightbulb, Trophy, ChevronRight, ChevronLeft } from 'lucide-react';

/* A fenced ```quiz block, answered in place.
 *
 *   {"title":"SQL 기초","questions":[
 *     {"q":"DDL이 아닌 것은?","options":["CREATE","ALTER","SELECT","DROP"],"answer":2,"explain":"SELECT는 DML(DQL)."},
 *     {"q":"기본키의 성질을 모두 고르세요","options":["유일성","NULL 허용","최소성"],"answer":[0,2]},
 *     {"q":"외래키는 NULL이 될 수 있다","type":"ox","answer":true},
 *     {"q":"구조적 질의 언어의 약자는?","type":"short","answer":["SQL"]}
 *   ]}
 *
 * Choices are single answer when `answer` is a number and pick-all when it is
 * a list; `ox` is true/false; `short` is typed and compared ignoring case and
 * spaces. Answers are kept per quiz (by its text), so leaving the chat and
 * coming back does not lose them. Nothing here is sent anywhere: it is the
 * reader checking themselves. */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.,·'"`()\-_]/g, '');

export const parseQuiz = (source) => {
  try {
    const raw = JSON.parse(String(source || '').trim());
    const list = Array.isArray(raw) ? raw : raw?.questions;
    if (!Array.isArray(list) || !list.length) return null;
    const questions = list.map((q) => {
      const text = String(q?.q ?? q?.question ?? '').trim();
      if (!text) return null;
      let type = q.type || (Array.isArray(q.options) ? (Array.isArray(q.answer) ? 'multi' : 'single') : (typeof q.answer === 'boolean' ? 'ox' : 'short'));
      if (type === 'tf') type = 'ox';
      if (type === 'ox') return { type, text, options: ['O', 'X'], answer: [q.answer === true || q.answer === 'O' || q.answer === 0 ? 0 : 1], explain: q.explain || q.explanation || '', hint: q.hint || '' };
      if (type === 'short') {
        const answers = (Array.isArray(q.answer) ? q.answer : [q.answer]).filter(a => a != null && a !== '').map(String);
        return answers.length ? { type, text, answers, explain: q.explain || q.explanation || '', hint: q.hint || '' } : null;
      }
      const options = (q.options || []).map(String);
      const answer = (Array.isArray(q.answer) ? q.answer : [q.answer])
        .map(a => (typeof a === 'number' ? a : options.findIndex(o => norm(o) === norm(a))))
        .filter(a => Number.isInteger(a) && a >= 0 && a < options.length);
      if (options.length < 2 || !answer.length) return null;
      return { type: answer.length > 1 || type === 'multi' ? 'multi' : 'single', text, options, answer, explain: q.explain || q.explanation || '', hint: q.hint || '' };
    }).filter(Boolean);
    return questions.length ? { title: String(raw?.title || '퀴즈'), mode: raw?.mode === 'all' ? 'all' : 'step', questions } : null;
  } catch { return null; }
};

const storeKey = (source) => {
  let h = 0;
  for (const c of String(source)) h = (h * 31 + c.codePointAt(0)) | 0;
  return `quiz:${h}`;
};
const load = (key) => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };

const correctOf = (q, a) => {
  if (!a?.checked) return null;
  if (q.type === 'short') return q.answers.some(x => norm(x) === norm(a.text));
  const picked = [...(a.picked || [])].sort();
  const want = [...q.answer].sort();
  return picked.length === want.length && picked.every((v, i) => v === want[i]);
};

export default function Quiz({ source }) {
  const quiz = useMemo(() => parseQuiz(source), [source]);
  const key = useMemo(() => storeKey(source), [source]);
  const [state, setState] = useState(() => load(key));
  const [at, setAt] = useState(() => Math.min(load(key).at || 0, (quiz?.questions.length || 1) - 1));
  if (!quiz) return null;
  const save = (next) => { setState(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* full */ } };
  const answers = state.answers || {};
  const setAnswer = (i, patch) => save({ ...state, at, answers: { ...answers, [i]: { ...answers[i], ...patch } } });
  const go = (i) => { setAt(i); save({ ...state, at: i }); };
  const done = quiz.questions.every((q, i) => answers[i]?.checked);
  const score = quiz.questions.filter((q, i) => correctOf(q, answers[i])).length;
  const total = quiz.questions.length;
  const shown = quiz.mode === 'all' ? quiz.questions.map((_, i) => i) : [at];

  const renderQuestion = (i) => {
    const q = quiz.questions[i];
    const a = answers[i] || {};
    const result = correctOf(q, a);
    const picked = new Set(a.picked || []);
    const pick = (o) => {
      if (a.checked) return;
      if (q.type === 'multi') { const s = new Set(picked); s.has(o) ? s.delete(o) : s.add(o); setAnswer(i, { picked: [...s] }); }
      else setAnswer(i, { picked: [o], checked: true });
    };
    return (
      <div key={i} className={`quiz-q ${result === true ? 'is-right' : result === false ? 'is-wrong' : ''}`}>
        <div className="quiz-q-head">
          <span className="quiz-num">Q{i + 1}</span>
          <span className="quiz-text">{q.text}</span>
          {q.type === 'multi' && <span className="quiz-tag">모두 고르기</span>}
        </div>
        {q.type === 'short' ? (
          <form className="quiz-short" onSubmit={(e) => { e.preventDefault(); if ((a.text || '').trim()) setAnswer(i, { checked: true }); }}>
            <input value={a.text || ''} disabled={a.checked} placeholder="답을 입력하세요" onChange={(e) => setAnswer(i, { text: e.target.value })} aria-label={`Q${i + 1} 답`} />
            {!a.checked && <button type="submit" className="quiz-check" disabled={!(a.text || '').trim()}>확인</button>}
          </form>
        ) : (
          <div className={`quiz-options ${q.type === 'ox' ? 'is-ox' : ''}`} role={q.type === 'multi' ? 'group' : 'radiogroup'}>
            {q.options.map((o, oi) => {
              const isAns = q.answer.includes(oi);
              const cls = a.checked ? (isAns ? 'is-answer' : picked.has(oi) ? 'is-miss' : 'is-dim') : picked.has(oi) ? 'is-picked' : '';
              return (
                <button key={oi} type="button" className={`quiz-option ${cls}`} disabled={a.checked}
                  role={q.type === 'multi' ? 'checkbox' : 'radio'} aria-checked={picked.has(oi)} onClick={() => pick(oi)}>
                  <span className="quiz-letter">{q.type === 'ox' ? o : String.fromCharCode(65 + oi)}</span>
                  {q.type !== 'ox' && <span className="quiz-option-text">{o}</span>}
                  {a.checked && isAns && <Check size={15} className="quiz-mark" />}
                  {a.checked && !isAns && picked.has(oi) && <X size={15} className="quiz-mark" />}
                </button>
              );
            })}
          </div>
        )}
        {q.type === 'multi' && !a.checked && (
          <button type="button" className="quiz-check" disabled={!picked.size} onClick={() => setAnswer(i, { checked: true })}>확인</button>
        )}
        {!a.checked && q.hint && (
          a.hint ? <div className="quiz-hint"><Lightbulb size={14} /> {q.hint}</div>
            : <button type="button" className="quiz-link" onClick={() => setAnswer(i, { hint: true })}><Lightbulb size={13} /> 힌트 보기</button>
        )}
        {a.checked && (
          <div className="quiz-feedback" role="status">
            <strong>{result ? '정답입니다!' : '오답입니다.'}</strong>
            {!result && q.type === 'short' && <span> 정답: {q.answers[0]}</span>}
            {q.explain && <p>{q.explain}</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="quiz-card" aria-label={quiz.title}>
      <header className="quiz-head">
        <span className="quiz-title">{quiz.title}</span>
        <span className="quiz-progress" aria-label="진행도">
          {quiz.questions.map((q, i) => {
            const r = correctOf(q, answers[i]);
            return <button key={i} type="button" aria-label={`Q${i + 1}`} className={`quiz-dot ${i === at && quiz.mode !== 'all' ? 'is-at' : ''} ${r === true ? 'is-right' : r === false ? 'is-wrong' : ''}`} onClick={() => go(i)} />;
          })}
        </span>
      </header>
      {shown.map(renderQuestion)}
      <footer className="quiz-foot">
        {quiz.mode !== 'all' && <>
          <button type="button" className="quiz-nav" disabled={at === 0} onClick={() => go(at - 1)}><ChevronLeft size={15} /> 이전</button>
          <span className="quiz-count">{at + 1} / {total}</span>
          <button type="button" className="quiz-nav" disabled={at === total - 1} onClick={() => go(at + 1)}>다음 <ChevronRight size={15} /></button>
        </>}
        {done && <span className="quiz-score"><Trophy size={15} /> {score} / {total}점 ({Math.round(score / total * 100)}%)</span>}
        <button type="button" className="quiz-link" onClick={() => { setAt(0); save({}); }}><RotateCcw size={13} /> 다시 풀기</button>
      </footer>
    </section>
  );
}
