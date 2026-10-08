// Shared by the event reader and every web/native client. Unknown phases stay blank.
export const CLI_ACTIVITY_LABELS = Object.freeze({
  starting: 'Starting…', thinking: 'Thinking…', responding: 'Responding…',
  running: 'Running…', reading: 'Reading…', searching: 'Searching…',
  browsing: 'Browsing…', editing: 'Editing…', writing: 'Writing…',
  tools: 'Using tools…', planning: 'Planning…', delegating: 'Delegating…',
  compacting: 'Compacting…', waiting: 'Waiting…', generating: 'Generating image…',
});

export const cliActivityLabel = phase => Object.hasOwn(CLI_ACTIVITY_LABELS, phase) ? CLI_ACTIVITY_LABELS[phase] : '';

// Classify tool identifiers, never the model's prose or arbitrary shell commands.
const TOOL_PHASES = new Map(Object.entries({
  running: ['bash', 'powershell', 'run_command', 'exec_command', 'execute_command', 'command_execution'],
  reading: ['read', 'read_file', 'read_text_file', 'read_multiple_files', 'view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'list_directory'],
  searching: ['grep', 'glob', 'grep_search', 'find_by_name', 'search_files', 'search_web', 'websearch', 'web_search'],
  browsing: ['webfetch', 'web_fetch', 'read_url_content', 'read_browser_page', 'browser_navigate', 'open_url'],
  editing: ['edit', 'multiedit', 'edit_file', 'apply_patch', 'replace_file_content', 'multi_replace_file_content'],
  writing: ['write', 'write_file', 'write_to_file', 'create_file'],
  planning: ['todowrite', 'update_plan', 'manage_task'],
  delegating: ['agent', 'task', 'spawn_agent', 'delegate', 'delegate_task', 'browser_subagent'],
  waiting: ['wait', 'wait_agent', 'command_status', 'askuserquestion', 'request_user_input'],
  generating: ['generate_image', 'imagegen'],
}).flatMap(([phase, names]) => names.map(name => [name, phase])));

export const cliToolPhase = (name, args = {}) => {
  let key = String(name || '').split('__').at(-1).toLowerCase();
  if (key === 'call_mcp_tool') key = String(args?.ToolName || args?.tool || '').toLowerCase();
  return TOOL_PHASES.get(key) || 'tools';
};
