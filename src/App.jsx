import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import localforage from 'localforage';
import { ArrowUp, Paperclip, Sparkles, RefreshCcw, Trash2, Copy, Check, Terminal, Settings, Edit, MessageSquare, ChevronDown, Download, Square, X, Play, Mic, MicOff, Volume2, Search, Code, Maximize2, Sun, Moon, Monitor, Pin, PinOff, GitBranch, FileDown, Command, Cpu, Plus, Save, ArrowDown, Zap, Layers, Server, ExternalLink, Star, Info, TriangleAlert, FileText, Minimize2, PanelLeft, ListTree, LogOut, UserPlus, Languages, User, Activity, Globe, Folder, FolderPlus, MoreHorizontal, ChevronLeft, ChevronRight, SlidersHorizontal, CornerDownRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import {
  extractCodeBlocks,
  normalizeLanguage,
  isPreviewable,
  isPythonish,
  buildPreviewDocument,
  ConsolePane,
  PythonRunner,
  CodeView,
  UnsupportedPreview,
  EXTENSION_FOR,
  PreviewStage,
} from './artifacts.jsx';
import { usePersistedNumber, ResizeHandle, Popover, AnchoredMenu, Collapsible, Transition, SettingToggle, Switch, clamp } from './ui.jsx';
import { I18nProvider, useI18n, LANGUAGES } from './i18n.jsx';
import { AuthScreen } from './AuthScreen.jsx';
import { ProfileDialog, ProfileAvatar } from './ProfileDialog.jsx';
import { SystemMonitor, SystemStrip } from './SystemMonitor.jsx';
import { KnowledgePanel } from './KnowledgePanel.jsx';
import { ModelCompare } from './ModelCompare.jsx';
import { loadLibrary, retrieve, formatContext, DEFAULT_EMBED_MODEL } from './rag.js';
import {
  loadMemories, saveMemories, addMemories, removeMemory,
  formatMemories, extractMemories, MEMORY_KINDS,
} from './memory.js';
import { sessionToHtml } from './htmlExport.js';
import { decodeByteFallback } from './byteFallback.js';
import { relativeTime, absoluteTime } from './relativeTime.js';
import { collectBackup, restoreBackup, describeBackup, isBackup } from './backup.js';
import {
  fetchServerConfig, serverMe, serverRegister, serverLogin, serverLogout,
  linkGoogleSession, pushState, pullState, createSyncScheduler,
} from './serverAccount.js';
import { appendVariant, selectVariant, removeVariant, variantsOf, variantCount, variantIndexOf } from './variants.js';
import { wasTruncated, joinContinuation, looksRestarted, CONTINUE_PROMPT } from './continuation.js';
import { newFolder, loadFolders, saveFolders, renameFolder, updateFolder, removeFolder, assignToFolder, groupByFolder, folderOf } from './folders.js';
import { PRESET_FIELDS, BUILTIN_PRESETS, newPreset, loadPresets, savePresets, sanitisePreset, matchPreset } from './presets.js';
import {
  loadUsers,
  publicUser,
  readSession,
  saveSession,
  deleteUser,
  sessionStorageKeyFor,
  setServerSocialConfig,
  signOutSocial,
  socialDefaults,
  kakaoRedirectUri,
} from './auth.jsx';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null, info: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { this.setState({ error, info }); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', color: 'red', background: '#222', height: '100vh', overflow: 'auto' }}>
          <h2>React Crashed!</h2>
          <pre>{this.state.error?.toString()}</pre>
          <pre>{this.state.info?.componentStack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Helper to parse thinking blocks
// Helper to parse MCP Tools UI
const parseMcpTools = (text) => {
  const parts = [];
  let currentText = text || '';

  const toolCallRegex = /<(TOOL_READ_FILE|TOOL_WRITE_FILE|TOOL_LIST_DIR|TOOL_SEARCH_FILES)(?:\s+(path|query)="([^"]+)")?(?:\s+(path|query)="([^"]+)")?>([\s\S]*?)<\/\1>/;
  const toolResultRegex = /<TOOL_RESULT>([\s\S]*?)<\/TOOL_RESULT>/;

  while (currentText) {
    const callMatch = currentText.match(toolCallRegex);
    const resultMatch = currentText.match(toolResultRegex);

    if (!callMatch && !resultMatch) {
      parts.push({ type: 'text', content: currentText });
      break;
    }

    let match = callMatch;
    let isResult = false;
    
    if (resultMatch) {
      if (!callMatch || resultMatch.index < callMatch.index) {
        match = resultMatch;
        isResult = true;
      }
    }

    if (match.index > 0) {
      parts.push({ type: 'text', content: currentText.substring(0, match.index) });
    }

    if (isResult) {
      parts.push({ 
        type: 'tool_result', 
        content: match[1].trim() 
      });
    } else {
      let pathVal = match[3];
      let queryVal = match[5];
      if (match[2] === 'query') {
        queryVal = match[3];
        pathVal = undefined;
      }
      
      parts.push({ 
        type: 'tool_call', 
        tool: match[1],
        path: pathVal || match[6].trim(),
        query: queryVal,
        content: match[6] 
      });
    }

    currentText = currentText.substring(match.index + match[0].length);
  }

  return parts;
};

const extractAttachments = (content) => {
  const attachments = [];
  const textMatches = [...content.matchAll(/---\s+Attached File:\s+(.*?)\s+---[\s\S]*?-------------------/g)];
  textMatches.forEach(m => {
    attachments.push({ type: 'file', name: m[1] });
  });

  const urlMatches = [...content.matchAll(/---\s+\[MCP Tool\] Fetched Content from\s+(.*?)\s+---[\s\S]*?-------------------/g)];
  urlMatches.forEach(m => {
    attachments.push({ type: 'url', name: m[1] });
  });

  const cleanedContent = content
    .replace(/---\s+Attached File:\s+(.*?)\s+---[\s\S]*?-------------------/g, '')
    .replace(/---\s+\[MCP Tool\] Fetched Content from\s+(.*?)\s+---[\s\S]*?-------------------/g, '')
    .replace(/---\s+Image Analysis by.*?\n[\s\S]*?-------------------\n?/g, '')
    .trim();

  return { attachments, cleanedContent };
};

const parseAssistantMessage = (content) => {
  const blocks = [];
  // Decoding here as well as at accumulation is what repairs chats that were
  // already saved with the byte spellings in them. The guard inside makes it
  // free for the overwhelming majority of messages that have none.
  let currentText = decodeByteFallback(content || '');

  const regex = /(?:<think>([\s\S]*?)(?:<\/think>|$))|(?:<(TOOL_[A-Z_]+)(?:\s+(?:path|query)="([^"]+)")?(?:\s+(?:path|query)="([^"]+)")?>([\s\S]*?)<\/\2>)|(?:<TOOL_RESULT>([\s\S]*?)<\/TOOL_RESULT>)/gi;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(currentText)) !== null) {
    if (match.index > lastIndex) {
      const beforeText = currentText.substring(lastIndex, match.index).trim();
      if (beforeText) blocks.push({ type: 'text', content: beforeText });
    }

    if (match[1] !== undefined) {
      blocks.push({ type: 'think', content: match[1], isComplete: match[0].endsWith('</think>') });
    } else if (match[2] !== undefined) {
      let pathVal = match[3];
      let queryVal = match[5];
      if (match[0].startsWith(`<${match[2]} query=`)) {
        queryVal = match[3];
        pathVal = undefined;
      }
      blocks.push({ type: 'tool_call', tool: match[2], path: pathVal || match[5]?.trim(), query: queryVal, content: match[5] });
    } else if (match[6] !== undefined) {
      blocks.push({ type: 'tool_result', content: match[6] });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < currentText.length) {
    const remainingText = currentText.substring(lastIndex).trim();
    if (remainingText) blocks.push({ type: 'text', content: remainingText });
  }

  return blocks;
};

// Python Runner Component (Uses Pyodide)
const categorizeSession = (timestamp) => {
  if (!timestamp) return 'Older';
  const now = new Date();
  const date = new Date(timestamp);
  
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  const diffDays = Math.floor((nowDay - dateDay) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 Days';
  if (diffDays <= 30) return 'Previous 30 Days';
  return 'Older';
};

// ---- Small utilities used by the newer features ----

// Rough token estimate. Latin text averages ~4 chars/token, Hangul ~1.5,
// so weight by how much of the string is non-ASCII.
const estimateTokens = (text) => {
  if (!text) return 0;
  const str = String(text);
  let wide = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) wide++;
  }
  const ascii = str.length - wide;
  return Math.ceil(ascii / 4 + wide / 1.5);
};

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const downloadBlob = (filename, content, mime = 'text/plain;charset=utf-8') => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const slugify = (text) => (text || 'chat')
  .trim()
  .replace(/[\\/:*?"<>|]+/g, '')
  .replace(/\s+/g, '-')
  .substring(0, 60) || 'chat';

// Strips the tool/think scaffolding so exported Markdown reads like a transcript.
const cleanForExport = (content) => (content || '')
  .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
  .replace(/<TOOL_RESULT>[\s\S]*?<\/TOOL_RESULT>/gi, '')
  .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?<\/TOOL_[A-Z_]+>/gi, '')
  .trim();

// What actually gets sent to the TTS engine. The old version only stripped
// the <think> *tags*, so the whole reasoning trace was read out loud.
const stripForSpeech = (text) => (text || '')
  // reasoning and tool scaffolding, including a block left unterminated
  .replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ')
  .replace(/<TOOL_RESULT>[\s\S]*?(<\/TOOL_RESULT>|$)/gi, ' ')
  .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?(<\/TOOL_[A-Z_]+>|$)/gi, ' ')
  // injected context blocks
  .replace(/---\s+Attached File:[\s\S]*?-------------------/g, ' ')
  .replace(/---\s+\[MCP Tool\] Fetched Content from[\s\S]*?-------------------/g, ' ')
  .replace(/---\s+Image Analysis by[\s\S]*?-------------------/g, ' ')
  // code is unpleasant to listen to
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  // markdown: keep the words, drop the syntax
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/^\s{0,3}>\s?/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '')
  .replace(/(\*\*|__|\*|_|~~)/g, '')
  .replace(/^\s*\|.*\|\s*$/gm, ' ')
  .replace(/^\s*[-:| ]+\s*$/gm, ' ')
  // any leftover raw HTML
  .replace(/<[^>]*>/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const sessionToMarkdown = (session) => {
  const lines = [`# ${session.title || 'Chat'}`, ''];
  const created = new Date(session.createdAt || Date.now());
  lines.push(`_${created.toLocaleString()}${session.lastModel ? ` · ${session.lastModel}` : ''}_`, '');
  (session.messages || []).forEach(msg => {
    const body = cleanForExport(msg.content);
    if (!body) return;
    lines.push(msg.role === 'user' ? '## 🧑 User' : '## 🤖 Assistant', '', body, '');
  });
  return lines.join('\n');
};

const SLASH_COMMANDS = [
  { name: '/imagine', desc: 'Generate an image from a prompt', template: '/imagine ' },
  { name: '/web', desc: 'Search the web, then answer from the results', template: '/web ' },
  { name: '/summarize', desc: 'Summarize the conversation so far', template: 'Summarize our conversation so far into concise bullet points.' },
  { name: '/translate', desc: 'Translate the following text', template: 'Translate the following text into natural Korean:\n\n' },
  { name: '/explain', desc: 'Explain code or a concept step by step', template: 'Explain the following step by step, assuming I am a competent engineer:\n\n' },
  { name: '/review', desc: 'Review code for bugs and improvements', template: 'Review this code for correctness bugs and possible simplifications:\n\n```\n\n```' },
  { name: '/fix', desc: 'Fix an error message', template: 'I am getting this error. Explain the cause and give me a fix:\n\n' },
];

const greetingKey = () => {
  const hour = new Date().getHours();
  if (hour < 5) return 'empty.night';
  if (hour < 12) return 'empty.morning';
  if (hour < 18) return 'empty.afternoon';
  return 'empty.evening';
};

const STARTER_PROMPTS = [
  { labelKey: 'empty.explain', Icon: Code, prompt: 'Explain the following code step by step:\n\n```\n\n```' },
  { labelKey: 'empty.webApp', Icon: Play, prompt: 'Build a single-file HTML page that ' },
  { labelKey: 'empty.summarize', Icon: Terminal, prompt: 'Summarize the key points of this page: https://' },
  { labelKey: 'empty.brainstorm', Icon: Sparkles, prompt: 'Give me 10 varied ideas for ' },
];

// Wraps each word of a text node in a span so newly streamed words can fade
// in on their own. React reuses the DOM node for a span whose position is
// unchanged, so only genuinely new words animate — the settled text stays put.
// Applied to the streaming message only; long transcripts never carry it.
const rehypeAnimateTokens = () => (tree) => {
  const SKIP = new Set(['code', 'pre', 'style', 'script', 'math']);

  const walk = (node) => {
    if (!node || !Array.isArray(node.children)) return;
    if (node.tagName && SKIP.has(node.tagName)) return;

    const next = [];
    let changed = false;

    for (const child of node.children) {
      if (child.type === 'text' && child.value) {
        // Keep the whitespace in the split so spacing survives the wrapping.
        const pieces = child.value.split(/(\s+)/);
        for (const piece of pieces) {
          if (!piece) continue;
          if (/^\s+$/.test(piece)) {
            next.push({ type: 'text', value: piece });
          } else {
            next.push({
              type: 'element',
              tagName: 'span',
              properties: { className: ['tok'] },
              children: [{ type: 'text', value: piece }],
            });
          }
        }
        changed = true;
      } else {
        walk(child);
        next.push(child);
      }
    }

    if (changed) node.children = next;
  };

  walk(tree);
};

/**
 * Search results arrive back as text so the model can read them. The UI
 * re-parses that text into cards; anything it cannot parse falls through to
 * the plain block, so an unexpected shape is never swallowed.
 */
const parseSearchResults = (text) => {
  const body = String(text || '');
  const header = body.match(/^Web search results for '(.*?)'(?: \(via ([^)]+)\))?:/);
  if (!header) return null;

  const entries = [];
  // "1. Title\n   https://url\n   snippet"
  const pattern = /^\s*(\d+)\.\s+(.+)\n\s+(\S+)\n\s+([\s\S]*?)(?=\n\s*\d+\.\s|\s*$)/gm;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    entries.push({
      title: match[2].trim(),
      url: match[3].trim(),
      snippet: match[4].trim().replace(/\s+/g, ' '),
    });
  }

  if (entries.length === 0) return null;
  return { query: header[1], provider: header[2] || '', entries };
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return url;
  }
};

/**
 * Does this question depend on facts newer than any training snapshot?
 *
 * A model cannot know it is out of date, so it answers 2024 facts with 2026
 * confidence. When one of these cues shows up the app searches first and hands
 * the model real sources instead of trusting recall.
 */
const RECENCY_CUES = [
  // English
  /\blatest\b/i, /\brecent(ly)?\b/i, /\bcurrent(ly)?\b/i, /\bnews\b/i, /\btoday\b/i,
  /\bthis (week|month|year)\b/i, /\bright now\b/i, /\bnowadays\b/i, /\bup ?to ?date\b/i,
  /\bnewest\b/i, /\bwhat'?s new\b/i, /\bstate of the art\b/i, /\bprice\b/i, /\brelease[ds]?\b/i,
  // Korean
  /최신/, /최근/, /요즘/, /근황/, /현재/, /지금/, /뉴스/, /동향/, /트렌드/, /출시/, /오늘/, /올해/,
  // Japanese
  /最新/, /最近/, /現在/, /ニュース/, /動向/,
  // Chinese
  /最新/, /最近/, /现在/, /新闻/, /动态/,
];

const YEAR_PATTERN = /\b(20[2-9]\d)\b/;

export const needsCurrentInfo = (text) => {
  const value = String(text || '');
  if (!value.trim()) return false;

  // A year at or after the current one is a strong signal on its own.
  const year = value.match(YEAR_PATTERN);
  if (year && Number(year[1]) >= new Date().getFullYear()) return true;

  return RECENCY_CUES.some(cue => cue.test(value));
};

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Splits text nodes in the rendered HAST so search hits can be wrapped in
// <mark>. Chat search used to hide every non-matching message, which threw
// away the surrounding conversation; now nothing is hidden.
const createSearchHighlighter = (query) => () => (tree) => {
  const needle = (query || '').trim();
  if (!needle) return;
  const pattern = new RegExp(escapeRegExp(needle), 'gi');

  const walk = (node) => {
    if (!node || !Array.isArray(node.children)) return;
    const next = [];
    let changed = false;

    for (const child of node.children) {
      if (child.type === 'text' && pattern.test(child.value)) {
        pattern.lastIndex = 0;
        let last = 0;
        let match;
        while ((match = pattern.exec(child.value)) !== null) {
          if (match.index > last) next.push({ type: 'text', value: child.value.slice(last, match.index) });
          next.push({
            type: 'element',
            tagName: 'mark',
            properties: { className: ['chat-hit'] },
            children: [{ type: 'text', value: match[0] }],
          });
          last = match.index + match[0].length;
          if (match[0].length === 0) pattern.lastIndex++; // guard against zero-width loops
        }
        if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
        changed = true;
      } else {
        walk(child);
        next.push(child);
      }
      pattern.lastIndex = 0;
    }

    if (changed) node.children = next;
  };

  walk(tree);
};

// Same idea for plain-text (user) bubbles, which never go through markdown.
const highlightPlain = (text, query) => {
  const needle = (query || '').trim();
  if (!needle) return text;
  const parts = String(text).split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  return parts.map((part, i) => (
    part.toLowerCase() === needle.toLowerCase()
      ? <mark className="chat-hit" key={i}>{part}</mark>
      : part
  ));
};

const DEFAULT_PROMPT_LIBRARY = [
  { id: 'p-commit', name: 'Commit message', body: 'Write a concise conventional-commit message for the following diff:\n\n' },
  { id: 'p-regex', name: 'Regex builder', body: 'Write a regular expression that matches the following, and explain each part:\n\n' },
  { id: 'p-korean', name: '한국어로 정리', body: '다음 내용을 한국어로 알기 쉽게 정리해 줘:\n\n' },
];

const extractText = (children) => {
  if (typeof children === 'string' || typeof children === 'number') {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(extractText).join('');
  }
  if (children && children.props && children.props.children) {
    return extractText(children.props.children);
  }
  return '';
};

