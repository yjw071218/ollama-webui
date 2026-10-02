/**
 * What a coding CLI did while it worked, read back out of its thinking.
 *
 * server/cliModels.js says each step of a CLI's own loop -- a tool it called,
 * a command it ran, a file it edited, a question it is waiting on -- as a line
 * of its own in the thinking:
 *
 *     [tool: workbench / edit_file · C:\repo\src\App.jsx]
 *     [running: npm test]
 *     [command: npm test → exit 1]
 *     ...the last lines of its output...
 *     [/output]
 *     [approval needed: Run `rm -rf dist`?]
 *
 * Shown as text, a long run was a wall of brackets. `activityOf` turns it into
 * prose and steps, and the chat draws the steps as a timeline (see
 * src/AgentActivity.jsx). Pure, so it is tested without a browser.
 */

const MARKER = /^\[(tool failed|tool|web search|running|command|edit|approval needed)(?:: ([\s\S]*))?\]\s*$/;
const STAMP = /^\[at: (\d{10,})\]$/;
const INPUT = /^\[input: (\{[\s\S]*)\]$/;
const COMMAND_END = /^([\s\S]*?) → (timed out|declined|exit (-?\d+|\?))$/;

/* `files / read_text_file` -> `read_text_file`; `Bash` -> `bash`. */
const baseName = (label) => String(label || '').split('/').pop().trim().toLowerCase();

/** What sort of step a tool name is, for its icon and verb. */
export const toolKind = (label) => {
  const name = baseName(label);
  if (/run_command|^bash$|shell|exec|terminal|powershell/.test(name)) return 'command';
  if (/edit|write|replace|patch|create|multiedit|move|rename|delete|notebookedit/.test(name)) return 'edit';
  if (/read|view|cat|open|get_file/.test(name)) return 'read';
  if (/grep|search_files|find|glob|^ls$|list|tree/.test(name)) return 'search';
  if (/web_?search|websearch/.test(name)) return 'web';
  if (/fetch|url|browse|webfetch/.test(name)) return 'fetch';
  if (/todo|task|agent/.test(name)) return 'task';
  return 'tool';
};

const sameCommand = (a, b) => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
};

/**
 * `[{ type: 'prose', text } | { type: 'step', kind, label, target, status, code, output }]`
 *
 * `status` is 'done', 'failed', 'waiting' (an approval) or 'running'; a step
 * with no result yet is 'running' only when `live` and it is the last one --
 * otherwise the CLI went on past it, so it finished.
 */
