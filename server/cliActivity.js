import { cliToolPhase } from '../src/cliActivity.js';

const PRIORITY = { waiting: 100, compacting: 90, running: 80, editing: 70, writing: 70,
  generating: 70, delegating: 60, browsing: 50, searching: 50, reading: 40, planning: 40,
  tools: 30, responding: 20, thinking: 10, starting: 1 };

// Activity is driven by protocol events, never by interpreting generated text.
export class CliActivity {
  constructor(provider) { this.provider = provider; this.items = new Map(); this.phase = ''; }
  update() {
    const phases = [...this.items.values()];
    const phase = phases.sort((a, b) => (PRIORITY[a] || 0) - (PRIORITY[b] || 0)).at(-1) || '';
    if (phase === this.phase) return undefined;
    this.phase = phase;
    return phase;
  }
  set(id, phase) { if (phase) this.items.set(id, phase); else this.items.delete(id); return this.update(); }
  toolStarted(id, name, args) { return this.set(id, cliToolPhase(name, args)); }
  clear() { this.items.clear(); return this.update(); }
  accept(line) {
    if (this.provider === 'codex') {
      const p = line.params || {}, item = p.item || {};
      if (line.method === 'turn/started' || line.method === 'turn/completed') this.items.clear();
      if (line.method === 'item/started') {
        const phase = ({ reasoning: 'thinking', agentMessage: 'responding', commandExecution: 'running',
          fileChange: 'editing', webSearch: 'searching', imageGeneration: 'generating',
          collabAgentToolCall: 'delegating', contextCompaction: 'compacting' })[item.type]
          || (['mcpToolCall', 'dynamicToolCall'].includes(item.type) ? cliToolPhase(item.tool, item.arguments) : '');
        if (phase) this.items.set(item.id, phase);
      }
      if (/^item\/reasoning\/(summaryTextDelta|textDelta)$/.test(line.method)) this.items.set(p.itemId, 'thinking');
      if (line.method === 'item/agentMessage/delta') this.items.set(p.itemId, 'responding');
      if (line.method === 'item/completed') this.items.delete(item.id);
    } else if (this.provider === 'claude-code') {
      const e = line.event || {}, b = e.content_block || {}, d = e.delta || {};
      if (line.type === 'system' && line.subtype === 'compact_boundary') this.items.delete('compact');
      if (line.type === 'system' && line.subtype === 'status') {
        if (line.status === 'compacting') this.items.set('compact', 'compacting');
        else this.items.delete('compact');
      }
      if (e.type === 'content_block_start') {
        const tool = ['tool_use', 'server_tool_use'].includes(b.type);
        const phase = /thinking/.test(b.type) ? 'thinking' : b.type === 'text' ? 'responding' : tool ? cliToolPhase(b.name, b.input) : '';
        if (phase) this.items.set(e.index, phase);
        if (b.id && tool) this.items.set(b.id, phase);
      }
      if (e.type === 'content_block_delta' && d.type === 'thinking_delta') this.items.set(e.index, 'thinking');
      if (e.type === 'content_block_delta' && d.type === 'text_delta') this.items.set(e.index, 'responding');
      if (e.type === 'content_block_stop') this.items.delete(e.index);
      if (line.type === 'user' && Array.isArray(line.message?.content)) {
        for (const p of line.message.content) if (p.type === 'tool_result') this.items.delete(p.tool_use_id);
      }
      if (line.type === 'result') this.items.clear();
    } else if (this.provider === 'agy') {
      const step = line.step_update || {};
      if (step.thinking_delta) this.items.set('step', 'thinking');
      if (step.step_type === 'agent_response' && step.text_delta) this.items.set('step', 'responding');
      if (line.event === 'result') this.items.clear();
    }
    return this.update();
  }
}