const MarkdownCodeBlock = memo(({ inline, className, children, onOpenArtifact, ...props }) => {
  const [copied, setCopied] = useState(false);
  const match = /language-([\w-]+)/.exec(className || '');
  const language = normalizeLanguage(match ? match[1] : '');
  const codeContent = extractText(children).replace(/\n$/, '');
  const lineCount = codeContent.split('\n').length;
  const previewable = isPreviewable(language);
  const runnable = isPythonish(language);
  const isLong = lineCount > 15;

  const handleCopy = () => {
    navigator.clipboard.writeText(codeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!inline) {
    // Anything previewable, runnable or simply long gets promoted to the side
    // panel. Short Python still runs inline, long Python now runs in the panel
    // instead of quietly losing its Run button.
    if (previewable || runnable || isLong) {
      const openAs = previewable ? 'preview' : runnable ? 'run' : 'code';
      return (
        <div className="artifact-card" onClick={() => onOpenArtifact(codeContent, openAs, language)}>
          <div className="artifact-icon"><Code size={20} /></div>
          <div className="artifact-info">
            <span className="artifact-lang">{language || 'Code snippet'}</span>
            <span className="artifact-lines">{lineCount} lines</span>
          </div>
          <div className="artifact-actions">
            {previewable && (
              <button onClick={(e) => { e.stopPropagation(); onOpenArtifact(codeContent, 'preview', language); }}>
                <Play size={14} /> Preview
              </button>
            )}
            {runnable && (
              <button onClick={(e) => { e.stopPropagation(); onOpenArtifact(codeContent, 'run', language); }}>
                <Play size={14} /> Run
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); onOpenArtifact(codeContent, 'code', language); }}>
              <Maximize2 size={14} /> {t('artifact.viewCode')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="code-container">
        <div className="code-header">
          <span>{language || 'text'}</span>
          <button className="code-copy-btn" onClick={handleCopy}>
            {copied ? <Check size={12} /> : <Copy size={12} />} Copy
          </button>
        </div>
        <pre className={className}><code className={className} {...props}>{children}</code></pre>
        {runnable && <PythonRunner code={codeContent} compact />}
      </div>
    );
  }
  return <code className={className} {...props}>{children}</code>;
});

function App() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVisionModel, setSelectedVisionModel] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeArtifact, setActiveArtifact] = useState(null); // { type, version, fallbackContent, fallbackLang, fallbackIsWeb }
  
  // Custom Dropdown State
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isVisionDropdownOpen, setIsVisionDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const visionDropdownRef = useRef(null);

  // Settings / Logs panel state
  const [showSettings, setShowSettings] = useState(false);
  const [downloadModelName, setDownloadModelName] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('systemPrompt') || 'You are Claude, a helpful, honest, and harmless AI assistant.');
  const [temperature, setTemperature] = useState(() => {
    const val = localStorage.getItem('temperature');
    return val !== null ? parseFloat(val) : 0.7;
  });
  const [maxTokens, setMaxTokens] = useState(() => {
    const val = localStorage.getItem('maxTokens');
    return val !== null ? parseInt(val) : 4096;
  });
  const [codeTheme, setCodeTheme] = useState(() => localStorage.getItem('codeTheme') || 'atom-one-dark');
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [searchHitIndex, setSearchHitIndex] = useState(0);
  const [starredOnly, setStarredOnly] = useState(false);
  const [thinkOverrides, setThinkOverrides] = useState({});
  const messageRefs = useRef({});
  const chatSearchRef = useRef(null);
  const searchVisitedRef = useRef(false);
  const [showChatInfo, setShowChatInfo] = useState(false);
  const [showSystemMonitor, setShowSystemMonitor] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showSystemStrip, setShowSystemStrip] = useState(() => localStorage.getItem('showSystemStrip') !== 'false');
  const lastDeletedRef = useRef(null);

  // --- Appearance ---
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const { t, lang, setLang } = useI18n();

  // --- Accounts (device-local profiles) ---
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [showAuthScreen, setShowAuthScreen] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(() => localStorage.getItem('googleClientId') || '');
  const [kakaoRestKey, setKakaoRestKey] = useState(() => localStorage.getItem('kakaoRestKey') || '');

  useEffect(() => { localStorage.setItem('googleClientId', googleClientId); }, [googleClientId]);
  useEffect(() => { localStorage.setItem('kakaoRestKey', kakaoRestKey); }, [kakaoRestKey]);

  // Restore the stored session, or show the sign-in screen on a first visit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = readSession();
      if (session) {
        const users = await loadUsers();
        const found = users.find(u => u.id === session.userId);
        if (!cancelled && found) {
          setCurrentUser(publicUser(found));
          setAuthReady(true);
          return;
        }
      }
      if (cancelled) return;
      // Someone who already chose "continue as guest" is not asked again.
      const seenAuth = localStorage.getItem('authIntroSeen') === 'true';
      setShowAuthScreen(!seenAuth);
      setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const [chatFontSize, setChatFontSize] = useState(() => localStorage.getItem('chatFontSize') || 'medium');
  const [chatDensity, setChatDensity] = useState(() => localStorage.getItem('chatDensity') || 'comfortable');
  const [showOutline, setShowOutline] = useState(false);
  const [motionMode, setMotionMode] = useState(() => localStorage.getItem('motionMode') || 'system');
  // Watched live: the OS toggle is what silently suppressed motion before,
  // and there was nothing on screen saying so.
  const [osReducedMotion, setOsReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const onChange = (e) => setOsReducedMotion(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // --- Advanced sampling parameters ---
  const readNum = (key, fallback) => {
    const val = localStorage.getItem(key);
    return val !== null && val !== '' ? parseFloat(val) : fallback;
  };
  const [topP, setTopP] = useState(() => readNum('topP', 0.9));
  const [topK, setTopK] = useState(() => readNum('topK', 40));
  const [repeatPenalty, setRepeatPenalty] = useState(() => readNum('repeatPenalty', 1.1));
  const [numCtx, setNumCtx] = useState(() => readNum('numCtx', 4096));
  const [seed, setSeed] = useState(() => localStorage.getItem('seed') || '');
  // 'auto' leaves the field out entirely so each model keeps its own default.
  const [thinkMode, setThinkMode] = useState(() => localStorage.getItem('thinkMode') || 'auto');
  // One tool call per turn made `search -> open the page -> answer` impossible,
  // so answers stayed at snippet depth. A small budget allows a real chain.
  const [toolBudget, setToolBudget] = useState(() => readNum('toolBudget', 5));
  const [autoGround, setAutoGround] = useState(() => localStorage.getItem('autoGround') !== 'false');
  // Ollama's `format` field: 'json' forces valid JSON, and a JSON Schema
  // object constrains the shape field by field.
  const [outputFormat, setOutputFormat] = useState(() => localStorage.getItem('outputFormat') || 'text');
  const [outputSchema, setOutputSchema] = useState(() => localStorage.getItem('outputSchema') || '');
  const [schemaError, setSchemaError] = useState('');

  useEffect(() => {
    localStorage.setItem('outputFormat', outputFormat);
    localStorage.setItem('outputSchema', outputSchema);
  }, [outputFormat, outputSchema]);

  // Parsed once here so a broken schema is reported in settings rather than
  // failing every request with an opaque Ollama error.
  const resolvedFormat = (() => {
    if (outputFormat === 'json') return 'json';
    if (outputFormat !== 'schema') return null;
    if (!outputSchema.trim()) return null;
    try {
      return JSON.parse(outputSchema);
    } catch (e) {
      return null;
    }
  })();

  useEffect(() => {
    if (outputFormat !== 'schema' || !outputSchema.trim()) { setSchemaError(''); return; }
    try {
      JSON.parse(outputSchema);
      setSchemaError('');
    } catch (e) {
      setSchemaError(e.message);
    }
  }, [outputFormat, outputSchema]);

  // --- Knowledge (retrieval over attached documents) ---
  const [knowledge, setKnowledge] = useState([]);
  const [ragEnabled, setRagEnabled] = useState(() => localStorage.getItem('ragEnabled') !== 'false');
  const [embedModel, setEmbedModel] = useState(() => localStorage.getItem('embedModel') || DEFAULT_EMBED_MODEL);
  const [ragTopK, setRagTopK] = useState(() => readNum('ragTopK', 5));

  // --- Cross-chat memory ---
  const [memories, setMemories] = useState([]);
  const [memoryEnabled, setMemoryEnabled] = useState(() => localStorage.getItem('memoryEnabled') !== 'false');
  const [autoRemember, setAutoRemember] = useState(() => localStorage.getItem('autoRemember') === 'true');
  const [extractingMemory, setExtractingMemory] = useState(false);

  // --- Regeneration variants ---
  // Set just before a retry so the finished answer knows which earlier answers
  // it has to join rather than replace.
  const pendingVariantsRef = useRef(null);

  // --- Auto-continue ---
  const [autoContinue, setAutoContinue] = useState(() => localStorage.getItem('autoContinue') === 'true');
  const [truncatedIndex, setTruncatedIndex] = useState(null);
  const continueDepthRef = useRef(0);
  const continuationTargetRef = useRef(null);   // { index, before, mode }
  // Templates that close the assistant turn cannot be prefilled. Which ones
  // those are is only discoverable by trying, so the answer is remembered.
  const noPrefillModelsRef = useRef(new Set());

  // --- Chat folders ---
  const [folders, setFolders] = useState([]);
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [folderDialog, setFolderDialog] = useState(null);   // { id?, name, systemPrompt }
  const [rowMenuFor, setRowMenuFor] = useState(null);
  // The menu renders at the document root, so it needs the button it belongs to.
  const rowMenuAnchors = useRef({});

  // --- Sampling presets ---
  const [presets, setPresets] = useState([]);
  const [newPresetName, setNewPresetName] = useState('');

  useEffect(() => { localStorage.setItem('autoContinue', String(autoContinue)); }, [autoContinue]);
  useEffect(() => { setFolders(loadFolders(currentUser?.id)); }, [currentUser?.id]);
  useEffect(() => { setPresets(loadPresets(currentUser?.id)); }, [currentUser?.id]);

  // --- Context compaction ---
  const [autoCompact, setAutoCompact] = useState(() => localStorage.getItem('autoCompact') !== 'false');
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    localStorage.setItem('memoryEnabled', String(memoryEnabled));
    localStorage.setItem('autoRemember', String(autoRemember));
    localStorage.setItem('autoCompact', String(autoCompact));
  }, [memoryEnabled, autoRemember, autoCompact]);

  useEffect(() => {
    localStorage.setItem('ragEnabled', String(ragEnabled));
    localStorage.setItem('embedModel', embedModel);
    localStorage.setItem('ragTopK', String(ragTopK));
  }, [ragEnabled, embedModel, ragTopK]);
  const [stopSequences, setStopSequences] = useState(() => localStorage.getItem('stopSequences') || '');
  const [minP, setMinP] = useState(() => readNum('minP', 0));
  const [presencePenalty, setPresencePenalty] = useState(() => readNum('presencePenalty', 0));
  const [frequencyPenalty, setFrequencyPenalty] = useState(() => readNum('frequencyPenalty', 0));
  // How long Ollama keeps a model in VRAM after the last request.
  const [keepAlive, setKeepAlive] = useState(() => localStorage.getItem('keepAlive') || '5m');

  // --- Behaviour ---
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem('defaultModel') || '');
  const [autoTitle, setAutoTitle] = useState(() => localStorage.getItem('autoTitle') !== 'false');
  const [sendKey, setSendKey] = useState(() => localStorage.getItem('sendKey') || 'enter');
  const [showTimestamps, setShowTimestamps] = useState(() => localStorage.getItem('showTimestamps') === 'true');
  const [storageUsage, setStorageUsage] = useState(null);

  // --- Command palette / shortcuts ---
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const paletteInputRef = useRef(null);

  // --- Sidebar session editing ---
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  // --- Prompt library ---
  const [promptLibrary, setPromptLibrary] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('promptLibrary') || 'null');
      return Array.isArray(saved) ? saved : DEFAULT_PROMPT_LIBRARY;
    } catch (e) {
      return DEFAULT_PROMPT_LIBRARY;
    }
  });
  const [newMemoryText, setNewMemoryText] = useState('');
  const [newMemoryKind, setNewMemoryKind] = useState('fact');
  const [newPromptName, setNewPromptName] = useState('');
  const [newPromptBody, setNewPromptBody] = useState('');

  // --- Composer helpers ---
  const [slashIndex, setSlashIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // --- Model management ---
  const [runningModels, setRunningModels] = useState([]);
  const [pullProgress, setPullProgress] = useState(null); // { status, percent }
  const [settingsTab, setSettingsTab] = useState('general');

  // --- Regenerate with a different model ---
  const [regenMenuOpen, setRegenMenuOpen] = useState(false);
  const regenRef = useRef(null);

  // Apply the theme choice. 'system' removes the attribute so the
  // prefers-color-scheme media query takes over again.
  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Reading comfort is expressed as CSS variables so every surface follows.
  useEffect(() => {
    const root = document.documentElement;
    const sizes = { small: '0.9rem', medium: '1rem', large: '1.12rem' };
    root.style.setProperty('--chat-font-size', sizes[chatFontSize] || sizes.medium);
    const compact = chatDensity === 'compact';
    root.style.setProperty('--chat-gap', compact ? '1.15rem' : '2rem');
    root.style.setProperty('--bubble-padding', compact ? '0.5rem 0.8rem' : '0.75rem 1rem');
    localStorage.setItem('chatFontSize', chatFontSize);
    localStorage.setItem('chatDensity', chatDensity);
  }, [chatFontSize, chatDensity]);

  // 'system' leaves the attribute off so the prefers-reduced-motion media
  // query stays in charge; the other two are explicit overrides.
  useEffect(() => {
    const root = document.documentElement;
    if (motionMode === 'system') root.removeAttribute('data-motion');
    else root.setAttribute('data-motion', motionMode);
    localStorage.setItem('motionMode', motionMode);
  }, [motionMode]);

  useEffect(() => {
    localStorage.setItem('topP', String(topP));
    localStorage.setItem('topK', String(topK));
    localStorage.setItem('repeatPenalty', String(repeatPenalty));
    localStorage.setItem('numCtx', String(numCtx));
    localStorage.setItem('seed', seed);
    localStorage.setItem('stopSequences', stopSequences);
    localStorage.setItem('thinkMode', thinkMode);
    localStorage.setItem('minP', String(minP));
    localStorage.setItem('presencePenalty', String(presencePenalty));
    localStorage.setItem('frequencyPenalty', String(frequencyPenalty));
    localStorage.setItem('keepAlive', keepAlive);
    localStorage.setItem('toolBudget', String(toolBudget));
    localStorage.setItem('autoGround', String(autoGround));
  }, [topP, topK, repeatPenalty, numCtx, seed, stopSequences, thinkMode, minP, presencePenalty, frequencyPenalty, keepAlive, toolBudget, autoGround]);

  useEffect(() => {
    localStorage.setItem('defaultModel', defaultModel);
    localStorage.setItem('autoTitle', String(autoTitle));
    localStorage.setItem('sendKey', sendKey);
    localStorage.setItem('showTimestamps', String(showTimestamps));
    localStorage.setItem('showSystemStrip', String(showSystemStrip));
  }, [defaultModel, autoTitle, sendKey, showTimestamps, showSystemStrip]);

  useEffect(() => {
    localStorage.setItem('promptLibrary', JSON.stringify(promptLibrary));
  }, [promptLibrary]);

  useEffect(() => {
    let link = document.getElementById('highlight-theme');
    if (!link) {
      link = document.createElement('link');
      link.id = 'highlight-theme';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${codeTheme}.min.css`;
  }, [codeTheme]);

  useEffect(() => {
    localStorage.setItem('systemPrompt', systemPrompt);
    localStorage.setItem('temperature', temperature.toString());
    localStorage.setItem('maxTokens', maxTokens.toString());
    localStorage.setItem('codeTheme', codeTheme);
  }, [systemPrompt, temperature, maxTokens, codeTheme]);

  // --- Toasts (replaces the blocking alert() calls) ---
  const [toasts, setToasts] = useState([]);
  // `action` renders an inline button, e.g. "Undo" after deleting a chat.
  const toast = useCallback((message, type = 'info', ms = 4000, action = null) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, type, action }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ms);
  }, []);
  const dismissToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  // STT / TTS States
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const audioRef = useRef(null);

  // --- Voice settings ---
  const readStr = (key, fallback) => {
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  };
  const [ttsEngine, setTtsEngine] = useState(() => readStr('ttsEngine', 'gpt-sovits'));
  // No default: a reference clip is a specific person's voice on a specific
  // machine. It is chosen in Settings > Voice and kept in this browser only.
  const [ttsRefAudio, setTtsRefAudio] = useState(() => readStr('ttsRefAudio', ''));
  const [ttsPromptText, setTtsPromptText] = useState(() => readStr('ttsPromptText', ''));
  const [ttsTextLang, setTtsTextLang] = useState(() => readStr('ttsTextLang', 'ko'));
  const [ttsPromptLang, setTtsPromptLang] = useState(() => readStr('ttsPromptLang', 'ko'));
  const [ttsSpeed, setTtsSpeed] = useState(() => parseFloat(readStr('ttsSpeed', '1')) || 1);
  const [ttsMaxChars, setTtsMaxChars] = useState(() => parseInt(readStr('ttsMaxChars', '600')) || 600);
  const [ttsAutoPlay, setTtsAutoPlay] = useState(() => readStr('ttsAutoPlay', 'false') === 'true');
  const [isSynthesizing, setIsSynthesizing] = useState(false);

  useEffect(() => {
    localStorage.setItem('ttsEngine', ttsEngine);
    localStorage.setItem('ttsRefAudio', ttsRefAudio);
    localStorage.setItem('ttsPromptText', ttsPromptText);
    localStorage.setItem('ttsTextLang', ttsTextLang);
    localStorage.setItem('ttsPromptLang', ttsPromptLang);
    localStorage.setItem('ttsSpeed', String(ttsSpeed));
    localStorage.setItem('ttsMaxChars', String(ttsMaxChars));
    localStorage.setItem('ttsAutoPlay', String(ttsAutoPlay));
  }, [ttsEngine, ttsRefAudio, ttsPromptText, ttsTextLang, ttsPromptLang, ttsSpeed, ttsMaxChars, ttsAutoPlay]);

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        setInput(prev => prev + (prev ? ' ' : '') + transcript);
        setIsListening(false);
      };
      recognitionRef.current.onerror = (e) => {
        setIsListening(false);
        addLog(`Speech recognition error: ${e.error}`, 'error');
      };
      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) {
      addLog('Speech Recognition API not supported in this browser.', 'error');
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      if (audioRef.current.dataset?.objectUrl) URL.revokeObjectURL(audioRef.current.dataset.objectUrl);
      audioRef.current = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingIndex(null);
    setIsSynthesizing(false);
  }, []);

  // Stop audio when the tab goes away, so nothing keeps talking in the background.
  useEffect(() => () => stopSpeaking(), [stopSpeaking]);

  const speakWithBrowser = (text, index) => {
    if (!window.speechSynthesis) {
      toast('This browser has no speech synthesis support.', 'error');
      setSpeakingIndex(null);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = ttsTextLang === 'ko' ? 'ko-KR' : ttsTextLang === 'ja' ? 'ja-JP' : ttsTextLang === 'zh' ? 'zh-CN' : 'en-US';
    utterance.rate = ttsSpeed;
    utterance.onend = () => setSpeakingIndex(null);
    utterance.onerror = () => setSpeakingIndex(null);
    setSpeakingIndex(index);
    window.speechSynthesis.speak(utterance);
  };

  const speakMessage = async (text, index) => {
    // Clicking the speaker on the message that is already playing stops it.
    if (speakingIndex === index) {
      stopSpeaking();
      return;
    }
    stopSpeaking();

    let cleanText = stripForSpeech(text);
    if (!cleanText) {
      toast('Nothing to read out in this message.', 'info');
      return;
    }
    if (cleanText.length > ttsMaxChars) {
      cleanText = `${cleanText.slice(0, ttsMaxChars)}…`;
      addLog(`[TTS] Text truncated to ${ttsMaxChars} characters.`, 'info');
    }

    if (ttsEngine === 'browser') {
      speakWithBrowser(cleanText, index);
      return;
    }

    setSpeakingIndex(index);
    setIsSynthesizing(true);

    try {
      // A dead backend does NOT make fetch reject: the Vite proxy answers 5xx
      // instead. The old `try { fetch() } catch` therefore always said "up".
      let isServerUp = false;
      try {
        const ping = await fetch('/tts-api/control');
        isServerUp = ping.status < 500; // 400 = alive but unhappy about params
      } catch (e) {
        isServerUp = false;
      }

      if (!isServerUp) {
        fetch('/api/start-tts').catch(e => console.error('Failed to auto-start TTS:', e));
        toast('GPT-SoVITS was not running — starting it now. Try again in 10-20 seconds.', 'info', 8000);
        addLog('[TTS] GPT-SoVITS unreachable; requested auto-start.', 'error');
        stopSpeaking();
        return;
      }

      const params = new URLSearchParams({
        text: cleanText,
        text_lang: ttsTextLang,
        ref_audio_path: ttsRefAudio,
        prompt_lang: ttsPromptLang,
        speed_factor: String(ttsSpeed),
        text_split_method: 'cut5',
        media_type: 'wav',
        streaming_mode: 'false',
      });
      if (ttsPromptText.trim()) params.set('prompt_text', ttsPromptText.trim());

      const response = await fetch(`/tts-api/tts?${params.toString()}`);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
      }

      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.dataset.objectUrl = audioUrl;
      audioRef.current = audio;

      const cleanup = () => {
        URL.revokeObjectURL(audioUrl);
        if (audioRef.current === audio) audioRef.current = null;
        setSpeakingIndex(null);
      };
      audio.onended = cleanup;
      audio.onerror = () => { cleanup(); toast('Could not play the generated audio.', 'error'); };

      setIsSynthesizing(false);
      await audio.play();
    } catch (error) {
      console.error('GPT-SoVITS TTS Error:', error);
      addLog(`[TTS] ${error.message}`, 'error');
      toast(`TTS failed: ${error.message}`, 'error', 6000);
      stopSpeaking();
    }
  };

  // Sessions State
  const [sessions, setSessions] = useState([{ id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' }]);
  const [currentSessionId, setCurrentSessionId] = useState(sessions[0].id);
  const [isStorageLoaded, setIsStorageLoaded] = useState(false);

  // Chats live under a per-profile key, so switching profiles swaps the
  // whole history. The guest keeps the original key, which also means an
  // existing install keeps its chats.
  const storageKey = sessionStorageKeyFor(currentUser?.id);
  // The active chat is remembered per profile. Ids are numbers but localStorage
  // hands back strings, so every comparison goes through String().
  const lastChatKey = `${storageKey}:last`;

  // Sessions are stored in creation order while the sidebar lists them by
  // recency, so "the first one" and "the one on top" are different chats.
  // Anything that has to pick a chat on the user's behalf picks by recency.
  const mostRecent = (list) =>
    [...list].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];

  const pickRestoredId = (list) => {
    const wanted = (() => { try { return localStorage.getItem(lastChatKey); } catch (e) { return null; } })();
    const match = wanted && list.find(x => String(x.id) === String(wanted));
    return (match || mostRecent(list)).id;
  };

  useEffect(() => {
    let cancelled = false;
    loadLibrary(currentUser?.id).then(list => { if (!cancelled) setKnowledge(list); });
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  useEffect(() => {
    let cancelled = false;
    loadMemories(currentUser?.id).then(list => { if (!cancelled) setMemories(list); });
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setIsStorageLoaded(false);

    localforage.getItem(storageKey).then(saved => {
      if (cancelled) return;
      if (saved && saved.length > 0) {
        setSessions(saved);
        setCurrentSessionId(pickRestoredId(saved));
      } else {
        // Migrate the pre-localforage data on the guest key only.
        const legacy = storageKey === 'ollama-sessions' ? localStorage.getItem('ollama-sessions') : null;
        let restored = false;
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy);
            if (parsed && parsed.length > 0) {
              setSessions(parsed);
              setCurrentSessionId(pickRestoredId(parsed));
              restored = true;
            }
          } catch (e) {}
        }
        if (!restored) {
          const fresh = { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
          setSessions([fresh]);
          setCurrentSessionId(fresh.id);
        }
      }
      loadedKeyRef.current = storageKey;
      setIsStorageLoaded(true);
    }).catch(err => {
      console.error('Failed to load sessions from localforage', err);
      if (!cancelled) { loadedKeyRef.current = storageKey; setIsStorageLoaded(true); }
    });

    return () => { cancelled = true; };
  }, [storageKey, authReady]);
  
  const currentSession = sessions.find(s => s.id === currentSessionId) || sessions[0] || { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
  const messages = currentSession?.messages || [];

  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Edit State
  const [editingMessageIndex, setEditingMessageIndex] = useState(null);
  const [editInput, setEditInput] = useState('');

  // Attachments & MCP
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);

  // Logs & Refs
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [logs, setLogs] = useState([]);
  const logsEndRef = useRef(null);
  const messagesEndRef = useRef(null);
  const isAutoScrollRef = useRef(true);
  const textareaRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Derived state for code versions
  // Every artifact-worthy fence in the conversation, in order.
  // Blocks written inside <think> are excluded, and each carries a stable id
  // so the panel keeps pointing at the same artifact while text streams in.
  const codeArtifacts = useMemo(() => {
    const results = [];
    messages.forEach((msg, messageIndex) => {
      if (msg.role !== 'assistant') return;
      extractCodeBlocks(msg.content).forEach((block, blockIndex) => {
        const lineCount = block.content ? block.content.split('\n').length : 0;
        const previewable = isPreviewable(block.language);
        const runnable = isPythonish(block.language);
        if (!previewable && !runnable && lineCount <= 15) return;
        if (!block.content.trim()) return;
        results.push({
          id: `${messageIndex}:${blockIndex}`,
          version: results.length + 1,
          messageIndex,
          language: block.language,
          content: block.content,
          closed: block.closed,
          previewable,
          runnable,
          lineCount,
        });
      });
    });
    return results;
  }, [messages]);

  // Local edits made in the panel, keyed by artifact id, so "edit and re-run"
  // never mutates the conversation itself.
  // --- Resizable / adjustable layout ---
  const DEFAULT_ARTIFACT_WIDTH = 620;
  const DEFAULT_SIDEBAR_WIDTH = 300;
  const DEFAULT_CONSOLE_HEIGHT = 200;
  const [artifactWidth, setArtifactWidth] = usePersistedNumber('artifactWidth', DEFAULT_ARTIFACT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber('sidebarWidth', DEFAULT_SIDEBAR_WIDTH);
  const [consoleDockHeight, setConsoleDockHeight] = usePersistedNumber('consoleDockHeight', DEFAULT_CONSOLE_HEIGHT);
  const [artifactMaximized, setArtifactMaximized] = useState(false);
  const [consoleDocked, setConsoleDocked] = useState(false);
  const [viewportPreset, setViewportPreset] = useState(() => localStorage.getItem('viewportPreset') || 'fit');
  const [viewportLandscape, setViewportLandscape] = useState(false);
  const [previewZoom, setPreviewZoom] = useState('fit');

  useEffect(() => { localStorage.setItem('viewportPreset', viewportPreset); }, [viewportPreset]);

  // Keep the panels usable when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const maxArtifact = Math.max(320, window.innerWidth - 420);
      setArtifactWidth(w => clamp(w, 320, maxArtifact));
      setSidebarWidth(w => clamp(w, 200, Math.max(200, Math.min(480, window.innerWidth - 360))));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setArtifactWidth, setSidebarWidth]);

  const [artifactEdits, setArtifactEdits] = useState({});
  const [consoleEntries, setConsoleEntries] = useState([]);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  const openArtifactIdsRef = useRef(new Set());
  const artifactSessionRef = useRef(currentSessionId);

  // Auto-open only when a *completed* artifact appears, so the panel does not
  // thrash while a fence is still streaming in.
  useEffect(() => {
    // Switching chats must not pop the panel open for artifacts that were
    // already there; adopt them as "seen" and start clean.
    if (artifactSessionRef.current !== currentSessionId) {
      artifactSessionRef.current = currentSessionId;
      openArtifactIdsRef.current = new Set(codeArtifacts.filter(a => a.closed).map(a => a.id));
      setActiveArtifact(null);
      setConsoleEntries([]);
      setArtifactEdits({});
      return;
    }

    const closedIds = codeArtifacts.filter(a => a.closed).map(a => a.id);
    if (closedIds.length === 0) {
      openArtifactIdsRef.current = new Set();
      return;
    }
    const known = openArtifactIdsRef.current;
    const fresh = closedIds.filter(id => !known.has(id));
    if (fresh.length === 0) return;
    closedIds.forEach(id => known.add(id));

    const latest = codeArtifacts.find(a => a.id === fresh[fresh.length - 1]);
    if (!latest) return;
    setActiveArtifact({
      id: latest.id,
      type: latest.previewable ? 'preview' : latest.runnable ? 'run' : 'code',
    });
  }, [codeArtifacts, currentSessionId]);

  // Drop the panel if its artifact disappeared (chat switch, message deleted).
  useEffect(() => {
    if (!activeArtifact || activeArtifact.id === '__detached') return;
    if (!codeArtifacts.some(a => a.id === activeArtifact.id)) setActiveArtifact(null);
  }, [codeArtifacts, activeArtifact]);

  const codeArtifactsRef = useRef(codeArtifacts);
  codeArtifactsRef.current = codeArtifacts;

  const handleOpenArtifact = useCallback((content, type, language) => {
    const match = codeArtifactsRef.current.find(a => a.content === content);
    if (match) {
      setActiveArtifact({ id: match.id, type });
    } else {
      // A fence that is still streaming has no stable id yet.
      setActiveArtifact({ id: '__detached', type, detachedContent: content, detachedLanguage: language || '' });
    }
    setConsoleEntries([]);
  }, []);

  const activeArtifactData = useMemo(() => {
    if (!activeArtifact) return null;
    if (activeArtifact.id === '__detached') {
      const language = normalizeLanguage(activeArtifact.detachedLanguage);
      return {
        id: '__detached',
        version: 0,
        messageIndex: -1,
        language,
        content: activeArtifact.detachedContent || '',
        closed: false,
        previewable: isPreviewable(language),
        runnable: isPythonish(language),
      };
    }
    return codeArtifacts.find(a => a.id === activeArtifact.id) || null;
  }, [activeArtifact, codeArtifacts]);

  // The content the panel actually shows: a local edit wins over the model's.
  const activeArtifactSource = activeArtifactData
    ? (artifactEdits[activeArtifactData.id] ?? activeArtifactData.content)
    : '';
  const activeArtifactIsEdited = !!activeArtifactData && artifactEdits[activeArtifactData.id] !== undefined;

  // A page split across html/css/js fences belongs to one message. Stitching
  // across the whole conversation used to mix unrelated snippets together.
  const previewDocument = useMemo(() => {
    if (!activeArtifactData || !activeArtifactData.previewable) return '';

    const sourceFor = (artifact) => artifactEdits[artifact.id] ?? artifact.content;
    const siblings = activeArtifactData.messageIndex >= 0
      ? codeArtifacts.filter(a => a.messageIndex === activeArtifactData.messageIndex && a.previewable)
      : [activeArtifactData];

    const pick = (langs) => {
      const found = siblings.filter(a => langs.includes(a.language));
      return found.length ? sourceFor(found[found.length - 1]) : '';
    };

    const lang = activeArtifactData.language;
    if (lang === 'svg') {
      return buildPreviewDocument({ svg: activeArtifactSource, css: pick(['css']) });
    }

    const html = lang === 'html' ? activeArtifactSource : pick(['html']);
    const css = lang === 'css' ? activeArtifactSource : pick(['css']);

    let script = '';
    let scriptLanguage = 'javascript';
    if (['javascript', 'jsx', 'typescript', 'tsx'].includes(lang)) {
      script = activeArtifactSource;
      scriptLanguage = lang;
    } else {
      const scriptSibling = siblings.filter(a => ['javascript', 'jsx', 'typescript', 'tsx'].includes(a.language)).pop();
      if (scriptSibling) {
        script = sourceFor(scriptSibling);
        scriptLanguage = scriptSibling.language;
      }
    }

    return buildPreviewDocument({ html, css, script, scriptLanguage });
  }, [activeArtifactData, activeArtifactSource, codeArtifacts, artifactEdits]);

  // A rebuilt document means a fresh run, so stale output should not linger.
  useEffect(() => { setConsoleEntries([]); }, [previewDocument]);

  // Closing the panel should not leave "maximized" armed for the next artifact.
  useEffect(() => {
    if (!activeArtifact) setArtifactMaximized(false);
  }, [activeArtifact]);

  const appendConsole = useCallback((entry) => {
    // Cap the buffer so a runaway loop cannot grow it without bound.
    setConsoleEntries(prev => (prev.length > 400 ? [...prev.slice(-300), entry] : [...prev, entry]));
  }, []);

  const setArtifactSource = (value) => {
    if (!activeArtifactData) return;
    setArtifactEdits(prev => ({ ...prev, [activeArtifactData.id]: value }));
  };

  const resetArtifactSource = () => {
    if (!activeArtifactData) return;
    setArtifactEdits(prev => {
      const next = { ...prev };
      delete next[activeArtifactData.id];
      return next;
    });
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsModelDropdownOpen(false);
      }
      if (visionDropdownRef.current && !visionDropdownRef.current.contains(event.target)) {
        setIsVisionDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Restore last used model when switching session
  useEffect(() => {
    const session = sessions.find(s => s.id === currentSessionId);
    if (session && session.lastModel && models.find(m => m.name === session.lastModel)) {
      setSelectedModel(session.lastModel);
    }
  }, [currentSessionId, models]);

  // Save sessions to localforage.
  // Streaming updates state on every token, and each save serialises *every*
  // session (base64 images included), so an unthrottled write pegged IndexedDB
  // during generation. Coalesce into one write per ~700ms, and flush on unload.
  const saveTimerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  useEffect(() => {
    if (!isStorageLoaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      localforage.setItem(storageKeyRef.current, sessionsRef.current)
        .catch(e => console.warn('Failed to save sessions to localforage.', e));
    }, 700);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [sessions, isStorageLoaded]);

  useEffect(() => {
    if (!isStorageLoaded) return undefined;
    const flush = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      localforage.setItem(storageKeyRef.current, sessionsRef.current).catch(() => {});
    };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [isStorageLoaded]);

  // Written straight away rather than debounced: a refresh right after a click
  // should still land on the chat that was clicked.
  const loadedKeyRef = useRef(null);
  useEffect(() => {
    if (!isStorageLoaded || !currentSessionId) return;
    if (loadedKeyRef.current !== storageKey) return;
    try { localStorage.setItem(lastChatKey, String(currentSessionId)); } catch (e) {}
  }, [currentSessionId, lastChatKey, storageKey, isStorageLoaded]);

  // Handle case where all sessions might be deleted
  useEffect(() => {
    if (sessions.length === 0) {
      const newSession = { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      setSessions([newSession]);
      setCurrentSessionId(newSession.id);
    } else if (!sessions.find(s => s.id === currentSessionId)) {
      setCurrentSessionId(mostRecent(sessions).id);
    }
  }, [sessions, currentSessionId]);

  const updateCurrentSession = (updates) => {
    setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, ...updates } : s));
  };

  const createNewSession = () => {
    // A configured default wins; otherwise the chat inherits whatever is selected.
    const startingModel = defaultModel && models.some(m => m.name === defaultModel) ? defaultModel : '';
    if (startingModel) setSelectedModel(startingModel);
    const newSession = { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: startingModel };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setAttachments([]);
    addLog('Created new chat session', 'info');
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  // No confirm dialog: the toast offers an Undo instead, which is both
  // faster for the common case and safer for a misclick.
  const deleteSession = (id, e) => {
    e?.stopPropagation();
    const victim = sessions.find(s => s.id === id);
    if (!victim) return;
    const position = sessions.findIndex(s => s.id === id);

    const newSessions = sessions.filter(s => s.id !== id);
    if (newSessions.length === 0) {
      const freshSession = { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      setSessions([freshSession]);
      setCurrentSessionId(freshSession.id);
    } else {
      setSessions(newSessions);
      if (currentSessionId === id) setCurrentSessionId(mostRecent(newSessions).id);
    }

    lastDeletedRef.current = { session: victim, position };
    toast(`Deleted "${victim.title}".`, 'info', 8000, {
      label: 'Undo',
      onClick: () => {
        const saved = lastDeletedRef.current;
        if (!saved) return;
        setSessions(prev => {
          if (prev.some(s => s.id === saved.session.id)) return prev;
          const restored = [...prev];
          restored.splice(Math.min(saved.position, restored.length), 0, saved.session);
          return restored;
        });
        setCurrentSessionId(saved.session.id);
        lastDeletedRef.current = null;
      },
    });
  };

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { time, msg, type }]);
  };

  // ---- Session management extras ----

  const togglePin = (id, e) => {
    e?.stopPropagation();
    setSessions(prev => prev.map(s => s.id === id ? { ...s, pinned: !s.pinned } : s));
  };

  const startRename = (session, e) => {
    e?.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  // Renaming by hand locks the title: an automatic one must never replace it.
  const commitRename = () => {
    const title = renameValue.trim();
    if (renamingId !== null && title) {
      setSessions(prev => prev.map(s => s.id === renamingId ? { ...s, title, titleLocked: true } : s));
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const duplicateSession = (id, e) => {
    e?.stopPropagation();
    const source = sessions.find(s => s.id === id);
    if (!source) return;
    const copy = {
      ...source,
      id: Date.now(),
      title: `${source.title} (copy)`,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: source.messages.map(m => ({ ...m })),
    };
    setSessions(prev => [copy, ...prev]);
    setCurrentSessionId(copy.id);
    addLog(`Duplicated chat: ${source.title}`, 'success');
  };

  // Fork the conversation at a given message into its own session,
  // leaving the original untouched.
  const branchFromMessage = (index) => {
    const upTo = messages.slice(0, index + 1).map(m => ({ ...m }));
    const branch = {
      id: Date.now(),
      title: `${currentSession.title} (branch)`,
      messages: upTo,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastModel: currentSession.lastModel || selectedModel,
    };
    setSessions(prev => [branch, ...prev]);
    setCurrentSessionId(branch.id);
    addLog(`Branched a new chat from message #${index + 1}`, 'success');
  };

  const exportSessionMarkdown = (session) => {
    const target = session || currentSession;
    if (!target) return;
    downloadBlob(`${slugify(target.title)}.md`, sessionToMarkdown(target), 'text/markdown;charset=utf-8');
    addLog(`Exported "${target.title}" as Markdown.`, 'success');
  };

  const exportAllMarkdown = () => {
    const body = sessions
      .map(sessionToMarkdown)
      .join('\n\n---\n\n');
    const date = new Date().toISOString().split('T')[0];
    downloadBlob(`ollama-chats-${date}.md`, body, 'text/markdown;charset=utf-8');
    addLog(`Exported ${sessions.length} chats as Markdown.`, 'success');
  };

  // The browser used to reach the web through api.allorigins.win purely for
  // CORS. That proxy going down took every web feature with it, so both of
  // these now go through the dev server, which has no such restriction.
  const mcpFetchUrl = async (url, limit = 8000, signal = undefined) => {
    const res = await fetch('/mcp/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit }),
      signal,   // so Stop cancels an in-flight page fetch too
    });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  };

  const mcpSearchWeb = async (query, limit = 5) => {
    const res = await fetch('/mcp/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit, language: lang }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
    return { results: data.results || [], provider: data.provider, attempts: data.attempts || [] };
  };

  const mcpFetchNews = async (topic, limit = 8) => {
    const res = await fetch('/mcp/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, limit, language: lang }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
    return { items: data.items || [], text: data.text || '' };
  };

  // Every free search backend blocks eventually. When the chain comes up
  // empty the model must be told that the *search* failed — otherwise it
  // reads "no results" as "the topic does not exist" and answers anyway.
  const searchFailureNote = (attempts) => [
    'The web search could not be completed. This is a tooling failure, not an',
    'absence of information — do not treat it as evidence about the topic.',
    attempts.length ? `Providers tried: ${attempts.join('; ')}.` : '',
    'Answer from your own knowledge and state clearly that the search did not run.',
  ].filter(Boolean).join(' ');

  const formatSearchResults = (results) => results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');

  // Every generation request shares these sampling options.
  // Models answer from a training snapshot and rarely know today's date, which
  // is how "what is new in 2026" turns into a confident answer from 2024. State
  // the date, and say plainly that the weights may be stale.
  const environmentPreamble = () => {
    const now = new Date();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    return [
      '[Environment]',
      `Current date and time: ${now.toISOString()} (${zone}).`,
      `Today is ${now.toLocaleDateString('en-CA')}.`,
      'Your training data ends before this date, so anything you "remember" about',
      'recent events, releases, versions, prices or people may be out of date.',
      'When a question depends on current facts, prefer information supplied in this',
      'conversation over your own recollection, and say when you are unsure.',
    ].join('\n');
  };

  const buildOptions = () => {
    const options = {
      temperature,
      num_predict: maxTokens,
      top_p: topP,
      top_k: topK,
      repeat_penalty: repeatPenalty,
      num_ctx: numCtx,
    };
    // Ollama ignores a zero for these, so only send what was actually set.
    if (minP > 0) options.min_p = minP;
    if (presencePenalty !== 0) options.presence_penalty = presencePenalty;
    if (frequencyPenalty !== 0) options.frequency_penalty = frequencyPenalty;
    if (seed !== '' && !Number.isNaN(Number(seed))) options.seed = Number(seed);
    const stops = stopSequences.split('\n').map(s => s.trim()).filter(Boolean);
    if (stops.length > 0) options.stop = stops;
    return options;
  };

  // ---- Accounts ----

  const handleAuthenticated = (user, { created } = {}) => {
    setCurrentUser(user);
    saveSession(user);
    localStorage.setItem('authIntroSeen', 'true');
    setShowAuthScreen(false);
    setShowProfileMenu(false);
    setActiveArtifact(null);
    toast(created ? t('auth.created') : t('auth.welcomeUser', { name: user.name }), 'success');
    addLog(`Signed in as ${user.name} (${user.provider}).`, 'success');

    // A social sign-in already proved who this is, so it should also be the
    // server account. Otherwise "the same account" on two devices shares
    // nothing, because each browser has its own storage for that origin.
    adoptServerSession(user);
  };

  /**
   * Make the sign-in that just happened the server session too, then bring the
   * account's settings down.
   *
   * Google hands over a credential the server verifies itself. Kakao is already
   * exchanged server-side, so that flow sets the cookie on its way through and
   * there is nothing left to send — asking /api/account/me finds it.
   */
  const adoptServerSession = async (user) => {
    try {
      if (user?.credential) await linkGoogleSession(user.credential);

      const me = await serverMe();
      if (!me?.success || !me.user) return;

      setSyncUser(me.user);
      setSyncInfo(me.state || null);
      addLog(`[sync] signed in to this server as ${me.user.name}.`, 'info');

      // Merge, so a device that already has chats keeps them. An account with
      // nothing on it is seeded from whatever this device has.
      const pulled = await pullState({ mode: 'merge' });
      if (!pulled.summary) { await pushState(); return; }
      if ((pulled.restored?.chats ?? 0) > 0) {
        toast(t('sync.pulled', { chats: pulled.restored.chats }), 'success', 8000, {
          label: t('backup.reload'),
          onClick: () => window.location.reload(),
        });
      }
    } catch (e) {
      // Sync is a bonus; a failure here must not break signing in.
      addLog(`[sync] could not join the server account: ${e.message}`, 'info');
    }
  };

  const handleGuest = () => {
    localStorage.setItem('authIntroSeen', 'true');
    setShowAuthScreen(false);
  };

  const handleSignOut = () => {
    signOutSocial();
    saveSession(null);
    setCurrentUser(null);
    setShowProfileMenu(false);
    setActiveArtifact(null);
    setShowAuthScreen(true);
    addLog('Signed out.', 'info');
  };

  const handleDeleteProfile = async () => {
    if (!currentUser) return;
    if (!window.confirm(`${t('auth.deleteAccount')}\n\n${t('auth.deleteWarning')}`)) return;
    const victim = currentUser;
    await deleteUser(victim.id);
    await localforage.removeItem(sessionStorageKeyFor(victim.id));
    signOutSocial();
    saveSession(null);
    setCurrentUser(null);
    setShowProfileMenu(false);
    setShowAuthScreen(true);
    addLog(`Deleted profile ${victim.name}.`, 'info');
  };

  // Settings always lands on General unless a caller asks for a specific tab,
  // so reopening never drops you back into whatever you last poked at.
  // ---- Memory ----

  const rememberFromChat = async () => {
    if (extractingMemory || messages.length < 2) return;
    setExtractingMemory(true);
    try {
      const transcript = messages
        .filter(m => !String(m.content).trim().startsWith('<TOOL_RESULT>'))
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${cleanForExport(m.content).slice(0, 1500)}`)
        .filter(line => line.length > 12)
        .join('\n\n')
        .slice(0, 12000);

      const candidates = await extractMemories(transcript, selectedModel);
      const { memories: next, added } = await addMemories(currentUser?.id, candidates);
      setMemories(next);

      if (added.length === 0) toast(t('memory.nothingNew'), 'info');
      else toast(t('memory.saved', { count: added.length }), 'success');
      addLog(`[memory] extracted ${candidates.length}, kept ${added.length}`, 'info');
    } catch (e) {
      addLog(`[memory] extraction failed: ${e.message}`, 'error');
      toast(t('memory.failed', { error: e.message }), 'error', 6000);
    } finally {
      setExtractingMemory(false);
    }
  };

  const toggleMemory = async (id) => {
    const next = memories.map(m => (m.id === id ? { ...m, enabled: m.enabled === false } : m));
    await saveMemories(currentUser?.id, next);
    setMemories(next);
  };

  const deleteMemory = async (id) => setMemories(await removeMemory(currentUser?.id, id));

  const addManualMemory = async (text, kind) => {
    const { memories: next, added } = await addMemories(currentUser?.id, [{ text, kind }]);
    setMemories(next);
    if (added.length === 0) toast(t('memory.duplicate'), 'info');
  };

  // ---- Context compaction ----
  // A local model's context window is small, and the oldest turns are what
  // silently fall out of it. Folding them into a summary keeps the thread
  // coherent instead of letting the model quietly forget how it started.

  const COMPACT_KEEP_RECENT = 6;

  const compactConversation = async () => {
    if (compacting || messages.length <= COMPACT_KEEP_RECENT + 2) return;
    setCompacting(true);

    const older = messages.slice(0, messages.length - COMPACT_KEEP_RECENT);
    const recent = messages.slice(messages.length - COMPACT_KEEP_RECENT);
    const sid = currentSessionId;
    const previous = messages;

    try {
      const transcript = older
        .filter(m => !String(m.content).trim().startsWith('<TOOL_RESULT>'))
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${cleanForExport(m.content).slice(0, 2000)}`)
        .join('\n\n')
        .slice(0, 20000);

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          stream: false,
          think: false,
          messages: [{
            role: 'user',
            content: [
              'Summarise the earlier part of this conversation so it can replace the',
              'original turns without losing anything the rest of the discussion depends on.',
              '',
              'Keep: decisions reached, facts established, constraints, names, file paths,',
              'numbers, and anything the user asked for. Drop pleasantries and repetition.',
              'Write it as compact notes, not prose. Same language as the conversation.',
              '',
              '---',
              transcript,
            ].join('\n'),
          }],
          options: { temperature: 0.2, num_predict: 900 },
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const summary = decodeByteFallback(data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!summary) throw new Error('the model returned an empty summary');

      const marker = {
        role: 'user',
        content: `[Earlier conversation, condensed]\n${summary}`,
        at: Date.now(),
        compacted: older.length,
      };

      updateCurrentSession({ messages: [marker, ...recent] });
      addLog(`[compact] folded ${older.length} messages into a summary`, 'success');
      toast(t('compact.done', { count: older.length }), 'success', 8000, {
        label: t('common.undo'),
        onClick: () => setSessions(prev => prev.map(x => (x.id === sid ? { ...x, messages: previous } : x))),
      });
    } catch (e) {
      addLog(`[compact] failed: ${e.message}`, 'error');
      toast(t('compact.failed', { error: e.message }), 'error', 6000);
    } finally {
      setCompacting(false);
    }
  };

  // ---- Export ----

  const exportSessionHtml = (session) => {
    const target = session || currentSession;
    if (!target) return;
    downloadBlob(`${slugify(target.title)}.html`, sessionToHtml(target), 'text/html;charset=utf-8');
    addLog(`Exported "${target.title}" as HTML.`, 'success');
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await fetchServerConfig();
      if (cancelled || !config) return;
      // Do this before anything renders a sign-in button, or it reads the
      // config as absent and hides itself.
      setServerSocialConfig(config);
      setServerConfig(config);

      const me = await serverMe();
      if (cancelled || !me?.success) return;
      setSyncUser(me.user || null);
      setSyncInfo(me.state || null);
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- Whole-state backup ----
  // Browser storage is per origin, so opening this app on a phone, or on a
  // different port, starts from nothing. This is how state moves.

  // --- The server's own account, and the state that follows it ---
  // Browser storage is per origin, so a device-local account cannot carry
  // settings to a phone. This one can: the server knows who signed in.
  const [syncUser, setSyncUser] = useState(null);
  const [syncInfo, setSyncInfo] = useState(null);
  const [syncBusy, setSyncBusy] = useState('');
  const [syncForm, setSyncForm] = useState({ mode: 'login', name: '', email: '', password: '' });
  const [serverConfig, setServerConfig] = useState(null);
  const syncRef = useRef(null);

  const [restoring, setRestoring] = useState(false);
  const backupInputRef = useRef(null);
  const backupRestoreMode = useRef('merge');

  const exportBackup = async () => {
    try {
      const backup = await collectBackup({ includeAccounts: true });
      const summary = describeBackup(backup);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(`ollama-webui-backup-${stamp}.json`,
        JSON.stringify(backup), 'application/json');
      addLog(`Backed up ${summary.chats} chats and ${summary.settings} settings.`, 'success');
      toast(t('backup.exported', { chats: summary.chats }), 'success');
    } catch (e) {
      addLog(`[backup] export failed: ${e.message}`, 'error');
      toast(t('backup.failed', { error: e.message }), 'error', 6000);
    }
  };

  const importBackup = async (file, mode) => {
    if (!file || restoring) return;
    setRestoring(true);
    try {
      const data = JSON.parse(await file.text());
      if (!isBackup(data)) throw new Error(t('backup.notABackup'));

      const summary = describeBackup(data);
      const question = mode === 'replace' ? t('backup.confirmReplace', summary) : t('backup.confirmMerge', summary);
      if (!window.confirm(question)) return;

      const restored = await restoreBackup(data, { mode });
      addLog(`[backup] restored ${restored.chats} chats, ${restored.settings} settings.`, 'success');
      toast(t('backup.restored', restored), 'success', 8000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
    } catch (e) {
      addLog(`[backup] import failed: ${e.message}`, 'error');
      toast(t('backup.failed', { error: e.message }), 'error', 7000);
    } finally {
      setRestoring(false);
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  // Changes go up on their own, coalesced: settings change on every keystroke
  // and the payload is the whole history, so one upload per character would be
  // absurd. Signed out, nothing is scheduled and nothing leaves the browser.
  useEffect(() => {
    if (!syncUser) { syncRef.current?.cancel(); syncRef.current = null; return undefined; }

    syncRef.current = createSyncScheduler({
      delay: 5000,
      onResult: (result) => setSyncInfo({ exists: true, bytes: result.bytes, savedAt: result.savedAt }),
      onError: (e) => addLog(`[sync] upload failed: ${e.message}`, 'error'),
    });

    const flush = () => { syncRef.current?.flush?.(); };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      syncRef.current?.cancel();
      syncRef.current = null;
    };
  }, [syncUser]);

  // Anything that lands in browser storage is worth sending up. Watching the
  // session list plus the settings that are saved separately covers it.
  useEffect(() => {
    if (!syncUser || !isStorageLoaded) return;
    syncRef.current?.schedule();
  }, [syncUser, isStorageLoaded, sessions, folders, presets, memories, systemPrompt,
      temperature, maxTokens, topP, topK, repeatPenalty, numCtx, lang, theme]);

  // ---- Syncing with the server account ----

  const refreshSyncInfo = async () => {
    const me = await serverMe();
    if (me?.success) { setSyncUser(me.user || null); setSyncInfo(me.state || null); }
  };

  const syncSignIn = async () => {
    const { mode, name, email, password } = syncForm;
    setSyncBusy('auth');
    try {
      const result = mode === 'register'
        ? await serverRegister(name, email, password)
        : await serverLogin(email, password);
      if (!result.success) throw new Error(result.error || 'Sign-in failed.');

      setSyncUser(result.user);
      setSyncForm({ mode: 'login', name: '', email: '', password: '' });

      // A fresh sign-in should bring the account's setup down, and a first
      // sign-in should send this device's up so the account is not empty.
      const pulled = await pullState({ mode: 'merge' });
      if (!pulled.summary) await pushState();
      await refreshSyncInfo();

      toast(pulled.summary
        ? t('sync.pulled', { chats: pulled.restored?.chats ?? 0 })
        : t('sync.seeded'), 'success', 8000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 7000);
    } finally {
      setSyncBusy('');
    }
  };

  const syncSignOut = async () => {
    setSyncBusy('auth');
    try {
      // Push first: signing out should not lose what has not gone up yet.
      if (syncRef.current) await syncRef.current.flush();
      await serverLogout();
      setSyncUser(null);
      setSyncInfo(null);
      toast(t('sync.signedOut'), 'info');
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  const syncNow = async () => {
    setSyncBusy('push');
    try {
      const result = await pushState();
      setSyncInfo({ exists: true, bytes: result.bytes, savedAt: result.savedAt });
      toast(t('sync.pushed', { chats: result.summary.chats }), 'success');
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  const syncPull = async (mode) => {
    setSyncBusy('pull');
    try {
      const pulled = await pullState({ mode });
      if (!pulled.summary) { toast(t('sync.nothingStored'), 'info'); return; }
      toast(t('sync.pulled', { chats: pulled.restored?.chats ?? 0 }), 'success', 8000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  const openSettings = (tab = 'general') => {
    setSettingsTab(tab);
    setShowSettings(true);
  };

  const readStorageUsage = async () => {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate) setStorageUsage({ used: estimate.usage || 0, quota: estimate.quota || 0 });
    } catch (e) {
      setStorageUsage(null);
    }
  };

  const openPalette = () => {
    setPaletteQuery('');
    setPaletteIndex(0);
    setShowPalette(true);
  };

  const scrollToBottom = () => {
    isAutoScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // ---- Model management ----

  const fetchRunningModels = async () => {
    try {
      const res = await fetch('/api/ps');
      if (!res.ok) return;
      const data = await res.json();
      setRunningModels(data.models || []);
    } catch (e) {
      setRunningModels([]);
    }
  };

  const deleteModel = async (name) => {
    if (!window.confirm(`Delete the model "${name}" from disk? This cannot be undone.`)) return;
    addLog(`Deleting model: ${name}`, 'info');
    try {
      const res = await fetch('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        // Ollama renamed this field to `model`; sending both keeps
        // older and newer daemons happy.
        body: JSON.stringify({ name, model: name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog(`Deleted model: ${name}`, 'success');
      if (selectedModel === name) setSelectedModel('');
      fetchModels();
      fetchRunningModels();
    } catch (e) {
      addLog(`Failed to delete ${name}: ${e.message}`, 'error');
    }
  };

  // keep_alive: 0 tells Ollama to evict the model from VRAM immediately.
  const unloadModel = async (name) => {
    addLog(`Unloading ${name} from memory...`, 'info');
    try {
      await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
      });
      addLog(`Unloaded ${name}.`, 'success');
      setTimeout(fetchRunningModels, 500);
    } catch (e) {
      addLog(`Failed to unload ${name}: ${e.message}`, 'error');
    }
  };

  // ---- Prompt library ----

  // ---- Prompt variables ----
  // The library stored plain text, so a reusable prompt still had to be edited
  // by hand every time. {{placeholders}} turn one into a small form.
  const [promptFill, setPromptFill] = useState(null);   // { body, names, values }

  const promptVariables = (body) => {
    const found = [...String(body || '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)]
      .map(m => m[1]);
    return [...new Set(found)];
  };

  const applyPromptVariables = (body, values) =>
    String(body || '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, name) => (
      values[name] !== undefined && values[name] !== '' ? values[name] : whole
    ));

  const savePrompt = () => {
    const name = newPromptName.trim();
    const body = newPromptBody.trim();
    if (!name || !body) return;
    setPromptLibrary(prev => [...prev, { id: `p-${Date.now()}`, name, body }]);
    setNewPromptName('');
    setNewPromptBody('');
    addLog(`Saved prompt: ${name}`, 'success');
  };

  const deletePrompt = (id) => setPromptLibrary(prev => prev.filter(p => p.id !== id));

  const insertPromptText = (body) => {
    setInput(prev => (prev ? `${prev}\n${body}` : body));
    setShowSettings(false);
    setShowPalette(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const insertPrompt = (body) => {
    const names = promptVariables(body);
    if (names.length === 0) { insertPromptText(body); return; }
    setShowSettings(false);
    setShowPalette(false);
    setPromptFill({ body, names, values: Object.fromEntries(names.map(n => [n, ''])) });
  };

  // Ollama reports what a model can actually do via /api/show. Without this
  // the app relayed every image through a second "vision model" that wrote an
  // English description — lossy and slow when the chosen model sees images
  // perfectly well by itself.
  const [modelCaps, setModelCaps] = useState({});
  const capsInFlight = useRef(new Set());

  const loadCapabilities = useCallback(async (name) => {
    if (!name || capsInFlight.current.has(name)) return;
    capsInFlight.current.add(name);
    try {
      const res = await fetch('/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setModelCaps(prev => ({ ...prev, [name]: data.capabilities || [] }));
    } catch (e) {
      // A model that cannot be inspected simply keeps the conservative default.
    } finally {
      capsInFlight.current.delete(name);
    }
  }, []);

  const hasCapability = (name, capability) => (modelCaps[name] || []).includes(capability);
  const modelSupportsVision = (name) => hasCapability(name, 'vision');

  const fetchModels = async () => {
    addLog('Fetching available models...', 'info');
    try {
      const res = await fetch('/api/tags');
      if (!res.ok) throw new Error('Ollama server is unreachable.');
      const data = await res.json();
      setModels(data.models || []);
      if (data.models && data.models.length > 0) {
        if (!selectedModel) setSelectedModel(data.models[0].name);
        // Try to auto-select a vision model if available
        if (!selectedVisionModel) {
          const visionModel = data.models.find(m => m.name.toLowerCase().includes('llava') || m.name.toLowerCase().includes('minicpm'));
          if (visionModel) setSelectedVisionModel(visionModel.name);
          else setSelectedVisionModel(data.models[0].name);
        }
        addLog(`Found ${data.models.length} models.`, 'success');
        // Capabilities decide whether images can go straight to the model.
        data.models.forEach(m => loadCapabilities(m.name));
      } else {
        addLog('No models found locally.', 'error');
      }
    } catch (err) {
      addLog(`Fetch models failed: ${err.message}`, 'error');
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  useEffect(() => {
    if (isAutoScrollRef.current) {
      // Smooth scrolling on every streamed token fights itself and stutters;
      // jump instantly while generating, animate only for finished turns.
      messagesEndRef.current?.scrollIntoView({ behavior: isGenerating ? 'auto' : 'smooth' });
    }
  }, [messages, isGenerating]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isAutoScrollRef.current = distanceFromBottom < 100;
    setShowScrollBtn(distanceFromBottom > 240);
  }, []);

  const handleInputResize = (e) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const applySlashCommand = (cmd) => {
    setInput(cmd.template);
    setSlashIndex(0);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        // Put the caret where the user is meant to keep typing.
        const caret = cmd.template.indexOf('```\n\n```') >= 0
          ? cmd.template.indexOf('```\n\n```') + 4
          : cmd.template.length;
        el.setSelectionRange(caret, caret);
      }
    }, 0);
  };

  const handleKeyDown = (e) => {
    // The slash menu takes over the arrow/enter keys while it is open.
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySlashCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }

    const wantsSend = sendKey === 'ctrlEnter'
      ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
      : (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey);

    if (wantsSend) {
      e.preventDefault();
      if (input.trim() || attachments.length > 0) handleSend();
    }
  };

  // Shared by the file picker, clipboard paste and drag & drop.
  const addFiles = (files) => {
    files.forEach(file => {
      if (!file) return;
      const reader = new FileReader();
      if (file.type.startsWith('image/')) {
        reader.onload = (ev) => {
          setAttachments(prev => [...prev, {
            name: file.name || `pasted-image-${Date.now()}.png`,
            type: 'image',
            data: ev.target.result.split(',')[1],
            preview: ev.target.result,
          }]);
        };
        reader.readAsDataURL(file);
      } else {
        reader.onload = (ev) => {
          setAttachments(prev => [...prev, { name: file.name, type: 'text', data: ev.target.result }]);
        };
        reader.readAsText(file);
      }
    });
  };

  const handleFileChange = (e) => {
    addFiles(Array.from(e.target.files));
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      addLog(`Attached ${files.length} file(s) from clipboard.`, 'success');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      addFiles(files);
      addLog(`Attached ${files.length} dropped file(s).`, 'success');
    }
  };

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const generateSessionTitle = async (sessionId, userText, assistantText, model) => {
    try {
      // The title is part of the interface, so it follows the UI language
      // rather than whatever language the conversation happened to be in.
      const titleLanguage = promptLanguageName(lang);
      const titlePrompt = [
        'Read the following conversation and give it a very short, concise title',
        '(at most 4-5 words) summarising the main topic.',
        '',
        `Write the title in ${titleLanguage}.`,
        'Reply with ONLY the title itself: no quotes, no trailing punctuation,',
        'no explanation, and nothing in any other language.',
        '',
        // Grounding blocks and reasoning traces are far longer than the turn
        // itself and push the actual topic out of a small context window.
        `User: ${cleanForExport(userText).slice(0, 1200)}`,
        '',
        `Assistant: ${cleanForExport(assistantText).slice(0, 1200)}`,
      ].join('\n');
      
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: titlePrompt }],
          stream: false,
          // Without think:false a reasoning model spends the whole
          // num_predict budget thinking and returns an empty title.
          think: false,
          options: { temperature: 0.3, num_predict: 40 }
        })
      });
      if (res.ok) {
        const data = await res.json();
        let newTitle = decodeByteFallback(data.message?.content || '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim()
          .replace(/^["']|["']$/g, '');
        // An empty reply means the model gave us nothing usable; keep the
        // first-message fallback title rather than resetting to "New Chat".
        if (!newTitle) return;

        setSessions(prev => prev.map(s => {
          if (s.id === sessionId) return { ...s, title: newTitle, titleGenerated: true };
          return s;
        }));
        addLog(`Named this chat "${newTitle}".`, 'info');
      }
    } catch (e) {
      console.warn("Failed to generate title", e);
    }
  };

  const handleSend = async (e = null, customMessages = null, overrideModel = null) => {
    const activeModel = overrideModel || selectedModel;
    e?.preventDefault();
    if (isGenerating || (!input.trim() && attachments.length === 0 && !customMessages)) return;

    const originalInput = input;
    const currentAttachments = [...attachments];
    const isAutoTool = !!customMessages;
    
    // 1. Immediately update UI
    if (!isAutoTool) {
      setInput('');
      setAttachments([]);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
    
    setIsGenerating(true);
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    // Declared out here so the catch block below can still see them.
    let initialMessages;
    let newMessageIndex;

    try {
      let finalInputText = originalInput;
      
      // --- Commands Interception ---
      if (!isAutoTool && finalInputText.trim().startsWith('/imagine ')) {
        const prompt = finalInputText.replace('/imagine ', '').trim();
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        const assistantResponse = `Here is the generated image for "**${prompt}**":\n\n![Generated Image](${imageUrl})`;
        
        const newMessages = [
           ...messages, 
           { role: 'user', content: finalInputText },
           { role: 'assistant', content: assistantResponse, metrics: null }
        ];
        
        updateCurrentSession({ messages: newMessages, updatedAt: Date.now(), lastModel: activeModel });
        return;
      }
      
      if (!isAutoTool && finalInputText.trim().startsWith('/web ')) {
        const query = finalInputText.replace('/web ', '').trim();
        addLog(`[Web Command] Searching for: ${query}`, 'info');
        try {
          const { results, provider, attempts } = await mcpSearchWeb(query);
          if (results.length === 0) {
            addLog(`[Web Command] Search failed: ${attempts.join(' | ')}`, 'error');
            toast(t('search.failed'), 'error', 7000);
            finalInputText = `I tried to search the web for "${query}". ${searchFailureNote(attempts)}`;
          } else {
            addLog(`[Web Command] ${results.length} results via ${provider}.`, 'success');
            finalInputText = `I searched the web for "${query}" (via ${provider}). Here are the top results:\n\n${formatSearchResults(results)}\n\nPlease summarize them or answer based on this information.`;
          }
        } catch(e) {
          addLog(`Web search failed: ${e.message}`, 'error');
          toast(`Web search failed: ${e.message}`, 'error', 6000);
        }
      }
      // ----------------------------
      
      let messageImages = [];

      // Process Attachments (synchronous)
      if (currentAttachments.length > 0) {
        currentAttachments.forEach(att => {
          if (att.type === 'text') {
            finalInputText += `\n\n--- Attached File: ${att.name} ---\n${att.data}\n-------------------`;
          } else if (att.type === 'image') {
            messageImages.push(att.data);
          }
        });
      }


      if (!isAutoTool) {
        const tempUserMessage = { role: 'user', content: finalInputText, at: Date.now() };
        if (messageImages.length > 0) tempUserMessage.images = messageImages;
        
        initialMessages = [...messages, tempUserMessage];
        
        let newTitle = currentSession.title;
        if (messages.length === 0 && finalInputText.trim()) {
           newTitle = finalInputText.trim().substring(0, 30);
        }
        updateCurrentSession({ messages: initialMessages, title: newTitle, updatedAt: Date.now(), lastModel: activeModel });
        
        newMessageIndex = initialMessages.length;
        const isUrlFetching = mcpEnabled && finalInputText.match(/(https?:\/\/[^\s]+)/g);
        updateCurrentSession({
           messages: [...initialMessages, { role: 'assistant', content: '', metrics: null, at: Date.now(), isMcpFetching: !!isUrlFetching }]
        });
      } else {
        initialMessages = customMessages;
        newMessageIndex = initialMessages.length;
        updateCurrentSession({
           messages: [...initialMessages, { role: 'assistant', content: '', metrics: null, at: Date.now() }],
           updatedAt: Date.now(),
           lastModel: activeModel
        });
      }

      let initialAssistantContent = '';

      // Fetch MCP / Web URLs
      if (mcpEnabled && finalInputText.trim() && !isAutoTool) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = finalInputText.match(urlRegex);
        
        if (urls) {
          for (const url of urls) {
            try {
              addLog(`[MCP Tool] Fetching URL: ${url}`, 'info');
              const data = await mcpFetchUrl(url, 5000, signal);
              const textContent = data.text.trim();
              finalInputText += `\n\n--- [MCP Tool] Fetched Content from ${url} ---\n${textContent}\n-------------------`;
              initialAssistantContent += `<think>\n--- [MCP Tool] Fetched Content from ${url} ---\n${textContent}\n</think>\n\n`;
              addLog(`[MCP Tool] Success: extracted ${textContent.length} chars`, 'success');
            } catch (err) {
              if (err.name !== 'AbortError') {
                addLog(`[MCP Tool] Failed to fetch ${url}: ${err.message}`, 'error');
                toast(`Could not fetch ${url}: ${err.message}`, 'error', 6000);
              }
            }
          }
          
          setSessions(prev => prev.map(s => {
            if (s.id !== currentSessionId) return s;
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: initialAssistantContent };
            return { ...s, messages: msgs };
          }));
        }
      }

      // --- Retrieval over attached documents ---
      // Runs before the web grounding: a document the user supplied is more
      // authoritative for their question than anything a search turns up.
      if (ragEnabled && !isAutoTool && originalInput.trim() && knowledge.some(d => d.enabled !== false)) {
        try {
          const hits = await retrieve(originalInput, knowledge, {
            model: embedModel,
            topK: ragTopK,
            signal,
          });
          if (hits.length > 0) {
            const block = `--- [Knowledge] Passages from your documents, most relevant first ---\n${formatContext(hits)}\n--- Cite these as [1], [2] ... when you use them. If they do not answer the question, say so instead of guessing. ---`;
            finalInputText += `\n\n${block}`;
            initialAssistantContent += `<think>\n${block}\n</think>\n\n`;
            addLog(`[knowledge] ${hits.length} passages from ${new Set(hits.map(h => h.docName)).size} document(s)`, 'success');
          } else {
            addLog('[knowledge] nothing relevant enough to include', 'info');
          }
        } catch (e) {
          if (e.name !== 'AbortError') {
            addLog(`[knowledge] retrieval failed: ${e.message}`, 'error');
            toast(t('rag.retrievalFailed', { error: e.message }), 'error', 7000);
          }
        }
      }

      // --- Grounding ---
      // Search before the model speaks when the question is time-sensitive, so
      // it has sources instead of a stale recollection to work from.
      if (autoGround && mcpEnabled && !isAutoTool && needsCurrentInfo(originalInput)) {
        addLog('[grounding] question looks time-sensitive; searching first', 'info');
        try {
          const { results, provider } = await mcpSearchWeb(originalInput.slice(0, 200), 5);
          if (results.length > 0) {
            const block = `--- [Grounding] Web results for "${originalInput.slice(0, 120)}" (via ${provider}, fetched ${new Date().toLocaleDateString('en-CA')}) ---\n${formatSearchResults(results)}\n-------------------`;
            finalInputText += `\n\n${block}`;
            initialAssistantContent += `<think>\n${block}\n</think>\n\n`;
            addLog(`[grounding] ${results.length} results via ${provider}`, 'success');
          } else {
            addLog('[grounding] no results; answering unaided', 'error');
          }
        } catch (e) {
          addLog(`[grounding] failed: ${e.message}`, 'error');
        }
      }

      // --- VISION PIPELINE ---
      // Send images straight to the model whenever it can read them. The
      // describe-then-relay path is now only a fallback for text-only models.
      const activeModelSeesImages = modelSupportsVision(activeModel);
      const needsVisionAnalysis = messageImages.length > 0
        && !activeModelSeesImages
        && selectedVisionModel
        && selectedVisionModel !== activeModel;

      if (messageImages.length > 0 && activeModelSeesImages) {
        addLog(`${activeModel} reads images natively; sending them directly.`, 'info');
      } else if (messageImages.length > 0 && !needsVisionAnalysis) {
        addLog(`${activeModel} cannot read images and no vision model is set.`, 'error');
      }
      if (needsVisionAnalysis && !isAutoTool) {
        addLog(`Analyzing ${messageImages.length} images with ${selectedVisionModel}...`, 'info');

        // Append: assigning here used to throw away anything the MCP
        // URL fetch had already put into the thought block.
        initialAssistantContent += `<think>\n--- Image Analysis by ${selectedVisionModel} ---\n`;

        setSessions(prev => prev.map(s => {
          if (s.id !== currentSessionId) return s;
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: `${initialAssistantContent}\n</think>\n\n`,
            isMcpFetching: true,
          };
          return { ...s, messages: msgs };
        }));
        
        try {
          const visionRes = await fetch('/api/chat', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
                model: selectedVisionModel,
                messages: [{
                   role: 'user', 
                   content: 'Describe the attached image(s) in extreme detail. Include all visible text, objects, layout, and context. You MUST reply in English. The user asked: "' + originalInput + '"',
                   images: messageImages
                }],
                stream: true,
                options: buildOptions()
             })
          });
          
          if (visionRes.ok) {
            const visionReader = visionRes.body.getReader();
            const visionDecoder = new TextDecoder();
            let rawAnalysisText = '';
            let visionBuffer = '';

            while (true) {
              const { done, value } = await visionReader.read();
              if (done) break;

              visionBuffer += visionDecoder.decode(value, { stream: true });
              const lines = visionBuffer.split('\n');
              visionBuffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.trim()) continue;
                let parsed;
                try { parsed = JSON.parse(line); } catch (e) { continue; }

                const delta = parsed.message || {};
                // The whole analysis already lives inside a <think> block,
                // so a reasoning vision model's thinking can just stream in too.
                const piece = (delta.thinking || '') + (delta.content || '');
                if (!piece) continue;
                rawAnalysisText += piece;
                // Byte-fallback runs span chunks here too.
                const analysisText = decodeByteFallback(rawAnalysisText);

                const currentDisplay = initialAssistantContent + analysisText + '\n</think>\n\n';
                setSessions(prev => prev.map(s => {
                  if (s.id !== currentSessionId) return s;
                  const msgs = [...s.messages];
                  msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: currentDisplay };
                  return { ...s, messages: msgs };
                }));
              }
            }
            
            const analysisText = decodeByteFallback(rawAnalysisText);
            finalInputText += `\n\n--- Image Analysis by ${selectedVisionModel} ---\n${analysisText}\n-------------------\n`;
            addLog(`Image analysis complete.`, 'success');
            
            // DO NOT mutate initialMessages[newMessageIndex - 1].content so UI's user bubble remains clean.
            // finalInputText handles sending it to Ollama later.
            initialAssistantContent = initialAssistantContent + analysisText + '\n</think>\n\n';
            
            setSessions(prev => prev.map(s => {
              if (s.id !== currentSessionId) return s;
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isMcpFetching: false };
              return { ...s, messages: msgs };
            }));
          } else {
            addLog(`Vision analysis returned error status`, 'error');
          }
        } catch (e) {
          addLog(`Vision analysis failed: ${e.message}`, 'error');
        }
      } else if (!isAutoTool) {
        setSessions(prev => prev.map(s => {
          if (s.id !== currentSessionId) return s;
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isMcpFetching: false };
          return { ...s, messages: msgs };
        }));
      }

      let conversation = initialMessages.map((m, idx) => {
        const msgData = { role: m.role, content: m.content };
        // Ensure finalInputText goes to the backend for the newly added user message
        if (idx === newMessageIndex - 1) {
          msgData.content = finalInputText;
        }
        // If we did vision analysis, we STRIP the images from the main model payload so text models don't crash
        // If we didn't (needsVisionAnalysis is false), we keep them for the model to handle itself
        if (m.images && !needsVisionAnalysis) msgData.images = m.images;
        return msgData;
      });

      // A chat can carry its own system prompt; fall back to the global one.
      // A folder's prompt is shared setup for everything filed under it, so it
      // sits in front of whatever this particular chat asks for.
      const folderPrompt = folderOf(currentSession, folders)?.systemPrompt?.trim() || '';
      const chatPrompt = currentSession.systemPrompt !== undefined
        ? currentSession.systemPrompt
        : systemPrompt;
      const effectiveSystemPrompt = [folderPrompt, chatPrompt].filter(Boolean).join('\n\n');

      if (effectiveSystemPrompt && !conversation.find(m => m.role === 'system')) {
        let mcpPrompt = '';
        const mcpToolCallsInTurnForSystem = initialMessages.filter(m => m.role === 'user' && m.content.includes('<TOOL_RESULT>')).length;
        if (mcpEnabled && mcpToolCallsInTurnForSystem === 0) {
          mcpPrompt = `[Agent tools enabled]
You can call tools by emitting one tag. Emit exactly one tag, then stop; the
result comes back in a <TOOL_RESULT> block and you continue from there.

Web
  <TOOL_WEB_SEARCH>search query</TOOL_WEB_SEARCH>
      Returns titles, URLs and short snippets. Snippets are not enough to answer
      a factual question — follow up with TOOL_FETCH_URL on the best result.
  <TOOL_FETCH_URL>https://example.com/page</TOOL_FETCH_URL>
      Opens a page and returns its readable text. This is how you get real
      detail, quotes, dates and numbers.
  <TOOL_NEWS>topic</TOOL_NEWS>
      Current headlines with publisher and timestamp. Leave the topic empty for
      today's top stories. Use this rather than TOOL_WEB_SEARCH for anything
      about the news — a search returns portal front pages, not stories.

Filesystem
  <TOOL_READ_FILE>absolute_path</TOOL_READ_FILE>
  <TOOL_LIST_DIR>absolute_path</TOOL_LIST_DIR>
  <TOOL_SEARCH_FILES path="absolute_directory" query="text"></TOOL_SEARCH_FILES>
  <TOOL_WRITE_FILE path="absolute_path">
  file content
  </TOOL_WRITE_FILE>

Environment
  <TOOL_TIME></TOOL_TIME>            Current date, time and timezone.
  <TOOL_LIST_MODELS></TOOL_LIST_MODELS>   Models installed in this Ollama.
  <TOOL_SYSTEM_INFO></TOOL_SYSTEM_INFO>   CPU, memory and GPU usage.

Rules
1. Use a tool whenever the answer depends on current facts, on this machine, or
   on anything you cannot verify from memory. Do not guess at recent events.
2. Emit the tag and nothing after it. Never write a tool result yourself.
3. You have up to ${toolBudget} tool calls this turn. Spend them: a search
   followed by fetching the most relevant URL is the normal pattern.
4. When you have enough, answer in natural language and cite the URLs you used.
5. If a tool reports a failure, say so plainly instead of inventing the answer.`;
        }
        
        const memoryBlock = memoryEnabled ? formatMemories(memories) : '';
        const finalSystemPrompt = [
          environmentPreamble(),
          memoryBlock,
          mcpPrompt,
          `[System Instructions]\n${effectiveSystemPrompt}`,
        ].filter(Boolean).join('\n\n');
        conversation = [{ role: 'system', content: finalSystemPrompt }, ...conversation];
      }

      const targetModel = activeModel;
      addLog(`Sending message to ${targetModel}...`, 'info');

      // 4. Send to Ollama
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          model: targetModel,
          messages: conversation,
          // Omitted entirely on 'auto' so each model keeps its own default.
          ...(thinkMode === 'auto' ? {} : { think: thinkMode === 'on' }),
          // Ollama parses a string as a Go duration ("5m"), so the sentinels
          // -1 (keep forever) and 0 (unload now) must go over as numbers —
          // "-1" fails with: time: missing unit in duration "-1".
          ...(keepAlive ? { keep_alive: /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive } : {}),
          ...(resolvedFormat ? { format: resolvedFormat } : {}),
          options: buildOptions()
        })
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Ollama returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Ollama >= 0.9 streams reasoning in a separate `message.thinking`
      // field (content stays empty while the model thinks) instead of
      // inline <think> tags. Re-wrap it so both shapes render the same way.
      // Raw as it comes off the wire; the decoded views are derived below.
      let rawThinkingText = '';
      let rawAnswerText = '';
      let truncated = false;
      let buffer = '';

      // Byte-fallback runs arrive one byte per chunk, so the decode has to see
      // the whole accumulated text — it is a no-op once nothing is left to join.
      const composeContent = (closeThinking) => {
        const thinkingText = decodeByteFallback(rawThinkingText);
        const answerText = decodeByteFallback(rawAnswerText);
        let out = initialAssistantContent;
        if (thinkingText) {
          // Leaving the tag open while thinking is what makes the UI show
          // the spinner and keep the dropdown expanded.
          out += (closeThinking || answerText)
            ? `<think>\n${thinkingText}\n</think>\n\n`
            : `<think>\n${thinkingText}`;
        }
        return out + answerText;
      };

      let assistantContent = initialAssistantContent;

      // A fast model emits tokens far quicker than the screen refreshes, and
      // one React commit per token makes the text stutter and pins the CPU.
      // Coalesce into at most one commit per animation frame instead.
      let flushHandle = null;
      const flushNow = () => {
        flushHandle = null;
        setSessions(prev => prev.map(s => {
          if (s.id !== currentSessionId) return s;
          const msgs = [...s.messages];
          msgs[newMessageIndex] = { ...msgs[newMessageIndex], content: assistantContent, isMcpFetching: false };
          return { ...s, messages: msgs };
        }));
      };
      const scheduleFlush = () => {
        if (flushHandle !== null) return;
        flushHandle = requestAnimationFrame(flushNow);
      };
      const cancelFlush = () => {
        if (flushHandle === null) return;
        cancelAnimationFrame(flushHandle);
        flushHandle = null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // a JSON object can straddle two chunks

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch (e) { continue; }

          const delta = parsed.message || {};
          if (delta.thinking) rawThinkingText += delta.thinking;
          if (delta.content) rawAnswerText += delta.content;

          if (delta.thinking || delta.content) {
            assistantContent = composeContent(false);
            scheduleFlush();
          }

          if (parsed.done) {
            cancelFlush();
            assistantContent = composeContent(true);
            const totalTime = (parsed.total_duration / 1e9).toFixed(2);
            const tokensPerSec = parsed.eval_duration && parsed.eval_count
              ? (parsed.eval_count / (parsed.eval_duration / 1e9)).toFixed(2)
              : null;

            const metrics = { totalTime, tokensPerSec, evalCount: parsed.eval_count, promptTokens: parsed.prompt_eval_count };
            // A retry set this; the finished answer joins the earlier ones
            // instead of overwriting them.
            const carried = pendingVariantsRef.current;
            pendingVariantsRef.current = null;
            truncated = wasTruncated(parsed);

            setSessions(prev => prev.map(s => {
              if (s.id !== currentSessionId) return s;
              const msgs = [...s.messages];
              const base = {
                ...msgs[newMessageIndex],
                content: assistantContent,
                // prompt_eval_count is the tokeniser's own count of everything sent;
                // the composer only ever had a heuristic before this.
                metrics,
                model: targetModel,
                isMcpFetching: false,
              };
              msgs[newMessageIndex] = carried
                ? appendVariant({ ...base, variants: carried, variantIndex: carried.length - 1 }, base)
                : base;
              return { ...s, messages: msgs };
            }));
          }
        }
      }

      // Make sure the think block is closed even if no `done` frame arrived,
      // and that no queued frame overwrites the final content.
      cancelFlush();
      assistantContent = composeContent(true);
      // Commit it synchronously: a stream that ends without a `done` frame
      // would otherwise lose the last batch to the cancelled callback.
      // Metrics set by `done` survive because the flush only rewrites content.
      flushNow();
      addLog(`Received response`, 'success');

      // One decoded view for everything downstream: tool tags, TTS and memory
      // all have to see the real characters, not the byte spellings.
      const answerText = decodeByteFallback(rawAnswerText);

      // A continuation is a separate turn on the wire but one reply on screen,
      // so the text is stitched back on and the scaffolding is dropped.
      const continuation = continuationTargetRef.current;
      continuationTargetRef.current = null;
      let truncationIndex = newMessageIndex;

      if (continuation) {
        truncationIndex = continuation.index;

        // A template that ignores the prefill answers by writing the reply over
        // again. Note it, throw the restart away and ask the other way instead.
        if (continuation.mode === 'prefill' && looksRestarted(continuation.before, answerText)) {
          noPrefillModelsRef.current.add(targetModel);
          addLog(`${targetModel} cannot be prefilled; asking for the continuation instead.`, 'info');
          setSessions(prev => prev.map(x => {
            if (x.id !== currentSessionId) return x;
            return { ...x, messages: x.messages.filter((_, i) => i <= continuation.index) };
          }));
          setIsGenerating(false);
          setTimeout(() => continueResponse(continuation.index), 120);
          return;
        }

        setSessions(prev => prev.map(x => {
          if (x.id !== currentSessionId) return x;
          const msgs = [...x.messages];
          if (!msgs[continuation.index]) return x;
          msgs[continuation.index] = {
            ...msgs[continuation.index],
            content: joinContinuation(continuation.before, answerText, continuation.mode),
          };
          // Drop the hidden instruction turn and the bubble it produced.
          return { ...x, messages: msgs.filter((_, i) => i <= continuation.index || i > newMessageIndex) };
        }));
        addLog('Continuation merged into the previous reply.', 'success');
      }

      // The reply stopped because it ran out of budget, not because it was
      // finished. Offer to carry on — or just do it, up to a sane depth.
      if (truncated) {
        addLog(`Response hit the ${maxTokens}-token limit.`, 'warning');
        if (autoContinue && continueDepthRef.current < MAX_AUTO_CONTINUE) {
          continueDepthRef.current += 1;
          setTruncatedIndex(null);
          setTimeout(() => continueResponse(truncationIndex), 120);
          return;
        }
        setTruncatedIndex(truncationIndex);
      } else {
        continueDepthRef.current = 0;
        setTruncatedIndex(null);
      }

      // ---- Agent tools ----
      // A registry rather than a chain of ifs: each entry owns its pattern and
      // its execution, so adding a tool is one object.
      if (mcpEnabled) {
        const TOOLS = [
          {
            name: 'TOOL_WEB_SEARCH',
            pattern: /<TOOL_WEB_SEARCH>([\s\S]*?)<\/TOOL_WEB_SEARCH>/,
            run: async (m) => {
              const query = m[1].trim();
              addLog(`[tool] web search: ${query}`, 'info');
              const { results, provider, attempts } = await mcpSearchWeb(query, 6);
              if (results.length === 0) return `SEARCH FAILED for '${query}'. ${searchFailureNote(attempts)}`;
              return `Web search results for '${query}' (via ${provider}):\n${formatSearchResults(results)}`;
            },
          },
          {
            name: 'TOOL_NEWS',
            pattern: /<TOOL_NEWS>([\s\S]*?)<\/TOOL_NEWS>/,
            run: async (m) => {
              const topic = m[1].trim();
              addLog(`[tool] news: ${topic || 'top stories'}`, 'info');
              const { items, text } = await mcpFetchNews(topic, 10);
              if (items.length === 0) {
                return `No headlines came back${topic ? ` for '${topic}'` : ''}. `
                  + 'This is a tooling failure, not evidence that nothing is happening.';
              }
              return text;
            },
          },
          {
            name: 'TOOL_FETCH_URL',
            pattern: /<TOOL_FETCH_URL>([\s\S]*?)<\/TOOL_FETCH_URL>/,
            run: async (m) => {
              const url = m[1].trim();
              addLog(`[tool] fetch: ${url}`, 'info');
              const data = await mcpFetchUrl(url, 12000, signal);
              return [
                `Page content from ${data.url}`,
                data.truncated ? '(truncated)' : '',
                '',
                data.text,
              ].filter(Boolean).join('\n');
            },
          },
          {
            name: 'TOOL_READ_FILE',
            pattern: /<TOOL_READ_FILE>([\s\S]*?)<\/TOOL_READ_FILE>/,
            run: async (m) => {
              const targetPath = m[1].trim();
              addLog(`[tool] read file: ${targetPath}`, 'info');
              const res = await fetch('/localfs/read', { method: 'POST', body: JSON.stringify({ targetPath }) });
              const data = await res.json();
              return data.success ? `File content of ${targetPath}:\n${data.content}` : `Error: ${data.error}`;
            },
          },
          {
            name: 'TOOL_LIST_DIR',
            pattern: /<TOOL_LIST_DIR>([\s\S]*?)<\/TOOL_LIST_DIR>/,
            run: async (m) => {
              const targetPath = m[1].trim();
              addLog(`[tool] list dir: ${targetPath}`, 'info');
              const res = await fetch('/localfs/list', { method: 'POST', body: JSON.stringify({ targetPath }) });
              const data = await res.json();
              return data.success ? `Contents of ${targetPath}:\n${data.files.join('\n')}` : `Error: ${data.error}`;
            },
          },
          {
            name: 'TOOL_SEARCH_FILES',
            pattern: /<TOOL_SEARCH_FILES path="([\s\S]*?)" query="([\s\S]*?)"><\/TOOL_SEARCH_FILES>/,
            run: async (m) => {
              const targetPath = m[1].trim();
              const query = m[2];
              addLog(`[tool] search files: "${query}" in ${targetPath}`, 'info');
              const res = await fetch('/localfs/search', { method: 'POST', body: JSON.stringify({ targetPath, query }) });
              const data = await res.json();
              return data.success
                ? `Files containing '${query}':\n${data.results.join('\n') || '(none)'}`
                : `Error: ${data.error}`;
            },
          },
          {
            name: 'TOOL_WRITE_FILE',
            pattern: /<TOOL_WRITE_FILE path="([\s\S]*?)">([\s\S]*?)<\/TOOL_WRITE_FILE>/,
            run: async (m) => {
              const targetPath = m[1].trim();
              addLog(`[tool] write file: ${targetPath}`, 'info');
              const res = await fetch('/localfs/write', { method: 'POST', body: JSON.stringify({ targetPath, content: m[2] }) });
              const data = await res.json();
              return data.success ? `Wrote ${targetPath}.` : `Error: ${data.error}`;
            },
          },
          {
            name: 'TOOL_TIME',
            pattern: /<TOOL_TIME>\s*<\/TOOL_TIME>/,
            run: async () => {
              const now = new Date();
              const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
              return [
                `ISO: ${now.toISOString()}`,
                `Local: ${now.toLocaleString()} (${zone})`,
                `Date: ${now.toLocaleDateString('en-CA')}`,
                `Weekday: ${now.toLocaleDateString('en-US', { weekday: 'long' })}`,
              ].join('\n');
            },
          },
          {
            name: 'TOOL_LIST_MODELS',
            pattern: /<TOOL_LIST_MODELS>\s*<\/TOOL_LIST_MODELS>/,
            run: async () => {
              const res = await fetch('/api/tags');
              if (!res.ok) return `Error: Ollama returned HTTP ${res.status}`;
              const data = await res.json();
              const list = (data.models || []).map(m => {
                const size = formatBytes(m.size);
                const params = m.details?.parameter_size ? ` · ${m.details.parameter_size}` : '';
                const quant = m.details?.quantization_level ? ` · ${m.details.quantization_level}` : '';
                return `- ${m.name} (${size}${params}${quant})`;
              });
              return `Installed models (${list.length}):\n${list.join('\n') || '(none)'}\nCurrently selected: ${activeModel}`;
            },
          },
          {
            name: 'TOOL_SYSTEM_INFO',
            pattern: /<TOOL_SYSTEM_INFO>\s*<\/TOOL_SYSTEM_INFO>/,
            run: async () => {
              const res = await fetch('/system/stats');
              if (!res.ok) return `Error: system stats unavailable (HTTP ${res.status})`;
              const data = await res.json();
              if (!data.ok) return `Error: ${data.error}`;
              const gpus = (data.gpus || []).map(g => (
                `- ${g.name}: ${g.utilization ?? '?'}% load, `
                + `${formatBytes(g.memoryUsed)} / ${formatBytes(g.memoryTotal)} VRAM`
                + (g.temperature !== null ? `, ${g.temperature}°C` : '')
              ));
              return [
                `CPU: ${data.cpu.model} (${data.cpu.count} logical cores)`,
                `CPU load: ${data.cpu.usage === null ? 'sampling' : `${Math.round(data.cpu.usage)}%`}`,
                `Memory: ${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`,
                gpus.length ? `GPUs:\n${gpus.join('\n')}` : 'GPUs: none detected',
              ].join('\n');
            },
          },
        ];

        const invoked = TOOLS
          .map(tool => ({ tool, match: answerText.match(tool.pattern) }))
          .filter(entry => entry.match)
          // Honour the first tag the model actually wrote.
          .sort((a, b) => a.match.index - b.match.index)[0];

        if (invoked) {
          const spent = initialMessages.filter(
            m => m.role === 'user' && m.content.includes('<TOOL_RESULT>')
          ).length;

          if (spent >= toolBudget) {
            const nextMessages = [
              ...initialMessages,
              { role: 'assistant', content: assistantContent },
              {
                role: 'user',
                content: `<TOOL_RESULT>\nTool budget for this turn is used up (${toolBudget} calls). `
                  + 'Answer now from what you have gathered. If it is not enough, say what is missing '
                  + 'rather than guessing. Do not emit any more tool tags.\n</TOOL_RESULT>',
              },
            ];
            setTimeout(() => handleSend(null, nextMessages, activeModel), 100);
            return;
          }

          let toolResultText;
          try {
            toolResultText = await invoked.tool.run(invoked.match);
          } catch (e) {
            toolResultText = `Error running ${invoked.tool.name}: ${e.message}`;
            addLog(`[tool] ${invoked.tool.name} failed: ${e.message}`, 'error');
          }

          const remaining = Math.max(0, toolBudget - spent - 1);
          const suffix = remaining > 0
            ? `\n\nYou have ${remaining} tool call(s) left. Use another only if you still need it; `
              + 'otherwise answer now, citing any URLs you used.'
            : '\n\nThis was your last tool call. Answer now, citing any URLs you used.';

          const nextMessages = [
            ...initialMessages,
            { role: 'assistant', content: assistantContent },
            { role: 'user', content: `<TOOL_RESULT>\n${toolResultText}${suffix}\n</TOOL_RESULT>` },
          ];

          setTimeout(() => handleSend(null, nextMessages, activeModel), 100);
          return; // Keep isGenerating true
        }
      }

      // Naming the chat waits until here for two reasons: a turn that called a
      // tool reaches the code above with nothing but the tool tag as its
      // "answer", and the title should describe the reply, not the request.
      if (!continuation) {
        const session = sessionsRef.current.find(x => x.id === currentSessionId);
        if (autoTitle && session && !session.titleLocked && !session.titleGenerated) {
          const firstUser = session.messages.find(m => m.role === 'user' && !m.continuation);
          if (firstUser) generateSessionTitle(currentSessionId, firstUser.content, answerText, targetModel);
        }
      }

      // Extraction runs on a settled conversation, and only every few turns —
      // it costs a full generation, so doing it after every reply is wasteful.
      if (autoRemember && !isAutoTool && initialMessages.length >= 4 && initialMessages.length % 6 === 0) {
        setTimeout(() => rememberFromChat(), 400);
      }

      // Only reached once the turn is genuinely finished (no tool round-trip
      // pending), so auto-play never fires on an intermediate step.
      if (ttsAutoPlay && stripForSpeech(answerText)) {
        setTimeout(() => speakMessage(answerText, newMessageIndex), 150);
      }

    } catch (err) {
      if (err.name === 'AbortError' || err.message.includes('abort')) {
        addLog('Generation stopped by user.', 'info');
        // Stopping mid-thought leaves an unterminated <think>, which would
        // keep the "Thinking..." spinner running forever. Close it.
        setSessions(prev => prev.map(s => {
          if (s.id !== currentSessionId) return s;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (!last || last.role !== 'assistant') return s;
          const opens = (last.content.match(/<think>/g) || []).length;
          const closes = (last.content.match(/<\/think>/g) || []).length;
          if (opens <= closes) return s;
          msgs[msgs.length - 1] = { ...last, content: `${last.content}\n</think>\n\n`, isMcpFetching: false };
          return { ...s, messages: msgs };
        }));
      } else {
        addLog(`Error: ${err.message}`, 'error');
        if (initialMessages) {
          updateCurrentSession({
             messages: [...initialMessages, { role: 'assistant', content: `**Error:** ${err.message}` }]
          });
        }
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const stopGeneration = (e) => {
    if (e) e.preventDefault();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsGenerating(false);
    addLog('User requested to stop generation.', 'info');
  };

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    if (index !== undefined) {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    }
  };

  // Drops the trailing assistant turn (plus any tool round-trips that
  // belong to it) and re-runs the request, optionally against another model.
  // ---- Continuing a truncated reply ----
  // Bounded so a model that keeps running into the limit cannot loop forever.
  const MAX_AUTO_CONTINUE = 3;

  const continueResponse = async (index) => {
    if (isGenerating) return;
    const target = messages[index];
    if (!target || target.role !== 'assistant') return;

    setTruncatedIndex(null);
    // The continuation is asked for as a normal turn but the answer is stitched
    // back onto the message that was cut off, so the chat reads as one reply.
    // Prefill is seamless where the template allows it, so it is tried first
    // and only abandoned for a model that has already been seen to restart.
    const mode = noPrefillModelsRef.current.has(selectedModel) ? 'instruct' : 'prefill';
    continuationTargetRef.current = { index, before: target.content, mode };

    const history = messages.slice(0, index + 1);
    handleSend(null, mode === 'prefill'
      ? history
      : [
          // `continuation` keeps this turn out of the transcript; the model
          // still sees it, the reader never does.
          ...history,
          { role: 'user', content: CONTINUE_PROMPT, at: Date.now(), continuation: true },
        ]);
  };

  // ---- Regeneration variants ----

  const showVariant = (index, variantIndex) => {
    updateCurrentSession({
      messages: messages.map((m, i) => (i === index ? selectVariant(m, variantIndex) : m)),
    });
  };

  const dropVariant = (index) => {
    const message = messages[index];
    if (!message || variantCount(message) <= 1) return;
    const previous = messages;
    const sid = currentSessionId;
    updateCurrentSession({
      messages: messages.map((m, i) => (i === index ? removeVariant(m, variantIndexOf(m)) : m)),
    });
    toast(t('variants.dropped'), 'info', 6000, {
      label: t('common.undo'),
      onClick: () => setSessions(prev => prev.map(x => (x.id === sid ? { ...x, messages: previous } : x))),
    });
  };

  // ---- Chat folders ----

  const persistFolders = (next) => { setFolders(next); saveFolders(currentUser?.id, next); };

  const saveFolderDialog = () => {
    const draft = folderDialog;
    if (!draft || !draft.name.trim()) return;
    if (draft.id) {
      persistFolders(updateFolder(
        renameFolder(folders, draft.id, draft.name),
        draft.id,
        { systemPrompt: draft.systemPrompt },
      ));
    } else {
      persistFolders([...folders, { ...newFolder(draft.name, draft.systemPrompt) }]);
    }
    setFolderDialog(null);
  };

  const deleteFolder = (id) => {
    const { folders: nextFolders, sessions: nextSessions } = removeFolder(folders, sessions, id);
    persistFolders(nextFolders);
    setSessions(nextSessions);
    setFolderDialog(null);
    toast(t('folders.deleted'), 'info');
  };

  const moveSessionToFolder = (sessionId, folderId) =>
    setSessions(prev => assignToFolder(prev, sessionId, folderId));

  const toggleFolderCollapsed = (id) =>
    setCollapsedFolders(prev => ({ ...prev, [id]: !prev[id] }));

  // ---- Sampling presets ----

  const currentSamplingValues = () => ({
    temperature, topP, topK, repeatPenalty, numCtx, maxTokens,
    minP, presencePenalty, frequencyPenalty, seed, stopSequences,
  });

  const SAMPLING_SETTERS = {
    temperature: setTemperature, topP: setTopP, topK: setTopK,
    repeatPenalty: setRepeatPenalty, numCtx: setNumCtx, maxTokens: setMaxTokens,
    minP: setMinP, presencePenalty: setPresencePenalty,
    frequencyPenalty: setFrequencyPenalty, seed: setSeed, stopSequences: setStopSequences,
  };

  const applyPreset = (preset) => {
    const values = sanitisePreset(preset.values);
    for (const field of PRESET_FIELDS) {
      if (field in values && SAMPLING_SETTERS[field]) SAMPLING_SETTERS[field](values[field]);
    }
    toast(t('presets.applied', { name: preset.builtin ? t(preset.nameKey) : preset.name }), 'success');
  };

  const persistPresets = (next) => { setPresets(next); savePresets(currentUser?.id, next); };

  const savePresetFromCurrent = () => {
    if (!newPresetName.trim()) return;
    persistPresets([...presets, newPreset(newPresetName, currentSamplingValues())]);
    setNewPresetName('');
    toast(t('presets.saved'), 'success');
  };

  const deletePreset = (id) => persistPresets(presets.filter(x => x.id !== id));

  const handleRetry = (overrideModel = null) => {
    if (isGenerating || messages.length === 0) return;
    // Whatever has already been generated for this turn is carried into the
    // new answer as its earlier variants instead of being thrown away.
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    pendingVariantsRef.current = lastAssistant ? variantsOf(lastAssistant) : null;
    const newMessages = [...messages];
    while (newMessages.length > 0) {
      const last = newMessages[newMessages.length - 1];
      const isToolResult = last.role === 'user' && last.content.trim().startsWith('<TOOL_RESULT>');
      if (last.role === 'assistant' || isToolResult) newMessages.pop();
      else break;
    }
    if (overrideModel) {
      setSelectedModel(overrideModel);
      addLog(`Regenerating with ${overrideModel}...`, 'info');
    }
    setRegenMenuOpen(false);
    handleSend(null, newMessages, overrideModel);
  };

  const deleteMessage = (index) => {
    const previous = messages;
    const sid = currentSessionId; // undo must target this chat even after switching
    updateCurrentSession({ messages: messages.filter((_, i) => i !== index) });
    toast('Message deleted.', 'info', 6000, {
      label: 'Undo',
      onClick: () => setSessions(prev => prev.map(s => (s.id === sid ? { ...s, messages: previous } : s))),
    });
  };

  const startEdit = (index, content) => {
    setEditingMessageIndex(index);
    setEditInput(content);
  };

  const cancelEdit = () => {
    setEditingMessageIndex(null);
    setEditInput('');
  };

  const saveEdit = (index) => {
    if (!editInput.trim()) return;
    // slice() is shallow, so assigning into [index] used to mutate the
    // message object that is still referenced by the stored session.
    const newMessages = messages.slice(0, index + 1).map((m, i) => (
      i === index ? { ...m, content: editInput } : m
    ));
    setEditingMessageIndex(null);
    handleSend(null, newMessages);
  };

  // Sort and group sessions for the sidebar
  const categories = ['Pinned', 'Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];
  const CATEGORY_KEYS = {
    'Pinned': 'sidebar.pinned', 'Today': 'sidebar.today', 'Yesterday': 'sidebar.yesterday',
    'Previous 7 Days': 'sidebar.prev7', 'Previous 30 Days': 'sidebar.prev30', 'Older': 'sidebar.older',
  };
  const sortedSessions = [...sessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  
  const filteredSessions = sessionSearchQuery.trim() === '' ? sortedSessions : sortedSessions.filter(s => {
    const q = sessionSearchQuery.toLowerCase();
    const matchTitle = s.title.toLowerCase().includes(q);
    const matchMessages = s.messages.some(m => m.content.toLowerCase().includes(q));
    return matchTitle || matchMessages;
  });

  // Folders take precedence over the date buckets: a filed chat appears in its
  // folder, and only what is left is grouped by when it was last touched.
  const { grouped: folderGroups, loose: unfiledSessions } = groupByFolder(filteredSessions, folders);

  const groupedSessions = categories.reduce((acc, cat) => { acc[cat] = []; return acc; }, {});
  
  unfiledSessions.forEach(session => {
    const category = session.pinned ? 'Pinned' : categorizeSession(session.updatedAt || session.createdAt);
    if (groupedSessions[category]) {
      groupedSessions[category].push(session);
    } else {
      groupedSessions['Older'].push(session);
    }
  });

  // One row, rendered from two places: inside a folder and under a date
  // heading. Keeping it in one function is what stops the two drifting apart.
  const renderSessionRow = (s) => (
    <div
      key={s.id}
      className={`history-item ${currentSessionId === s.id ? 'active' : ''}`}
      onClick={() => !isGenerating && setCurrentSessionId(s.id)}
    >
      {s.pinned && <Pin size={12} className="pin-marker" />}
      {renamingId === s.id ? (
        <input
          className="history-rename-input"
          value={renameValue}
          autoFocus
          onClick={e => e.stopPropagation()}
          onChange={e => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
          }}
        />
      ) : (
        <div className="history-main" onDoubleClick={(e) => startRename(s, e)}>
          <span className="history-title">{s.title}</span>
          <span className="history-meta" title={absoluteTime(s.updatedAt || s.createdAt, lang)}>
            {relativeTime(s.updatedAt || s.createdAt, lang)}
          </span>
        </div>
      )}
      <div className="history-actions">
        <button
          className={s.pinned ? 'is-on' : ''}
          title={s.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
          onClick={(e) => togglePin(s.id, e)}
        >
          {s.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>

        <span className="row-menu-wrap">
          <button
            ref={el => { rowMenuAnchors.current[s.id] = el; }}
            title={t('sidebar.more')}
            onClick={(e) => { e.stopPropagation(); setRowMenuFor(rowMenuFor === s.id ? null : s.id); }}
          >
            <MoreHorizontal size={13} />
          </button>
          <AnchoredMenu
            open={rowMenuFor === s.id}
            onClose={() => setRowMenuFor(null)}
            anchorRef={{ current: rowMenuAnchors.current[s.id] }}
            className="row-menu"
            width={215}
          >
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); startRename(s); }}>
              <Edit size={13} /><span className="cmd-label">{t('sidebar.rename')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); duplicateSession(s.id); }}>
              <Copy size={13} /><span className="cmd-label">{t('sidebar.duplicate')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); exportSessionMarkdown(s); }}>
              <FileDown size={13} /><span className="cmd-label">{t('sidebar.exportMd')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); exportSessionHtml(s); }}>
              <Globe size={13} /><span className="cmd-label">{t('sidebar.exportHtml')}</span>
            </button>

            <div className="row-menu-sep">{t('folders.move')}</div>
            <button className="cmd-item" onClick={() => { moveSessionToFolder(s.id, null); setRowMenuFor(null); }}>
              <span className="cmd-label">{t('folders.none')}</span>
              {!s.folderId && <Check size={13} />}
            </button>
            {folders.map(f => (
              <button key={f.id} className="cmd-item" onClick={() => { moveSessionToFolder(s.id, f.id); setRowMenuFor(null); }}>
                <Folder size={13} />
                <span className="cmd-label">{f.name}</span>
                {s.folderId === f.id && <Check size={13} />}
              </button>
            ))}
          </AnchoredMenu>
        </span>

        <button className="danger" title={t('sidebar.delete')} onClick={(e) => deleteSession(s.id, e)}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );

  const exportSessions = () => {
    // A data: URI silently fails once the history carries base64 images;
    // a Blob URL has no practical size limit.
    downloadBlob(
      `chat_history_${new Date().toISOString().split('T')[0]}.json`,
      JSON.stringify(sessions, null, 2),
      'application/json;charset=utf-8'
    );
    addLog(`Exported ${sessions.length} chats as JSON.`, 'success');
  };

  const importSessions = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (Array.isArray(imported)) {
          // Merge avoiding ID collisions
          const newIds = new Set(sessions.map(s => s.id));
          const toAdd = imported.map(s => {
             while(newIds.has(s.id)) s.id = s.id + 1;
             newIds.add(s.id);
             return s;
          });
          setSessions([...sessions, ...toAdd]);
          addLog(`Successfully imported ${toAdd.length} sessions.`, 'success');
        }
      } catch (err) {
        addLog(`Import failed: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  };

  const clearAllChats = () => {
    if (window.confirm('Are you sure you want to delete ALL chat history? This cannot be undone.')) {
      const freshSession = { id: Date.now(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      setSessions([freshSession]);
      setCurrentSessionId(freshSession.id);
      addLog('All chats cleared.', 'info');
      setShowSettings(false);
    }
  };

  // Streams Ollama's NDJSON pull progress so the modal can show a real bar
  // instead of an indeterminate spinner.
  const handleDownload = async () => {
    const name = downloadModelName.trim();
    if (!name) return;
    setIsDownloading(true);
    setPullProgress({ status: 'starting', percent: 0 });
    addLog(`Initiated pull for model: ${name}`, 'info');

    try {
      const res = await fetch('/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, model: name, stream: true })
      });
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastLoggedStatus = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep the trailing partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch (e) { continue; }

          if (parsed.error) throw new Error(parsed.error);

          const percent = parsed.total
            ? Math.min(100, Math.round(((parsed.completed || 0) / parsed.total) * 100))
            : null;
          setPullProgress({
            status: parsed.status || '',
            percent,
            completed: parsed.completed,
            total: parsed.total,
          });

          if (parsed.status && parsed.status !== lastLoggedStatus) {
            lastLoggedStatus = parsed.status;
            addLog(`[pull] ${parsed.status}`, 'info');
          }
        }
      }

      addLog(`Successfully downloaded model: ${name}`, 'success');
      setDownloadModelName('');
      fetchModels();
    } catch (err) {
      addLog(`Error pulling model: ${err.message}`, 'error');
    } finally {
      setIsDownloading(false);
      setPullProgress(null);
    }
  };

  // ---- Derived UI state for the newer features ----

  // Google refuses to register an origin whose host is a bare IP address —
  // it insists on a public top-level domain. nip.io is public DNS that resolves
  // any address in the name straight back to itself, so this is the same
  // machine reached by a name the console will accept.
  const registerableOrigin = (() => {
    const { protocol, hostname, port } = window.location;
    const isBareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    const host = isBareIp ? `${hostname}.nip.io` : hostname;
    return `${protocol}//${host}${port ? `:${port}` : ''}`;
  })();


  // Highlights whichever preset the sliders currently sit on, so moving one
  // control visibly takes the chat off that preset.
  const activePreset = matchPreset([...BUILTIN_PRESETS, ...presets], currentSamplingValues());


  // Indices of the messages matching the in-chat search, in document order.
  const searchHits = (() => {
    const q = chatSearchQuery.trim().toLowerCase();
    if (!q) return [];
    return messages.reduce((acc, m, i) => {
      if ((m.content || '').toLowerCase().includes(q)) acc.push(i);
      return acc;
    }, []);
  })();

  const markdownRehypePlugins = useMemo(() => {
    const base = [rehypeKatex, rehypeHighlight];
    const q = chatSearchQuery.trim();
    return q ? [...base, createSearchHighlighter(q)] : base;
  }, [chatSearchQuery]);

  // Same set plus the per-word wrapper, for the message currently streaming.
  const streamingRehypePlugins = useMemo(
    () => [...markdownRehypePlugins, rehypeAnimateTokens],
    [markdownRehypePlugins]
  );

  const jumpToHit = (next) => {
    if (searchHits.length === 0) return;
    searchVisitedRef.current = true;
    const target = (next + searchHits.length) % searchHits.length;
    setSearchHitIndex(target);
    isAutoScrollRef.current = false;
    messageRefs.current[searchHits[target]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Reset the cursor whenever the query changes.
  useEffect(() => { setSearchHitIndex(0); searchVisitedRef.current = false; }, [chatSearchQuery]);

  // Jump list of the user's turns, so long chats stay navigable.
  const chatOutline = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role === 'user' && !m.content.trim().startsWith('<TOOL_RESULT>'))
    .map(({ m, index }) => ({
      index,
      starred: !!m.starred,
      label: cleanForExport(m.content).split('\n').find(Boolean)?.slice(0, 120) || '(attachment)',
    }));

  const jumpToMessage = (index) => {
    isAutoScrollRef.current = false;
    messageRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setShowOutline(false);
  };

  const toggleStar = (index) => {
    const newMessages = messages.map((m, i) => (i === index ? { ...m, starred: !m.starred } : m));
    updateCurrentSession({ messages: newMessages });
  };

  // Stats for the chat-info panel.
  const chatStats = (() => {
    const msgs = messages || [];
    const userCount = msgs.filter(m => m.role === 'user').length;
    const assistantCount = msgs.filter(m => m.role === 'assistant').length;
    const tokens = msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const speeds = msgs.map(m => parseFloat(m.metrics?.tokensPerSec)).filter(v => !Number.isNaN(v));
    const avgSpeed = speeds.length ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : null;
    const starred = msgs.filter(m => m.starred).length;
    return { userCount, assistantCount, tokens, avgSpeed, starred, total: msgs.length };
  })();

  // The slash menu only shows while the composer holds a bare `/word`.
  const slashMatches = (() => {
    const match = /^\/([a-zA-Z가-힣]*)$/.exec(input);
    if (!match) return [];
    const q = match[1].toLowerCase();
    const fromLibrary = promptLibrary.map(p => ({
      name: `/${slugify(p.name).toLowerCase()}`,
      desc: p.name,
      template: p.body,
    }));
    return [...SLASH_COMMANDS, ...fromLibrary]
      .filter(c => c.name.slice(1).toLowerCase().startsWith(q));
  })();

  // Rough context budget indicator for the current conversation.
  // Ollama reports prompt_eval_count for the last turn: the tokeniser's own
  // number for everything sent. Anything typed since is still an estimate,
  // but the bulk of the figure is now measured rather than guessed.
  const lastMeasured = [...messages].reverse()
    .find(m => m.role === 'assistant' && m.metrics?.promptTokens);
  const measuredTokens = lastMeasured
    ? lastMeasured.metrics.promptTokens + (lastMeasured.metrics.evalCount || 0)
    : null;

  const tokensSinceMeasurement = measuredTokens === null
    ? 0
    : messages
        .slice(messages.lastIndexOf(lastMeasured) + 1)
        .reduce((sum, m) => sum + estimateTokens(m.content), 0);

  const usedTokens = measuredTokens === null
    ? estimateTokens(systemPrompt)
      + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
      + estimateTokens(input)
    : measuredTokens + tokensSinceMeasurement + estimateTokens(input);

  const tokensAreMeasured = measuredTokens !== null;
  const ctxPercent = numCtx > 0 ? Math.min(100, Math.round((usedTokens / numCtx) * 100)) : 0;

  const paletteItems = (() => {
    const items = [
      { section: 'Actions', label: t('sidebar.newChat'), icon: <Plus size={15} />, hint: 'Ctrl+Shift+O', action: createNewSession },
      { section: 'Actions', label: t('sidebar.resize'), icon: <Layers size={15} />, hint: 'Ctrl+B', action: () => setIsSidebarOpen(v => !v) },
      { section: 'Actions', label: t('sidebar.settings'), icon: <Settings size={15} />, hint: 'Ctrl+,', action: () => openSettings() },
      { section: 'Actions', label: t('header.exportChat'), icon: <FileDown size={15} />, action: () => exportSessionMarkdown() },
      { section: 'Actions', label: t('sidebar.exportHtml'), icon: <Globe size={15} />, action: () => exportSessionHtml() },
      { section: 'Actions', label: t('folders.new'), icon: <FolderPlus size={15} />, action: () => setFolderDialog({ name: '', systemPrompt: '' }) },
      { section: 'Actions', label: t('memory.extract'), icon: <Sparkles size={15} />, action: () => rememberFromChat() },
      { section: 'Actions', label: t('compact.action'), icon: <Layers size={15} />, action: () => compactConversation() },
      { section: 'Actions', label: t('data.exportJson'), icon: <Download size={15} />, action: exportSessions },
      { section: 'Actions', label: t('sidebar.rename'), icon: <Edit size={15} />, action: () => startRename(currentSession) },
      { section: 'Actions', label: currentSession?.pinned ? 'Unpin this chat' : 'Pin this chat', icon: <Pin size={15} />, action: () => togglePin(currentSessionId) },
      { section: 'Actions', label: t('sidebar.duplicate'), icon: <Copy size={15} />, action: () => duplicateSession(currentSessionId) },
      { section: 'Actions', label: `Web Fetch (MCP): turn ${mcpEnabled ? 'off' : 'on'}`, icon: <Terminal size={15} />, action: () => setMcpEnabled(v => !v) },
      { section: 'Actions', label: `Thinking: ${thinkMode} (cycle auto/on/off)`, icon: <Zap size={15} />, action: () => setThinkMode(m => m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto') },
      { section: 'Actions', label: t('profile.title'), icon: <User size={15} />, action: () => (currentUser ? setShowProfileDialog(true) : setShowAuthScreen(true)) },
      { section: 'Appearance', label: `${t('settings.animations')}: ${motionMode}`, icon: <Zap size={15} />, action: () => setMotionMode(m => (m === 'system' ? 'full' : m === 'full' ? 'reduced' : 'system')) },
      { section: 'Actions', label: t('sysmon.title'), icon: <Activity size={15} />, action: () => setShowSystemMonitor(true) },
      { section: 'Actions', label: t('settings.knowledge'), icon: <FileText size={15} />, action: () => openSettings('knowledge') },
      { section: 'Actions', label: t('compare.title'), icon: <Layers size={15} />, action: () => setShowCompare(true) },
      { section: 'Appearance', label: `${t('behaviour.systemStrip')}: ${showSystemStrip ? t('common.on') : t('common.off')}`, icon: <Activity size={15} />, action: () => setShowSystemStrip(v => !v) },
      { section: 'Actions', label: t('chat.info'), icon: <Info size={15} />, action: () => setShowChatInfo(true) },
      { section: 'Actions', label: starredOnly ? 'Show all messages' : 'Show starred messages only', icon: <Star size={15} />, action: () => setStarredOnly(v => !v) },
      { section: 'Actions', label: t('header.searchInChat'), icon: <Search size={15} />, hint: 'Ctrl+F', action: () => setTimeout(() => chatSearchRef.current?.focus(), 30) },
      { section: 'Actions', label: t('settings.shortcuts'), icon: <Command size={15} />, hint: 'Ctrl+/', action: () => setShowShortcuts(true) },
      { section: 'Voice', label: t('msg.stopReading'), icon: <Square size={15} />, action: stopSpeaking },
      { section: 'Voice', label: `Auto-play replies: turn ${ttsAutoPlay ? 'off' : 'on'}`, icon: <Volume2 size={15} />, action: () => setTtsAutoPlay(v => !v) },
      { section: 'Voice', label: t('settings.voice'), icon: <Volume2 size={15} />, action: () => openSettings('voice') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.light')}`, icon: <Sun size={15} />, action: () => setTheme('light') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.dark')}`, icon: <Moon size={15} />, action: () => setTheme('dark') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.system')}`, icon: <Monitor size={15} />, action: () => setTheme('system') },
      { section: 'Appearance', label: `Density: switch to ${chatDensity === 'compact' ? 'comfortable' : 'compact'}`, icon: <Layers size={15} />, action: () => setChatDensity(d => (d === 'compact' ? 'comfortable' : 'compact')) },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.small')}`, icon: <Layers size={15} />, action: () => setChatFontSize('small') },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.medium')}`, icon: <Layers size={15} />, action: () => setChatFontSize('medium') },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.large')}`, icon: <Layers size={15} />, action: () => setChatFontSize('large') },
      { section: 'Appearance', label: t('settings.resetPanels'), icon: <PanelLeft size={15} />, action: () => { setSidebarWidth(DEFAULT_SIDEBAR_WIDTH); setArtifactWidth(DEFAULT_ARTIFACT_WIDTH); setConsoleDockHeight(DEFAULT_CONSOLE_HEIGHT); setArtifactMaximized(false); } },
    ];

    models.forEach(m => items.push({
      section: 'Switch model',
      label: m.name,
      icon: <Cpu size={15} />,
      hint: m.size ? formatBytes(m.size) : undefined,
      action: () => setSelectedModel(m.name),
    }));

    promptLibrary.forEach(p => items.push({
      section: 'Prompts',
      label: p.name,
      icon: <MessageSquare size={15} />,
      action: () => insertPrompt(p.body),
    }));

    sortedSessions.slice(0, 30).forEach(s => {
      if (s.id === currentSessionId) return;
      items.push({
        section: 'Jump to chat',
        label: s.title,
        icon: s.pinned ? <Pin size={15} /> : <MessageSquare size={15} />,
        action: () => setCurrentSessionId(s.id),
      });
    });

    const q = paletteQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => i.label.toLowerCase().includes(q) || i.section.toLowerCase().includes(q));
  })();

  const runPaletteItem = (item) => {
    setShowPalette(false);
    setPaletteQuery('');
    item?.action?.();
  };

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = (e.key || '').toLowerCase();
      const inField = ['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable;

      if (mod && key === 'k') {
        e.preventDefault();
        setShowPalette(v => !v);
        setPaletteQuery('');
        setPaletteIndex(0);
        return;
      }
      if (mod && e.shiftKey && key === 'o') {
        e.preventDefault();
        createNewSession();
        return;
      }
      if (mod && key === 'b' && !inField) {
        e.preventDefault();
        setIsSidebarOpen(v => !v);
        return;
      }
      if (mod && key === ',') {
        e.preventDefault();
        if (showSettings) setShowSettings(false);
        else openSettings();
        return;
      }
      if (mod && (e.key === '\\' || key === '\\')) {
        e.preventDefault();
        if (activeArtifact) setActiveArtifact(null);
        else if (codeArtifacts.length > 0) {
          const last = codeArtifacts[codeArtifacts.length - 1];
          setActiveArtifact({ id: last.id, type: last.previewable ? 'preview' : last.runnable ? 'run' : 'code' });
        }
        return;
      }
      if (mod && key === 'f') {
        e.preventDefault();
        chatSearchRef.current?.focus();
        chatSearchRef.current?.select();
        return;
      }
      if (mod && key === '/') {
        e.preventDefault();
        setShowShortcuts(v => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (showPalette) { setShowPalette(false); return; }
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (showCompare) { setShowCompare(false); return; }
        if (showSystemMonitor) { setShowSystemMonitor(false); return; }
        if (showSettings) { setShowSettings(false); return; }
        if (activeArtifact) { setActiveArtifact(null); return; }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPalette, showShortcuts, showSettings, showSystemMonitor, showCompare, activeArtifact, codeArtifacts]);

  // Keep the palette selection in range as the query narrows the list.
  useEffect(() => {
    setPaletteIndex(i => Math.min(i, Math.max(0, paletteItems.length - 1)));
  }, [paletteQuery, paletteItems.length]);

  useEffect(() => {
    if (showPalette) setTimeout(() => paletteInputRef.current?.focus(), 30);
  }, [showPalette]);

  // Poll loaded models while the Models tab is visible.
  useEffect(() => {
    if (showSettings && settingsTab === 'data') readStorageUsage();
  }, [showSettings, settingsTab]);

  useEffect(() => {
    const wantsModels = showSettings && settingsTab === 'models';
    if (!wantsModels && !showSystemMonitor) return undefined;
    fetchRunningModels();
    const timer = setInterval(fetchRunningModels, 5000);
    return () => clearInterval(timer);
  }, [showSettings, settingsTab, showSystemMonitor]);

  // Close the regenerate menu when clicking elsewhere.
  useEffect(() => {
    if (!regenMenuOpen) return;
    const onClick = (e) => {
      if (regenRef.current && !regenRef.current.contains(e.target)) setRegenMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [regenMenuOpen]);

  if (!authReady) {
    return (
      <div className="auth-screen">
        <RefreshCcw size={22} className="spin" />
      </div>
    );
  }

  if (showAuthScreen) {
    return <AuthScreen onAuthenticated={handleAuthenticated} onGuest={handleGuest} />;
  }

  return (
    <div
      className={`claude-app ${activeArtifact ? 'has-artifact' : ''} ${artifactMaximized ? 'artifact-maximized' : ''}`}
      style={{ '--artifact-width': `${artifactWidth}px`, '--sidebar-width': `${sidebarWidth}px` }}
    >
      {/* Sidebar */}
      <div className={`claude-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={createNewSession}>
            <div className="claude-logo-icon">
              <Sparkles size={16} color="var(--bg-primary)" />
            </div>
            <span>{t('sidebar.newChat')}</span>
            <Edit size={16} className="edit-icon" />
          </button>
        </div>

        <div className="sidebar-search">
          <div className="sidebar-search-inner">
            <Search size={14} className="search-icon" />
            <input 
              type="text" 
              placeholder={t('sidebar.searchChats')} 
              value={sessionSearchQuery}
              onChange={e => setSessionSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="sidebar-content">
          <div className="folder-bar">
            <span className="folder-bar-label">{t('folders.title')}</span>
            <button
              className="folder-add"
              title={t('folders.new')}
              onClick={() => setFolderDialog({ name: '', systemPrompt: '' })}
            >
              <FolderPlus size={13} />
            </button>
          </div>

          {folders.length === 0 && (
            <div className="folder-empty-hint">{t('folders.emptyHint')}</div>
          )}

          {folderGroups.map(({ folder, sessions: inside }) => (
            <div key={folder.id} className="folder-group">
              <div className="folder-head" onClick={() => toggleFolderCollapsed(folder.id)}>
                <ChevronRight size={13} className={`folder-caret ${collapsedFolders[folder.id] ? '' : 'open'}`} />
                <Folder size={13} />
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">{inside.length}</span>
                <button
                  className="folder-edit"
                  title={t('folders.edit')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFolderDialog({ id: folder.id, name: folder.name, systemPrompt: folder.systemPrompt || '' });
                  }}
                >
                  <Settings size={12} />
                </button>
              </div>
              {!collapsedFolders[folder.id] && (
                inside.length > 0
                  ? inside.map(renderSessionRow)
                  : <div className="folder-empty">{t('folders.empty')}</div>
              )}
            </div>
          ))}

          {categories.map(category => groupedSessions[category].length > 0 && (
            <div key={category} className="session-group">
              <div className="recents-label" style={{ padding: '0.5rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{t(CATEGORY_KEYS[category])}</div>
              {groupedSessions[category].map(renderSessionRow)}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="profile-wrap">
            <button className="settings-toggle" onClick={() => setShowProfileMenu(v => !v)}>
              <ProfileAvatar user={currentUser || { name: t('sidebar.guest') }} size={28} />
              <span className="user-name">{currentUser?.name || t('sidebar.guest')}</span>
              <ChevronDown size={14} className="settings-icon" />
            </button>

            <Popover open={showProfileMenu} onClose={() => setShowProfileMenu(false)} className="profile-menu">
              {currentUser ? (
                <>
                  <div className="profile-head">
                    <div className="profile-name">{currentUser.name}</div>
                    {currentUser.email && <div className="profile-email">{currentUser.email}</div>}
                    <div className="profile-provider">{currentUser.provider}</div>
                  </div>
                  <button className="cmd-item" onClick={() => { setShowProfileMenu(false); setShowProfileDialog(true); }}>
                    <User size={15} /><span className="cmd-label">{t('profile.title')}</span>
                  </button>
                  <button className="cmd-item" onClick={() => { openSettings(); setShowProfileMenu(false); }}>
                    <Settings size={15} /><span className="cmd-label">{t('sidebar.settings')}</span>
                  </button>
                  <button className="cmd-item" onClick={() => { setShowProfileMenu(false); setShowAuthScreen(true); }}>
                    <UserPlus size={15} /><span className="cmd-label">{t('auth.switchAccount')}</span>
                  </button>
                  <button className="cmd-item" onClick={handleSignOut}>
                    <LogOut size={15} /><span className="cmd-label">{t('auth.signOut')}</span>
                  </button>
                  <button className="cmd-item danger" onClick={handleDeleteProfile}>
                    <Trash2 size={15} /><span className="cmd-label">{t('auth.deleteAccount')}</span>
                  </button>
                </>
              ) : (
                <>
                  <div className="profile-head">
                    <div className="profile-name">{t('sidebar.guest')}</div>
                    <div className="profile-email">{t('auth.subtitle')}</div>
                  </div>
                  <button className="cmd-item" onClick={() => { setShowProfileMenu(false); setShowAuthScreen(true); }}>
                    <UserPlus size={15} /><span className="cmd-label">{t('auth.signIn')}</span>
                  </button>
                  <button className="cmd-item" onClick={() => { openSettings('general'); setShowProfileMenu(false); }}>
                    <Settings size={15} /><span className="cmd-label">{t('sidebar.settings')}</span>
                  </button>
                </>
              )}
            </Popover>
          </div>
        </div>

        {isSidebarOpen && (
          <ResizeHandle
            label={t('sidebar.resize')}
            direction={1}
            getSize={() => sidebarWidth}
            setSize={setSidebarWidth}
            min={200}
            max={() => Math.min(480, window.innerWidth - 360)}
            onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        )}
      </div>

      {/* Main Chat Area */}
      <div className="claude-main">
        {/* Top Navigation */}
        <div className="main-header">
          <button className="toggle-sidebar" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
          </button>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {showSystemStrip && <SystemStrip onOpen={() => setShowSystemMonitor(true)} inHeader />}

            <div className="sidebar-search-inner" style={{ background: 'var(--bg-main)', border: '1px solid var(--border-color)', width: '260px' }}>
              <Search size={14} className="search-icon" style={{ marginLeft: '0.5rem' }} />
              <input
                ref={chatSearchRef}
                type="text"
                placeholder={t('header.searchInChat')}
                value={chatSearchQuery}
                onChange={e => setChatSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchHits.length === 0) return;
                    // The first Enter lands on hit #1; after that it steps.
                    if (!searchVisitedRef.current) jumpToHit(0);
                    else jumpToHit(e.shiftKey ? searchHitIndex - 1 : searchHitIndex + 1);
                  }
                  if (e.key === 'Escape') { e.preventDefault(); setChatSearchQuery(''); }
                }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none', padding: '0.5rem', width: '100%', fontSize: '0.85rem' }}
              />
              {chatSearchQuery && (
                <div className="search-nav">
                  <span>{searchHits.length ? `${searchHitIndex + 1}/${searchHits.length}` : '0/0'}</span>
                  <button title={t('header.prevMatch')} disabled={searchHits.length === 0} onClick={() => jumpToHit(searchHitIndex - 1)}>
                    <ChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />
                  </button>
                  <button title={t('header.nextMatch')} disabled={searchHits.length === 0} onClick={() => jumpToHit(searchHitIndex + 1)}>
                    <ChevronDown size={13} />
                  </button>
                  <button title={t('header.clearSearch')} onClick={() => setChatSearchQuery('')}>
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>

            <button
              className={`icon-btn bordered ${starredOnly ? 'toggled' : ''}`}
              title={starredOnly ? t('header.showAll') : t('header.starredOnly')}
              onClick={() => setStarredOnly(v => !v)}
            >
              <Star size={16} fill={starredOnly ? 'currentColor' : 'none'} />
            </button>

            <div className="outline-wrap">
              <button
                className={`icon-btn bordered ${showOutline ? 'toggled' : ''}`}
                title={t('header.outline')}
                onClick={() => setShowOutline(v => !v)}
                disabled={chatOutline.length === 0}
              >
                <ListTree size={16} />
              </button>
              <Popover open={showOutline} onClose={() => setShowOutline(false)}>
                {chatOutline.length === 0
                  ? <div className="outline-empty">{t('header.noTurns')}</div>
                  : chatOutline.map((item, n) => (
                    <button
                      key={item.index}
                      className={`outline-item ${item.starred ? 'is-starred' : ''}`}
                      onClick={() => jumpToMessage(item.index)}
                    >
                      <span className="outline-index">{item.starred ? '★' : n + 1}</span>
                      <span className="outline-text">{item.label}</span>
                    </button>
                  ))}
              </Popover>
            </div>

            <button
              className={`icon-btn bordered ${showSystemMonitor ? 'toggled' : ''}`}
              title={t('sysmon.title')}
              onClick={() => setShowSystemMonitor(v => !v)}
            >
              <Activity size={16} />
            </button>

            <button
              className="icon-btn bordered"
              title={t('header.chatInfo')}
              onClick={() => setShowChatInfo(true)}
            >
              <Info size={16} />
            </button>

            <div className="model-selector-container" ref={dropdownRef}>
              <button className="dropdown-trigger" onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}>
                <span className="model-name">{selectedModel || t('header.selectModel')}</span>
                <ChevronDown size={14} />
              </button>
              {isModelDropdownOpen && (
                <div className="dropdown-menu">
                  {models.length === 0 && <div className="dropdown-item" style={{opacity: 0.5}}>{t('header.noModels')}</div>}
                  {models.map(m => (
                    <button 
                      key={m.name} 
                      className={`dropdown-item ${selectedModel === m.name ? 'selected' : ''}`} 
                      onClick={() => { setSelectedModel(m.name); setIsModelDropdownOpen(false); }}
                    >
                      <span>{m.name}</span>
                      {modelSupportsVision(m.name) && <span className="cap-badge" title={t('model.visionCapable')}>👁</span>}
                      {selectedModel === m.name && <Check size={14} className="check-icon" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!modelSupportsVision(selectedModel) && (
            <div className="model-selector-container" ref={visionDropdownRef}>
              <button className="dropdown-trigger" onClick={() => setIsVisionDropdownOpen(!isVisionDropdownOpen)} style={{ backgroundColor: 'transparent', border: '1px solid var(--border-color)' }}>
                <span className="model-name" style={{ color: 'var(--text-muted)' }}>👁️ Vision: {selectedVisionModel || 'Auto'}</span>
                <ChevronDown size={14} color="var(--text-muted)" />
              </button>
              {isVisionDropdownOpen && (
                <div className="dropdown-menu">
                  {models.length === 0 && <div className="dropdown-item" style={{opacity: 0.5}}>{t('header.noModels')}</div>}
                  {models.map(m => (
                    <button 
                      key={m.name} 
                      className={`dropdown-item ${selectedVisionModel === m.name ? 'selected' : ''}`} 
                      onClick={() => { setSelectedVisionModel(m.name); setIsVisionDropdownOpen(false); }}
                    >
                      <span>{m.name}</span>
                      {selectedVisionModel === m.name && <Check size={14} className="check-icon" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}

            <button
              className="icon-btn bordered"
              title={t('compare.title')}
              onClick={() => setShowCompare(true)}
              disabled={models.length < 2}
            >
              <Layers size={16} />
            </button>

            <button
              className="icon-btn bordered"
              title={`${t('header.palette')} (Ctrl+K)`}
              onClick={() => openPalette()}
            >
              <Command size={16} />
            </button>

            <button
              className="icon-btn bordered"
              title={t('header.exportChat')}
              onClick={() => exportSessionMarkdown()}
              disabled={messages.length === 0}
            >
              <FileDown size={16} />
            </button>

            <button
              className="icon-btn bordered"
              title={`${t('header.theme')}: ${theme}`}
              onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
            >
              {theme === 'light' ? <Sun size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Monitor size={16} />}
            </button>
          </div>
        </div>

        {/* Chat Messages */}
        <div className="messages-scroll-area" onScroll={handleScroll}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-logo">
                <Sparkles size={48} color="var(--text-primary)" />
              </div>
              <h1>{t(greetingKey())}</h1>
              <p>{t('empty.help')}</p>

              <div className="starter-grid">
                {STARTER_PROMPTS.map(s => (
                  <button
                    key={s.labelKey}
                    className="starter-card"
                    onClick={() => {
                      setInput(s.prompt);
                      setTimeout(() => textareaRef.current?.focus(), 0);
                    }}
                  >
                    <s.Icon size={16} />
                    <span>{t(s.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-wrapper">
              {messages.map((msg, i) => {
                const isPureToolResult = (m) => m && m.role === 'user' && m.content.trim().startsWith('<TOOL_RESULT>') && m.content.trim().endsWith('</TOOL_RESULT>');
                // The continue instruction is scaffolding, not something the reader wrote.
                if (msg.continuation) return null;
                
                if (isPureToolResult(msg)) return null;

                if (starredOnly && !msg.starred) return null;

                let isContinuation = false;
                if (msg.role === 'assistant' && i > 0) {
                  let p = i - 1;
                  while (p >= 0 && isPureToolResult(messages[p])) p--;
                  if (p >= 0 && messages[p].role === 'assistant') isContinuation = true;
                }
                
                if (isContinuation) return null;

                const group = [msg];
                if (msg.role === 'assistant') {
                  let next = i + 1;
                  while (next < messages.length) {
                    if (isPureToolResult(messages[next]) || messages[next].role === 'assistant') {
                      group.push(messages[next]);
                      next++;
                    } else {
                      break;
                    }
                  }
                }

                return (
                <div
                  key={i}
                  ref={el => { messageRefs.current[i] = el; }}
                  className={`message-row ${msg.role} ${msg.starred ? 'starred' : ''} ${searchHits[searchHitIndex] === i ? 'search-current' : ''}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="message-avatar assistant-avatar">
                      <Sparkles size={16} />
                    </div>
                  )}
                  
                  <div className="message-content">
                    {msg.role === 'assistant' ? (
                      <>
                        {(() => {
                          const allBlocks = [];
                          group.forEach(gMsg => {
                            if (gMsg.role === 'user' && gMsg.content.trim().startsWith('<TOOL_RESULT>')) {
                              const match = gMsg.content.match(/<TOOL_RESULT>([\s\S]*?)<\/TOOL_RESULT>/i);
                              if (match) {
                                allBlocks.push({ type: 'tool_result', content: match[1] });
                              }
                            } else {
                              allBlocks.push(...parseAssistantMessage(gMsg.content));
                            }
                          });

                          const internalBlocks = allBlocks.filter(b => b.type !== 'text');
                          const textBlocks = allBlocks.filter(b => b.type === 'text');
                          const isFetching = group[group.length - 1].isMcpFetching;
                          const isThinkingOnly = group[group.length - 1].content === '' && !isFetching;
                          const isThinkingIncomplete = internalBlocks.some(b => b.type === 'think' && !b.isComplete);
                          const shouldOpenDropdown = isFetching || isThinkingOnly || isThinkingIncomplete;
                          // Auto-open while the model is still thinking, but an
                          // explicit click always wins from then on.
                          const thinkIsOpen = thinkOverrides[i] !== undefined ? thinkOverrides[i] : shouldOpenDropdown;
                          const isStreamingRow = isGenerating && i + group.length - 1 >= messages.length - 1;

                          return (
                            <>
                              {isStreamingRow && textBlocks.length === 0 && !isFetching && !isThinkingOnly && (
                                <div className="stream-dots" aria-label={t('msg.thinking')}>
                                  <span /><span /><span />
                                </div>
                              )}

                              {(internalBlocks.length > 0 || isFetching || isThinkingOnly) && (
                                <div className={`claude-think ${thinkIsOpen ? 'is-open' : ''}`}>
                                  <button
                                    type="button"
                                    className="think-summary"
                                    aria-expanded={thinkIsOpen}
                                    onClick={() => setThinkOverrides(prev => ({ ...prev, [i]: !thinkIsOpen }))}
                                  >
                                    <RefreshCcw size={14} className={shouldOpenDropdown ? 'spin' : ''} />
                                    <span>
                                      {isFetching ? t('msg.fetching') : (shouldOpenDropdown ? t('msg.thinking') : t('msg.thought'))}
                                    </span>
                                    <ChevronDown size={13} className="think-chevron" />
                                  </button>
                                  <Collapsible open={thinkIsOpen}>
                                  <div className="think-body">
                                    {internalBlocks.map((part, idx) => {
                                      if (part.type === 'think') {
                                        return (
                                          <ReactMarkdown 
                                            key={`think-${idx}`}
                                            remarkPlugins={[remarkGfm, remarkMath]} 
                                            rehypePlugins={markdownRehypePlugins}
                                          >
                                            {part.content}
                                          </ReactMarkdown>
                                        );
                                      } else if (part.type === 'tool_call') {
                                        const isSearch = part.tool === 'TOOL_WEB_SEARCH';
                                        const target = isSearch
                                          ? (part.content || part.query || '').trim()
                                          : (part.path || part.query || '');
                                        return (
                                          <div key={`tc-${idx}`} className="tool-block">
                                            <div className="tool-block-head">
                                              {isSearch ? <Search size={13} /> : <Terminal size={13} />}
                                              <span className="tool-block-verb">
                                                {part.tool === 'TOOL_READ_FILE' && t('tool.readFile')}
                                                {part.tool === 'TOOL_LIST_DIR' && t('tool.listDir')}
                                                {part.tool === 'TOOL_WRITE_FILE' && t('tool.writeFile')}
                                                {part.tool === 'TOOL_SEARCH_FILES' && t('tool.searchFiles')}
                                                {isSearch && t('tool.webSearch')}
                                                {part.tool === 'TOOL_FETCH_URL' && t('tool.fetchUrl')}
                                                {part.tool === 'TOOL_TIME' && t('tool.time')}
                                                {part.tool === 'TOOL_NEWS' && t('tool.news')}
                                                {part.tool === 'TOOL_LIST_MODELS' && t('tool.listModels')}
                                                {part.tool === 'TOOL_SYSTEM_INFO' && t('tool.systemInfo')}
                                              </span>
                                              <code className="tool-block-target">{target}</code>
                                            </div>
                                            {part.content && !isSearch && (
                                              <pre className="tool-block-body">{part.content}</pre>
                                            )}
                                          </div>
                                        );
                                      } else if (part.type === 'tool_result') {
                                        const search = parseSearchResults(part.content);
                                        const failed = /^SEARCH FAILED/.test((part.content || '').trim());

                                        if (search) {
                                          return (
                                            <div key={`tr-${idx}`} className="tool-block search-block">
                                              <div className="tool-block-head">
                                                <Search size={13} />
                                                <span className="tool-block-verb">{t('tool.results', { count: search.entries.length })}</span>
                                                {search.provider && <span className="tool-provider">{search.provider}</span>}
                                              </div>
                                              <ol className="search-results">
                                                {search.entries.map((entry, n) => (
                                                  <li key={n} className="search-result">
                                                    <a href={entry.url} target="_blank" rel="noreferrer noopener" className="search-result-title">
                                                      {entry.title}
                                                    </a>
                                                    <div className="search-result-host">
                                                      <ExternalLink size={10} /> {hostOf(entry.url)}
                                                    </div>
                                                    {entry.snippet && <p className="search-result-snippet">{entry.snippet}</p>}
                                                  </li>
                                                ))}
                                              </ol>
                                            </div>
                                          );
                                        }

                                        return (
                                          <div key={`tr-${idx}`} className={`tool-block ${failed ? 'is-failed' : ''}`}>
                                            <div className="tool-block-head">
                                              {failed ? <TriangleAlert size={13} /> : <Check size={13} />}
                                              <span className="tool-block-verb">
                                                {failed ? t('tool.failed') : t('tool.result')}
                                              </span>
                                            </div>
                                            <pre className="tool-block-body">{part.content}</pre>
                                          </div>
                                        );
                                      }
                                      return null;
                                    })}
                                  </div>
                                  </Collapsible>
                                </div>
                              )}
                              
                              {textBlocks.map((tb, idx) => (
                                <div
                                  key={`text-${idx}`}
                                  className={`markdown-body ${
                                    isStreamingRow && idx === textBlocks.length - 1 ? 'is-streaming' : ''
                                  }`}
                                >
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={
                                      isStreamingRow && idx === textBlocks.length - 1
                                        ? streamingRehypePlugins
                                        : markdownRehypePlugins
                                    }
                                    components={{
                                      code: (props) => <MarkdownCodeBlock {...props} onOpenArtifact={handleOpenArtifact} />
                                    }}
                                  >
                                    {tb.content}
                                  </ReactMarkdown>
                                </div>
                              ))}
                            </>
                          );
                        })()}

                        {variantCount(group[group.length - 1]) > 1 && (
                          <div className="variant-pager">
                            <button
                              className="variant-btn"
                              disabled={variantIndexOf(group[group.length - 1]) === 0}
                              onClick={() => showVariant(i, variantIndexOf(group[group.length - 1]) - 1)}
                              title={t('variants.previous')}
                            >
                              <ChevronLeft size={13} />
                            </button>
                            <span className="variant-count">
                              {variantIndexOf(group[group.length - 1]) + 1} / {variantCount(group[group.length - 1])}
                            </span>
                            <button
                              className="variant-btn"
                              disabled={variantIndexOf(group[group.length - 1]) === variantCount(group[group.length - 1]) - 1}
                              onClick={() => showVariant(i, variantIndexOf(group[group.length - 1]) + 1)}
                              title={t('variants.next')}
                            >
                              <ChevronRight size={13} />
                            </button>
                            {group[group.length - 1].model && (
                              <span className="variant-model" title={t('variants.model')}>{group[group.length - 1].model}</span>
                            )}
                            <button className="variant-btn" onClick={() => dropVariant(i)} title={t('variants.drop')}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}

                        {truncatedIndex === i && !isGenerating && (
                          <button className="continue-btn" onClick={() => continueResponse(i)}>
                            <CornerDownRight size={14} />
                            <span>{t('continue.action')}</span>
                            <span className="continue-hint">{t('continue.hint')}</span>
                          </button>
                        )}

                        {group[group.length - 1].metrics && (
                          <div className="claude-metrics">
                            <span>{group[group.length - 1].metrics.totalTime}s</span>
                            {group[group.length - 1].metrics.tokensPerSec && (
                              <>
                                <span className="dot">•</span>
                                <span>{group[group.length - 1].metrics.tokensPerSec} tokens/s</span>
                              </>
                            )}
                            {group[group.length - 1].metrics.promptTokens && (
                              <>
                                <span className="dot">•</span>
                                <span title={t('msg.promptTokens')}>
                                  {group[group.length - 1].metrics.promptTokens.toLocaleString()} + {(group[group.length - 1].metrics.evalCount || 0).toLocaleString()} tok
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      editingMessageIndex === i ? (
                        <div className="edit-message-box">
                          <textarea 
                            className="settings-textarea" 
                            value={editInput} 
                            onChange={e => setEditInput(e.target.value)} 
                            style={{minHeight: '100px'}}
                          />
                          <div className="edit-actions">
                            <button className="btn" onClick={cancelEdit} style={{padding: '0.4rem 0.8rem'}}>Cancel</button>
                            <button className="btn pull-btn" onClick={() => saveEdit(i)} style={{padding: '0.4rem 0.8rem'}}>{t('msg.saveSubmit')}</button>
                          </div>
                        </div>
                      ) : (
                        <div className="user-text">
                          {msg.images && (
                            <div className="user-attachments-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              {msg.images.map((img, idx) => (
                                <img key={idx} src={`data:image/jpeg;base64,${img}`} alt="Attached" style={{maxWidth: '200px', maxHeight: '150px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border-color)'}} />
                              ))}
                            </div>
                          )}
                          {parseMcpTools(msg.content).map((mcpPart, mcpIdx) => {
                            if (mcpPart.type === 'tool_result') return null; // Shouldn't be here anyway due to pure check above

                            const { attachments, cleanedContent } = extractAttachments(mcpPart.content);
                            
                            return (
                              <div key={mcpIdx} style={{whiteSpace: 'pre-wrap'}}>
                                {attachments.length > 0 && (
                                  <div className="user-attachments-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                    {attachments.map((att, aIdx) => (
                                      <div key={aIdx} className="user-attachment-card" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.4rem 0.6rem', borderRadius: '6px', fontSize: '0.8rem', border: '1px solid var(--border-color)' }}>
                                        <Paperclip size={14} />
                                        <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {highlightPlain(cleanedContent, chatSearchQuery)}
                              </div>
                            );
                          })}
                        </div>
                      )
                    )}
                  </div>
                  
                  {showTimestamps && group[group.length - 1].at && (
                    <div className="message-time">
                      {new Date(group[group.length - 1].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}

                  {/* Hover Actions */}
                  {editingMessageIndex !== i && (
                    <div className="msg-hover-actions">
                      {msg.role === 'user' ? (
                        <>
                          <button className="action-btn" onClick={() => startEdit(i, msg.content)} title={t('msg.edit')}>
                            <Edit size={14} />
                          </button>
                          <button className="action-btn" onClick={() => copyToClipboard(msg.content, i)} title={t('msg.copy')}>
                            {copiedIndex === i ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          <button className="action-btn" onClick={() => branchFromMessage(i)} title={t('msg.branch')}>
                            <GitBranch size={14} />
                          </button>
                          <button className="action-btn" onClick={() => toggleStar(i)} title={msg.starred ? 'Remove star' : 'Star this message'}>
                            <Star size={14} fill={msg.starred ? 'currentColor' : 'none'} color={msg.starred ? 'var(--primary)' : 'currentColor'} />
                          </button>
                          <button className="action-btn" onClick={() => deleteMessage(i)} title={t('msg.delete')} style={{ color: '#EF4444' }}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="action-btn"
                            onClick={() => speakMessage(group ? group.map(g => g.content).join('\n\n') : msg.content, i)}
                            title={speakingIndex === i ? t('msg.stopReading') : t('msg.readAloud')}
                          >
                            {speakingIndex === i && isSynthesizing
                              ? <RefreshCcw size={14} className="spin" color="var(--primary)" />
                              : <Volume2 size={14} color={speakingIndex === i ? 'var(--primary)' : 'currentColor'} />}
                          </button>
                          <button className="action-btn" onClick={() => copyToClipboard(group ? group.map(g => g.content).join('\n\n') : msg.content, i)} title={t('msg.copy')}>
                            {copiedIndex === i ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          <button className="action-btn" onClick={() => branchFromMessage(i)} title={t('msg.branch')}>
                            <GitBranch size={14} />
                          </button>
                          <button className="action-btn" onClick={() => toggleStar(i)} title={msg.starred ? 'Remove star' : 'Star this message'}>
                            <Star size={14} fill={msg.starred ? 'currentColor' : 'none'} color={msg.starred ? 'var(--primary)' : 'currentColor'} />
                          </button>
                          {i === messages.length - 1 && (
                            <>
                              <button className="action-btn" onClick={() => handleRetry()} title={t('msg.retry')}>
                                <RefreshCcw size={14} />
                              </button>
                              <span className="regen-wrap" ref={regenRef}>
                                <button className="action-btn" onClick={() => setRegenMenuOpen(v => !v)} title={t('msg.regenerateWith')}>
                                  <Cpu size={14} />
                                </button>
                                {regenMenuOpen && (
                                  <div className="regen-menu">
                                    {models.length === 0 && <div className="cmd-empty">{t('models.none')}</div>}
                                    {models.map(m => (
                                      <button
                                        key={m.name}
                                        className="cmd-item"
                                        onClick={() => handleRetry(m.name)}
                                      >
                                        <Cpu size={14} />
                                        <span className="cmd-label">{m.name}</span>
                                        {selectedModel === m.name && <Check size={13} />}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </span>
                            </>
                          )}
                          <button className="action-btn" onClick={() => deleteMessage(i)} title={t('msg.delete')} style={{ color: '#EF4444' }}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  )}

                </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div
          className="input-area-wrapper"
          onDragOver={e => { e.preventDefault(); if (!isDragging) setIsDragging(true); }}
          onDragLeave={e => { if (e.currentTarget === e.target) setIsDragging(false); }}
          onDrop={handleDrop}
        >
          {showScrollBtn && (
            <button className="scroll-bottom-btn" title={t('composer.jumpLatest')} onClick={scrollToBottom}>
              <ArrowDown size={16} />
            </button>
          )}

          <form className="input-container" style={{ flexDirection: 'column' }} onSubmit={e => { e.preventDefault(); if(input.trim() || attachments.length > 0) handleSend(e); }}>

            {isDragging && (
              <div className="dropzone-overlay">{t('composer.dropFiles')}</div>
            )}

            <Transition open={slashMatches.length > 0} duration={150} className="slash-menu">
              <>
                {slashMatches.map((cmd, idx) => (
                  <button
                    type="button"
                    key={cmd.name + idx}
                    className={`slash-item ${idx === Math.min(slashIndex, slashMatches.length - 1) ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(idx)}
                    onClick={() => applySlashCommand(cmd)}
                  >
                    <span className="slash-name">{cmd.name}</span>
                    <span className="slash-desc">{cmd.desc}</span>
                  </button>
                ))}
              </>
            </Transition>

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div className="attachments-preview">
                {attachments.map((att, i) => (
                  <div key={i} className="attachment-item">
                    {att.type === 'image' ? (
                      <img src={att.preview} alt={att.name} />
                    ) : (
                      <div className="attachment-doc"><Terminal size={14} /> {att.name}</div>
                    )}
                    <button type="button" className="attachment-remove" onClick={() => removeAttachment(i)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', width: '100%', alignItems: 'flex-end', gap: '0.5rem' }}>
              <input 
                type="file" 
                multiple 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                style={{ display: 'none' }} 
                accept="image/*,.txt,.md,.csv,.json"
              />
              <button type="button" className="attach-btn" title={t('composer.attach')} onClick={() => fileInputRef.current?.click()}>
                <Paperclip size={20} />
              </button>
              
              <button type="button" className="attach-btn" title={t('composer.voice')} onClick={toggleListening} style={{ color: isListening ? '#EF4444' : 'var(--text-muted)' }}>
                {isListening ? <Mic size={20} /> : <MicOff size={20} />}
              </button>
              
              <textarea
                ref={textareaRef}
                className="chat-input"
                placeholder={t('composer.placeholder', { model: selectedModel || 'Ollama' })}
                value={input}
                onChange={handleInputResize}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows="1"
              />
              
              {isGenerating ? (
                <button type="button" className="send-btn active" onClick={stopGeneration} title={t('composer.stop')}>
                  <Square size={14} fill="currentColor" stroke="none" />
                </button>
              ) : (
                <button 
                  type="submit"
                  className={`send-btn ${(input.trim() || attachments.length > 0) ? 'active' : ''}`}
                  disabled={(!input.trim() && attachments.length === 0) || !selectedModel}
                >
                  <ArrowUp size={18} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </form>

          <div className="input-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 1rem' }}>
            <span>{t('composer.disclaimer', { slash: '/' })}</span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            {/* Context usage estimate */}
            <div className="ctx-meter" title={tokensAreMeasured ? t('composer.tokensMeasured') : t('composer.tokensEstimated')}>
              <span>
                {tokensAreMeasured ? '' : '~'}
                {usedTokens.toLocaleString()} / {numCtx.toLocaleString()} tok
              </span>
              <div className="ctx-meter-bar">
                <div
                  className={`ctx-meter-fill ${ctxPercent >= 100 ? 'over' : ctxPercent >= 80 ? 'warn' : ''}`}
                  style={{ width: `${ctxPercent}%` }}
                />
              </div>
              {autoCompact && ctxPercent >= 75 && messages.length > 8 && (
                <button
                  type="button"
                  className="ctx-compact-btn"
                  onClick={compactConversation}
                  disabled={compacting}
                  title={t('compact.help')}
                >
                  {compacting ? <RefreshCcw size={11} className="spin" /> : <Layers size={11} />}
                  {t('compact.action')}
                </button>
              )}
            </div>

            {/* MCP Toggle */}
            <div className="mcp-toggle-container" title={t('composer.mcpTitle')}>
              <div className="mcp-toggle-label">
                <Terminal size={14} color={mcpEnabled ? 'var(--primary)' : 'var(--text-muted)'} />
                <span style={{ color: mcpEnabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>{t('composer.webFetch')}</span>
                <Switch checked={mcpEnabled} onChange={setMcpEnabled} label={t('composer.webFetch')} />
              </div>
            </div>
            </div>
          </div>
        </div>

        {/* Settings Overlay */}
        <Transition open={showSettings} duration={200} className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h2 style={{ marginBottom: 0 }}>{t('settings.title')}</h2>
                <button className="icon-btn" onClick={() => setShowSettings(false)} title={`${t('common.close')} (Esc)`}><X size={18} /></button>
              </div>

              <div className="settings-tabs">
                {[
                  { id: 'general', label: t('settings.general') },
                  { id: 'generation', label: t('settings.generation') },
                  { id: 'models', label: t('settings.models') },
                  { id: 'prompts', label: t('settings.prompts') },
                  { id: 'knowledge', label: t('settings.knowledge') },
                  { id: 'memory', label: t('settings.memory') },
                  { id: 'voice', label: t('settings.voice') },
                  { id: 'account', label: t('settings.account') },
                  { id: 'data', label: t('settings.data') },
                ].map(tab => (
                  <button
                    key={tab.id}
                    className={`settings-tab ${settingsTab === tab.id ? 'active' : ''}`}
                    onClick={() => setSettingsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {settingsTab === 'general' && (
                <>
                  <div className="settings-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <Languages size={14} /> {t('settings.language')}
                    </label>
                    <select className="settings-input" value={lang} onChange={e => setLang(e.target.value)}>
                      {LANGUAGES.map(l => (
                        <option key={l.code} value={l.code}>
                          {l.native}{l.native === l.english ? '' : ` — ${l.english}`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.appearance')}</label>
                    <div className="theme-switch">
                      <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}><Sun size={14} /> {t('settings.light')}</button>
                      <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}><Moon size={14} /> {t('settings.dark')}</button>
                      <button className={theme === 'system' ? 'active' : ''} onClick={() => setTheme('system')}><Monitor size={14} /> {t('settings.system')}</button>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.textSize')}</label>
                    <div className="theme-switch">
                      <button className={chatFontSize === 'small' ? 'active' : ''} onClick={() => setChatFontSize('small')}>{t('settings.small')}</button>
                      <button className={chatFontSize === 'medium' ? 'active' : ''} onClick={() => setChatFontSize('medium')}>{t('settings.medium')}</button>
                      <button className={chatFontSize === 'large' ? 'active' : ''} onClick={() => setChatFontSize('large')}>{t('settings.large')}</button>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.density')}</label>
                    <div className="theme-switch">
                      <button className={chatDensity === 'comfortable' ? 'active' : ''} onClick={() => setChatDensity('comfortable')}>{t('settings.comfortable')}</button>
                      <button className={chatDensity === 'compact' ? 'active' : ''} onClick={() => setChatDensity('compact')}>{t('settings.compact')}</button>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.animations')}</label>
                    <div className="theme-switch">
                      <button className={motionMode === 'system' ? 'active' : ''} onClick={() => setMotionMode('system')}>{t('settings.system')}</button>
                      <button className={motionMode === 'full' ? 'active' : ''} onClick={() => setMotionMode('full')}>{t('settings.motionFull')}</button>
                      <button className={motionMode === 'reduced' ? 'active' : ''} onClick={() => setMotionMode('reduced')}>{t('settings.motionReduced')}</button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('settings.motionHelp')}
                    </div>
                    {osReducedMotion && motionMode !== 'full' && (
                      <div className="setup-why" style={{ marginTop: '0.5rem' }}>
                        {t('settings.motionOsNotice')}
                        <button
                          className="icon-btn bordered"
                          style={{ marginTop: '0.5rem' }}
                          onClick={() => setMotionMode('full')}
                        >
                          <Zap size={13} /> {t('settings.motionEnableFull')}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.layout')}</label>
                    <button
                      className="btn"
                      style={{ padding: '0.45rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-main)', color: 'var(--text-primary)', cursor: 'pointer' }}
                      onClick={() => {
                        setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
                        setArtifactWidth(DEFAULT_ARTIFACT_WIDTH);
                        setConsoleDockHeight(DEFAULT_CONSOLE_HEIGHT);
                        setArtifactMaximized(false);
                        toast('Panel sizes reset.', 'success', 2000);
                      }}
                    >
                      <PanelLeft size={14} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> {t('settings.resetPanels')}
                    </button>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('settings.layoutHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('behaviour.defaultModel')}</label>
                    <select className="settings-input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)}>
                      <option value="">{t('behaviour.defaultModelLast')}</option>
                      {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                    </select>
                  </div>

                  <div className="settings-group">
                    <label>{t('behaviour.sendKey')}</label>
                    <div className="theme-switch">
                      <button className={sendKey === 'enter' ? 'active' : ''} onClick={() => setSendKey('enter')}>Enter</button>
                      <button className={sendKey === 'ctrlEnter' ? 'active' : ''} onClick={() => setSendKey('ctrlEnter')}>Ctrl + Enter</button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('behaviour.sendKeyHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <SettingToggle
                      checked={autoTitle}
                      onChange={setAutoTitle}
                      label={t('behaviour.autoTitle')}
                      description={t('behaviour.autoTitleHelp')}
                    />

                    <SettingToggle
                      checked={showTimestamps}
                      onChange={setShowTimestamps}
                      label={t('behaviour.timestamps')}
                      description={t('behaviour.timestampsHelp')}
                    />

                    <SettingToggle
                      checked={showSystemStrip}
                      onChange={setShowSystemStrip}
                      label={t('behaviour.systemStrip')}
                      description={t('behaviour.systemStripHelp')}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.systemPrompt')}</label>
                    <textarea
                      className="settings-textarea"
                      value={systemPrompt}
                      onChange={e => setSystemPrompt(e.target.value)}
                      placeholder={t('settings.systemPrompt')}
                    />
                    <div className="preset-buttons" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                      <button className="btn" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setSystemPrompt("You are Claude, a helpful, honest, and harmless AI assistant.")}>{t('preset.default')}</button>
                      <button className="btn" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setSystemPrompt("You are an expert software engineer. Provide clean, efficient, and well-documented code.")}>{t('preset.coder')}</button>
                      <button className="btn" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setSystemPrompt("You are a creative writer. Help me brainstorm ideas and write engaging stories.")}>{t('preset.writer')}</button>
                      <button className="btn" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setSystemPrompt("You are a language tutor. Correct my grammar and explain natural phrasing.")}>{t('preset.tutor')}</button>
                      <button className="btn" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }} onClick={() => setSystemPrompt("답변은 항상 한글로 작성해 줘. 친절하고 존댓말로 대답해 줘.")}>{t('preset.korean')}</button>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.codeTheme')}</label>
                    <select className="settings-input" value={codeTheme} onChange={e => setCodeTheme(e.target.value)}>
                      <option value="atom-one-dark">Atom One Dark</option>
                      <option value="github-dark">GitHub Dark</option>
                      <option value="dracula">Dracula</option>
                      <option value="night-owl">Night Owl</option>
                      <option value="monokai">Monokai</option>
                      <option value="vs2015">VS 2015</option>
                      <option value="github">GitHub Light</option>
                    </select>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.shortcuts')}</label>
                    <button
                      className="btn"
                      style={{ padding: '0.45rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-main)', color: 'var(--text-primary)', cursor: 'pointer' }}
                      onClick={() => { setShowSettings(false); setShowShortcuts(true); }}
                    >
                      <Command size={14} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> {t('settings.viewShortcuts')}
                    </button>
                  </div>
                </>
              )}

              {settingsTab === 'generation' && (
                <>
                  <div className="settings-group">
                    <label>{t('presets.title')}</label>
                    <div className="preset-chips">
                      {BUILTIN_PRESETS.map(preset => (
                        <button
                          key={preset.id}
                          className={`preset-chip ${activePreset?.id === preset.id ? 'active' : ''}`}
                          onClick={() => applyPreset(preset)}
                        >
                          <SlidersHorizontal size={12} />
                          {t(preset.nameKey)}
                        </button>
                      ))}
                      {presets.map(preset => (
                        <span key={preset.id} className={`preset-chip saved ${activePreset?.id === preset.id ? 'active' : ''}`}>
                          <button className="preset-chip-main" onClick={() => applyPreset(preset)}>
                            <Save size={12} />
                            {preset.name}
                          </button>
                          <button className="preset-chip-del" title={t('common.delete')} onClick={() => deletePreset(preset.id)}>
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>

                    <div className="settings-row" style={{ marginTop: '0.55rem' }}>
                      <input
                        type="text"
                        className="settings-input"
                        style={{ flex: 3 }}
                        value={newPresetName}
                        maxLength={40}
                        placeholder={t('presets.namePlaceholder')}
                        onChange={e => setNewPresetName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); savePresetFromCurrent(); } }}
                      />
                      <button
                        className="icon-btn bordered"
                        style={{ flex: 1 }}
                        disabled={!newPresetName.trim()}
                        onClick={savePresetFromCurrent}
                      >
                        <Save size={13} /> {t('presets.save')}
                      </button>
                    </div>
                    <div className="setting-help">{t('presets.help')}</div>
                  </div>

                  <div className="settings-group">
                    <SettingToggle
                      checked={autoContinue}
                      onChange={setAutoContinue}
                      label={t('continue.auto')}
                      description={t('continue.autoHelp')}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('gen.thinking')}</label>
                    <div className="theme-switch">
                      <button className={thinkMode === 'auto' ? 'active' : ''} onClick={() => setThinkMode('auto')}>{t('common.auto')}</button>
                      <button className={thinkMode === 'on' ? 'active' : ''} onClick={() => setThinkMode('on')}>{t('common.on')}</button>
                      <button className={thinkMode === 'off' ? 'active' : ''} onClick={() => setThinkMode('off')}>{t('common.off')}</button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
{t('gen.thinkingHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('gen.temperature')}: {temperature}</label>
                    <input
                      type="range"
                      min="0" max="2" step="0.1"
                      value={temperature}
                      onChange={e => setTemperature(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <span>{t('gen.precise')}</span><span>{t('gen.creative')}</span>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>Top P: {topP}</label>
                    <input
                      type="range"
                      min="0" max="1" step="0.05"
                      value={topP}
                      onChange={e => setTopP(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div className="settings-group">
                    <label>Repeat Penalty: {repeatPenalty}</label>
                    <input
                      type="range"
                      min="0.8" max="2" step="0.05"
                      value={repeatPenalty}
                      onChange={e => setRepeatPenalty(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div className="settings-group">
                    <div className="settings-row">
                      <div>
                        <label>{t('gen.maxTokens')}</label>
                        <input
                          type="number"
                          className="settings-input"
                          value={maxTokens}
                          onChange={e => setMaxTokens(parseInt(e.target.value) || 4096)}
                        />
                      </div>
                      <div>
                        <label>{t('gen.contextSize')}</label>
                        <input
                          type="number"
                          className="settings-input"
                          value={numCtx}
                          onChange={e => setNumCtx(parseInt(e.target.value) || 4096)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="settings-group">
                    <div className="settings-row">
                      <div>
                        <label>Top K</label>
                        <input
                          type="number"
                          className="settings-input"
                          value={topK}
                          onChange={e => setTopK(parseInt(e.target.value) || 0)}
                        />
                      </div>
                      <div>
                        <label>{t('gen.seed')}</label>
                        <input
                          type="number"
                          className="settings-input"
                          value={seed}
                          placeholder={t('gen.seedRandom')}
                          onChange={e => setSeed(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('gen.minP')}: {minP}</label>
                    <input
                      type="range"
                      min="0" max="0.5" step="0.01"
                      value={minP}
                      onChange={e => setMinP(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('gen.minPHelp')}</div>
                  </div>

                  <div className="settings-group">
                    <div className="settings-row">
                      <div>
                        <label>{t('gen.presencePenalty')}: {presencePenalty}</label>
                        <input
                          type="range"
                          min="-2" max="2" step="0.1"
                          value={presencePenalty}
                          onChange={e => setPresencePenalty(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: 'var(--accent)' }}
                        />
                      </div>
                      <div>
                        <label>{t('gen.frequencyPenalty')}: {frequencyPenalty}</label>
                        <input
                          type="range"
                          min="-2" max="2" step="0.1"
                          value={frequencyPenalty}
                          onChange={e => setFrequencyPenalty(parseFloat(e.target.value))}
                          style={{ width: '100%', accentColor: 'var(--accent)' }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('format.title')}</label>
                    <div className="theme-switch">
                      <button className={outputFormat === 'text' ? 'active' : ''} onClick={() => setOutputFormat('text')}>{t('format.text')}</button>
                      <button className={outputFormat === 'json' ? 'active' : ''} onClick={() => setOutputFormat('json')}>JSON</button>
                      <button className={outputFormat === 'schema' ? 'active' : ''} onClick={() => setOutputFormat('schema')}>{t('format.schema')}</button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('format.help')}
                    </div>

                    {outputFormat === 'schema' && (
                      <>
                        <textarea
                          className="settings-textarea"
                          value={outputSchema}
                          onChange={e => setOutputSchema(e.target.value)}
                          placeholder={'{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" }\n  },\n  "required": ["name"]\n}'}
                          spellCheck={false}
                          style={{ marginTop: '0.5rem', minHeight: '130px', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}
                        />
                        {schemaError && (
                          <div className="auth-error" style={{ marginTop: '0.4rem' }}>
                            <TriangleAlert size={14} /> <span>{t('format.schemaInvalid', { error: schemaError })}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="settings-group">
                    <label>{t('tools.budget')}: {toolBudget}</label>
                    <input
                      type="range"
                      min="1" max="10" step="1"
                      value={toolBudget}
                      onChange={e => setToolBudget(parseInt(e.target.value) || 1)}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('tools.budgetHelp')}</div>
                  </div>

                  <div className="settings-group">
                    <SettingToggle
                      checked={autoGround}
                      onChange={setAutoGround}
                      label={t('tools.autoGround')}
                      description={t('tools.autoGroundHelp')}
                    />
                    <SettingToggle
                      checked={autoCompact}
                      onChange={setAutoCompact}
                      label={t('compact.action')}
                      description={t('compact.help')}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('gen.keepAlive')}</label>
                    <select className="settings-input" value={keepAlive} onChange={e => setKeepAlive(e.target.value)}>
                      <option value="0">{t('gen.keepAliveNone')}</option>
                      <option value="5m">5m</option>
                      <option value="30m">30m</option>
                      <option value="1h">1h</option>
                      <option value="-1">{t('gen.keepAliveForever')}</option>
                    </select>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('gen.keepAliveHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('gen.stopSequences')}</label>
                    <textarea
                      className="settings-textarea"
                      value={stopSequences}
                      onChange={e => setStopSequences(e.target.value)}
                      placeholder={"</s>\nUser:"}
                      style={{ minHeight: '70px' }}
                    />
                  </div>

                  <div className="settings-group">
                    <button
                      className="btn"
                      style={{ padding: '0.45rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-main)', color: 'var(--text-primary)', cursor: 'pointer' }}
                      onClick={() => {
                        setTemperature(0.7); setMaxTokens(4096); setTopP(0.9); setTopK(40);
                        setRepeatPenalty(1.1); setNumCtx(4096); setSeed(''); setStopSequences('');
                        setThinkMode('auto'); setMinP(0); setPresencePenalty(0);
                        setFrequencyPenalty(0); setKeepAlive('5m');
                        setToolBudget(5); setAutoGround(true);
                        setOutputFormat('text'); setOutputSchema('');
                      }}
                    >
                      {t('gen.resetDefaults')}
                    </button>
                  </div>
                </>
              )}

              {settingsTab === 'models' && (
                <>
                  <div className="settings-group">
                    <label>{t('models.pull')}</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="text"
                        className="settings-input"
                        value={downloadModelName}
                        onChange={e => setDownloadModelName(e.target.value)}
                        placeholder="e.g. llama3, mistral, gemma3:4b"
                        onKeyDown={e => e.key === 'Enter' && handleDownload()}
                      />
                      <button className="pull-btn" onClick={handleDownload} disabled={isDownloading || !downloadModelName.trim()}>
                        {isDownloading ? <RefreshCcw className="spin" size={16} /> : <Download size={16} />}
                      </button>
                    </div>
                    {pullProgress && (
                      <div className="pull-progress">
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{pullProgress.status}</span>
                          <span>
                            {pullProgress.percent !== null && pullProgress.percent !== undefined ? `${pullProgress.percent}%` : ''}
                            {pullProgress.total ? ` (${formatBytes(pullProgress.completed || 0)} / ${formatBytes(pullProgress.total)})` : ''}
                          </span>
                        </div>
                        <div className="pull-progress-bar">
                          <div className="pull-progress-fill" style={{ width: `${pullProgress.percent || 0}%` }} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="settings-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <Zap size={13} /> {t('models.loaded')} ({runningModels.length})
                    </label>
                    {runningModels.length === 0 && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('models.noneLoaded')}</div>
                    )}
                    {runningModels.map(m => (
                      <div className="manager-row" key={`ps-${m.name}`}>
                        <Server size={14} color="var(--success)" />
                        <span className="manager-name">{m.name}</span>
                        <span className="manager-meta">{formatBytes(m.size_vram || m.size)}</span>
                        <button className="icon-btn bordered" title={t('models.unload')} onClick={() => unloadModel(m.name)}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="settings-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'space-between' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><Cpu size={13} /> {t('models.installed')} ({models.length})</span>
                      <button className="icon-btn" title={t('models.refresh')} onClick={() => { fetchModels(); fetchRunningModels(); }}><RefreshCcw size={13} /></button>
                    </label>
                    {models.map(m => (
                      <div className="manager-row" key={`inst-${m.name}`}>
                        <Cpu size={14} color={selectedModel === m.name ? 'var(--primary)' : 'var(--text-muted)'} />
                        <span className="manager-name">{m.name}</span>
                        <span className="manager-meta">
                          {formatBytes(m.size)}
                          {m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ''}
                          {m.details?.quantization_level ? ` · ${m.details.quantization_level}` : ''}
                        </span>
                        <button className="icon-btn bordered" title={t('models.use')} onClick={() => setSelectedModel(m.name)}>
                          <Check size={14} />
                        </button>
                        <button className="icon-btn bordered" title={t('models.deleteOne')} onClick={() => deleteModel(m.name)} style={{ color: 'var(--danger)' }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {settingsTab === 'prompts' && (
                <>
                  <div className="settings-group">
                    <label>{t('prompts.saved')} ({promptLibrary.length})</label>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
{t('prompts.hint', { slash: '/' })}
                    </div>
                    {promptLibrary.length === 0 && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('prompts.empty')}</div>
                    )}
                    {promptLibrary.map(p => (
                      <div className="prompt-lib-item" key={p.id}>
                        <span className="prompt-lib-name">{p.name}</span>
                        <span className="prompt-lib-body">{p.body}</span>
                        <button className="icon-btn bordered" title={t('prompts.insert')} onClick={() => insertPrompt(p.body)}>
                          <ArrowUp size={14} />
                        </button>
                        <button className="icon-btn bordered" title={t('prompts.deleteOne')} onClick={() => deletePrompt(p.id)} style={{ color: 'var(--danger)' }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="settings-group">
                    <label>{t('prompts.add')}</label>
                    <input
                      type="text"
                      className="settings-input"
                      value={newPromptName}
                      onChange={e => setNewPromptName(e.target.value)}
                      placeholder={t('prompts.name')}
                      style={{ marginBottom: '0.5rem' }}
                    />
                    <textarea
                      className="settings-textarea"
                      value={newPromptBody}
                      onChange={e => setNewPromptBody(e.target.value)}
                      placeholder={t('prompts.body')}
                      style={{ minHeight: '90px' }}
                    />
                    <button
                      className="pull-btn"
                      style={{ marginTop: '0.5rem' }}
                      onClick={savePrompt}
                      disabled={!newPromptName.trim() || !newPromptBody.trim()}
                    >
                      <Save size={14} style={{ marginRight: '0.35rem' }} /> {t('prompts.save')}
                    </button>
                  </div>
                </>
              )}

              {settingsTab === 'knowledge' && (
                <>
                  <div className="settings-group">
                    <SettingToggle
                      checked={ragEnabled}
                      onChange={setRagEnabled}
                      label={t('rag.enabled')}
                      description={t('rag.enabledHelp')}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('rag.topK')}: {ragTopK}</label>
                    <input
                      type="range"
                      min="1" max="12" step="1"
                      value={ragTopK}
                      onChange={e => setRagTopK(parseInt(e.target.value) || 5)}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('rag.topKHelp')}</div>
                  </div>

                  <KnowledgePanel
                    userId={currentUser?.id}
                    models={models}
                    embedModel={embedModel}
                    onEmbedModelChange={setEmbedModel}
                    onLibraryChange={setKnowledge}
                  />
                </>
              )}

              {settingsTab === 'memory' && (
                <>
                  <div className="settings-group">
                    <SettingToggle
                      checked={memoryEnabled}
                      onChange={setMemoryEnabled}
                      label={t('memory.enabled')}
                      description={t('memory.enabledHelp')}
                    />
                    <SettingToggle
                      checked={autoRemember}
                      onChange={setAutoRemember}
                      label={t('memory.auto')}
                      description={t('memory.autoHelp')}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('memory.stored')} ({memories.length})</label>

                    <button
                      className="icon-btn bordered"
                      onClick={rememberFromChat}
                      disabled={extractingMemory || messages.length < 2}
                    >
                      {extractingMemory ? <RefreshCcw size={14} className="spin" /> : <Sparkles size={14} />}
                      {t('memory.extract')}
                    </button>

                    <div className="rag-list">
                      {memories.length === 0 && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('memory.empty')}</div>
                      )}
                      {memories.map(m => (
                        <div className={`rag-item ${m.enabled === false ? 'is-off' : ''}`} key={m.id}>
                          <span className="memory-kind">{m.kind}</span>
                          <div className="rag-item-meta">
                            <div className="memory-text">{m.text}</div>
                          </div>
                          <button
                            className={`icon-btn ${m.enabled === false ? '' : 'toggled'}`}
                            title={m.enabled === false ? t('rag.enable') : t('rag.disable')}
                            onClick={() => toggleMemory(m.id)}
                          >
                            <Check size={14} />
                          </button>
                          <button className="icon-btn" style={{ color: 'var(--danger)' }} onClick={() => deleteMemory(m.id)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('memory.add')}</label>
                    <div className="settings-row" style={{ alignItems: 'flex-start' }}>
                      <input
                        type="text"
                        className="settings-input"
                        value={newMemoryText}
                        onChange={e => setNewMemoryText(e.target.value)}
                        placeholder={t('memory.addPlaceholder')}
                        style={{ flex: 3 }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newMemoryText.trim()) {
                            addManualMemory(newMemoryText, newMemoryKind);
                            setNewMemoryText('');
                          }
                        }}
                      />
                      <select
                        className="settings-input"
                        value={newMemoryKind}
                        onChange={e => setNewMemoryKind(e.target.value)}
                        style={{ flex: 1 }}
                      >
                        {MEMORY_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </div>
                    <button
                      className="pull-btn"
                      style={{ marginTop: '0.5rem' }}
                      disabled={!newMemoryText.trim()}
                      onClick={() => { addManualMemory(newMemoryText, newMemoryKind); setNewMemoryText(''); }}
                    >
                      <Save size={14} style={{ marginRight: '0.35rem' }} /> {t('common.save')}
                    </button>
                  </div>

                  <div className="settings-group">
                    <div className="auth-note" style={{ margin: 0 }}>{t('memory.privacy')}</div>
                  </div>
                </>
              )}

              {settingsTab === 'voice' && (
                <>
                  <div className="settings-group">
                    <label>{t('voice.engine')}</label>
                    <div className="theme-switch">
                      <button className={ttsEngine === 'gpt-sovits' ? 'active' : ''} onClick={() => setTtsEngine('gpt-sovits')}>
                        <Volume2 size={14} /> GPT-SoVITS
                      </button>
                      <button className={ttsEngine === 'browser' ? 'active' : ''} onClick={() => setTtsEngine('browser')}>
                        <Mic size={14} /> {t('voice.browser')}
                      </button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('voice.stripNote')}
                    </div>
                  </div>

                  {ttsEngine === 'gpt-sovits' && (
                    <>
                      <div className="settings-group">
                        <label>{t('voice.refAudio')}</label>
                        <input
                          type="text"
                          className="settings-input"
                          value={ttsRefAudio}
                          onChange={e => setTtsRefAudio(e.target.value)}
                          placeholder="C:\\...\\sample.wav"
                          spellCheck={false}
                        />
                      </div>

                      <div className="settings-group">
                        <label>{t('voice.refText')}</label>
                        <input
                          type="text"
                          className="settings-input"
                          value={ttsPromptText}
                          onChange={e => setTtsPromptText(e.target.value)}
                          placeholder={t('voice.refTextPlaceholder')}
                        />
                      </div>

                      <div className="settings-group">
                        <div className="settings-row">
                          <div>
                            <label>{t('voice.outLang')}</label>
                            <select className="settings-input" value={ttsTextLang} onChange={e => setTtsTextLang(e.target.value)}>
                              <option value="ko">{t('lang.ko')}</option>
                              <option value="ja">{t('lang.ja')}</option>
                              <option value="en">{t('lang.en')}</option>
                              <option value="zh">{t('lang.zh')}</option>
                              <option value="auto">{t('common.auto')}</option>
                            </select>
                          </div>
                          <div>
                            <label>{t('voice.refLang')}</label>
                            <select className="settings-input" value={ttsPromptLang} onChange={e => setTtsPromptLang(e.target.value)}>
                              <option value="ko">{t('lang.ko')}</option>
                              <option value="ja">{t('lang.ja')}</option>
                              <option value="en">{t('lang.en')}</option>
                              <option value="zh">{t('lang.zh')}</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  <div className="settings-group">
                    <label>{t('voice.speed')}: {ttsSpeed.toFixed(2)}x</label>
                    <input
                      type="range"
                      min="0.5" max="2" step="0.05"
                      value={ttsSpeed}
                      onChange={e => setTtsSpeed(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div className="settings-group">
                    <label>{t('voice.maxChars')} ({ttsMaxChars})</label>
                    <input
                      type="range"
                      min="100" max="3000" step="50"
                      value={ttsMaxChars}
                      onChange={e => setTtsMaxChars(parseInt(e.target.value) || 600)}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {t('voice.maxCharsHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <SettingToggle
                      checked={ttsAutoPlay}
                      onChange={setTtsAutoPlay}
                      label={t('voice.autoPlay')}
                      description={t('voice.autoPlayHelp')}
                    />
                  </div>

                  <div className="settings-group">
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="pull-btn"
                        onClick={() => speakMessage('안녕하세요. 음성 설정 테스트입니다. This is a voice test.', -1)}
                        disabled={speakingIndex !== null}
                      >
                        <Play size={14} style={{ marginRight: '0.35rem' }} /> {t('voice.test')}
                      </button>
                      <button
                        className="btn"
                        style={{ padding: '0.45rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-main)', color: 'var(--text-primary)', cursor: 'pointer' }}
                        onClick={stopSpeaking}
                      >
                        <Square size={13} style={{ marginRight: '0.35rem' }} /> {t('voice.stop')}
                      </button>
                      <button
                        className="btn"
                        style={{ padding: '0.45rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-main)', color: 'var(--text-primary)', cursor: 'pointer' }}
                        onClick={() => {
                          fetch('/api/start-tts').catch(() => {});
                          toast('Asked the dev server to launch GPT-SoVITS.', 'info');
                        }}
                      >
                        {t('voice.startServer')}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {settingsTab === 'account' && (
                <>
                  <div className="settings-group">
                    <label>{t('auth.profile')}</label>
                    {currentUser ? (
                      <div className="account-card">
                        <ProfileAvatar user={currentUser} size={42} />
                        <div className="account-meta">
                          <div className="account-name">{currentUser.name}</div>
                          {currentUser.email && <div className="account-email">{currentUser.email}</div>}
                          <div className="account-provider">{currentUser.provider}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="account-card">
                        <div className="account-avatar">{t('sidebar.guest').charAt(0)}</div>
                        <div className="account-meta">
                          <div className="account-name">{t('sidebar.guest')}</div>
                          <div className="account-email">{t('auth.subtitle')}</div>
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                      {currentUser && (
                        <button className="icon-btn bordered" onClick={() => { setShowSettings(false); setShowProfileDialog(true); }}>
                          <User size={14} /> {t('profile.title')}
                        </button>
                      )}
                      <button className="icon-btn bordered" onClick={() => { setShowSettings(false); setShowAuthScreen(true); }}>
                        <UserPlus size={14} /> {currentUser ? t('auth.switchAccount') : t('auth.signIn')}
                      </button>
                      {currentUser && (
                        <>
                          <button className="icon-btn bordered" onClick={() => { setShowSettings(false); handleSignOut(); }}>
                            <LogOut size={14} /> {t('auth.signOut')}
                          </button>
                          <button className="icon-btn bordered" style={{ color: 'var(--danger)' }} onClick={handleDeleteProfile}>
                            <Trash2 size={14} /> {t('auth.deleteAccount')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('auth.socialSetup')}</label>
                    <div className="setup-why">{t('auth.whySetup')}</div>

                    <ol className="setup-steps">
                      <li>
                        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console → Credentials</a>
                        {' → OAuth client ID → Web application'}
                      </li>
                      <li>
                        <a href="https://developers.kakao.com/console/app" target="_blank" rel="noreferrer">Kakao Developers → 내 애플리케이션</a>
                        {' → 앱 키 → REST API 키 · 카카오 로그인 → Redirect URI'}
                      </li>
                      <li className="setup-origin">
                        <span>{t('auth.copyOrigin')}:</span>
                        <code>{registerableOrigin}</code>
                        <button
                          className="icon-btn bordered"
                          onClick={() => { copyToClipboard(registerableOrigin); toast(t('common.copied'), 'success', 1500); }}
                        >
                          <Copy size={13} />
                        </button>
                      </li>
                      <li>
                        <code>.env</code>: <code>VITE_GOOGLE_CLIENT_ID</code> / <code>VITE_KAKAO_REST_KEY</code>
                      </li>
                    </ol>

                    <div className="setup-why">{t('auth.kakaoNote')}</div>
                    <div className="setup-why">{t('auth.kakaoChecklist')}</div>

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                      {t('auth.socialHelp')}
                    </div>
                    <label style={{ fontSize: '0.78rem' }}>{t('auth.googleClientId')}</label>
                    <input
                      type="text"
                      className="settings-input"
                      value={googleClientId}
                      onChange={e => setGoogleClientId(e.target.value.trim())}
                      placeholder="123456789-abc.apps.googleusercontent.com"
                      spellCheck={false}
                      style={{ marginBottom: '0.6rem' }}
                    />
                    <label style={{ fontSize: '0.78rem' }}>{t('auth.kakaoRestKey')}</label>
                    <input
                      type="text"
                      className="settings-input"
                      value={kakaoRestKey}
                      onChange={e => setKakaoRestKey(e.target.value.trim())}
                      placeholder="0123456789abcdef0123456789abcdef"
                      spellCheck={false}
                    />
                    <div className="setup-origin" style={{ marginTop: '0.4rem' }}>
                      <span>{t('auth.kakaoRedirect')}:</span>
                      <code>{kakaoRedirectUri()}</code>
                      <button
                        className="icon-btn bordered"
                        onClick={() => { copyToClipboard(kakaoRedirectUri()); toast(t('common.copied'), 'success', 1500); }}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                      {socialDefaults().googleClientId || socialDefaults().kakaoRestKey
                        ? 'Values from .env are used unless overridden above.'
                        : 'Leave blank to use .env values instead.'}
                    </div>
                  </div>

                  <div className="settings-group">
                    <div className="auth-note" style={{ margin: 0 }}>{t('auth.localNote')}</div>
                  </div>
                  <div className="settings-group">
                    <label>{t('sync.title')}</label>
                    <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('sync.help')}</div>

                    {!serverConfig && (
                      <div className="auth-note" style={{ margin: 0 }}>{t('sync.noServer')}</div>
                    )}

                    {serverConfig && !syncUser && currentUser && (
                      <div className="auth-note" style={{ margin: '0 0 0.6rem' }}>
                        {t('sync.reSignIn', { provider: currentUser.provider })}
                      </div>
                    )}

                    {serverConfig && !syncUser && (
                      <>
                        <div className="theme-switch" style={{ marginBottom: '0.6rem' }}>
                          <button
                            className={syncForm.mode === 'login' ? 'active' : ''}
                            onClick={() => setSyncForm(f => ({ ...f, mode: 'login' }))}
                          >{t('sync.signIn')}</button>
                          <button
                            className={syncForm.mode === 'register' ? 'active' : ''}
                            onClick={() => setSyncForm(f => ({ ...f, mode: 'register' }))}
                          >{t('sync.createAccount')}</button>
                        </div>

                        {syncForm.mode === 'register' && (
                          <input
                            type="text"
                            className="settings-input"
                            style={{ marginBottom: '0.4rem' }}
                            placeholder={t('sync.name')}
                            value={syncForm.name}
                            onChange={e => setSyncForm(f => ({ ...f, name: e.target.value }))}
                          />
                        )}
                        <input
                          type="email"
                          className="settings-input"
                          style={{ marginBottom: '0.4rem' }}
                          placeholder={t('sync.email')}
                          autoComplete="username"
                          value={syncForm.email}
                          onChange={e => setSyncForm(f => ({ ...f, email: e.target.value }))}
                        />
                        <input
                          type="password"
                          className="settings-input"
                          style={{ marginBottom: '0.5rem' }}
                          placeholder={t('sync.password')}
                          autoComplete={syncForm.mode === 'register' ? 'new-password' : 'current-password'}
                          value={syncForm.password}
                          onChange={e => setSyncForm(f => ({ ...f, password: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') syncSignIn(); }}
                        />
                        <button
                          className="auth-submit profile-save"
                          disabled={syncBusy === 'auth' || !syncForm.email || !syncForm.password}
                          onClick={syncSignIn}
                        >
                          {syncBusy === 'auth'
                            ? <RefreshCcw size={14} className="spin" />
                            : (syncForm.mode === 'register' ? t('sync.createAccount') : t('sync.signIn'))}
                        </button>
                      </>
                    )}

                    {serverConfig && syncUser && (
                      <>
                        <div className="sync-status">
                          <Check size={14} />
                          <span>{t('sync.signedInAs', { name: syncUser.name, email: syncUser.email })}</span>
                        </div>
                        <div className="setting-help" style={{ marginBottom: '0.6rem' }}>
                          {syncInfo?.exists
                            ? t('sync.lastSaved', {
                                when: relativeTime(syncInfo.savedAt, lang),
                                size: formatBytes(syncInfo.bytes),
                              })
                            : t('sync.nothingStored')}
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button className="icon-btn bordered" disabled={!!syncBusy} onClick={syncNow}>
                            {syncBusy === 'push' ? <RefreshCcw size={14} className="spin" /> : <ArrowUp size={14} />}
                            {t('sync.pushNow')}
                          </button>
                          <button className="icon-btn bordered" disabled={!!syncBusy} onClick={() => syncPull('merge')}>
                            {syncBusy === 'pull' ? <RefreshCcw size={14} className="spin" /> : <ArrowDown size={14} />}
                            {t('sync.pull')}
                          </button>
                          <button className="icon-btn bordered" disabled={!!syncBusy} onClick={syncSignOut}>
                            <LogOut size={14} /> {t('sync.signOut')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                </>
              )}

              {settingsTab === 'data' && (
                <>
                  <div className="settings-actions">
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <button onClick={exportSessions} style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                        {t('data.exportJson')}
                      </button>
                      <label style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', textAlign: 'center', color: 'var(--text-primary)' }}>
                        {t('data.importJson')}
                        <input type="file" accept=".json" onChange={importSessions} style={{ display: 'none' }} />
                      </label>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                      <button onClick={() => exportSessionMarkdown()} style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                        {t('data.exportThisMd')}
                      </button>
                      <button onClick={exportAllMarkdown} style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                        {t('data.exportAllMd')}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                      <button onClick={() => exportSessionHtml()} style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                        {t('data.exportThisHtml')}
                      </button>
                    </div>
                    <button className="btn" style={{ backgroundColor: '#EF4444', color: 'white', width: '100%', padding: '0.5rem', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }} onClick={clearAllChats}>
                      {t('data.clearAll')}
                    </button>
                  </div>

                  <div className="settings-group">
                    <label>{t('backup.title')}</label>
                    <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('backup.help')}</div>

                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <button className="icon-btn bordered" onClick={exportBackup}>
                        <Save size={14} /> {t('backup.export')}
                      </button>
                      <button
                        className="icon-btn bordered"
                        disabled={restoring}
                        onClick={() => { backupRestoreMode.current = 'merge'; backupInputRef.current?.click(); }}
                      >
                        {restoring ? <RefreshCcw size={14} className="spin" /> : <Download size={14} />}
                        {t('backup.import')}
                      </button>
                      <button
                        className="icon-btn bordered"
                        style={{ color: 'var(--danger)' }}
                        disabled={restoring}
                        onClick={() => { backupRestoreMode.current = 'replace'; backupInputRef.current?.click(); }}
                      >
                        <TriangleAlert size={14} /> {t('backup.importReplace')}
                      </button>
                    </div>

                    <input
                      ref={backupInputRef}
                      type="file"
                      accept="application/json,.json"
                      style={{ display: 'none' }}
                      onChange={e => importBackup(e.target.files?.[0], backupRestoreMode.current)}
                    />

                    <div className="backup-origin">{t('backup.origin', { origin: window.location.origin })}</div>
                  </div>

                  <div className="settings-group">
                    <label>{t('data.storage')}</label>
                    {storageUsage ? (
                      <>
                        <div className="ctx-meter" style={{ fontSize: '0.8rem' }}>
                          <span>
                            {formatBytes(storageUsage.used)}
                            {storageUsage.quota ? ` / ${formatBytes(storageUsage.quota)}` : ''}
                          </span>
                          <div className="ctx-meter-bar" style={{ width: '120px' }}>
                            <div
                              className="ctx-meter-fill"
                              style={{ width: `${storageUsage.quota ? Math.min(100, (storageUsage.used / storageUsage.quota) * 100) : 0}%` }}
                            />
                          </div>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                          {t('data.storageHelp')}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('data.storageUnknown')}</div>
                    )}
                  </div>

                  <div className="settings-group">
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{t('data.logs')}</span>
                      <button className="icon-btn" title={t('data.clearLogs')} onClick={() => setLogs([])}><Trash2 size={13} /></button>
                    </label>
                    <div className="mini-logs">
                      {logs.length === 0 && <div className="log-item log-info">{t('data.noLogs')}</div>}
                      {logs.slice(-40).map((l, i) => (
                        <div key={i} className={`log-item log-${l.type}`}>
                          [{l.time}] {l.msg}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
          </div>
        </Transition>
      </div>

        {/* Artifact Panel */}
        {activeArtifact && activeArtifactData && (() => {
          const errorCount = consoleEntries.filter(c => c.level === 'error').length;
          const tabs = [
            activeArtifactData.previewable && { id: 'preview', label: t('artifact.preview'), icon: <Play size={13} /> },
            activeArtifactData.runnable && { id: 'run', label: t('artifact.run'), icon: <Play size={13} /> },
            { id: 'code', label: t('artifact.code'), icon: <Code size={13} /> },
            activeArtifactData.previewable && {
              id: 'console',
              label: t('artifact.console'),
              icon: <Terminal size={13} />,
              badge: consoleEntries.length,
              danger: errorCount > 0,
            },
          ].filter(Boolean);

          // Fall back to Code if the requested tab does not apply here.
          const activeTab = tabs.some(t => t.id === activeArtifact.type) ? activeArtifact.type : 'code';
          const extension = EXTENSION_FOR[activeArtifactData.language] || 'txt';
          const siblings = codeArtifacts.filter(a => a.id !== activeArtifactData.id);

          return (
          <div className={`artifact-panel ${artifactMaximized ? 'maximized' : ''}`}>
            {!artifactMaximized && (
              <ResizeHandle
                label={t('artifact.resize')}
                direction={-1}
                getSize={() => artifactWidth}
                setSize={setArtifactWidth}
                min={320}
                max={() => Math.max(320, window.innerWidth - 420)}
                onReset={() => setArtifactWidth(DEFAULT_ARTIFACT_WIDTH)}
              />
            )}
            <div className="artifact-panel-header">
              <div className="artifact-title-row">
                <h3>{(activeArtifactData.language || 'code').toUpperCase()}</h3>
                {activeArtifactData.version > 0 && <span className="artifact-version">v{activeArtifactData.version}</span>}
                {!activeArtifactData.closed && <span className="artifact-streaming">{t('artifact.streaming')}</span>}
                {siblings.length > 0 && (
                  <select
                    value={activeArtifactData.id}
                    onChange={(e) => { setActiveArtifact({ id: e.target.value, type: activeArtifact.type }); setConsoleEntries([]); }}
                    className="artifact-version-select"
                  >
                    {codeArtifacts.map(a => (
                      <option key={a.id} value={a.id}>v{a.version} · {a.language || 'code'} · {a.lineCount} {t('common.lines')}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="artifact-header-actions">
                {activeTab === 'preview' && (
                  <button
                    className="icon-btn bordered"
                    title={t('artifact.reload')}
                    onClick={() => { setConsoleEntries([]); setPreviewReloadKey(k => k + 1); }}
                  >
                    <RefreshCcw size={16} />
                  </button>
                )}
                <button className="icon-btn bordered" title={t('common.copy')} onClick={() => { copyToClipboard(activeArtifactSource); toast('Code copied.', 'success', 2000); }}>
                  <Copy size={16} />
                </button>
                <button
                  className="icon-btn bordered"
                  title={activeTab === 'preview' ? 'Download the assembled page' : 'Download the source'}
                  onClick={() => downloadBlob(
                    activeTab === 'preview'
                      ? `artifact-v${activeArtifactData.version || 'x'}.html`
                      : `artifact-v${activeArtifactData.version || 'x'}.${extension}`,
                    activeTab === 'preview' ? previewDocument : activeArtifactSource
                  )}
                >
                  <Download size={16} />
                </button>
                {activeArtifactData.previewable && (
                  <button
                    className="icon-btn bordered"
                    title={t('artifact.openNewTab')}
                    onClick={() => {
                      // A blob URL survives popup blockers better than document.write
                      // and gives the page a real origin.
                      const url = URL.createObjectURL(new Blob([previewDocument], { type: 'text/html' }));
                      window.open(url, '_blank');
                      setTimeout(() => URL.revokeObjectURL(url), 30000);
                    }}
                  >
                    <ExternalLink size={16} />
                  </button>
                )}
                {activeArtifactData.previewable && (
                  <button
                    className={`icon-btn bordered ${consoleDocked ? 'toggled' : ''}`}
                    title={t('artifact.dockConsole')}
                    onClick={() => setConsoleDocked(v => !v)}
                  >
                    <Terminal size={16} />
                  </button>
                )}
                <button
                  className={`icon-btn bordered ${artifactMaximized ? 'toggled' : ''}`}
                  title={artifactMaximized ? t('artifact.restore') : t('artifact.maximize')}
                  onClick={() => setArtifactMaximized(v => !v)}
                >
                  {artifactMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button className="icon-btn bordered" title={`${t('artifact.close')} (Esc)`} onClick={() => setActiveArtifact(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="artifact-tabs">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  className={`artifact-tab ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveArtifact({ ...activeArtifact, id: activeArtifactData.id, type: tab.id })}
                >
                  {tab.icon}
                  {tab.label}
                  {tab.badge > 0 && <span className={`artifact-tab-badge ${tab.danger ? 'danger' : ''}`}>{tab.badge}</span>}
                </button>
              ))}
            </div>

            <div className="artifact-panel-content">
              {activeTab === 'preview' && (
                <div className="preview-split">
                  <div className="preview-split-main">
                    <PreviewStage
                      doc={previewDocument}
                      onConsole={appendConsole}
                      reloadKey={previewReloadKey}
                      presetId={viewportPreset}
                      onPresetChange={setViewportPreset}
                      landscape={viewportLandscape}
                      onToggleOrientation={() => setViewportLandscape(v => !v)}
                      zoomMode={previewZoom}
                      onZoomChange={setPreviewZoom}
                    />
                  </div>
                  {consoleDocked && (
                    <div className="preview-split-console" style={{ height: `${consoleDockHeight}px` }}>
                      <ResizeHandle
                        axis="y"
                        label="Resize the console"
                        direction={-1}
                        getSize={() => consoleDockHeight}
                        setSize={setConsoleDockHeight}
                        min={90}
                        max={() => Math.max(90, window.innerHeight - 260)}
                        onReset={() => setConsoleDockHeight(DEFAULT_CONSOLE_HEIGHT)}
                      />
                      <ConsolePane entries={consoleEntries} onClear={() => setConsoleEntries([])} />
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'run' && (
                activeArtifactData.runnable
                  ? <PythonRunner key={`${activeArtifactData.id}-${activeArtifactSource.length}`} code={activeArtifactSource} />
                  : <UnsupportedPreview language={activeArtifactData.language} />
              )}

              {activeTab === 'code' && (
                <CodeView
                  code={activeArtifactSource}
                  language={activeArtifactData.language}
                  editable
                  isEdited={activeArtifactIsEdited}
                  onChange={setArtifactSource}
                  onReset={resetArtifactSource}
                />
              )}

              {activeTab === 'console' && (
                <ConsolePane entries={consoleEntries} onClear={() => setConsoleEntries([])} />
              )}
            </div>
          </div>
          );
        })()}

        {/* Chat info + per-chat overrides */}
        <Transition open={showChatInfo} duration={200} className="settings-overlay" onClick={() => setShowChatInfo(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h2 style={{ marginBottom: 0 }}>{t('chat.info')}</h2>
                <button className="icon-btn" onClick={() => setShowChatInfo(false)}><X size={18} /></button>
              </div>

              <div className="settings-group">
                <label>{t('chat.titleField')}</label>
                <input
                  type="text"
                  className="settings-input"
                  value={currentSession.title}
                  onChange={e => updateCurrentSession({ title: e.target.value })}
                />
              </div>

              <div className="settings-group">
                <label>{t('chat.stats')}</label>
                <div className="stat-grid">
                  <div className="stat-tile">
                    <div className="stat-value">{chatStats.total}</div>
                    <div className="stat-label">{t('chat.messages')}</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{chatStats.userCount} / {chatStats.assistantCount}</div>
                    <div className="stat-label">{t('chat.youAssistant')}</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">~{chatStats.tokens.toLocaleString()}</div>
                    <div className="stat-label">{t('chat.estTokens')}</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{chatStats.avgSpeed ? `${chatStats.avgSpeed}` : '—'}</div>
                    <div className="stat-label">{t('chat.avgSpeed')}</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{chatStats.starred}</div>
                    <div className="stat-label">{t('chat.starredCount')}</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{codeArtifacts.length}</div>
                    <div className="stat-label">{t('chat.artifacts')}</div>
                  </div>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Created {new Date(currentSession.createdAt || Date.now()).toLocaleString()}
                  {currentSession.lastModel ? ` · last model: ${currentSession.lastModel}` : ''}
                </div>
              </div>

              <div className="settings-group">
                <div className="setting-toggle-row">
                  <div>
                    <label style={{ marginBottom: 0 }}>{t('chat.override')}</label>
                    <div className="setting-desc">{t('chat.overrideHelp')}</div>
                  </div>
                  <Switch
                    checked={currentSession.systemPrompt !== undefined}
                    onChange={(next) => updateCurrentSession({ systemPrompt: next ? systemPrompt : undefined })}
                    label={t('chat.override')}
                  />
                </div>
                {currentSession.systemPrompt !== undefined && (
                  <textarea
                    className="settings-textarea"
                    value={currentSession.systemPrompt}
                    onChange={e => updateCurrentSession({ systemPrompt: e.target.value })}
                    placeholder={t('chat.overridePlaceholder')}
                    style={{ marginTop: '0.5rem' }}
                  />
                )}
              </div>

              <div className="settings-group">
                <label>{t('chat.actions')}</label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button className="icon-btn bordered" title={t('chat.retitleHint')}
                    onClick={() => {
                      const firstUser = messages.find(m => m.role === 'user');
                      const firstAssistant = messages.find(m => m.role === 'assistant');
                      if (!firstUser) { toast(t('chat.nothingToSummarize'), 'info'); return; }
                      generateSessionTitle(currentSessionId, firstUser.content, firstAssistant?.content || '', selectedModel);
                      toast(t('chat.retitling'), 'info');
                    }}
                  >
                    <RefreshCcw size={14} /> {t('chat.retitle')}
                  </button>
                  <button className="icon-btn bordered" onClick={() => exportSessionMarkdown()}>
                    <FileDown size={14} /> {t('sidebar.exportMd')}
                  </button>
                  <button className="icon-btn bordered" onClick={() => { duplicateSession(currentSessionId); setShowChatInfo(false); }}>
                    <Copy size={14} /> {t('common.duplicate')}
                  </button>
                  <button className="icon-btn bordered" onClick={() => togglePin(currentSessionId)}>
                    <Pin size={14} /> {currentSession.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    className="icon-btn bordered"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => {
                      const previous = messages;
                      const sid = currentSessionId;
                      updateCurrentSession({ messages: [] });
                      toast(t('chat.cleared'), 'info', 8000, {
                        label: 'Undo',
                        onClick: () => setSessions(prev => prev.map(s => (s.id === sid ? { ...s, messages: previous } : s))),
                      });
                    }}
                  >
                    <Trash2 size={14} /> {t('chat.clearMessages')}
                  </button>
                </div>
              </div>
          </div>
        </Transition>

        {showProfileDialog && currentUser && (
          <ProfileDialog
            user={currentUser}
            onClose={() => setShowProfileDialog(false)}
            onUpdated={(updated) => { setCurrentUser(updated); toast(t('profile.saved'), 'success', 2000); }}
            onSignOut={() => { setShowProfileDialog(false); handleSignOut(); }}
            onSwitch={() => { setShowProfileDialog(false); setShowAuthScreen(true); }}
            onDelete={() => { setShowProfileDialog(false); handleDeleteProfile(); }}
          />
        )}

        <Transition open={showSystemMonitor} duration={200} className="settings-overlay" onClick={() => setShowSystemMonitor(false)}>
          <div className="settings-modal sysmon-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>{t('sysmon.title')}</h2>
              <button className="icon-btn" onClick={() => setShowSystemMonitor(false)} title={`${t('common.close')} (Esc)`}>
                <X size={18} />
              </button>
            </div>
            {showSystemMonitor && <SystemMonitor runningModels={runningModels} />}
          </div>
        </Transition>

        {showCompare && (
          <ModelCompare
            models={models}
            defaultPrompt={input || [...messages].reverse().find(m => m.role === 'user')?.content || ''}
            systemPrompt={currentSession.systemPrompt !== undefined ? currentSession.systemPrompt : systemPrompt}
            options={buildOptions()}
            onClose={() => setShowCompare(false)}
          />
        )}

        <Transition open={!!promptFill} duration={180} className="settings-overlay" onClick={() => setPromptFill(null)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>{t('prompts.fillTitle')}</h2>
              <button className="icon-btn" onClick={() => setPromptFill(null)}><X size={18} /></button>
            </div>

            <div className="settings-group">
              {(promptFill?.names || []).map(name => (
                <div key={name} style={{ marginBottom: '0.6rem' }}>
                  <label style={{ display: 'block', fontSize: '0.78rem', marginBottom: '0.2rem' }}>{name}</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={promptFill?.values[name] || ''}
                    autoFocus={name === promptFill?.names[0]}
                    onChange={e => setPromptFill(f => ({ ...f, values: { ...f.values, [name]: e.target.value } }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        insertPromptText(applyPromptVariables(promptFill.body, promptFill.values));
                        setPromptFill(null);
                      }
                    }}
                  />
                </div>
              ))}

              <div className="prompt-preview">{applyPromptVariables(promptFill?.body || '', promptFill?.values || {})}</div>

              <button
                className="auth-submit profile-save"
                style={{ marginTop: '0.7rem' }}
                onClick={() => { insertPromptText(applyPromptVariables(promptFill.body, promptFill.values)); setPromptFill(null); }}
              >
                {t('prompts.insert')}
              </button>
            </div>
          </div>
        </Transition>

        <Transition open={!!folderDialog} duration={180} className="settings-overlay" onClick={() => setFolderDialog(null)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>{folderDialog?.id ? t('folders.edit') : t('folders.new')}</h2>
              <button className="icon-btn" onClick={() => setFolderDialog(null)}><X size={18} /></button>
            </div>

            <div className="settings-group">
              <label>{t('folders.name')}</label>
              <input
                type="text"
                className="settings-input"
                value={folderDialog?.name || ''}
                autoFocus
                maxLength={60}
                onChange={e => setFolderDialog(f => ({ ...f, name: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveFolderDialog(); } }}
              />
            </div>

            <div className="settings-group">
              <label>{t('folders.prompt')}</label>
              <textarea
                className="settings-textarea"
                style={{ minHeight: '110px' }}
                value={folderDialog?.systemPrompt || ''}
                placeholder={t('folders.promptPlaceholder')}
                onChange={e => setFolderDialog(f => ({ ...f, systemPrompt: e.target.value }))}
              />
              <div className="setting-help">{t('folders.promptHelp')}</div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="auth-submit profile-save" style={{ flex: 1 }} onClick={saveFolderDialog}>
                {t('common.save')}
              </button>
              {folderDialog?.id && (
                <button
                  className="icon-btn bordered"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => deleteFolder(folderDialog.id)}
                >
                  <Trash2 size={14} /> {t('common.delete')}
                </button>
              )}
            </div>
            {folderDialog?.id && <div className="setting-help" style={{ marginTop: '0.5rem' }}>{t('folders.deleteHelp')}</div>}
          </div>
        </Transition>

        {/* Toasts */}
        {toasts.length > 0 && (
          <div className="toast-stack">
            {toasts.map(t => (
              <div key={t.id} className={`toast toast-${t.type}`}>
                {t.type === 'error' ? <X size={15} /> : t.type === 'success' ? <Check size={15} /> : <Sparkles size={15} />}
                <span>{t.message}</span>
                {t.action && (
                  <button
                    className="toast-action"
                    onClick={() => { t.action.onClick(); dismissToast(t.id); }}
                  >
                    {t.action.label}
                  </button>
                )}
                <button onClick={() => dismissToast(t.id)}><X size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Command Palette (Ctrl+K) */}
        <Transition open={showPalette} duration={180} className="cmd-overlay" onClick={() => setShowPalette(false)}>
          <div className="cmd-palette" onClick={e => e.stopPropagation()}>
              <div className="cmd-input-row">
                <Search size={16} color="var(--text-muted)" />
                <input
                  ref={paletteInputRef}
                  value={paletteQuery}
                  placeholder={t('palette.placeholder')}
                  onChange={e => { setPaletteQuery(e.target.value); setPaletteIndex(0); }}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPaletteIndex(i => Math.min(i + 1, paletteItems.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPaletteIndex(i => Math.max(i - 1, 0));
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      runPaletteItem(paletteItems[paletteIndex]);
                    }
                  }}
                />
              </div>

              <div className="cmd-list">
                {paletteItems.length === 0 && <div className="cmd-empty">{t('palette.empty')}</div>}
                {paletteItems.map((item, idx) => {
                  const showSection = idx === 0 || paletteItems[idx - 1].section !== item.section;
                  return (
                    <React.Fragment key={`${item.section}-${item.label}-${idx}`}>
                      {showSection && <div className="cmd-section">{item.section}</div>}
                      <button
                        className={`cmd-item ${idx === paletteIndex ? 'active' : ''}`}
                        onMouseEnter={() => setPaletteIndex(idx)}
                        onClick={() => runPaletteItem(item)}
                        ref={idx === paletteIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                      >
                        {item.icon}
                        <span className="cmd-label">{item.label}</span>
                        {item.hint && <span className="cmd-shortcut">{item.hint}</span>}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

            <div className="cmd-footer">
              <span>↑↓ {t('palette.navigate')}</span>
              <span>↵ {t('palette.run')}</span>
              <span>esc {t('palette.close')}</span>
            </div>
          </div>
        </Transition>

        {/* Keyboard shortcut reference (Ctrl+/) */}
        <Transition open={showShortcuts} duration={200} className="settings-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h2 style={{ marginBottom: 0 }}>{t('settings.shortcuts')}</h2>
                <button className="icon-btn" onClick={() => setShowShortcuts(false)}><X size={18} /></button>
              </div>
              {[
                { keys: ['Ctrl', 'K'], desc: 'Command palette' },
                { keys: ['Ctrl', 'Shift', 'O'], desc: 'New chat' },
                { keys: ['Ctrl', 'B'], desc: 'Toggle sidebar' },
                { keys: ['Ctrl', ','], desc: 'Open settings' },
                { keys: ['Ctrl', 'F'], desc: 'Find in chat (Enter / Shift+Enter to step)' },
                { keys: ['Ctrl', '\\'], desc: 'Toggle the artifact panel' },
                { keys: ['Ctrl', '/'], desc: 'This list' },
                { keys: ['Esc'], desc: 'Close palette / settings / artifact' },
                { keys: ['Enter'], desc: 'Send message' },
                { keys: ['Shift', 'Enter'], desc: 'New line' },
                { keys: ['/'], desc: 'Slash commands in the composer' },
                { keys: ['Ctrl', 'V'], desc: 'Paste an image straight into the composer' },
                { keys: ['Double-click'], desc: 'Rename a chat in the sidebar, or reset a panel edge' },
                { keys: ['Drag'], desc: 'Sidebar / artifact panel edges resize them' },
              ].map((s, i) => (
                <div className="shortcut-row" key={i}>
                  <span>{s.desc}</span>
                  <span className="shortcut-keys">
                    {s.keys.map(k => <kbd key={k}>{k}</kbd>)}
                  </span>
                </div>
              ))}
          </div>
        </Transition>
    </div>
  );
}

export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  );
}
