#!/usr/bin/env node
/**
 * The subscription CLIs as a tool: a local model hands the hard part of a
 * question to Claude Code, Codex or Antigravity and carries on with the
 * answer.
 *
 *     node server/mcpDelegate.mjs [--models claude-code:sonnet,codex:gpt-5.5] [--no-fallback]
 *
 * A local model is free and private and answers most things well enough;
 * what it gets wrong is the one step that needs a much larger model -- a
 * proof, a tricky bug, a fact it does not have. Switching the whole chat to a
 * CLI model spends the subscription on every turn, the easy ones included.
 * With this server in `mcp.json`, the local model asks for help only when it
 * decides it needs it, and the quota is spent on that one question.
 *
 * Tools:
 *   list_models   the CLI models on this machine, and which are over a limit
 *   ask           one question to one of them; the answer comes back as text
 *
 * Each question runs the CLI exactly as a chat answer does (server/cliModels.js):
 * one process, no tools of its own, nothing it can change on this machine.
 * `--models` limits which may be asked; with CLI_FALLBACK in `.env`, a model
 * over its limit is replaced by the next CLI in it (`--no-fallback` not).
 *
 * It is never handed to the CLIs themselves (see `isDelegate` in
 * server/cliModels.js): a CLI able to ask a CLI is a loop that ends when the
 * subscription does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  availableProviders, modelsOf, parseCliModel, runCli, allLimits, noteLimitError, effortOf,
} from './cliModels.js';
import { blockedUntil, candidatesFor, isLimitError, isUnavailableError } from './cliFallback.js';
import { recordUsage } from './cliUsage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* `.env` as the server reads it (server/index.js): set variables win. */
const loadEnv = () => {
  const out = { ...process.env };
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || line.trim().startsWith('#')) continue;
      if (out[match[1]] === undefined) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
  return out;
};

const env = loadEnv();
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
};
const only = flagValue('--models').split(',').map(s => s.trim()).filter(Boolean);
const useFallback = !argv.includes('--no-fallback');

/** The models that may be asked, as `cli:model` names. */
export const askable = async () => {
  const names = [];
  for (const provider of availableProviders(env)) {
    for (const model of await modelsOf(provider, env)) names.push(`${provider.id}:${model}`);
  }
  return only.length ? names.filter(n => only.includes(n)) : names;
};

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

const describeLimits = (id) => {
  const limits = allLimits(env)[id];
  const blocked = blockedUntil(limits);
  if (!blocked) return 'available';
  return blocked.until ? `over its usage limit until ${new Date(blocked.until).toISOString()}` : 'over its usage limit';
};

const TOOLS = async () => {
  const models = await askable();
  return [
    {
      name: 'list_models',
      description: 'List the larger models this app can ask through the subscription CLIs (Claude Code, Codex, Antigravity), and whether each is currently over its usage limit.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'ask',
      description: 'Ask a much larger model (Claude, GPT or Gemini, through a subscription CLI) one self-contained question and get its answer as text. '
        + 'Use it sparingly, for the part of a task you cannot do reliably yourself: hard reasoning, tricky code, a careful review. '
        + 'It does not see this conversation -- put everything it needs in `prompt`. It cannot use tools or read files.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Which model, e.g. one of: ' + (models.slice(0, 8).join(', ') || 'claude-code:sonnet'), ...(models.length ? { enum: models } : {}) },
          prompt: { type: 'string', description: 'The whole question, with any context it needs.' },
          system: { type: 'string', description: 'Optional instructions for how to answer.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How hard it should think. Default: its own default.' },
        },
        required: ['model', 'prompt'],
      },
    },
  ];
};

/** One question, with the fallback chain's other CLIs if this one is over its limit. */
export const ask = async ({ model, prompt, system = '', effort = '' }) => {
  const allowed = await askable();
  if (!allowed.includes(model)) throw new Error(`${model} cannot be asked here. Available: ${allowed.join(', ') || 'none'}`);
  const chain = (useFallback ? candidatesFor(model, env) : [model]).filter(name => allowed.includes(name));
  const tried = [];
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const target = parseCliModel(name);
    if (!target) continue;
    const lastChance = i === chain.length - 1;
    if (!lastChance && blockedUntil(allLimits(env)[target.provider.id])) { tried.push(`${name} (limit)`); continue; }
    let answer = '';
    const started = Date.now();
    try {
      const think = effort && effortOf(effort, target.provider, env) ? effort : undefined;
      const result = await runCli({
        provider: target.provider,
        model: target.model,
        request: { system: system || 'You are a careful expert assistant. Answer the question directly and completely.', prompt, images: [] },
        env,
        think,
        onDelta: (d) => { answer += d.content || ''; },
      });
      recordUsage({ provider: target.provider.id, model: target.model, via: 'delegate', usage: result.usage, ms: Date.now() - started, fallbackFrom: name !== model ? model : '' });
      const usage = result.usage || {};
      const footer = [
        `answered by ${name}`,
        tried.length ? `instead of ${tried.join(', ')}` : '',
        Number.isFinite(usage.eval) ? `${usage.eval} tokens` : '',
        Number.isFinite(usage.costUsd) ? `$${usage.costUsd.toFixed(4)}` : '',
      ].filter(Boolean).join(' · ');
      return `${answer.trim()}\n\n[${footer}]`;
    } catch (e) {
      const message = String(e.message || e);
      recordUsage({ provider: target.provider.id, model: target.model, via: 'delegate', error: message, ms: Date.now() - started });
      noteLimitError(target.provider.id, message);
      if (!answer && !lastChance && (isLimitError(message) || isUnavailableError(message))) { tried.push(`${name} (${isLimitError(message) ? 'limit' : 'unavailable'})`); continue; }
      throw e;
    }
  }
  throw new Error(`No model could answer${tried.length ? `: ${tried.join(', ')}` : ''}.`);
};

const call = async (name, args = {}) => {
  if (name === 'list_models') {
    const models = await askable();
    if (!models.length) return text('No subscription CLI is installed and offered on this machine.');
    return text(models.map(m => `${m} — ${describeLimits(parseCliModel(m).provider.id)}`).join('\n'));
  }
  if (name === 'ask') {
    if (!String(args.prompt || '').trim()) throw new Error('`prompt` is empty.');
    return text(await ask({
      model: String(args.model || ''), prompt: String(args.prompt), system: String(args.system || ''), effort: String(args.effort || ''),
    }));
  }
  throw new Error(`No tool called ${name}`);
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async (message) => {
  const { id, method, params } = message;
  if (id === undefined) return;
  try {
    if (method === 'initialize') {
      return write({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ollama-webui-delegate', version: '1.0.0' },
          instructions: 'Ask a larger model (Claude, GPT, Gemini) one self-contained question when a step is beyond you. Each call spends the reader\'s subscription, so use it for the hard part only.',
        },
      });
    }
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: await TOOLS() } });
    if (method === 'tools/call') {
      try {
        return write({ jsonrpc: '2.0', id, result: await call(params?.name, params?.arguments || {}) });
      } catch (e) {
        return write({ jsonrpc: '2.0', id, result: text(`Error: ${e.message}`, true) });
      }
    }
    return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported` } });
  } catch (e) {
    return write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
};

/* Only when run as a server; imported (by the tests), it just exports. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let buffer = '';
  // A question takes minutes; the client closing stdin is not a reason to drop its answer.
  const pending = new Set();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const work = handle(parsed).finally(() => pending.delete(work));
      pending.add(work);
    }
  });
  process.stdin.on('end', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
}