export const activityOf = (text, { live = false } = {}) => {
  const segments = [];
  const steps = [];
  let prose = [];
  let output = null;          // the step whose output (or result) lines follow
  let at = null;              // the time of the marker about to come ([at: N])

  const flushProse = () => {
    const body = prose.join('\n').trim();
    if (body) segments.push({ type: 'prose', text: body });
    prose = [];
  };
  const push = (step) => {
    flushProse();
    const made = { type: 'step', ...step, ...(at ? { at } : {}) };
    at = null;
    segments.push(made);
    steps.push(made);
    return made;
  };
  const closeOutput = () => {
    if (output) { output.step[output.key] = output.lines.join('\n').trim(); output = null; }
  };
  // The step a command result belongs to: the latest one still waiting for it.
  const openCommand = (command) => {
    for (let n = steps.length - 1; n >= 0; n -= 1) {
      const s = steps[n];
      if (s.kind === 'command' && s.status === 'pending' && (!command || !s.target || sameCommand(s.target, command))) return s;
    }
    return null;
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '[/output]') { closeOutput(); continue; }
    const stamp = STAMP.exec(trimmed);
    if (stamp) { closeOutput(); at = Number(stamp[1]); continue; }
    const input = INPUT.exec(trimmed);
    if (input && steps.length) {
      closeOutput();
      steps[steps.length - 1].input = input[1];
      continue;
    }
    if (trimmed === '[result]') {
      closeOutput();
      const last = steps[steps.length - 1];
      if (last) output = { step: last, key: 'result', lines: [] };
      continue;
    }
    const m = MARKER.exec(trimmed);
    if (!m) {
      if (output) output.lines.push(line); else prose.push(line);
      continue;
    }
    closeOutput();
    const [, what, rest = ''] = m;
    const detail = rest.trim();
    if (what === 'tool') {
      const cut = detail.indexOf(' · ');
      const label = cut === -1 ? detail : detail.slice(0, cut);
      const target = cut === -1 ? '' : detail.slice(cut + 3);
      push({ kind: toolKind(label), label, target, status: 'pending' });
    } else if (what === 'running') {
      push({ kind: 'command', label: 'command', target: detail, status: 'pending' });
    } else if (what === 'command') {
      const end = COMMAND_END.exec(detail);
      const command = end ? end[1] : detail;
      const verdict = end ? end[2] : '';
      const code = end && end[3] !== undefined && end[3] !== '?' ? Number(end[3]) : null;
      const endAt = at;
      const step = openCommand(command) || push({ kind: 'command', label: 'command', target: command, status: 'pending' });
      if (endAt && step.at && endAt !== step.at) step.endAt = endAt;
      at = null;
      if (!step.target) step.target = command;
      step.code = code;
      step.status = verdict === 'timed out' ? 'timedOut' : verdict === 'declined' ? 'declined' : (code === 0 || code === null ? 'done' : 'failed');
      output = { step, key: 'output', lines: [] };
    } else if (what === 'edit') {
      push({ kind: 'edit', label: 'edit', target: detail, status: 'done' });
    } else if (what === 'web search') {
      push({ kind: 'web', label: 'web search', target: detail, status: 'done' });
    } else if (what === 'approval needed') {
      push({ kind: 'approval', label: 'approval', target: detail, status: 'waiting' });
    } else if (what === 'tool failed') {
      // Said of the call before it, when there is one still open.
      const last = [...steps].reverse().find(s => s.status === 'pending' && s.kind !== 'command');
      if (last) {
        last.status = 'failed'; last.error = detail;
        if (at && last.at) last.endAt = at;
      } else push({ kind: 'tool', label: 'tool', target: detail, status: 'failed', error: detail });
    }
    at = null;               // a stamp belongs to the one marker after it
  }
  closeOutput();
  flushProse();

  /* How long each took: to its own end when it has one (a command), else to
     the step after it. The last one, still running, is timed by the view. */
  steps.forEach((step, n) => {
    if (!step.at) return;
    const end = step.endAt || steps.slice(n + 1).find(s => s.at)?.at;
    if (end && end >= step.at) step.ms = end - step.at;
  });

  /* Settle what is still open: a step followed by another finished (the CLI
     moved on); the very last one is running while the answer is still live.
     An approval stops waiting once anything comes after it. */
  steps.forEach((step, n) => {
    const last = n === steps.length - 1;
    if (step.status === 'pending') step.status = live && last ? 'running' : 'done';
    if (step.status === 'waiting' && (!live || !last)) step.status = 'answered';
  });
  return segments;
};

/** Whether a thinking text has any step in it, so plain reasoning keeps its old look. */
export const hasActivity = (text) => String(text || '').split(/\r?\n/).some(line => MARKER.test(line.trim()));

/** Counts for the summary line: `{ steps, commands, edits, failed, running }`. */
export const activitySummary = (segments) => {
  const steps = segments.filter(s => s.type === 'step');
  return {
    steps: steps.length,
    commands: steps.filter(s => s.kind === 'command').length,
    edits: steps.filter(s => s.kind === 'edit').length,
    failed: steps.filter(s => ['failed', 'timedOut', 'declined'].includes(s.status)).length,
    running: steps.some(s => s.status === 'running' || s.status === 'waiting'),
  };
};
