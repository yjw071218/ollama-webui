import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import localforage from 'localforage';
import { ArrowUp, Paperclip, Sparkles, RefreshCcw, Trash2, Copy, Check, Terminal, Settings, Edit, MessageSquare, ChevronDown, Download, Square, X, Play, Mic, MicOff, Volume2, Search, Code, Maximize2, Sun, Moon, Monitor, Pin, PinOff, GitBranch, FileDown, Command, Cpu, Plus, Save, ArrowDown, Zap, Layers, Server, ExternalLink, Star, Info, TriangleAlert, FileText, Minimize2, PanelLeft, ListTree, LogOut, UserPlus, Languages, User, Activity, Globe, Folder, FolderPlus, MoreHorizontal, ChevronLeft, ChevronRight, SlidersHorizontal, CornerDownRight, Archive, WrapText, ListChecks, ChevronUp, Vibrate, Smartphone, FolderInput, StretchHorizontal, TextQuote, Brain, HelpCircle, Baby, Share2, ClipboardPaste, Upload, Users, Telescope, ShieldCheck, Wand2, Clock, Film, Brush, Scissors, Tags, Images } from 'lucide-react';
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
import { usePersistedNumber, ResizeHandle, Popover, AnchoredMenu, Collapsible, Transition, SettingToggle, Switch, clamp, useDialog } from './ui.jsx';
import { I18nProvider, useI18n, LANGUAGES, promptLanguageName } from './i18n.jsx';
import { registerServiceWorker, watchInstallPrompt, isStandalone, supportsServiceWorker } from './pwa.js';
import { trackDrawerSwipe } from './gestures.js';
import { haptic, setHapticsEnabled, hapticsSupported } from './haptics.js';
import { AuthScreen } from './AuthScreen.jsx';
import { ProfileDialog, ProfileAvatar } from './ProfileDialog.jsx';
import { SecurityPanel, SignOutOthersButton } from './SecurityPanel.jsx';
import { SystemMonitor, SystemStrip } from './SystemMonitor.jsx';
import { StudioPanel, loadHistory as loadStudioHistory, thumbOf } from './StudioPanel.jsx';
import { MaskEditor } from './MaskEditor.jsx';
import { PictureTags } from './PictureTags.jsx';
import { PictureGallery } from './PictureGallery.jsx';
import { JobProgress, useJobStream } from './studioProgress.jsx';
import { sizeRatio } from './jobProgress.js';
import { PictureSettings } from './PictureSettings.jsx';
import { SafePicture, useSafeguardLevel } from './SafeImage.jsx';
import { shouldVeil, promptSignal } from './safeguard.js';
import { readAll as readStudioSettings, restoreForm, CHAT_PICTURE_KEY, readChatPictureModel } from './studioSettings.js';
import {
  blobToDataUrl, pictureSize, padForExtension, samplingSize, parseAspect, sizeForAspect, asImageDataUrl,
} from './pictureTools.js';
import { normalizeTimeline, durationFromTimeline, clampSeconds, VIDEO_SECONDS, H3_GUIDE, asksForVideo } from './videoPrompt.js';
import { UsagePanel } from './UsagePanel.jsx';
import {
  cleanTag, tagsOf, addTag, removeTag, allTags, suggest as suggestTags,
  filterByTags, parseTagQuery, suggestForChat, MAX_PER_CHAT,
} from './tags.js';
import { KnowledgePanel } from './KnowledgePanel.jsx';
import { ModelCompare } from './ModelCompare.jsx';
import { loadLibrary, retrieve, formatContext, visibleDocuments, removeDocument, DEFAULT_EMBED_MODEL, extractDocument, renderPdfPages, embedTexts, normalise } from './rag.js';
import { buildIndex, searchIndex, loadIndex, clearIndex, indexBytes, MAX_INDEXED } from './chatSearch.js';
import {
  loadMemories, saveMemories, addMemories, removeMemory,
  formatMemories, extractMemories, MEMORY_KINDS,
} from './memory.js';
import { sessionToHtml, sessionToPrintableHtml, sessionToMarkdown } from './htmlExport.js';
import { decodeByteFallback } from './byteFallback.js';
import { safeHead, stripLoneSurrogates } from './textCut.js';
import { takeSpeakable, splitForSpeech } from './speechChunks.js';
import { relativeTime, absoluteTime } from './relativeTime.js';
import { collectBackup, restoreBackup, describeBackup, isBackup, settingsFingerprint } from './backup.js';
import {
  setActiveScope, getActiveScope, getSetting, setSetting, clearScopeSettings,
} from './settingsStore.js';
import { deriveScope, ownerOfScope } from './profileScope.js';
import { stamped, conversationTime } from './sessionEdit.js';
import { fileMarker, indexedMarker, extractAttachments, stripAttachments } from './attachMarkers.js';
import { forHistory, isToolResult, turnStart, wireText } from './wireHistory.js';
import { isDraft, newDraft, promoted, withoutStaleDrafts, persistable, nextSessionId } from './draftChat.js';
import { Logo } from './Logo.jsx';
import {
  buildSnapshot, createShare, listShares, revokeShare,
  loadShareUrls, rememberShareUrl, forgetShareUrl,
} from './shareLink.js';
import { turnMetrics } from './turnMetrics.js';
import { runResearch, DEPTHS } from './research.js';
import { ResearchTrace } from './ResearchTrace.jsx';
import { waitFor, isOverdue } from './coalesce.js';
import { copyText } from './clipboard.js';
import { buildSelectionPrompt, selectionTarget, SELECTION_ACTIONS } from './selection.js';
import { promptsFrom, stepHistory, wantsHistory, NOT_BROWSING } from './promptHistory.js';
import { canShare, shareText, shareBody } from './share.js';
import { DRAWING_TAGS, schemasFor, toolCallsIn, nativeCallToTag, tagAttrs, TAG_ATTRS, canonicalToolTags } from './tools.js';
import { parseAssistantMessage } from './messageParts.js';
import { localSttAvailable, recordAndTranscribe, whisperLanguage } from './stt.js';
import { wantsNavigation, NAV_KEYS, step } from './messageNav.js';
import {
  loadQueue, enqueue, removeEntry, noteAttempt, nextDue, stalled,
  makeEntry, isRetryable, MAX_ATTEMPTS,
} from './sendQueue.js';
import { ingestDocument, shouldPasteAsFile, namePastedText } from './ingest.js';
import { holdScreenAwake } from './wakeLock.js';
import { recordRun, loadRuns, clearRuns, summarise, promptCostTrend } from './perf.js';
import {
  syncFully, createSyncScheduler, accountStamp, resetSyncPosition, OwnerMismatch,
  subscribeToAccount,
} from './syncEngine.js';
import {
  useSession, deleteAccount as deleteServerAccount, signOutOtherDevices,
  leaveHandoff, takeHandoff, fetchServerConfig,
} from './session.jsx';
import {
  findLegacyData, wasOffered, markOffered, importLegacyBucket, alreadyImported,
  purgeLegacyCredentials,
} from './legacyImport.js';
import { appendVariant, selectVariant, removeVariant, variantsOf, variantCount, variantIndexOf } from './variants.js';
import { diffText, summariseDiff } from './diffText.js';
import {
  CONDITIONS, signalsFor, routeFor, newRule as newModelRule, loadRules as loadModelRules,
  saveRules as saveModelRules, suggestRules,
} from './routing.js';
import {
  evidenceFor, questionFor, verifyPrompt, parseVerdicts, locateQuotes, summariseVerdicts,
} from './verify.js';
import {
  newChain, newStep, loadChains, saveChains, runChain, validateChain, blocking,
  referencesIn, STARTER_CHAINS, MAX_STEPS,
} from './chains.js';
import { ChainTrace } from './ChainTrace.jsx';
import {
  buildContext, summaryPrompt, formatSummary, formatRecalled, savings,
  asTurns, MIN_RECENT_TURNS,
} from './convMemory.js';
import {
  loadProfile, saveProfile, formatProfile, emptyProfile, clampField, isEmpty as isProfileEmpty,
  estimateCost as profileCost, nextSuggestion as nextProfileField, FIELDS as PROFILE_FIELDS,
} from './userProfile.js';
import { wasTruncated, joinContinuation, looksRestarted, CONTINUE_PROMPT } from './continuation.js';
import { parseToolResults, verbKey, showsBody } from './toolResults.js';
import {
  DEFAULT_NUM_CTX, DEFAULT_MAX_TOKENS, OLD_NUM_CTX, OLD_MAX_TOKENS,
  MIGRATION_KEY, raiseIfUntouched,
} from './contextDefault.js';
import { newFolder, loadFolders, saveFolders, renameFolder, updateFolder, removeFolder, assignToFolder, groupByFolder, folderOf } from './folders.js';
import { PRESET_FIELDS, BUILTIN_PRESETS, newPreset, loadPresets, savePresets, sanitisePreset, matchPreset } from './presets.js';
import {
  loadPersonas, savePersonas, matchPersona, personaOf, upsertPersona, removePersona,
  openingMessages, sanitiseSampling, PERSONA_SAMPLING,
} from './personas.js';
import {
  sessionStorageKeyFor,
  setServerSocialConfig,
  forgetGoogleAutoSelect,
  kakaoUnlink,
  readKakaoOutcome,
  socialDefaults,
  kakaoRedirectUri,
} from './auth.jsx';

// Read once, at load, so restoring it later cannot restore a decorated copy
// of itself.
const BASE_PAGE_TITLE = typeof document !== 'undefined' ? document.title : 'Ollama WebUI';

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

// How long the chat list waits before being written to browser storage, and
// the longest it may wait however busy things are. The ceiling is what makes a
// streaming reply reach storage at all -- and storage is what the account sync
// uploads, so it is also what makes the reply reach the other devices. See
// src/coalesce.js.
//
// These two set the pace the *other* devices see, because the upload is
// scheduled from the write and can only ever send what the write left behind:
// the lag is this ceiling plus the upload's, and nothing shortens it except
// shortening these. At 1500 + 3000 a reply arrived on the phone in lurches
// several seconds wide. Halved, and with the upload ceiling down to a second,
// it reads as text being written.
//
// Not lower than this. A save rewrites the whole chat list, so the cost is the
// size of the history rather than the size of the change, and at some point
// the phone would be spending its time syncing instead of showing what it
// synced.
const SAVE_DELAY_MS = 400;
const SAVE_MAX_DELAY_MS = 800;

/**
 * A cheap fingerprint of a chat list: which chats, and when each last changed.
 *
 * Deliberately only the ids and the timestamps, because that is exactly what
 * the account sync compares (`localChanges` in syncEngine.js). Two lists with
 * the same signature are two lists the sync cannot tell apart, so a write that
 * does not move it has nothing to upload -- and every edit now moves it, which
 * is what src/sessionEdit.js is for.
 */
const chatsSignature = (list) =>
  (list || []).map(c => `${c?.id}:${c?.updatedAt || 0}`).sort().join('|');

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

/* ---- How hard the model should think ----

   This was a three-way switch: auto, on, off. On and off are the only two
   things a `think: true|false` field can say, and for a long time that was the
   only thing Ollama's API accepted — but the models that reason properly
   (gpt-oss and the ones that followed it) take a *level*, and the difference
   between "low" and "high" on one of those is the difference between four
   seconds and forty. A switch cannot ask for that, so a question that deserved
   forty seconds either got four or got them at random.

   `wire` is what goes into the request body, and `undefined` means the field is
   left out entirely — which is a third thing, distinct from true and false: it
   is "you decide", and it is the only value under which a model's own default
   survives.

   The scale stops at "high" because that is where Ollama's scale stops. A sixth
   level above it would be a label on the screen with nothing behind it on the
   wire, and the point of showing the effort is that it is real. */
const THINK_MODES = [
  { id: 'auto', wire: undefined },
  { id: 'off', wire: false },
  { id: 'low', wire: 'low' },
  { id: 'medium', wire: 'medium' },
  { id: 'high', wire: 'high' },
];

const THINK_IDS = THINK_MODES.map(m => m.id);

/** What the request body should carry, as a patch, so `auto` can carry nothing. */
const thinkField = (mode) => {
  const chosen = THINK_MODES.find(m => m.id === mode);
  return chosen && chosen.wire !== undefined ? { think: chosen.wire } : {};
};

/** A stored value, including the two names the old three-way switch used. */
const readThinkMode = (stored) => {
  if (stored === 'on') return 'high';        // the old "on", at the level it meant
  return THINK_IDS.includes(stored) ? stored : 'auto';
};

/* One glyph per tool, so a row of receipts can be read without reading. */
const TOOL_ICONS = {
  TOOL_WEB_SEARCH: Search,
  TOOL_FETCH_URL: Globe,
  TOOL_NEWS: Globe,
  TOOL_READ_FILE: FileText,
  TOOL_WRITE_FILE: FileText,
  TOOL_LIST_DIR: Folder,
  TOOL_SEARCH_FILES: Search,
  TOOL_TIME: Clock,
  TOOL_LIST_MODELS: Layers,
  TOOL_SYSTEM_INFO: Cpu,
  TOOL_GENERATE_IMAGE: Wand2,
  TOOL_GENERATE_VIDEO: Film,
  TOOL_REMOVE_BACKGROUND: Scissors,
  TOOL_UPSCALE_IMAGE: Maximize2,
  TOOL_EXTEND_IMAGE: Maximize2,
};
const ToolVerbIcon = ({ name }) => {
  const Icon = TOOL_ICONS[name] || Check;
  return <Icon size={12} />;
};

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Save a string as a file.
 *
 * The `charset=utf-8` in the type is a hint to the browser and travels no
 * further: a `.md` or `.txt` saved to disk is bytes and nothing else, and
 * Windows still reads a plain text file as the system code page unless told
 * otherwise. On a Korean machine that is CP949, which is why an exported
 * transcript full of Hangul opened as mojibake in Notepad and in Excel while
 * looking perfectly correct in the browser it came from.
 *
 * A byte-order mark is how a file says "I am UTF-8" to those programs. It goes
 * on the plain-text formats only: every Markdown parser skips it, and it is
 * *not* put on JSON, where a leading BOM is a parse error in most strict
 * readers and would make a backup unrestorable. HTML says so in a meta tag of
 * its own and needs nothing here.
 */
const BOM = '\ufeff';
const NEEDS_BOM = /^text\/(plain|markdown|csv)/i;

const downloadBlob = (filename, content, mime = 'text/plain;charset=utf-8') => {
  const parts = NEEDS_BOM.test(mime) ? [BOM, content] : [content];
  const blob = new Blob(parts, { type: mime });
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
const cleanForExport = (content) => canonicalToolTags(content || '')
  .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
  .replace(/<TOOL_RESULT>[\s\S]*?<\/TOOL_RESULT>/gi, '')
  .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?<\/TOOL_[A-Z_]+>/gi, '')
  .trim();

// What actually gets sent to the TTS engine. The old version only stripped
// the <think> *tags*, so the whole reasoning trace was read out loud.
const stripForSpeech = (text) => stripAttachments(
  canonicalToolTags(text || '')
    // reasoning and tool scaffolding, including a block left unterminated
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ')
    .replace(/<TOOL_RESULT>[\s\S]*?(<\/TOOL_RESULT>|$)/gi, ' ')
    .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?(<\/TOOL_[A-Z_]+>|$)/gi, ' '),
  // Every injected block, from the one place that knows them all, so a marker
  // added later is never read out loud by accident.
  ' ',
)
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

/* Turn `[1]` in an answer into something you can press.
 *
 * When the knowledge library supplies passages, the model is told to cite them
 * as `[1]`, `[2]`. It does — and the number was nothing: not a link, not a
 * hover, not clickable anywhere. To check whether a claim really came from the
 * document you had to open the collapsed reasoning block and count paragraphs
 * until you found the matching one.
 *
 * The whole point of a citation is that checking it is cheap. This is the same
 * HAST text-splitting the search highlighter does, keyed on the marker instead
 * of on a search term, and it only marks numbers that have a passage behind
 * them — `[3]` with two passages retrieved is the model inventing a source,
 * and dressing that up as a link would be the worst outcome available.
 */
const CITATION_PATTERN = /\[(\d{1,2})\]/g;

/**
 * What the regeneration actually changed.
 *
 * The pager already says "2 / 3". This says what makes them different, which
 * is the thing anybody regenerating wanted to know and the thing that is
 * hardest to get by reading: six hundred words, four minutes apart, compared
 * from memory.
 *
 * Deliberately not a side-by-side. Two columns of the same six hundred words
 * is more reading, not less; one column with the removals struck through is
 * the whole answer *and* the change, in one pass.
 */
const VariantDiff = ({ before, after, onClose }) => {
  const { t } = useI18n();
  // Recomputed only when the pair changes: this is quadratic work in the worst
  // case and a re-render of the transcript must not pay for it again.
  const { parts, coarse } = useMemo(() => diffText(before, after), [before, after]);
  const summary = useMemo(() => summariseDiff(parts), [parts]);

  return (
    <div className="variant-diff">
      <div className="variant-diff-head">
        <span className="variant-diff-summary">
          {summary.identical
            ? t('diff.identical')
            : t('diff.summary', { added: summary.added, removed: summary.removed })}
        </span>
        {/* Said out loud, because a paragraph marked wholly changed when one
            word moved is a lie the reader has no way to detect. */}
        {coarse && <span className="variant-diff-coarse">{t('diff.coarse')}</span>}
        <button className="variant-btn" onClick={onClose} title={t('diff.hide')}>
          <X size={12} />
        </button>
      </div>
      {!summary.identical && (
        <div className="variant-diff-body">
          {parts.map((part, n) => (
            part.type === 'same'
              ? <span key={n}>{part.text}</span>
              : part.type === 'add'
                ? <ins className="diff-add" key={n}>{part.text}</ins>
                : <del className="diff-remove" key={n}>{part.text}</del>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * What the check found.
 *
 * Every verdict quotes the answer's own words, which is what makes it possible
 * to go and look. A verdict whose quote is *not* in the answer is shown and
 * marked rather than hidden: "the checker quoted something that is not there"
 * is itself worth knowing, and quietly dropping those would leave a page of
 * findings that all look equally solid.
 */
const VerifyPanel = ({ verification }) => {
  const { t } = useI18n();
  const verdicts = verification.verdicts || [];
  const found = summariseVerdicts(verdicts);

  if (verification.status === 'running') {
    return (
      <div className="verify-panel is-running">
        <RefreshCcw size={13} className="spin" />
        <span>{t('verify.running')}</span>
      </div>
    );
  }
  if (verification.status === 'failed') {
    return (
      <div className="verify-panel is-failed">
        <TriangleAlert size={13} />
        <span>{t('verify.failed', { error: verification.error || '' })}</span>
      </div>
    );
  }

  return (
    <div className={`verify-panel ${found.problems > 0 ? 'has-problems' : ''}`}>
      <div className="verify-head">
        <ShieldCheck size={13} />
        <span className="verify-summary">
          {verdicts.length === 0
            ? t('verify.nothing')
            /* Three outcomes, not two. Without sources nothing was verified,
               and reporting "all supported" there would be the one output
               worse than none. */
            : !verification.hasEvidence
              ? t('verify.toCheck', { count: found.total })
              : found.problems > 0
                ? t('verify.problems', { count: found.problems, total: found.total })
                : t('verify.clean', { count: found.total })}
        </span>
        {/* The distinction the whole panel turns on. Without sources these are
            questions to ask, not findings. */}
        {!verification.hasEvidence && (
          <span className="verify-note">{t('verify.noSources')}</span>
        )}
      </div>

      {verdicts.map((entry, n) => (
        <div className={`verify-verdict is-${entry.verdict} ${entry.found ? '' : 'not-found'}`} key={n}>
          <span className="verify-badge">{t(`verify.verdict.${entry.verdict}`)}</span>
          <span className="verify-quote">“{entry.quote}”</span>
          {entry.note && <span className="verify-why">{entry.note}</span>}
          {!entry.found && <span className="verify-missing">{t('verify.notInAnswer')}</span>}
        </div>
      ))}
    </div>
  );
};

const createCitationLinker = (count, kinds) => () => (tree) => {
  if (!count) return;

  const walk = (node) => {
    if (!node || !Array.isArray(node.children)) return;
    // Not inside code: `arr[1]` in a snippet is an index, not a citation.
    if (node.tagName === 'code' || node.tagName === 'pre') return;

    const next = [];
    let changed = false;

    for (const child of node.children) {
      if (child.type !== 'text') { walk(child); next.push(child); continue; }

      CITATION_PATTERN.lastIndex = 0;
      let last = 0;
      let match;
      while ((match = CITATION_PATTERN.exec(child.value)) !== null) {
        const n = Number(match[1]);
        // Out of range: leave it as the text it is.
        if (!(n >= 1 && n <= count)) continue;
        if (match.index > last) next.push({ type: 'text', value: child.value.slice(last, match.index) });
        next.push({
          type: 'element',
          tagName: 'button',
          properties: {
            type: 'button',
            // `is-link` where the source is a page to visit rather than a
            // passage to read, so the two are distinguishable before pressing.
            className: kinds?.[n - 1] === 'url' ? ['citation-mark', 'is-link'] : ['citation-mark'],
            'data-citation': String(n),
          },
          children: [{ type: 'text', value: match[0] }],
        });
        last = match.index + match[0].length;
        changed = true;
      }
      if (changed && last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
      else if (!changed) next.push(child);
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

/**
 * A fenced code block.
 *
 * Keyed off `pre`, not `code`, and that is the whole point.
 *
 * This used to be a `code` component that asked its own `inline` prop whether
 * it was a block or a word inside a sentence. react-markdown stopped passing
 * `inline` in v9 -- the string does not appear anywhere in v10's source -- so
 * the prop was `undefined` on every call and `if (!inline)` was true on every
 * call. Every scrap of inline code became a full block: "use the `useState`
 * hook" rendered as the words "use the", a bordered card with a language
 * header and a copy button, and then the words "hook". A sentence with two
 * inline spans came out in five pieces. It also put a <div> and a <pre> inside
 * a <p>, which is invalid HTML that React warns about and browsers silently
 * restructure.
 *
 * There is no ambiguity left to get wrong now. A fence is `<pre><code>` in the
 * parsed tree and inline code is a bare `<code>`, so handling `pre` means only
 * fences arrive here, and `code` is left alone to be what it says it is.
 */
const MarkdownCodeBlock = memo(({ className, children, onOpenArtifact, ...props }) => {
  // This component is defined outside App, so there is no `t` in scope here
  // and there never was -- the artifact card below called one, which is a
  // ReferenceError the moment a long code block renders. The hook is the fix
  // and it is also the right one: this is a component, and the label belongs
  // in the same translation table as every other label.
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // Long lines in a fenced block scroll sideways, which on a phone means a
  // one-line shell command you can only read a third of. Wrapping is not the
  // default because it destroys the alignment of anything laid out in columns,
  // so it is offered per block instead of chosen once for all of them.
  const [wrapped, setWrapped] = useState(false);

  // `children` is the <code> element the parser built for this fence. Its
  // className carries the info string (```js becomes `language-js`), and its
  // own children are the spans rehype-highlight produced -- rendered as they
  // are, so highlighting survives, and read through `extractText` wherever the
  // plain source is what is wanted.
  const codeEl = Array.isArray(children) ? children.find(c => c && c.props) : children;
  const codeClass = codeEl?.props?.className || className || '';
  const match = /language-([\w-]+)/.exec(codeClass);
  const language = normalizeLanguage(match ? match[1] : '');
  const codeContent = extractText(codeEl?.props?.children ?? children).replace(/\n$/, '');
  const lineCount = codeContent.split('\n').length;
  const previewable = isPreviewable(language);
  const runnable = isPythonish(language);
  const isLong = lineCount > 15;

  const handleCopy = async () => {
    if (!await copyText(codeContent)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  {
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
          <div className="code-header-actions">
            <button
              className={`code-copy-btn ${wrapped ? 'is-on' : ''}`}
              aria-pressed={wrapped}
              title={wrapped ? t('code.noWrap') : t('artifact.wrap')}
              onClick={() => setWrapped(v => !v)}
            >
              <WrapText size={12} />
            </button>
            <button className="code-copy-btn" onClick={handleCopy}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
        <pre className={wrapped ? 'is-wrapped' : undefined} {...props}>{children}</pre>
        {runnable && <PythonRunner code={codeContent} compact />}
      </div>
    );
  }
});

// Decided before React renders anything, because the useState initialisers
// below read settings and must read the right profile's. A tab that has none of
// its own inherits the last profile used in this browser, then stops following
// it — which is what lets two tabs be two people.
// The scope is settled before this module's component ever renders: the session
// provider asks the server who is signed in, calls setActiveScope, and only
// then mounts the tree. There is no boot-time guess left to be wrong.

function App() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVisionModel, setSelectedVisionModel] = useState('');
  // The breakpoint the stylesheet uses for the drawer layout, kept in one place
  // so the two cannot disagree about what "narrow" means.
  const NARROW_QUERY = '(max-width: 860px)';
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY);
    if (!query) return undefined;
    const onChange = (event) => setIsNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Open on a desktop, shut on a phone: there it covers the conversation.
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => !(typeof window !== 'undefined' && window.matchMedia?.(NARROW_QUERY).matches),
  );

  // Rotating a phone into landscape, or resizing a window past the breakpoint,
  // should not leave a drawer stranded over the conversation.
  const wasNarrowRef = useRef(isNarrow);
  useEffect(() => {
    if (wasNarrowRef.current === isNarrow) return;
    wasNarrowRef.current = isNarrow;
    setIsSidebarOpen(!isNarrow);
  }, [isNarrow]);
  const [activeArtifact, setActiveArtifact] = useState(null); // { type, version, fallbackContent, fallbackLang, fallbackIsWeb }
  
  // Custom Dropdown State
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isVisionDropdownOpen, setIsVisionDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const visionDropdownRef = useRef(null);

  /* The composer's own two menus.
   *
   * The row under the box used to be five buttons and two switches laid side by
   * side with the thing you type into, which is the wrong shape for a composer:
   * the box was the narrowest item on the widest row, and the controls were
   * loudest exactly where the writing should be. Now the box has the row above
   * to itself, and the row below holds a `+` for the things you *add* to a
   * message and a picker for how the message is answered. */
  /* Which half of the app you are in. The sidebar's two places: the
   * conversations, or the studio. Kept here rather than in the sidebar because
   * the main area is what actually changes. */
  const [sidebarPlace, setSidebarPlace] = useState('home');
  /* Whether the Studio has ever been opened in this tab. It stays mounted once
     it has been, so a generation keeps being tracked while you are reading a
     chat -- see where it is rendered. */
  const [studioOpened, setStudioOpened] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);

  // Settings / Logs panel state
  const [showSettings, setShowSettings] = useState(false);
  const [downloadModelName, setDownloadModelName] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  /* Chats found by meaning rather than by the words you typed.
     Empty until you ask: building the index costs a round trip per batch of
     messages, and doing it on every keystroke would be absurd. */
  const [semanticHits, setSemanticHits] = useState([]);
  const [semanticState, setSemanticState] = useState('idle'); // idle | working | done | failed
  const [semanticProgress, setSemanticProgress] = useState(null);
  /** How big the chat index has grown, or null if there is none. */
  const [indexUsage, setIndexUsage] = useState(null);
  const [systemPrompt, setSystemPrompt] = useState(() => getSetting('systemPrompt') || 'You are Claude, a helpful, honest, and harmless AI assistant.');
  const [temperature, setTemperature] = useState(() => {
    const val = getSetting('temperature');
    return val !== null ? parseFloat(val) : 0.7;
  });
  /* Raised once for installs still carrying the old default, which was set
     before reasoning models and is why long answers stopped mid-sentence. See
     `contextDefault.js` for the measurements. */
  const [maxTokens, setMaxTokens] = useState(() => raiseIfUntouched(getSetting('maxTokens'), {
    oldDefault: OLD_MAX_TOKENS,
    newDefault: DEFAULT_MAX_TOKENS,
    alreadyDone: getSetting(MIGRATION_KEY) === 'true',
  }).value);
  const [codeTheme, setCodeTheme] = useState(() => getSetting('codeTheme') || 'atom-one-dark');
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  // On a phone the search field cannot share the header row with the model
  // picker — one of them ends up off the edge, and for a while it was the model
  // picker. So the field is reached from a button and takes a row of its own.
  // On a wide screen it is simply always there and this does nothing.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHitIndex, setSearchHitIndex] = useState(0);
  const [starredOnly, setStarredOnly] = useState(false);
  /* Which tags the sidebar is narrowed to, and which chat's tag editor is
     open. Neither is worth remembering across a reload: a filter you did
     not set is a sidebar that has lost half your chats for no visible
     reason, which is the single most alarming thing a chat list can do. */
  const [tagFilter, setTagFilter] = useState([]);
  const [tagEditorFor, setTagEditorFor] = useState(null);
  const [tagDraft, setTagDraft] = useState('');
  /* Which message is showing a diff against its previous answer. One at a
     time, by index: two open diffs in one transcript is two things to read
     instead of the comparison you opened the first one for. */
  const [diffFor, setDiffFor] = useState(null);
  /* Which results have their settings open, as `message:picture`. Several at
     once, unlike the diff: comparing two pictures' settings side by side is the
     reason to open the second. Not kept -- a reload closes them all. */
  const [shownSettings, setShownSettings] = useState({});
  /* Rules for which model answers what. Read through a ref in the send path
     for the usual reason: a turn outlives the render that started it. */
  const [routingEnabled, setRoutingEnabled] = useState(() => getSetting('routingEnabled') === 'true');
  const [modelRules, setModelRules] = useState([]);
  const modelRulesRef = useRef(modelRules);
  modelRulesRef.current = modelRules;
  const routingEnabledRef = useRef(routingEnabled);
  routingEnabledRef.current = routingEnabled;
  /* Saved sequences of prompts, and the one the composer is armed with.
     Armed rather than run immediately: a chain runs *on* something, and
     what it runs on is whatever gets typed next. */
  const [chains, setChains] = useState([]);
  const [armedChain, setArmedChain] = useState(null);
  const [chainEditor, setChainEditor] = useState(null);
  /* Long-conversation memory. On by default: the thing it fixes -- a chat that
     gets slower every turn until it stops fitting -- is the default experience
     without it, and somebody who wants the whole transcript sent can say so. */
  const [convMemory, setConvMemory] = useState(() => getSetting('convMemory') !== 'false');
  const convMemoryRef = useRef(convMemory);
  convMemoryRef.current = convMemory;
  /* Who is asking. The other half of the persona pair -- personas say who the
     assistant is, and nothing said who the person is. */
  const [userProfile, setUserProfile] = useState(emptyProfile);
  const [thinkOverrides, setThinkOverrides] = useState({});
  const messageRefs = useRef({});
  const chatSearchRef = useRef(null);
  const searchVisitedRef = useRef(false);
  const [showChatInfo, setShowChatInfo] = useState(false);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);

  /* Published copies of conversations.
   *
   * `shareUrls` is not duplication of `shares`: the server keeps only a hash
   * of each token, so it can list what exists but can never show the link
   * again. The URL therefore lives on the device that made it. See
   * src/shareLink.js. */
  const [shares, setShares] = useState([]);
  const [shareUrls, setShareUrls] = useState({});
  const [shareBusy, setShareBusy] = useState(false);
  const [shareExpiryDays, setShareExpiryDays] = useState(0);
  const [justShared, setJustShared] = useState('');
  const [showSystemMonitor, setShowSystemMonitor] = useState(false);
  /* Two panels behind one door. The machine and the habit are different
     questions, but they are the same curiosity -- "how is this going" --
     and a second overlay would be a second thing to find. */
  const [monitorTab, setMonitorTab] = useState('system');
  const [showCompare, setShowCompare] = useState(false);
  const [showSystemStrip, setShowSystemStrip] = useState(() => getSetting('showSystemStrip') !== 'false');
  const lastDeletedRef = useRef(null);

  // --- Appearance ---
  const [theme, setTheme] = useState(() => getSetting('theme') || 'system');
  const { t, lang, setLang, dir } = useI18n();

  // --- Who is signed in ---
  //
  // One source, and it is the server's. The provider above this tree has
  // already asked and already pointed the settings store at the right account;
  // by the time this component exists the answer is settled and cannot change
  // underneath it, because a change of identity remounts the tree rather than
  // updating it. That is the whole fix: there is no longer a window in which
  // this component believes one thing and the server believes another.
  const authSession = useSession();
  const user = authSession.user;

  const [syncInfo, setSyncInfo] = useState(authSession.stateInfo || null);
  const [syncBusy, setSyncBusy] = useState('');
  const [serverConfig, setServerConfig] = useState(null);
  const syncRef = useRef(null);
  // The account's savedAt that this device already accounts for. Anything newer
  // came from somewhere else and is worth pulling; our own pushes update it so
  // they do not read as remote changes.
  const syncStampRef = useRef(0);
  const settingsPrintRef = useRef('');

  /**
   * Whose data is on screen.
   *
   * Derived from the session and from nothing else. The version this replaces
   * took a server account *and* a browser-local profile and preferred whichever
   * was present, which meant the same browser produced two different answers
   * seconds apart during boot — and wrote chats into both.
   */
  const profileScope = deriveScope(user, 'ready');
  const accountId = ownerOfScope(profileScope);

  // Every setting read goes through the store, so it has to be told before the
  // render that reads them. The provider already did this; repeating it is a
  // cheap guarantee that no render can ever see another account's values.
  if (getActiveScope() !== profileScope) setActiveScope(profileScope);
  const storageKey = sessionStorageKeyFor(profileScope);

  // Read from callbacks that outlive the render they were created in.
  const profileScopeRef = useRef(profileScope);
  profileScopeRef.current = profileScope;

  // Read once, synchronously, because it decides what the very first render
  // shows. A sign-out has to land on the sign-in screen even though this
  // browser has long since seen the intro.
  const [handoff] = useState(takeHandoff);
  const [showAuthScreen, setShowAuthScreen] = useState(
    () => !user && (handoff?.kind === 'signed-out' || getSetting('authIntroSeen') !== 'true'),
  );

  // The sign-in that produced this tree happened in the tree before it, so this
  // is where its result is actually reported.
  useEffect(() => {
    if (handoff?.kind !== 'signed-in') return;
    toast(
      handoff.created ? t('auth.created') : t('auth.welcomeUser', { name: handoff.name }),
      'success',
    );
    addLog(`Signed in as ${handoff.name} (${handoff.provider}).`, 'success');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(() => getSetting('googleClientId') || '');
  const [kakaoRestKey, setKakaoRestKey] = useState(() => getSetting('kakaoRestKey') || '');

  useEffect(() => { setSetting('googleClientId', googleClientId); }, [googleClientId]);
  useEffect(() => { setSetting('kakaoRestKey', kakaoRestKey); }, [kakaoRestKey]);

  // Whatever the old browser-local login left on disk that was never safe to
  // keep. Those accounts cannot authenticate anything any more; their password
  // hashes and passkey keys are only material to be scraped.
  useEffect(() => { purgeLegacyCredentials(); }, []);

  // Told to the model so "what is the weather" has somewhere to be about. Not
  // read from the browser: geolocation needs both a permission prompt and a
  // secure context, and this app is routinely opened over plain HTTP.
  const [userLocation, setUserLocation] = useState(() => getSetting('userLocation') || '');
  useEffect(() => { setSetting('userLocation', userLocation); }, [userLocation]);

  const [chatFontSize, setChatFontSize] = useState(() => getSetting('chatFontSize') || 'medium');
  const [chatDensity, setChatDensity] = useState(() => getSetting('chatDensity') || 'comfortable');
  // How wide the conversation is allowed to get. 768px was hardcoded, which is
  // a comfortable measure for prose on a laptop and a waste of two thirds of a
  // 27-inch monitor -- and too narrow for anyone reading tables or diffs.
  const [contentWidth, setContentWidth] = useState(() => getSetting('contentWidth') || 'medium');
  // Off where the device cannot do it anyway, so the switch is not offered as
  // a setting that does nothing.
  const [hapticsOn, setHapticsOn] = useState(() => {
    const saved = getSetting('haptics');
    return saved === null ? true : saved === 'true';
  });
  const [showOutline, setShowOutline] = useState(false);
  const [motionMode, setMotionMode] = useState(() => getSetting('motionMode') || 'system');
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
  //
  // `getSetting`, not `localStorage.getItem`. That distinction is the whole
  // reason a phone and a laptop signed into the same account disagreed about
  // every one of these.
  //
  // Settings belong to an account, so they are stored under a key carrying its
  // scope -- `topP@srv-abc`, not `topP` (see src/settingsStore.js). Every one
  // of these values was *written* through `setSetting`, which does that, and
  // *read* straight out of localStorage, which does not. So the scoped value
  // was written, synced, downloaded onto the other device -- and then never
  // read by anything. Both machines started from the built-in default on every
  // load, which is why they never matched and why changing one changed nothing
  // anywhere.
  const readNum = (key, fallback) => {
    const val = getSetting(key);
    return val !== null && val !== '' ? parseFloat(val) : fallback;
  };
  const [topP, setTopP] = useState(() => readNum('topP', 0.9));
  const [topK, setTopK] = useState(() => readNum('topK', 40));
  const [repeatPenalty, setRepeatPenalty] = useState(() => readNum('repeatPenalty', 1.1));
  const [numCtx, setNumCtx] = useState(() => raiseIfUntouched(getSetting('numCtx'), {
    oldDefault: OLD_NUM_CTX,
    newDefault: DEFAULT_NUM_CTX,
    alreadyDone: getSetting(MIGRATION_KEY) === 'true',
  }).value);
  const [seed, setSeed] = useState(() => getSetting('seed') || '');
  // 'auto' leaves the field out entirely so each model keeps its own default.
  // The rest are a scale, not a switch -- see THINK_MODES.
  const [thinkMode, setThinkMode] = useState(() => readThinkMode(getSetting('thinkMode')));
  // One tool call per turn made `search -> open the page -> answer` impossible,
  // so answers stayed at snippet depth. A small budget allows a real chain.
  const [toolBudget, setToolBudget] = useState(() => readNum('toolBudget', 5));
  /* Questions that could not be sent. Loaded from storage on purpose: the
     failures that matter most are the ones where you give up and refresh. */
  const [sendQueue, setSendQueue] = useState([]);
  const [autoGround, setAutoGround] = useState(() => getSetting('autoGround') !== 'false');
  /* Deep research: several searches, several pages actually read, one cited
     answer. Off at every load rather than remembered, because it costs
     minutes -- a mode that silently persists is one you discover by waiting
     four minutes for the answer to "what time is it". The depth is
     remembered; whether it is armed is not. */
  const [researchMode, setResearchMode] = useState(false);
  const [researchDepth, setResearchDepth] = useState(() => getSetting('researchDepth') || 'normal');
  // Ollama's `format` field: 'json' forces valid JSON, and a JSON Schema
  // object constrains the shape field by field.
  const [outputFormat, setOutputFormat] = useState(() => getSetting('outputFormat') || 'text');
  const [outputSchema, setOutputSchema] = useState(() => getSetting('outputSchema') || '');
  const [schemaError, setSchemaError] = useState('');

  useEffect(() => {
    setSetting('outputFormat', outputFormat);
    setSetting('outputSchema', outputSchema);
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
  const [ragEnabled, setRagEnabled] = useState(() => getSetting('ragEnabled') !== 'false');
  const [embedModel, setEmbedModel] = useState(() => getSetting('embedModel') || DEFAULT_EMBED_MODEL);
  const [ragTopK, setRagTopK] = useState(() => readNum('ragTopK', 5));

  // --- Cross-chat memory ---
  const [memories, setMemories] = useState([]);
  const [memoryEnabled, setMemoryEnabled] = useState(() => getSetting('memoryEnabled') !== 'false');
  const [autoRemember, setAutoRemember] = useState(() => getSetting('autoRemember') === 'true');
  const [extractingMemory, setExtractingMemory] = useState(false);

  // --- Regeneration variants ---
  // Set just before a retry so the finished answer knows which earlier answers
  // it has to join rather than replace.
  const pendingVariantsRef = useRef(null);

  // --- Auto-continue ---
  const [autoContinue, setAutoContinue] = useState(() => getSetting('autoContinue') === 'true');
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
  const folderDocRef = useRef(null);
  // The name of the file being indexed into a folder, or null.
  const [folderIngest, setFolderIngest] = useState(null);
  const [rowMenuFor, setRowMenuFor] = useState(null);
  // The menu renders at the document root, so it needs the button it belongs to.
  const rowMenuAnchors = useRef({});

  // --- Sampling presets ---
  const [presets, setPresets] = useState([]);
  const [newPresetName, setNewPresetName] = useState('');

  /* Saved system prompts.
   *
   * Which one is "in effect" is worked out by comparing bodies rather than
   * stored as an id -- the box below stays editable, and a remembered id would
   * go on claiming "Code reviewer" after the text had been replaced. */
  const [personas, setPersonas] = useState(() => loadPersonas(''));
  const [newPersonaName, setNewPersonaName] = useState('');
  const [newPersonaAvatar, setNewPersonaAvatar] = useState('');
  const [newPersonaGreeting, setNewPersonaGreeting] = useState('');
  /* Whether the persona being saved pins the model and sampling numbers
     that are currently set. Off by default: a persona that pins a model
     is unusable on a machine without it, so pinning is a choice. */
  const [pinPersonaSetup, setPinPersonaSetup] = useState(false);
  const [editingPersonaId, setEditingPersonaId] = useState(null);

  useEffect(() => { setSetting('autoContinue', String(autoContinue)); }, [autoContinue]);
  useEffect(() => { setFolders(loadFolders(profileScope)); }, [profileScope]);
  useEffect(() => { setPresets(loadPresets(profileScope)); }, [profileScope]);
  useEffect(() => { setPersonas(loadPersonas(profileScope)); }, [profileScope]);

  // --- Context compaction ---
  const [autoCompact, setAutoCompact] = useState(() => getSetting('autoCompact') !== 'false');
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    setSetting('memoryEnabled', String(memoryEnabled));
    setSetting('autoRemember', String(autoRemember));
    setSetting('autoCompact', String(autoCompact));
  }, [memoryEnabled, autoRemember, autoCompact]);

  useEffect(() => {
    setSetting('ragEnabled', String(ragEnabled));
    setSetting('embedModel', embedModel);
    setSetting('ragTopK', String(ragTopK));
  }, [ragEnabled, embedModel, ragTopK]);
  const [stopSequences, setStopSequences] = useState(() => getSetting('stopSequences') || '');
  const [minP, setMinP] = useState(() => readNum('minP', 0));
  const [presencePenalty, setPresencePenalty] = useState(() => readNum('presencePenalty', 0));
  const [frequencyPenalty, setFrequencyPenalty] = useState(() => readNum('frequencyPenalty', 0));
  // How long Ollama keeps a model in VRAM after the last request.
  const [keepAlive, setKeepAlive] = useState(() => getSetting('keepAlive') || '5m');

  // --- Behaviour ---
  const [defaultModel, setDefaultModel] = useState(() => getSetting('defaultModel') || '');
  const [autoTitle, setAutoTitle] = useState(() => getSetting('autoTitle') !== 'false');
  const [sendKey, setSendKey] = useState(() => getSetting('sendKey') || 'enter');
  const [showTimestamps, setShowTimestamps] = useState(() => getSetting('showTimestamps') === 'true');
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
      const saved = JSON.parse(getSetting('promptLibrary') || 'null');
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

  /* Where the up arrow has walked back to, and what was in the box before it
     started walking.
     Refs, not state, for both. Nothing renders from either — and holding the
     up arrow fires key repeats faster than React re-renders, so a state value
     read from the handler's closure would still say NOT_BROWSING on the third
     repeat and walk to the same entry every time. A ref is current on the very
     next event, which is what a held key needs. */
  const historyIndexRef = useRef(NOT_BROWSING);
  const historyDraftRef = useRef('');
  const [isDragging, setIsDragging] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Reading position, 0 to 1. See handleScroll for why it is worth having.
  const [scrollProgress, setScrollProgress] = useState(0);
  const [showTopBtn, setShowTopBtn] = useState(false);

  // --- Model management ---
  const [runningModels, setRunningModels] = useState([]);
  const [pullProgress, setPullProgress] = useState(null); // { status, percent }
  const [settingsTab, setSettingsTab] = useState('general');

  // --- The settings tab strip ---
  //
  // Nine tabs and a phone's width: the strip scrolls sideways, and two things
  // have to be true for that to be usable rather than a place tabs go to hide.
  //
  // The active tab has to be *on screen*, and it is not always reached by
  // tapping it -- the command palette opens Knowledge, Voice or Account
  // directly, and the strip would still be showing the first five.
  //
  // And there has to be some sign that the strip scrolls at all. The browser's
  // own scrollbar is not it: a few grey pixels over the tab labels, not drawn
  // until the strip is already moving. So which edge has more behind it is
  // measured here and the stylesheet fades that edge.
  //
  // The strip is held as state rather than in a ref, and that is the part that
  // took two attempts to get right. `Transition` raises its `mounted` flag
  // from inside an effect, so on the commit where `showSettings` becomes true
  // the panel returns null and there is no strip in the document yet -- a ref
  // read at that moment is empty, and the effect that reads it does not run
  // again, because none of its dependencies changed when the strip finally
  // appeared. Opening Voice from the command palette landed exactly there: the
  // seventh tab was active and the strip was still showing the first five.
  //
  // A callback ref that sets state turns "the node exists now" into a
  // dependency, so there is no frame to guess at.
  const [tabStrip, setTabStrip] = useState(null);
  const [tabOverflow, setTabOverflow] = useState(null);

  const measureTabOverflow = useCallback((strip) => {
    if (!strip) return;
    const slack = strip.scrollWidth - strip.clientWidth;
    // Everything fits -- on a desktop it wraps instead and there is no
    // scrolling to advertise.
    if (slack <= 2) { setTabOverflow(null); return; }
    // `Math.abs` is what makes this work in Arabic: a right-to-left scroll
    // container counts from 0 down to negative, so the raw number is the
    // right distance with the wrong sign.
    const travelled = Math.abs(strip.scrollLeft);
    if (travelled <= 2) { setTabOverflow('end'); return; }
    if (travelled >= slack - 2) { setTabOverflow('start'); return; }
    setTabOverflow('both');
  }, []);

  useEffect(() => {
    if (!showSettings || !tabStrip) { setTabOverflow(null); return undefined; }

    const settle = () => {
      // A strip with no width has nothing to scroll and nothing to measure;
      // acting on it would only record "everything fits" and stop.
      if (tabStrip.clientWidth === 0) return;
      tabStrip.querySelector('.settings-tab.active')
        ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      measureTabOverflow(tabStrip);
    };

    // A ResizeObserver rather than a frame or a timeout.
    //
    // The panel is mounted by a transition, so the tabs have no width for the
    // first frame or two after it opens -- and how many depends on what else
    // was on screen. Opening settings from the command palette was the case
    // that showed it: one animation was still closing while this one started,
    // the strip was measured at zero, and the active tab therefore never
    // scrolled into view. Reaching Voice from the palette left the strip
    // showing the first five tabs with no sign that the seventh was the one
    // now open.
    //
    // An observer does not have to guess. It fires when the strip first has a
    // size, and again whenever that size changes -- a rotated phone, a
    // resized window, a font that finished loading, a language whose tab
    // labels are wider.
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(settle)
      : null;
    if (observer) observer.observe(tabStrip);

    // Two frames as the fallback, and also as a belt for the case where the
    // strip's box never changes size at all -- reopening the panel at the same
    // width on a tab further along, where there is still an active tab to
    // bring into view.
    const frame = requestAnimationFrame(() => requestAnimationFrame(settle));

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
    // `lang` is in here because the tab labels are translated: the strip is a
    // different width in German than in Korean, and the fade has to follow.
  }, [showSettings, settingsTab, lang, tabStrip, measureTabOverflow]);

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
    setSetting('theme', theme);
  }, [theme]);

  // Reading comfort is expressed as CSS variables so every surface follows.
  useEffect(() => {
    const root = document.documentElement;
    const sizes = { small: '0.9rem', medium: '1rem', large: '1.12rem' };
    root.style.setProperty('--chat-font-size', sizes[chatFontSize] || sizes.medium);
    const compact = chatDensity === 'compact';
    root.style.setProperty('--chat-gap', compact ? '1.15rem' : '2rem');
    root.style.setProperty('--bubble-padding', compact ? '0.5rem 0.8rem' : '0.75rem 1rem');
    setSetting('chatFontSize', chatFontSize);
    setSetting('chatDensity', chatDensity);
  }, [chatFontSize, chatDensity]);

  // The conversation and the composer read the same variable, so they stay the
  // same width as each other however it is set -- a composer wider than the
  // answers above it reads as a layout bug rather than a preference.
  useEffect(() => {
    const widths = { narrow: '640px', medium: '768px', wide: '1100px' };
    document.documentElement.style.setProperty('--content-width', widths[contentWidth] || widths.medium);
    setSetting('contentWidth', contentWidth);
  }, [contentWidth]);

  // The module keeps the answer in a variable because `haptic()` runs on the
  // tap path, where a synchronous localStorage read would be the slowest thing
  // in the handler.
  useEffect(() => {
    setHapticsEnabled(hapticsOn);
    setSetting('haptics', String(hapticsOn));
  }, [hapticsOn]);

  // 'system' leaves the attribute off so the prefers-reduced-motion media
  // query stays in charge; the other two are explicit overrides.
  useEffect(() => {
    const root = document.documentElement;
    if (motionMode === 'system') root.removeAttribute('data-motion');
    else root.setAttribute('data-motion', motionMode);
    setSetting('motionMode', motionMode);
  }, [motionMode]);

  useEffect(() => {
    setSetting('topP', String(topP));
    setSetting('topK', String(topK));
    setSetting('repeatPenalty', String(repeatPenalty));
    setSetting('numCtx', String(numCtx));
    setSetting('seed', seed);
    setSetting('stopSequences', stopSequences);
    setSetting('thinkMode', thinkMode);
    setSetting('minP', String(minP));
    setSetting('presencePenalty', String(presencePenalty));
    setSetting('frequencyPenalty', String(frequencyPenalty));
    setSetting('keepAlive', keepAlive);
    setSetting('toolBudget', String(toolBudget));
    setSetting('autoGround', String(autoGround));
    setSetting('researchDepth', researchDepth);
    setSetting('routingEnabled', String(routingEnabled));
    setSetting('convMemory', String(convMemory));
  }, [topP, topK, repeatPenalty, numCtx, seed, stopSequences, thinkMode, minP, presencePenalty, frequencyPenalty, keepAlive, toolBudget, autoGround, researchDepth, routingEnabled, convMemory]);

  useEffect(() => {
    setSetting('defaultModel', defaultModel);
    setSetting('autoTitle', String(autoTitle));
    setSetting('sendKey', sendKey);
    setSetting('showTimestamps', String(showTimestamps));
    setSetting('showSystemStrip', String(showSystemStrip));
  }, [defaultModel, autoTitle, sendKey, showTimestamps, showSystemStrip]);

  useEffect(() => {
    setSetting('promptLibrary', JSON.stringify(promptLibrary));
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
    setSetting('systemPrompt', systemPrompt);
    setSetting('temperature', temperature.toString());
    setSetting('maxTokens', maxTokens.toString());
    setSetting('codeTheme', codeTheme);
  }, [systemPrompt, temperature, maxTokens, codeTheme]);

  /* Recorded once, after the raised defaults have been read and written above.
     Without it the raise would happen again every load — including after
     somebody deliberately set 4096 back, which would be the app overruling
     them rather than fixing a default. */
  useEffect(() => { setSetting(MIGRATION_KEY, 'true'); }, []);

  // --- Toasts (replaces the blocking alert() calls) ---
  const [toasts, setToasts] = useState([]);
  // `action` renders an inline button, e.g. "Undo" after deleting a chat.
  const toast = useCallback((message, type = 'info', ms = 4000, action = null) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, type, action }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ms);
  }, []);
  const dismissToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  // --- Installing, and staying up to date ---
  //
  // `installReady` is only true while the browser is holding an install prompt
  // for us. It is not "this app can be installed": Firefox and Safari never
  // fire the event, and an app that is already installed does not fire it
  // again, so a button shown on that basis would be a button that does nothing
  // for a good half of the people who see it.
  const [installReady, setInstallReady] = useState(false);
  const [runningAsApp, setRunningAsApp] = useState(() => isStandalone());
  const installRef = useRef(null);

  useEffect(() => {
    const watcher = watchInstallPrompt(setInstallReady);
    installRef.current = watcher;
    return () => { watcher.dispose(); installRef.current = null; };
  }, []);

  // Installing does not reload, so nothing else would notice that the app is
  // now an app -- and the "install" button would stay on screen inside the
  // window it just opened.
  useEffect(() => {
    const query = window.matchMedia?.('(display-mode: standalone)');
    if (!query) return undefined;
    const onChange = () => setRunningAsApp(isStandalone());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const promptInstall = useCallback(async () => {
    const accepted = await installRef.current?.prompt();
    if (accepted) {
      haptic('medium');
      toast(t('pwa.installed'), 'success');
    }
  }, [toast, t]);

  // A waiting worker is a build the user has not agreed to run yet. The toast
  // does not expire on its own: it is the only way to get the new version, and
  // a notice that vanishes after four seconds is a notice nobody sees.
  //
  // Registered exactly once. The handler is reached through a ref rather than
  // being a dependency, because it closes over `t` -- so listing it would
  // unregister and re-register the worker every time the language changed.
  const updateNoticeRef = useRef(null);
  updateNoticeRef.current = (apply) => toast(t('pwa.updateReady'), 'info', 1000 * 60 * 60, {
    label: t('pwa.reload'),
    onClick: apply,
  });
  useEffect(() => registerServiceWorker({
    onUpdate: (apply) => updateNoticeRef.current?.(apply),
  }), []);

  // STT / TTS States
  const [isListening, setIsListening] = useState(false);
  /* Recording has stopped and the clip is with the transcriber. A separate
     state from `isListening` because they look different and mean different
     things: one is "say something", the other is "wait". */
  const [isTranscribing, setIsTranscribing] = useState(false);
  /* Which Whisper the local server should load. The default is what
     faster-whisper-server ships with; anything it can fetch works. */
  const [sttModel, setSttModel] = useState(() => getSetting('sttModel') || 'Systran/faster-whisper-small');
  /* Saved by its own effect, right here.
     It was added to the settings effect four hundred lines above instead, and
     a dependency array is evaluated *during render* -- so the app read this
     `const` before the line that declares it and threw
     `Cannot access 'sttModel' before initialization` at boot. That is the
     fourth time this exact shape has broken this file; an effect belongs
     beside the state it saves. */
  useEffect(() => { setSetting('sttModel', sttModel); }, [sttModel]);
  /* The transcript handler, by ref.
     The browser's recogniser is built once in an effect that runs before
     `heard` exists, so it cannot close over it -- the same shape as
     `onHeardRef` below, and for the same reason. */
  const heardRef = useRef(() => {});
  const recognitionRef = useRef(null);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const audioRef = useRef(null);

  // --- Voice settings ---
  // Scoped, for the same reason as `readNum` above. `ttsRefAudio` is the one
  // exception and it needs no special case here: the store lists it as
  // machine-local, so `getSetting` returns the unscoped key for it and a
  // reference clip stays on the machine whose disk it names.
  const readStr = (key, fallback) => {
    const val = getSetting(key);
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
    setSetting('ttsEngine', ttsEngine);
    setSetting('ttsRefAudio', ttsRefAudio);
    setSetting('ttsPromptText', ttsPromptText);
    setSetting('ttsTextLang', ttsTextLang);
    setSetting('ttsPromptLang', ttsPromptLang);
    setSetting('ttsSpeed', String(ttsSpeed));
    setSetting('ttsMaxChars', String(ttsMaxChars));
    setSetting('ttsAutoPlay', String(ttsAutoPlay));
  }, [ttsEngine, ttsRefAudio, ttsPromptText, ttsTextLang, ttsPromptLang, ttsSpeed, ttsMaxChars, ttsAutoPlay]);

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.onresult = (e) => {
        setIsListening(false);
        // Through the same handler the local transcriber uses, so the two
        // paths cannot drift apart.
        heardRef.current(e.results[0][0].transcript);
      };
      recognitionRef.current.onerror = (e) => {
        setIsListening(false);
        addLog(`Speech recognition error: ${e.error}`, 'error');
        // No microphone permission is not a transient failure, and the idle
        // watcher would otherwise ask for it again every half second.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          voiceModeRef.current = false;
          setVoiceMode(false);
        }
      };
      recognitionRef.current.onend = () => {
        setIsListening(false);
        // Silence, or a pause the browser decided was the end. Listening again
        // is left to the idle watcher further down, so that exactly one piece
        // of code decides when the microphone opens.
      };
    }
  }, []);

  /* One transcript, wherever it came from.
   *
   * Both recognisers end here so the two paths cannot drift: in hands-free the
   * transcript is the question and goes straight out, and plain dictation puts
   * the words in the composer without sending, because a slip of the tongue
   * should be editable. */
  const heard = (transcript) => {
    const text = String(transcript || '').trim();
    if (!text) return;
    if (onHeardRef.current?.(text)) return;
    setInput(prev => prev + (prev ? ' ' : '') + text);
  };
  heardRef.current = heard;

  /* Recording for a local Whisper, when there is one to send to.
   *
   * Held in a ref rather than state: the only thing that reads it is the stop
   * that follows the start, and a re-render between them would drop the
   * recorder on the floor. */
  const localRecorderRef = useRef(null);

  const toggleListening = async () => {
    // A recording in progress is stopped and transcribed, whichever recogniser
    // is in use.
    if (localRecorderRef.current) {
      const rec = localRecorderRef.current;
      localRecorderRef.current = null;
      setIsListening(false);
      setIsTranscribing(true);
      try {
        heard(await rec.stop());
      } catch (e) {
        addLog(`[stt] local transcription failed: ${e.message}`, 'error');
        toast(t('voice.sttFailed'), 'error', 6000);
      } finally {
        setIsTranscribing(false);
      }
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    /* Prefer the local one. The browser's recogniser uploads the audio to
       Google on Chrome -- it needs the internet, it sends what you said to a
       third party, and it is markedly worse in Korean. Where a local Whisper
       is running, it is better on every count. */
    if (await localSttAvailable()) {
      try {
        localRecorderRef.current = await recordAndTranscribe({
          language: whisperLanguage(lang),
          model: sttModel,
        });
        setIsListening(true);
        addLog('[stt] recording for the local transcriber', 'info');
        return;
      } catch (e) {
        // No microphone permission, or no recorder. Fall through to the
        // browser's, which will report the same thing in its own way.
        addLog(`[stt] could not start recording: ${e.message}`, 'error');
        localRecorderRef.current = null;
      }
    }

    if (!recognitionRef.current) {
      addLog('Speech Recognition API not supported in this browser.', 'error');
      toast(t('voice.noRecogniser'), 'error', 7000);
      return;
    }
    recognitionRef.current.start();
    setIsListening(true);
  };


  const stopSpeaking = useCallback(() => {
    // Anything still waiting to be said must go, or stopping would silence the
    // clip that is playing and then start the next one a second later.
    speechQueueRef.current = [];
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
      toast(t('toast.noSpeech'), 'error');
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

  /**
   * Play one clip, and resolve when it has finished.
   *
   * Pulled out of `speakMessage` so that several pieces of one answer can be
   * played back to back. Resolves rather than rejects on a playback error:
   * a queue that stops dead on one bad clip leaves the rest of the answer
   * unspoken, and the reader would rather hear the remainder.
   */
  const playBlob = (blob) => new Promise((resolve) => {
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio.dataset.objectUrl = audioUrl;
    audioRef.current = audio;

    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(audioUrl);
      if (audioRef.current === audio) audioRef.current = null;
      if (!ok) toast(t('toast.audioFailed'), 'error');
      resolve();
    };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.play().catch(() => done(false));
  });

  /* Pieces of an answer waiting to be spoken, and whether the pump is running.
   *
   * Refs, not state: the pump is a loop that must see what was pushed while it
   * was awaiting the previous clip, and a state value captured when the loop
   * started would be the queue as it was a sentence ago. */
  const speechQueueRef = useRef([]);
  const speechPumpRef = useRef(false);

  /**
   * Say this next.
   *
   * The reply used to be spoken only once it had finished. On a local 31B at
   * four tokens a second that is a minute or two of silence first — and in
   * hands-free mode, where the point is not to be looking at the screen, a
   * minute of silence is indistinguishable from the app having died.
   */
  const enqueueSpeech = async (piece, index) => {
    const text = stripForSpeech(piece);
    if (!text) return;
    speechQueueRef.current.push({ text, index });
    if (speechPumpRef.current) return;

    speechPumpRef.current = true;
    setSpeakingIndex(index);
    try {
      while (speechQueueRef.current.length > 0) {
        const next = speechQueueRef.current.shift();
        await synthesiseAndPlay(next.text, next.index);
      }
    } finally {
      speechPumpRef.current = false;
      // Only if nothing else started in the meantime.
      if (speechQueueRef.current.length === 0) setSpeakingIndex(null);
    }
  };

  /**
   * One piece: synthesise it and play it to the end.
   *
   * This was the whole of `speakMessage`. It is separate now because an answer
   * is spoken in pieces as it arrives, and the queue above needs something it
   * can await once per piece.
   */
  const synthesiseAndPlay = async (cleanText, index) => {
    if (ttsEngine === 'browser') {
      await speakWithBrowser(cleanText, index);
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
        toast(t('toast.sovitsStarting'), 'info', 8000);
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
      setIsSynthesizing(false);
      // Awaited, so the caller knows when this piece has finished playing --
      // which is what lets the queue below play the next one immediately after
      // rather than on top of it.
      await playBlob(blob);
    } catch (error) {
      console.error('GPT-SoVITS TTS Error:', error);
      addLog(`[TTS] ${error.message}`, 'error');
      toast(t('toast.ttsFailed', { error: error.message }), 'error', 6000);
      stopSpeaking();
    }
  };

  /**
   * Read a whole message out.
   *
   * Split into sentences and queued, which is the same path a streamed answer
   * takes -- so a message read from the speaker button sounds exactly like one
   * that was read as it arrived, rather than the two drifting into different
   * phrasing. See src/speechChunks.js.
   */
  const speakMessage = async (text, index) => {
    // Clicking the speaker on the message that is already playing stops it.
    if (speakingIndex === index) {
      stopSpeaking();
      return;
    }
    stopSpeaking();

    let cleanText = stripForSpeech(text);
    if (!cleanText) {
      toast(t('toast.nothingToRead'), 'info');
      return;
    }
    if (cleanText.length > ttsMaxChars) {
      cleanText = `${safeHead(cleanText, ttsMaxChars)}…`;
      addLog(`[TTS] Text truncated to ${ttsMaxChars} characters.`, 'info');
    }

    for (const piece of splitForSpeech(cleanText)) await enqueueSpeech(piece, index);
  };

  // Sessions State
  const [sessions, setSessions] = useState([{ id: nextSessionId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' }]);
  const [currentSessionId, setCurrentSessionId] = useState(sessions[0].id);
  const [isStorageLoaded, setIsStorageLoaded] = useState(false);

  // The active chat is remembered per profile. Ids are numbers but localStorage
  // hands back strings, so every comparison goes through String().
  const lastChatKey = `${storageKey}:last`;

  // Sessions are stored in creation order while the sidebar lists them by
  // recency, so "the first one" and "the one on top" are different chats.
  // Anything that has to pick a chat on the user's behalf picks by recency.
  const mostRecent = (list) =>
    [...list].sort((a, b) => conversationTime(b) - conversationTime(a))[0];

  const pickRestoredId = (list) => {
    const wanted = (() => { try { return localStorage.getItem(lastChatKey); } catch (e) { return null; } })();
    const match = wanted && list.find(x => String(x.id) === String(wanted));
    return (match || mostRecent(list)).id;
  };

  useEffect(() => {
    let cancelled = false;
    loadLibrary(profileScope).then(list => { if (!cancelled) setKnowledge(list); });
    return () => { cancelled = true; };
  }, [profileScope]);

  useEffect(() => {
    let cancelled = false;
    loadMemories(profileScope).then(list => { if (!cancelled) setMemories(list); });
    return () => { cancelled = true; };
  }, [profileScope]);

  useEffect(() => {
    let cancelled = false;
    setIsStorageLoaded(false);

    localforage.getItem(storageKey).then(async saved => {
      if (cancelled) return;

      // Nothing is copied between buckets here. This used to adopt whatever the
      // local profile had when the account's bucket looked empty, which sounds
      // harmless and was not: the scope read as the guest for as long as the
      // profile was still being restored, so a signed-in account could swallow
      // the guest's history — and then upload it. Chats cross accounts by
      // syncing with the same account, or by an import the person asked for,
      // and by nothing else.
      if (cancelled) return;

      /* Opening the app starts a new chat, the way opening a notebook
         starts on a blank page rather than in the middle of last week.

         It used to reopen whatever was last read, which sounds helpful
         and is only helpful once: on the second visit you are looking at
         a finished conversation, and the thing you actually came to do is
         behind a button. The old conversation has not gone anywhere -- it
         is the first row in the sidebar.

         The draft costs nothing to open. It is not written anywhere until
         something is said in it (see src/draftChat.js), so arriving and
         leaving again creates no chat at all. */
      if (saved && saved.length > 0) {
        const fresh = newDraft();
        setSessions([fresh, ...saved]);
        setCurrentSessionId(fresh.id);
      } else {
        // Migrate the pre-localforage data on the guest key only.
        const legacy = storageKey === 'ollama-sessions' ? localStorage.getItem('ollama-sessions') : null;
        let restored = false;
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy);
            if (parsed && parsed.length > 0) {
              const fresh = newDraft();
              setSessions([fresh, ...parsed]);
              setCurrentSessionId(fresh.id);
              restored = true;
            }
          } catch (e) {}
        }
        if (!restored) {
          const fresh = newDraft();
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
  }, [storageKey, profileScope]);
  
  /**
   * Re-read the chat list from storage into what is on screen.
   *
   * The list is read once, when this tree mounts, and the first exchange with
   * the account happens *after* that — so a chat written on another device
   * lands in storage a moment too late to be rendered, and the screen goes on
   * showing what it read. That is the whole of "I refreshed and my other
   * device's conversation is not there": it had arrived, into storage, and
   * nothing put it on screen. Opening a new tab appeared to fix it because the
   * new tab read the storage the previous one had just filled.
   *
   * The same thing happens between two tabs of one browser, which share the
   * store: one receives a reply, the other is still showing what it read at
   * mount.
   */
  const refreshChatsFromStorage = async () => {
    // A reply still streaming lives in state and is not in storage yet.
    // Re-reading would throw away the half of it that has arrived.
    if (isGeneratingRef.current) return false;
    let saved;
    try {
      saved = await localforage.getItem(storageKeyRef.current);
    } catch (e) {
      return false;
    }
    if (!saved || saved.length === 0) return false;

    /* Storage is the truth about conversations and knows nothing about
       drafts, which live only here until something is said in them. So a
       re-read has to carry them across rather than replace them away.

       Without this, switching to another browser tab and back moved you
       off the blank chat you were about to type in and onto whatever you
       last had a conversation in -- because the id being looked for was
       not in the list that came back, and the fallback picked the most
       recent. The draft was not stale; it was never going to be there. */
    const drafts = (sessionsRef.current || []).filter(isDraft);
    const held = new Set(drafts.map(d => String(d.id)));
    setSessions([...drafts, ...saved.filter(x => !held.has(String(x.id)))]);

    // Where you were is where you stay: a draft you are holding counts as
    // much as a conversation storage can confirm.
    setCurrentSessionId(id => (
      held.has(String(id)) || saved.some(x => x.id === id) ? id : pickRestoredId(saved)
    ));
    return true;
  };

  const currentSession = sessions.find(s => s.id === currentSessionId) || sessions[0] || { id: nextSessionId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
  const messages = currentSession?.messages || [];
  // For the global key handler, which is installed once and cannot see this.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const [input, setInput] = useState('');
  /* Which message the keyboard is on, or null before anything is focused.
     Mirrored into a ref because the global key handler is registered once and
     would otherwise read whatever this was on the render that installed it --
     which is null, for ever. */
  const [navIndex, setNavIndex] = useState(null);
  const navIndexRef = useRef(null);
  navIndexRef.current = navIndex;
  // An index into *this* chat's messages, so switching chats must forget it or
  // the ring lands on whatever happens to be in that position over there.
  // Both are indices into *this* chat's messages, so switching chats has to
  // forget them, or they land on whatever happens to be in that position
  // over there -- a diff of two unrelated answers, in the worst case.
  useEffect(() => { setNavIndex(null); setDiffFor(null); }, [currentSessionId]);
  const [isGenerating, setIsGenerating] = useState(false);
  /**
   * Which chat the answer being generated belongs to.
   *
   * A reply is written to the chat that asked for it, not to whichever one is
   * on screen: `handleSend` captures the id when it starts and every write it
   * makes goes there. That was already true, and it is what makes leaving the
   * chat safe -- but nothing on screen knew it, so the sidebar simply refused
   * to change chats while a reply was arriving. Waiting out a long answer to
   * look something up in another chat is not a rule anyone would choose; it
   * was a guard standing in for a fact the interface did not have.
   *
   * With the id held here the interface can tell the two apart: the chat being
   * written to shows a stop button and a spinner in the list, and every other
   * chat behaves as though nothing were happening -- because as far as that
   * chat is concerned, nothing is.
   */
  const [generatingSessionId, setGeneratingSessionId] = useState(null);

  /* The picture being drawn for the answer that is being written.
   *
   * A generation inside a conversation blocks the turn -- the answer genuinely
   * is not ready until the picture is -- so for a minute or three the only
   * thing on screen was the three dots that mean "thinking". They are the same
   * three dots whether it is sampling, upscaling, or has fallen over, which is
   * the one distinction worth drawing. This is the job id to watch; the stream
   * itself is `drawingLive` further down. */
  const [drawing, setDrawing] = useState(null);
  // How much of a generated picture is shown before someone chooses to see it.
  const safeLevel = useSafeguardLevel();

  /** Stop a picture this conversation asked for -- in ComfyUI, not just here. */
  const stopDrawing = (id) => {
    if (!id) return;
    fetch('/studio/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => { /* it was already going to be abandoned */ });
  };

  // The sync poll is set up once and runs for the life of the tab, so anything
  // it consults has to be read at call time. Reading the state variables
  // directly meant its "is the user busy?" check saw whatever was true when the
  // interval was created — false, always — and reloaded the page in the middle
  // of an answer.
  const isGeneratingRef = useRef(isGenerating);
  isGeneratingRef.current = isGenerating;
  useEffect(() => {
    // Fired however the reply ended — finished, stopped, or failed — so the
    // deferred sync check has a single thing to wait for.
    if (!isGenerating) window.dispatchEvent(new Event('webui:generation-ended'));
  }, [isGenerating]);

  /* Keep the screen on while the answer is being written.
   *
   * A phone blanks its screen after half a minute, and a browser whose screen
   * is off is eventually frozen outright -- no JavaScript, no stream, no
   * upload. It is the one case the sync work cannot reach from inside the
   * page, because a frozen page runs no code to fix itself with. Asking the
   * system not to sleep is the only thing that helps.
   *
   * Bounded by the answer, so there is no setting to forget to turn off: the
   * lock is taken when a reply starts and released when it ends, whichever way
   * it ended. Where the browser has no such lock -- desktop Safari, Firefox --
   * this does nothing at all and says nothing about it. */
  useEffect(() => {
    if (!isGenerating) return undefined;
    return holdScreenAwake();
  }, [isGenerating]);
  const inputRef = useRef(input);
  inputRef.current = input;

  /* ------------------------------- talking to it, rather than typing at it ---
   *
   * Every part of this already existed and none of it was joined up: dictation
   * put words in the composer and stopped, and auto-play read finished answers
   * aloud. Between them sat two manual steps -- press send, then press the
   * microphone again -- which is exactly the two steps you cannot do while
   * cooking, driving or holding a baby, and those are the times anyone wants
   * to talk to a computer instead of typing at it.
   *
   * Hands-free closes the loop: listen, send what was heard, read the answer
   * out, listen again. It is a mode rather than a setting because it takes
   * over the microphone and the speaker, and a thing that takes those over had
   * better be something you switched on deliberately and can see is on.
   *
   * The state machine is deliberately tiny -- idle / listening / thinking /
   * speaking -- and every transition is driven by an event that already
   * existed. Nothing polls.
   */
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false);
  voiceModeRef.current = voiceMode;
  const voiceHoldRef = useRef(null);
  const voiceHoldFiredRef = useRef(false);

  // What to do with a transcript, and what to do when speech finishes. Both
  // are reached through refs because the handlers that call them were attached
  // once, at mount, and close over that render's `handleSend` forever.
  const onHeardRef = useRef(null);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.start();
      setIsListening(true);
    } catch (e) {
      // `start()` throws if it is already running -- harmless, and the
      // alternative is tracking a second copy of state the browser owns.
    }
  }, []);

  const stopVoiceMode = useCallback(() => {
    setVoiceMode(false);
    voiceModeRef.current = false;
    try { recognitionRef.current?.stop(); } catch (e) { /* not running */ }
    setIsListening(false);
    stopSpeaking();
  }, [stopSpeaking]);

  const toggleVoiceMode = () => {
    if (voiceMode) { stopVoiceMode(); haptic('light'); return; }
    if (!recognitionRef.current) {
      toast(t('voice.unsupported'), 'error', 6000);
      return;
    }
    setVoiceMode(true);
    voiceModeRef.current = true;
    haptic('medium');
    startListening();
  };

  // Leaving the page, or the app being replaced, must not leave a microphone
  // open and a voice talking into an empty room.
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch (e) { /* ignore */ } }, []);

  // What a heard sentence means. Returning true claims the transcript, so the
  // dictation path does not also paste it into the composer.
  onHeardRef.current = (transcript) => {
    if (!voiceModeRef.current) return false;
    const heard = (transcript || '').trim();
    // Nothing usable: claimed anyway, so it is not pasted, and the idle
    // watcher will open the microphone again.
    if (!heard || isGeneratingRef.current) return true;
    setInput(heard);
    haptic('light');
    // `handleSend` reads `input` from the render it was created in, so it has
    // to be the *next* one -- hence the ref and the tick. Calling the current
    // one here would send whatever the composer held a moment ago, which for
    // the first question of a hands-free session is nothing at all.
    setTimeout(() => handleSendRef.current?.(), 60);
    return true;
  };

  /**
   * One place decides when the microphone opens: when hands-free is on and
   * nothing else is happening.
   *
   * Written as "is anything in progress?" rather than as a chain of
   * completion callbacks, because there are four ways a turn can end -- the
   * answer finished, the speech finished, the speech never started because
   * there was nothing to read out, the recognition ended having heard silence
   * -- and a callback hung off each of them is four places to forget one.
   *
   * The delay is a gap for a person, not a technical need: replying the
   * instant the last syllable lands feels like being interrupted.
   */
  useEffect(() => {
    if (!voiceMode) return undefined;
    if (isGenerating || isListening || isSynthesizing || speakingIndex !== null) return undefined;
    const timer = setTimeout(() => {
      if (voiceModeRef.current && !isGeneratingRef.current) startListening();
    }, 500);
    return () => clearTimeout(timer);
  }, [voiceMode, isGenerating, isListening, isSynthesizing, speakingIndex, startListening]);

  const handleSendRef = useRef(null);
  // A painted edit waiting for the next send: `{ mask, target }`. See MaskEditor.
  const pendingPaintRef = useRef(null);

  /* ------------------------------------------------ retrying a held question
   *
   * The queue is drained by one watcher rather than by whatever happened to
   * notice: two retries of the same entry would send the question twice, and
   * sending somebody's question twice is worse than not sending it at all.
   *
   * It waits for the app to be idle, because a retry that arrives in the
   * middle of an answer would interleave with it, and it stops after
   * MAX_ATTEMPTS so a laptop that is genuinely off does not produce a message
   * an hour later when it wakes.
   */
  useEffect(() => {
    setSendQueue(loadQueue(profileScope));
  }, [profileScope]);

  const retryingRef = useRef(false);
  useEffect(() => {
    if (sendQueue.length === 0) return undefined;

    let cancelled = false;
    const attempt = async () => {
      if (cancelled || retryingRef.current) return;
      if (isGeneratingRef.current) return;
      // Offline is a fact the browser already knows; asking saves a round trip
      // that is certain to fail and a wasted attempt from the budget.
      if (navigator.onLine === false) return;

      const due = nextDue(loadQueue(profileScope));
      if (!due) return;

      retryingRef.current = true;
      try {
        const session = sessionsRef.current.find(x => String(x.id) === String(due.sessionId));
        // The chat it belonged to is gone. Nothing to retry into, and putting
        // it somewhere else would be a surprise.
        if (!session) {
          setSendQueue(removeEntry(profileScope, due.id));
          addLog('[queue] dropped a held question: its chat no longer exists', 'info');
          return;
        }

        addLog(`[queue] retrying (attempt ${(due.attempts || 0) + 1}/${MAX_ATTEMPTS})`, 'info');
        // Marked as attempted before it is tried, so a failure that never
        // returns -- a hung socket -- still counts against the budget.
        setSendQueue(noteAttempt(profileScope, due.id, ''));

        setCurrentSessionId(session.id);
        setInput(due.text);
        setAttachments(due.attachments || []);
        // Cleared optimistically: `handleSend` re-queues on its own if this
        // attempt fails too, and leaving it would duplicate the entry.
        setSendQueue(removeEntry(profileScope, due.id));
        await new Promise(r => setTimeout(r, 60));
        handleSendRef.current?.();
      } finally {
        retryingRef.current = false;
      }
    };

    // Two triggers, because the two situations are different: a timer for
    // "Ollama is still loading", and the online event for "the wifi came
    // back", which can be minutes before the next tick.
    const timer = setInterval(attempt, 4000);
    window.addEventListener('online', attempt);
    attempt();
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', attempt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendQueue.length, profileScope]);

  /* Telling you the answer is here when you are not looking at the page.
   *
   * A local model on a laptop takes long enough that nobody watches it, and
   * now that leaving the chat is allowed, nobody has to stay on the page
   * either. A browser tab has exactly one way to get attention without asking
   * permission first, and it is its own title.
   *
   * Deliberately not a Notification: that needs a permission prompt, and a
   * prompt on first use for something nobody asked for is how a site teaches
   * people to click Block.
   *
   * The mark is cleared when the tab is looked at again, not on a timer -- the
   * point is to survive until it has been seen.
   */
  const wasGeneratingRef = useRef(false);
  const unseenAnswerRef = useRef(false);

  useEffect(() => {
    const justFinished = wasGeneratingRef.current && !isGenerating;
    wasGeneratingRef.current = isGenerating;
    if (!justFinished || !document.hidden) return;
    unseenAnswerRef.current = true;
    document.title = `✅ ${BASE_PAGE_TITLE}`;
    haptic('medium');
  }, [isGenerating]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden || !unseenAnswerRef.current) return;
      unseenAnswerRef.current = false;
      document.title = BASE_PAGE_TITLE;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Everything on screen -- the streaming dots, the stop button, the caret --
  // asks this rather than `isGenerating`. `isGenerating` means "somewhere in
  // this tab a reply is arriving", which is true in every chat and should
  // decorate only one.
  const isThisChatGenerating = isGenerating && generatingSessionId === currentSessionId;

  // Read from the `finally` at the end of a turn, which runs long after the
  // closure it lives in was created -- the whole point being that the chat on
  // screen may have changed since.
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  /* ---- what you were part-way through saying, and where you were reading ----
   *
   * Both are the same complaint: leaving a chat threw away the state that was
   * not in the chat. A half-written question vanished, and a long answer you
   * were three screens into reopened at the bottom. Neither mattered much
   * while switching chats mid-answer was forbidden. It is not any more, so
   * moving between chats has become an ordinary thing to do, and losing your
   * place every time you do it is an ordinary annoyance.
   *
   * Held in this browser rather than on the account. A draft is not a message
   * yet and syncing it would upload on every keystroke; worse, a draft
   * arriving from another device would overwrite whatever was being typed
   * here. Scroll positions are about a window's height, which is not the same
   * on the phone as on the laptop.
   */
  const DRAFTS_KEY = `chatDrafts:${profileScope || 'guest'}`;
  // Timings belong to this machine, so they are keyed like drafts: per profile,
  // in this browser, never synced. See src/perf.js.
  const perfKey = `perfRuns:${profileScope || 'guest'}`;

  // Per profile, like every other library: one machine's rules are about the
  // models on that machine, and mixing two people's is worse than none.
  useEffect(() => { setModelRules(loadModelRules(profileScope)); }, [profileScope]);
  useEffect(() => { setChains(loadChains(profileScope)); }, [profileScope]);
  useEffect(() => { setUserProfile(loadProfile(profileScope)); }, [profileScope]);

  const persistProfile = (next) => {
    setUserProfile(next);
    saveProfile(profileScope, next);
  };

  /**
   * A picture made in the studio, put into the composer.
   *
   * Fetched and re-encoded rather than referenced by URL, because an attachment
   * is bytes: the transcript is saved, synced and exported, and a `/studio/view`
   * link in a saved chat points at a file on one machine's ComfyUI that a phone
   * opening the same conversation cannot reach — and that ComfyUI will
   * eventually clean up anyway.
   */
  const attachGeneratedImage = async (job) => {
    const output = (job?.outputs || [])[0];
    if (!output) return;
    try {
      const res = await fetch(output.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      setAttachments(prev => [...prev, {
        name: output.filename || `generated-${Date.now()}.png`,
        type: 'image',
        data: String(dataUrl).split(',')[1],
        preview: dataUrl,
      }]);
      toast(t('studio.attached'), 'success');
    } catch (e) {
      toast(t('studio.attachFailed', { error: e.message }), 'error', 6000);
    }
  };

  /* ------------------------------------------------ doing things to a picture
   *
   * The buttons under a picture in the chat. Each one that makes a new picture
   * writes a turn into the conversation -- the request in the reader's words,
   * and an answer carrying the call and the result -- so the transcript says
   * what happened, an export shows it, and the model sees it next time it is
   * asked about "that picture". */

  // The picture being painted on (MaskEditor), and the tag sheet's state.
  const [paintTarget, setPaintTarget] = useState(null);
  const [tagSheet, setTagSheet] = useState(null);

  const pictureStyle = (picture) => picture?.style || (picture?.model === 'anima-base' ? 'anime' : 'photo');
  // A call written into the transcript must not end early on a quote or a tag in its text.
  const tagText = (text) => String(text || '').replace(/"/g, '&quot;').replace(/<\/?TOOL_/gi, '');

  const downloadPicture = async (picture) => {
    try {
      const blob = await (await fetch(picture.full || picture.dataUrl)).blob();
      const ext = /video\/webm/.test(blob.type) ? 'webm' : /video/.test(blob.type) ? 'mp4'
        : /webp/.test(blob.type) ? 'webp' : /jpe?g/.test(blob.type) ? 'jpg' : 'png';
      const base = String(picture.filename || '').replace(/\.[a-z0-9]+$/i, '') || `picture-${Date.now()}`;
      downloadBlob(`${base}.${ext}`, blob, blob.type || 'image/png');
    } catch (e) {
      toast(t('picture.failed', { error: e.message }), 'error', 6000);
    }
  };

  /** A picture from the gallery or a message, into the composer as an attachment. */
  const attachPicture = async (item) => {
    if (item.source === 'studio') return attachGeneratedImage(item.job);
    try {
      const dataUrl = item.full || item.dataUrl;
      setAttachments(prev => [...prev, {
        name: item.filename || `picture-${Date.now()}.png`,
        type: 'image',
        data: String(dataUrl).split(',')[1],
        preview: dataUrl,
      }]);
      toast(t('studio.attached'), 'success');
    } catch (e) {
      toast(t('studio.attachFailed', { error: e.message }), 'error', 6000);
    }
  };

  /**
   * One action that ends in pictures, as a turn of its own. The progress card
   * is the same one a drawing shows, because it is the same kind of wait.
   */
  const runPictureAction = async ({ request, call, work }) => {
    if (isGenerating) { toast(t('picture.busy'), 'info', 3000); return; }
    const sid = currentSessionId;
    const actionId = `act-${Date.now().toString(36)}`;
    reviseSession(sid, s => ({
      ...s,
      updatedAt: Date.now(),
      messages: [
        ...s.messages,
        { role: 'user', content: request, at: Date.now() },
        { role: 'assistant', content: call, at: Date.now(), actionId },
      ],
    }));
    const settle = (patch) => reviseSession(sid, s => ({
      ...s,
      messages: s.messages.map(m => (m.actionId === actionId ? { ...m, ...patch } : m)),
    }));
    setIsGenerating(true);
    setGeneratingSessionId(sid);
    abortControllerRef.current = new AbortController();
    try {
      const pictures = await work(abortControllerRef.current.signal);
      settle({ generated: pictures, at: Date.now() });
    } catch (e) {
      settle({ content: `${call}\n\n${t('picture.failed', { error: e.message })}`, at: Date.now() });
    } finally {
      setIsGenerating(false);
      setGeneratingSessionId(null);
    }
  };

  const pictureAction = (kind, picture) => {
    if (!picture?.dataUrl) return;
    if (kind === 'download') return downloadPicture(picture);
    if (kind === 'paint') { setPaintTarget(picture); return; }
    if (kind === 'tags') {
      setTagSheet({ picture, loading: true });
      runPictureOp('tag', picture)
        .then(({ tags }) => setTagSheet(s => (s?.picture === picture ? { picture, tags } : s)))
        .catch(e => setTagSheet(s => (s?.picture === picture ? { picture, error: t('picture.failed', { error: e.message }) } : s)));
      return;
    }
    if (kind === 'redraw') {
      const style = pictureStyle(picture);
      const negative = picture.negative || '';
      return runPictureAction({
        request: t('picture.req.redraw'),
        call: `<TOOL_GENERATE_IMAGE style="${style}" negative="${tagText(negative)}">${tagText(picture.prompt)}</TOOL_GENERATE_IMAGE>`,
        // No seed: another take on the same prompt is what "again" means -- in
        // the same shape as the one it is another take of.
        work: (signal) => generateImages(1, picture.prompt || '', style, negative, null, signal, { shapeFrom: picture.dataUrl }),
      });
    }
    if (kind === 'rmbg') {
      return runPictureAction({
        request: t('picture.req.rmbg'),
        call: '<TOOL_REMOVE_BACKGROUND></TOOL_REMOVE_BACKGROUND>',
        work: async (signal) => [await runPictureOp('rmbg', picture, { signal })],
      });
    }
    if (kind === 'upscale') {
      return runPictureAction({
        request: t('picture.req.upscale'),
        call: '<TOOL_UPSCALE_IMAGE factor="2"></TOOL_UPSCALE_IMAGE>',
        work: async (signal) => [await runPictureOp('upscale', picture, { factor: 2, signal })],
      });
    }
  };

  /* A painted edit goes to the chat as a question -- the reader's words, with
     the mask riding along -- so the model writes the prompt the way it does for
     any edit. See `pendingPaintRef` in handleSend. */
  const submitPaint = ({ mask, instruction }) => {
    const target = paintTarget;
    setPaintTarget(null);
    if (!target || isGenerating) return;
    pendingPaintRef.current = { mask, target: target.filename || '' };
    setInput(instruction);
    setTimeout(() => handleSendRef.current?.(), 60);
  };

  const persistChains = (next) => {
    setChains(next);
    saveChains(profileScope, next);
  };

  /**
   * The reader chose a model.
   *
   * That ends routing for this chat, permanently and without asking. A feature
   * that quietly puts the model back after you changed it is not a
   * convenience -- it is a bug nobody can report, and the whole value of the
   * rules rests on trusting what the selector says.
   */
  const modelPickedByHand = (name) => {
    setSelectedModel(name);
    if (routingEnabled && !currentSession.manualModel) {
      reviseSession(currentSessionId, s => ({ ...s, manualModel: true }));
      addLog(`[routing] off for this chat: ${name} was chosen by hand`, 'info');
    }
  };

  const persistModelRules = (rules) => {
    setModelRules(rules);
    saveModelRules(profileScope, rules);
  };

  const draftsRef = useRef(null);
  const readDrafts = () => {
    if (draftsRef.current) return draftsRef.current;
    try {
      const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
      draftsRef.current = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      draftsRef.current = {};
    }
    return draftsRef.current;
  };

  const writeDraft = (sessionId, text) => {
    if (sessionId == null) return;
    const drafts = readDrafts();
    // An empty draft is not a draft, and keeping the key would grow the store
    // by one entry per chat ever visited.
    if (text && text.trim()) drafts[sessionId] = text;
    else delete drafts[sessionId];
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch (e) { /* quota */ }
  };

  // Where the reader was in each chat. `atBottom` rather than a number for the
  // commonest case: a chat read to the end should reopen at the end even
  // though the answer has grown since, and a stored pixel offset would put it
  // slightly above wherever the end now is.
  const scrollMemoryRef = useRef(new Map());
  const restorePlaceRef = useRef(null);

  /**
   * Swap one chat's draft and reading position for another's.
   *
   * Driven by an effect on `currentSessionId` rather than by the click
   * handlers, because a chat can also change from the command palette, from a
   * deletion, from the launcher shortcut and from another tab -- and a save
   * that only some of those paths performed would lose drafts in a way nobody
   * could reproduce.
   */
  const previousSessionRef = useRef(currentSessionId);
  useEffect(() => {
    const leaving = previousSessionRef.current;
    if (leaving === currentSessionId) return;
    previousSessionRef.current = currentSessionId;

    writeDraft(leaving, inputRef.current);
    // The place is not saved here. By the time this effect runs React has
    // already rendered the *new* chat, so the scroll container is showing that
    // one and reading its offset would file the new chat's position under the
    // old chat's id. It is recorded continuously in `handleScroll` instead,
    // where the position and the chat it belongs to are still the same thing.

    // Where to land in the chat being opened. Decided here, applied by the
    // effect below once the messages have actually been laid out -- the height
    // to scroll within does not exist yet at this point.
    const place = scrollMemoryRef.current.get(currentSessionId);
    isAutoScrollRef.current = !place || place.atBottom;
    restorePlaceRef.current = (place && !place.atBottom) ? place.top : null;

    const draft = readDrafts()[currentSessionId] || '';
    setInput(draft);
    // The textarea keeps whatever height it was given by hand; it only resizes
    // from its own input handler, which nothing fired here.
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.style.height = 'auto';
      if (draft) box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // Closing the tab is leaving the chat too, and the effect above never runs
  // for it. `pagehide` rather than `beforeunload`: iOS Safari fires the latter
  // rarely and not at all when the page is frozen for an app switch.
  useEffect(() => {
    const save = () => { writeDraft(currentSessionIdRef.current, inputRef.current); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  // Edit State
  const [editingMessageIndex, setEditingMessageIndex] = useState(null);
  const [editInput, setEditInput] = useState('');

  // Attachments & MCP
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);

  // Filled from /system/stats, which the system monitor already polls. Only
  // used while the file tools are on -- see environmentPreamble.
  const [hostInfo, setHostInfo] = useState(null);
  useEffect(() => {
    if (!mcpEnabled || hostInfo) return;
    let cancelled = false;
    fetch('/system/stats')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.ok !== false && d?.host) setHostInfo(d.host); })
      .catch(() => { /* the middleware is not running; the preamble omits it */ });
    return () => { cancelled = true; };
  }, [mcpEnabled, hostInfo]);


  // Which message has its action row open, on a device where hovering is not a
  // gesture. A pointer can reveal a toolbar by moving over a message; a finger
  // cannot, and the previous answer -- show every toolbar, always -- put a
  // floating bar under every single message, overlapping the one below it.
  // So: tap a message to reveal its actions, tap again (or another) to put
  // them away. `null` means none, which is the resting state.
  const [openActionsIndex, setOpenActionsIndex] = useState(null);

  // `hover: none` is the honest question -- not the screen width. A small
  // window on a laptop still has a mouse and should keep hover-to-reveal; a
  // large tablet has no pointer and should not.
  const [isTouchUi, setIsTouchUi] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true
  );
  useEffect(() => {
    const query = window.matchMedia?.('(hover: none)');
    if (!query) return undefined;
    const onChange = e => setIsTouchUi(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // --- The drawer, by swipe ---
  //
  // Attached to `document` rather than to the app element so a swipe that
  // begins on the backdrop over an open drawer still closes it, and so this
  // does not have to wait for a ref to exist.
  //
  // The listener is installed once and asks for the current state when a
  // gesture starts. Re-attaching it whenever the drawer opened would drop the
  // very gesture that opened it, since the finger is still down.
  const swipeStateRef = useRef({ isOpen: false, rtl: false, enabled: false });
  swipeStateRef.current = {
    isOpen: isSidebarOpen,
    rtl: dir === 'rtl',
    // Only where the drawer is a drawer. On a wide screen the sidebar is a
    // column that is always there, and there is nothing for a swipe to do.
    enabled: isTouchUi && isNarrow,
  };
  useEffect(() => trackDrawerSwipe(document, () => swipeStateRef.current, (verdict) => {
    setIsSidebarOpen(verdict === 'open');
    haptic('light');
  }), []);

  /**
   * A tap on the body of a message toggles its actions.
   *
   * Everything that is already interactive is left alone -- a tap on a link, a
   * button, a form control or the action row itself means that thing, not
   * "show me the toolbar". So is a code block: it scrolls sideways under the
   * finger and carries its own controls, and a toolbar appearing every time
   * someone drags a long line into view would be noise. A tap that ends a text
   * selection is ignored for the same reason: the user was selecting.
   */
  const IGNORE_TAP = 'button, a, input, textarea, select, label, .msg-hover-actions, .code-container, .artifact-card, pre';

  const toggleMessageActions = (event, index) => {
    if (!isTouchUi) return;
    if (event.target.closest(IGNORE_TAP)) return;
    if ((window.getSelection?.().toString() || '').length > 0) return;
    setOpenActionsIndex(prev => (prev === index ? null : index));
  };

  // The open row is remembered by index, and an index means nothing once the
  // list under it has changed -- a deleted message shifts every later one, and
  // a new reply would leave the toolbar attached to the wrong bubble.
  useEffect(() => { setOpenActionsIndex(null); }, [currentSessionId, messages.length]);

  // Switching chats does not fire a scroll event, so the bar would keep showing
  // how far through the *previous* conversation the reader had got.
  useEffect(() => { setScrollProgress(0); setShowTopBtn(false); }, [currentSessionId]);

  /**
   * Put the reader back where they were in this chat.
   *
   * Two frames, not one. The first gets the messages into the document; the
   * second is after the browser has laid them out, which is when the container
   * finally has something to scroll within. Restoring before that scrolls to
   * the bottom of a box that is still one screen tall.
   *
   * Marked as this code's own scroll, or the scroll handler reads the landing
   * position as the reader choosing to be there and turns following off for a
   * chat they have not touched.
   */
  useEffect(() => {
    if (restorePlaceRef.current == null) return undefined;
    const top = restorePlaceRef.current;
    restorePlaceRef.current = null;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const area = scrollAreaRef.current;
      if (!area) return;
      selfScrollRef.current = true;
      area.scrollTop = Math.min(top, area.scrollHeight - area.clientHeight);
      requestAnimationFrame(() => { selfScrollRef.current = false; });
    }));
    return () => cancelAnimationFrame(frame);
  }, [currentSessionId]);

  // Logs & Refs
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [logs, setLogs] = useState([]);
  const logsEndRef = useRef(null);
  const scrollAreaRef = useRef(null);
  // Whether the conversation should keep following the end of the answer.
  // Set false the moment the reader scrolls for themselves; set true again
  // only when they come back to the bottom. See `followTail` below.
  const isAutoScrollRef = useRef(true);
  // Set while a scroll this code caused is still on its way to the scroll
  // handler, so that scroll is not mistaken for the reader's own.
  const selfScrollRef = useRef(false);
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
  const DEFAULT_SIDEBAR_WIDTH = 340;
  const DEFAULT_CONSOLE_HEIGHT = 200;
  const [artifactWidth, setArtifactWidth] = usePersistedNumber('artifactWidth', DEFAULT_ARTIFACT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber('sidebarWidth', DEFAULT_SIDEBAR_WIDTH);
  const [consoleDockHeight, setConsoleDockHeight] = usePersistedNumber('consoleDockHeight', DEFAULT_CONSOLE_HEIGHT);
  const [artifactMaximized, setArtifactMaximized] = useState(false);
  const [consoleDocked, setConsoleDocked] = useState(false);
  const [viewportPreset, setViewportPreset] = useState(() => getSetting('viewportPreset') || 'fit');
  const [viewportLandscape, setViewportLandscape] = useState(false);
  const [previewZoom, setPreviewZoom] = useState('fit');

  useEffect(() => { setSetting('viewportPreset', viewportPreset); }, [viewportPreset]);

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
  // When the oldest unsaved change was made, or 0 when there is none. See the
  // save effect below for why a debounce without this is not a debounce.
  const saveSinceRef = useRef(0);
  // Read inside `handleSend`, which is long-lived: a plain closure would see
  // the list as it was when the turn started.
  const personasRef = useRef(personas);
  personasRef.current = personas;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  // Chats this tab was told to get rid of.
  //
  // The merge below keeps anything in storage that this tab does not have, and
  // without this list a deletion would be indistinguishable from not having
  // heard about a chat yet — so deleting one would put it straight back.
  const removedIdsRef = useRef(new Set());

  /**
   * Write the chat list, merged with whatever is already in storage.
   *
   * Not `setItem(list)`. This store has more than one writer: a second tab of
   * the same account writes it, and so does the sync when it brings a chat down
   * from the server. A plain overwrite from React state loses whatever those
   * wrote between the last read and this write — and it did. The sequence was:
   *
   *   1. the sync pulls a chat written on another device, and stores it
   *   2. 700ms later this effect writes React's list, which never had it, over
   *      the top
   *   3. the next sync sees a chat it had uploaded and no longer holds, which
   *      is precisely what a deletion looks like, and tombstones it
   *
   * So the other device's conversation did not merely fail to appear. It was
   * deleted from the account, by a tab that had never been told it existed.
   *
   * Merging makes the failure mode the harmless one. A chat this tab has not
   * heard of survives; a chat another device really did delete may briefly come
   * back, and that corrects itself — the resurrected copy carries its original
   * timestamp, which is older than the tombstone, so the server refuses it and
   * sends the tombstone again. Losing data does not self-correct. Keeping it
   * does.
   */
  const persistSessions = async (list) => {
    // Drafts are filtered here rather than at every call site, because this
    // is the one door to storage -- and `collectLocal` in syncEngine.js
    // reads that same key, so keeping them out of storage keeps them off
    // the account as well.
    list = persistable(list);
    const key = storageKeyRef.current;
    let stored = [];
    try { stored = (await localforage.getItem(key)) || []; } catch (e) { stored = []; }

    const removed = removedIdsRef.current;
    const merged = new Map();
    for (const chat of stored) {
      if (chat?.id == null || removed.has(String(chat.id))) continue;
      merged.set(String(chat.id), chat);
    }
    for (const chat of list) {
      if (chat?.id == null || removed.has(String(chat.id))) continue;
      const held = merged.get(String(chat.id));
      // Same chat on both sides: the later edit is the one to keep.
      if (!held || (chat.updatedAt || 0) >= (held.updatedAt || 0)) merged.set(String(chat.id), chat);
    }

    const next = [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    try {
      await localforage.setItem(key, next);
    } catch (e) {
      console.warn('Failed to save sessions to localforage.', e);
    }

    // The upload reads *storage*, not React state -- `collectLocal` in
    // syncEngine.js opens the same key this just wrote. So a storage write is
    // the moment there is genuinely something new to send, and scheduling the
    // upload from anywhere else is a race between two independent timers.
    //
    // It was lost, reliably, at the end of every reply. The upload timer fired
    // in the gap between the last token and this write, sent the version of the
    // chat that was in storage -- the assistant's empty placeholder, saved
    // while the model was still loading -- and cleared its pending mark. This
    // write then landed with the finished answer in it and scheduled nothing,
    // because only a change to `sessions` did that and `sessions` had stopped
    // changing. The answer stayed in storage and the other device showed
    // "Thinking..." over an empty bubble until something else happened to that
    // chat. Scheduling here means the last write always gets its upload.
    //
    // Only when the write actually changed something, though, and `updatedAt`
    // is the honest test because it is the same one the upload applies. Without
    // it the device *receiving* a stream would answer every update with a
    // pointless round trip: the records land in storage, the chat list is
    // re-read, that re-read is written back, and the write asks for an upload
    // of the very thing that just arrived.
    if (chatsSignature(stored) !== chatsSignature(next)) syncRef.current?.schedule();
    return next;
  };

  // Save when the chat has been quiet for SAVE_DELAY_MS -- or, whatever
  // happens, when SAVE_MAX_DELAY_MS has passed since the first unsaved change.
  //
  // The ceiling is not a refinement, it is the difference between saving and
  // not saving at all. A plain debounce re-arms on every change, so a change
  // arriving more often than the delay postpones the write for ever, and a
  // streaming reply rewrites the chat several times a second for as long as
  // the model is talking. Nothing was written for the whole of a reply.
  //
  // On this device that was invisible, because what is on screen comes from
  // React state and not from storage. It was visible on every *other* device,
  // because the upload reads storage: they were sent the last thing that had
  // been saved, which was the empty placeholder written during the pause while
  // the model loaded, and then nothing until the answer had finished.
  // And the ceiling itself needs a clock that a hidden page still has. A
  // backgrounded window's timers are clamped to one a second, and to one a
  // minute after five minutes of it -- measured, not assumed: a self-repeating
  // 250ms timer fired 78 times in twenty seconds in front and 20 behind. So
  // the ceiling is also checked here, on the change, which arrives off the
  // network and is throttled by nothing.
  useEffect(() => {
    if (!isStorageLoaded) return;
    const now = Date.now();
    if (!saveSinceRef.current) saveSinceRef.current = now;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (isOverdue(now, saveSinceRef.current, SAVE_MAX_DELAY_MS)) {
      saveTimerRef.current = null;
      saveSinceRef.current = 0;
      persistSessions(sessionsRef.current);
      return undefined;
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveSinceRef.current = 0;
      persistSessions(sessionsRef.current);
    }, waitFor(now, saveSinceRef.current, SAVE_DELAY_MS, SAVE_MAX_DELAY_MS));
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, isStorageLoaded]);

  // Going away: write what the save timer has not yet. Coming back: read what
  // another tab wrote while this one was not looking.
  //
  // `beforeunload` alone was the whole of the first half, and on a phone it is
  // close to useless: iOS Safari fires it rarely, and switching apps or locking
  // the screen is not an unload at all — the page is frozen, then discarded
  // without ever being told. `pagehide` and the hidden half of
  // `visibilitychange` are the events that actually arrive, and they arrive
  // first.
  //
  // The `pending` guard is what keeps two tabs from fighting. Tabs of one
  // account share the store, so a tab that has been sitting untouched is
  // holding a list that is now out of date — and writing it on the way out
  // would put the stale copy over whatever the other tab had just saved. A tab
  // flushes what *it* has pending and nothing else; with no timer armed there
  // is, by definition, nothing of its own to write.
  useEffect(() => {
    if (!isStorageLoaded) return undefined;
    const flush = () => {
      if (!saveTimerRef.current) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      saveSinceRef.current = 0;
      persistSessions(sessionsRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      // Back in view. Another tab may have written since; this is the cheap
      // half of the same fix as the boot re-read, and it means switching to a
      // tab shows the conversation rather than needing a refresh.
      else refreshChatsFromStorage();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStorageLoaded]);

  // Written straight away rather than debounced: a refresh right after a click
  // should still land on the chat that was clicked.
  const loadedKeyRef = useRef(null);
  useEffect(() => {
    if (!isStorageLoaded || !currentSessionId) return;
    if (loadedKeyRef.current !== storageKey) return;
    // A draft is not a chat anybody was reading, and recording it would make
    // this key name something storage has never heard of.
    if (isDraft(sessions.find(x => x.id === currentSessionId))) return;
    try { localStorage.setItem(lastChatKey, String(currentSessionId)); } catch (e) {}
  }, [currentSessionId, lastChatKey, storageKey, isStorageLoaded, sessions]);

  // Handle case where all sessions might be deleted
  useEffect(() => {
    if (sessions.length === 0) {
      const newSession = newDraft();
      setSessions([newSession]);
      setCurrentSessionId(newSession.id);
    } else if (!sessions.find(s => s.id === currentSessionId)) {
      setCurrentSessionId(mostRecent(sessions).id);
    }
  }, [sessions, currentSessionId]);

  /**
   * Change one chat, and say when.
   *
   * Every edit to a chat goes through here so that none of them can forget to
   * move `updatedAt` -- which is not a display detail but the sync's clock, and
   * a change that does not move it never leaves this browser. src/sessionEdit.js
   * has the full account of what that cost; the short version is that a reply
   * being streamed never stamped the chat, so the account kept the empty
   * placeholder and the other device showed "Thinking..." for ever.
   *
   * A caller that sets `updatedAt` itself still wins: a restore from an undo
   * toast means the moment it was restored, not the moment it was written.
   */
  const reviseSession = (id, revise) => {
    setSessions(prev => prev.map(s => (s.id === id ? stamped(s, revise(s)) : s)));
  };

  const updateCurrentSession = (updates) => {
    reviseSession(currentSessionId, s => ({ ...s, ...updates }));
  };

  /**
   * Put the time an answer finished on it.
   *
   * The empty bubble an answer streams into is made the moment the question is
   * sent, and it used to keep that moment -- so a reply that took four minutes
   * because it drew a video said it was written four minutes before it
   * appeared. The time under an answer is when it was done: called as each
   * turn ends, however it ends, on the last message of the chat it was asked
   * in. A tool loop ends several times on the way; the last of them wins.
   *
   * `since` is when the turn began, and a message older than that is not this
   * turn's: a question put back in the send queue takes its bubble with it,
   * and the last message is then the previous answer, which finished when it
   * said it did.
   */
  const markAnswered = (id, since = 0) => reviseSession(id, s => {
    const last = s.messages[s.messages.length - 1];
    if (!last || last.role !== 'assistant') return s;
    if (last.at && last.at < since) return s;
    const msgs = [...s.messages];
    msgs[msgs.length - 1] = { ...last, at: Date.now() };
    return { ...s, messages: msgs };
  });

  /**
   * Put a conversation on screen, from anywhere.
   *
   * The Studio is laid over the chat rather than replacing it, which is what
   * keeps a half-written message and a streaming reply intact while you make a
   * picture. The cost is that picking a chat while the Studio is open changed
   * which conversation was underneath and left the Studio on top of it — so
   * the click appeared to do nothing.
   *
   * One helper rather than a `setSidebarPlace('home')` beside every
   * `setCurrentSessionId`: there are four places a person can choose a chat
   * from — the list, the command palette, the "still generating over there"
   * button, and a new chat — and a fifth would have been added without this.
   *
   * Deliberately not an effect on `currentSessionId`. The send queue switches
   * chats in the background when it retries a message, and being thrown out of
   * the Studio mid-prompt by a retry is worse than the bug this fixes.
   */
  const openChat = (id) => {
    setCurrentSessionId(id);
    setSidebarPlace('home');
    // On a phone the drawer is over the conversation it was used to open.
    if (isNarrow) setIsSidebarOpen(false);
  };

  const createNewSession = () => {
    // On a phone the drawer sits over the chat it just created.
    if (isNarrow) setIsSidebarOpen(false);
    // A configured default wins; otherwise the chat inherits whatever is selected.
    const startingModel = defaultModel && models.some(m => m.name === defaultModel) ? defaultModel : '';
    if (startingModel) setSelectedModel(startingModel);
    /* A draft, not a conversation. It is the chat on screen and can be
       typed into, but it reaches neither the sidebar nor storage nor the
       account until the first message is sent -- see src/draftChat.js.

       Any earlier draft is dropped on the way past: pressing this three
       times should leave one, not three. */
    const newSession = newDraft(startingModel);
    setSessions(prev => [newSession, ...withoutStaleDrafts(prev, newSession.id)]);
    openChat(newSession.id);
    setAttachments([]);
    addLog('Started a new chat', 'info');
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  /**
   * Write the chat list and push it to the account, now.
   *
   * The ordinary path debounces twice — 700ms to storage, four seconds to the
   * account — and both are right for a streaming reply, which changes on every
   * token. A deletion is not that. It happens once, on purpose, and if the page
   * reloads inside those five seconds the account still has the chat and sends
   * it straight back: delete, refresh, and there it is again. On a phone that
   * is not an edge case, because refreshing is how you return to the app.
   *
   * So destructive changes skip both timers. `next` is passed rather than read
   * from state because the state has not been committed yet at the call site.
   */
  const persistChatsNow = async (next) => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    saveSinceRef.current = 0;
    await persistSessions(next);
    await syncRef.current?.flush();
  };

  // No confirm dialog: the toast offers an Undo instead, which is both
  // faster for the common case and safer for a misclick.
  const deleteSession = (id, e) => {
    e?.stopPropagation();
    const victim = sessions.find(s => s.id === id);
    if (!victim) return;
    haptic('warn');
    const position = sessions.findIndex(s => s.id === id);

    const newSessions = sessions.filter(s => s.id !== id);
    if (newSessions.length === 0) {
      const freshSession = { id: nextSessionId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      setSessions([freshSession]);
      setCurrentSessionId(freshSession.id);
      persistChatsNow([freshSession]);
    } else {
      setSessions(newSessions);
      if (currentSessionId === id) setCurrentSessionId(mostRecent(newSessions).id);
      persistChatsNow(newSessions);
    }

    // Say so, rather than letting the absence speak. The merge in
    // `persistSessions` keeps anything in storage this tab does not hold, so
    // without this a deletion would read as "has not heard of it yet" and the
    // chat would come straight back.
    removedIdsRef.current.add(String(id));

    lastDeletedRef.current = { session: victim, position };
    toast(t('toast.chatDeleted', { title: victim.title }), 'info', 8000, {
      label: t('common.undo'),
      onClick: () => {
        const saved = lastDeletedRef.current;
        if (!saved) return;
        // The deletion has already reached the account as a tombstone stamped
        // with the moment it happened. A record that carried its old timestamp
        // would lose to that tombstone and be deleted again on the next pull,
        // so the restore is stamped with when it was restored — which is also
        // the honest answer to when this chat last changed.
        removedIdsRef.current.delete(String(saved.session.id));
        const restoredSession = { ...saved.session, updatedAt: Date.now() };
        let committed = null;
        setSessions(prev => {
          if (prev.some(s => s.id === restoredSession.id)) return prev;
          const restored = [...prev];
          restored.splice(Math.min(saved.position, restored.length), 0, restoredSession);
          committed = restored;
          return restored;
        });
        setCurrentSessionId(restoredSession.id);
        lastDeletedRef.current = null;
        if (committed) persistChatsNow(committed);
      },
    });
  };

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { time, msg, type }]);
  };

  // ---- Doing something to several chats at once ----
  //
  // Filing away a month of chats, or clearing out the ones a bad prompt
  // produced, used to be a row menu opened once per chat: three taps each,
  // every one of them a fresh chance to hit the row instead of the button and
  // load the chat you were trying to delete. The list has a selection mode
  // now, and the bar at the bottom does the same three things to all of it.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  // Archived chats are hidden, not deleted. The list is the thing that gets
  // unusable first -- a year of one-off questions buries the handful of chats
  // anyone actually returns to -- and deleting is the wrong answer to that,
  // because the reason those chats are kept is that they might be wanted.
  const [showArchived, setShowArchived] = useState(false);
  const bulkDeletedRef = useRef(null);

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); setBulkMoveOpen(false); };

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    haptic('light');
  };

  // Whatever the sidebar is currently showing, which is not the same as every
  // chat: a search narrows the list, and "select all" that reaches past what
  // is on screen is how people delete things they never saw.
  const selectAllVisible = (visible) => {
    const ids = visible.map(s => s.id);
    const everything = ids.every(id => selectedIds.has(id));
    setSelectedIds(everything ? new Set() : new Set(ids));
  };

  const moveSelectedToFolder = (folderId) => {
    const chosen = selectedIds;
    if (chosen.size === 0) return;
    // One pass rather than one `reviseSession` per chat: each of those is a
    // separate state update reading the list as it was, and the last one wins.
    setSessions(prev => prev.map(s => (
      chosen.has(s.id) ? stamped(s, assignToFolder([s], s.id, folderId)[0]) : s
    )));
    toast(t('bulk.moved', { count: chosen.size }), 'success');
    haptic('medium');
    exitSelectMode();
  };

  const exportSelected = () => {
    const chosen = sessions.filter(s => selectedIds.has(s.id));
    if (chosen.length === 0) return;
    downloadBlob(
      `chats_${new Date().toISOString().split('T')[0]}.json`,
      JSON.stringify(chosen, null, 2),
      'application/json;charset=utf-8'
    );
    toast(t('bulk.exported', { count: chosen.length }), 'success');
    exitSelectMode();
  };

  /**
   * Delete everything selected, with one undo for the lot.
   *
   * The single-chat path this mirrors is `deleteSession`, and the two pieces
   * that look like bookkeeping are the ones that matter. `removedIdsRef` is
   * what stops the merge in `persistSessions` reading a deletion as "this tab
   * has not heard of that chat yet" and putting it straight back. And the
   * restore re-stamps: the deletions have already reached the account as
   * tombstones stamped with now, so a chat restored with its old timestamp
   * loses to its own tombstone and disappears again on the next pull.
   */
  const deleteSelected = () => {
    const doomed = sessions
      .map((session, position) => ({ session, position }))
      .filter(({ session }) => selectedIds.has(session.id));
    if (doomed.length === 0) return;

    const remaining = sessions.filter(s => !selectedIds.has(s.id));
    let committed = remaining;

    if (remaining.length === 0) {
      // The list is never empty: an empty sidebar has nothing to click and no
      // way back to a conversation.
      const fresh = { id: nextSessionId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      committed = [fresh];
      setSessions(committed);
      setCurrentSessionId(fresh.id);
    } else {
      setSessions(remaining);
      if (selectedIds.has(currentSessionId)) setCurrentSessionId(mostRecent(remaining).id);
    }
    for (const { session } of doomed) removedIdsRef.current.add(String(session.id));
    persistChatsNow(committed);

    bulkDeletedRef.current = doomed;
    haptic('warn');
    exitSelectMode();

    toast(t('bulk.deleted', { count: doomed.length }), 'info', 8000, {
      label: t('common.undo'),
      onClick: () => {
        const saved = bulkDeletedRef.current;
        if (!saved) return;
        bulkDeletedRef.current = null;
        const now = Date.now();
        let restoredList = null;
        setSessions(prev => {
          const next = [...prev];
          // Ascending, so each chat lands where it was: putting the later ones
          // back first shifts every index after them.
          for (const { session, position } of [...saved].sort((a, b) => a.position - b.position)) {
            if (next.some(s => s.id === session.id)) continue;
            removedIdsRef.current.delete(String(session.id));
            next.splice(Math.min(position, next.length), 0, { ...session, updatedAt: now });
          }
          restoredList = next;
          return next;
        });
        if (restoredList) persistChatsNow(restoredList);
      },
    });
  };

  // ---- Session management extras ----

  const togglePin = (id, e) => {
    e?.stopPropagation();
    reviseSession(id, s => ({ ...s, pinned: !s.pinned }));
  };

  const toggleArchived = (id, e) => {
    e?.stopPropagation();
    let archived = false;
    reviseSession(id, s => {
      archived = !s.archived;
      return { ...s, archived };
    });
    haptic('light');
    toast(archived ? t('sidebar.archived') : t('sidebar.unarchived'), 'info', 5000, {
      label: t('common.undo'),
      onClick: () => reviseSession(id, s => ({ ...s, archived: !archived })),
    });
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
      reviseSession(renamingId, s => ({ ...s, title, titleLocked: true }));
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
      id: nextSessionId(),
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
      id: nextSessionId(),
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

  /**
   * One picture, start to finish, for the model's `generate_image` tool.
   *
   * Queue, poll, fetch the bytes, hand back a data URL. All of it here rather
   * than in the studio panel because the two want different things from the
   * same machinery: the panel wants a gallery it can keep adding to, and this
   * wants one blocking call that either returns a picture or throws.
   *
   * The model chooses a style rather than a checkpoint. "Which of Krea 2 Turbo
   * and Anima Base" is not a question a language model should be answering in
   * the middle of a conversation, and the answer would be wrong the moment
   * either is renamed — but "is this anime or is it not" it can answer.
   */
  /**
   * What the Studio was last set to, for a picture asked for in conversation.
   *
   * The model writes the prompt -- that is the half that depends on what is
   * being asked for. Everything else is a preference: the resolution somebody
   * likes, the sampler they settled on, the checkpoint they installed, the
   * LoRAs they stack. Those were chosen once in the Studio and should not have
   * to be chosen again through a chat message, which is not a form.
   *
   * Per workflow, because Krea 2 runs at 8 steps and Anima at 40 -- one shared
   * set of numbers would be wrong for whichever the request did not pick.
   *
   * Validated against ComfyUI's current lists before it is sent, exactly as
   * the Studio does on load: a saved LoRA that has since been deleted is not a
   * harmless leftover, it is a generation that fails a minute in. Nothing
   * saved, or no ComfyUI to ask, means the workflow's own defaults -- which is
   * what this did before it did anything.
   */
  const studioSettingsFor = async (modelId, signal) => {
    const saved = readStudioSettings(profileScopeRef.current)[modelId];
    if (!saved) return {};

    let descriptor = null;
    try {
      const data = await fetch('/studio/models', { signal }).then(r => r.json());
      descriptor = (data?.models || []).find(m => m.id === modelId) || null;
    } catch (e) { /* offline; fall through to the defaults */ }
    if (!descriptor) return {};

    const form = restoreForm(descriptor, saved);
    const loras = (form.loras || []).filter(l => l.name);
    return {
      // Not the prompt, and not the negative: this request has its own, and the
      // one sitting in the Studio belongs to whatever was being made there.
      size: `${form.width}x${form.height}`,
      steps: form.steps,
      cfg: form.cfg,
      ...(descriptor.has?.duration ? { duration: form.duration, fps: form.fps } : {}),
      ...(form.sampler ? { sampler: form.sampler } : {}),
      ...(form.scheduler ? { scheduler: form.scheduler } : {}),
      ...(form.model ? { modelFile: form.model } : {}),
      ...(form.vae ? { vae: form.vae } : {}),
      ...(form.clip ? { clip: form.clip } : {}),
      ...(loras.length ? { loras } : {}),
      // A locked seed is a deliberate choice to repeat a picture; an unlocked
      // one means a new picture each time, which is what a fresh request is.
      ...(form.lockSeed && form.seed !== '' ? { seed: Number(form.seed) } : {}),
    };
  };

  const drawingLive = useJobStream(drawing?.id || null);

  /**
   * Which workflow draws a picture asked for in conversation.
   *
   * The Studio sets it: `auto` lets the model's `style` decide -- Anima for
   * anime, Krea 2 for everything else -- and the other two pin one workflow
   * whatever the style says. Kept with the Studio's settings, so it syncs with
   * them. See StudioPanel's "for pictures in chat".
   */
  const chatImageModel = (style) => {
    const chosen = readStudioSettings(profileScopeRef.current)?.[CHAT_PICTURE_KEY]?.model;
    if (chosen === 'anima-base' || chosen === 'krea2-turbo') return chosen;
    return style === 'anime' ? 'anima-base' : 'krea2-turbo';
  };

  /* How many pixels a workflow is set up to sample: the Studio's size for it,
     or the workflow's own default. A requested shape keeps this area. */
  const DEFAULT_AREA = { 'anima-base': 1296 * 1728, 'krea2-turbo': 1024 * 1360, 'minimax-h3': 1088 * 1088 };
  const workflowArea = (model, settings = {}) => {
    const [w, h] = String(settings.size || '').split('x').map(Number);
    return w > 0 && h > 0 ? w * h : (DEFAULT_AREA[model] || 1024 * 1024);
  };

  /** A picture, into ComfyUI's input folder, by the name ComfyUI filed it under. */
  const uploadToComfy = async (source, name, signal) => {
    const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
    const form = new FormData();
    form.append('image', blob, name);
    const up = await fetch('/studio/upload', { method: 'POST', body: form, signal }).then(r => r.json());
    if (!up?.success) throw new Error(up?.error || 'the picture could not be uploaded');
    return up.name;
  };

  /** A finished output's bytes, as a data URL the message can keep. */
  const outputAsDataUrl = async (url, signal) => {
    const blob = await fetch(url, { signal }).then(r => {
      if (!r.ok) throw new Error(`could not read the result (HTTP ${r.status})`);
      return r.blob();
    });
    return blobToDataUrl(blob);
  };

  /**
   * Watch one ComfyUI job to the end, with the progress card up, and hand back
   * its final state.
   *
   * Twenty minutes by default, as a ceiling for "something is wrong" rather
   * than for the expected wait. It used to be two, from when this always ran a
   * distilled model at its default size; these workflows carry an upscaler and
   * a face detailer behind the sampler, and a ceiling under the real time is a
   * picture thrown away after the work of making it was done. The reader can
   * always press Stop.
   */
  const watchJob = async (id, {
    prompt = '', video = false, signal, deadlineMs = 1200000, every = 1200,
    // For the card: what kind of job, its shape, what it is made from, and
    // where it sits in a batch. See JobProgress.
    kind = video ? 'video' : 'image', aspect = null, source = null, batch = null,
  } = {}) => {
    const deadline = Date.now() + deadlineMs;
    let finished = null;
    setDrawing({ id, video, prompt, kind, aspect, source, batch });
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('stopped');
        await new Promise(r => setTimeout(r, every));
        const state = await fetch(`/studio/job?id=${encodeURIComponent(id)}`, { signal })
          .then(r => r.json())
          .catch(() => null);
        if (state?.state === 'failed') throw new Error(state.error || 'the job failed');
        /* How many are in front of it. ComfyUI runs one prompt at a time, so a
           job queued behind another produces no progress messages whatsoever --
           and without this the card says "queued" with no indication of whether
           that means seconds or an hour. */
        if (typeof state?.ahead === 'number') {
          setDrawing(d => (d && d.ahead !== state.ahead ? { ...d, ahead: state.ahead } : d));
        }
        if (state?.state === 'done' && (state.outputs?.length || state.texts?.length)) { finished = state; break; }
      }
    } finally {
      // On the way out through a throw as well: a progress bar still on screen
      // after the thing it was measuring gave up is worse than no bar at all.
      setDrawing(null);
      /* And ComfyUI is told. Stop used to stop only the *watching*: the prompt
         stayed queued and the GPU carried on for minutes on a picture nobody
         would see. The Studio's cancel takes it out of the queue or interrupts
         it. Without the signal: it is the thing that has just been aborted, and
         passing it would cancel the cancel. */
      if (!finished) stopDrawing(id);
    }
    if (!finished) throw new Error('the job did not finish in time');
    return finished;
  };

  /* The saved file, not a preview of it. A workflow's preview nodes report
     their temp files beside the save node's output, and the first of them is
     not reliably the finished picture. */
  const finalOutput = (outputs = [], media = 'image') =>
    outputs.find(o => o.type === 'output' && o.media === media)
    || outputs.find(o => o.media === media)
    || outputs[0];

  /**
   * One picture, start to finish, for the model's `generate_image` tool.
   *
   * Queue, watch, fetch the bytes, hand back a data URL. The model chooses a
   * style rather than a checkpoint -- "is this anime or is it not" it can
   * answer -- unless the Studio pins a workflow for chat.
   *
   * `opts` carries what the chat-side tools add: `mask` (a white-on-black
   * picture of what may change, for a painted edit or an extension), `size`
   * to sample at when the canvas is not the workflow's usual shape, and
   * `seed` to pin one.
   */
  const generateOneImage = async (prompt, style = 'photo', negative = '', edit = null, signal, opts = {}) => {
    const model = chatImageModel(style);
    const settings = await studioSettingsFor(model, signal);

    /* The shape, in order of who has the say:
     *
     *   - an edit keeps the shape of the picture being edited. It is that
     *     picture, changed; a different shape is extend_image's job, and forcing
     *     one here crops or stretches what they asked to keep;
     *   - otherwise a shape they asked for (`aspect`);
     *   - otherwise the shape of the picture this one is made from (`shapeFrom`:
     *     the one they just attached, or the one being redrawn);
     *   - otherwise the Studio's size, as before.
     *
     * Each at the workflow's usual area, so a wide picture costs what a tall
     * one does. */
    let size = opts.size || null;
    if (!size) {
      const area = workflowArea(model, settings);
      const ratio = parseAspect(opts.aspect);
      const source = edit?.dataUrl || (!ratio && opts.shapeFrom) || null;
      if (source) {
        const dims = await pictureSize(source).catch(() => null);
        if (dims) size = samplingSize(dims, area);
      } else if (ratio) {
        size = sizeForAspect(ratio, area);
      }
    }

    /* Editing rather than drawing. The picture has to reach ComfyUI's own input
       folder before a workflow can load it by name, which is what
       `/studio/upload` is for — the same path the Studio's reference picker
       takes. */
    const referenceImage = edit?.dataUrl
      ? await uploadToComfy(edit.blob || edit.dataUrl, `edit-${Date.now()}.png`, signal)
      : undefined;
    const maskImage = referenceImage && opts.mask
      ? await uploadToComfy(opts.mask, `mask-${Date.now()}.png`, signal)
      : undefined;
    const pinnedSeed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed)
      : (referenceImage && edit.seedModel === model && Number.isFinite(Number(edit.seed)) ? Number(edit.seed) : undefined);

    const queued = await fetch('/studio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...settings,
        model,
        prompt,
        ...(negative ? { negative } : {}),
        ...(referenceImage ? { referenceImage, denoise: edit.change } : {}),
        // Only that part redrawn; see `applyRegionEdit` on the server.
        ...(referenceImage && edit.region && !maskImage ? { region: edit.region } : {}),
        ...(maskImage ? { maskImage, maskGrow: Number(opts.maskGrow) || 0 } : {}),
        ...(size ? { size: `${size.width}x${size.height}` } : {}),
        ...(pinnedSeed !== undefined ? { seed: pinnedSeed } : {}),
        // Anima reads tags and a sentence; the server rearranges the prompt into both.
        ...(model === 'anima-base' ? { shapeTags: true } : {}),
      }),
      signal,
    }).then(r => r.json());
    if (!queued?.success) throw new Error(queued?.error || 'the generator refused the job');
    // Said, rather than an edit quietly becoming a redraw of everything.
    for (const warning of queued.warnings || []) addLog(`[studio] ${warning}`, 'warning');
    // The server takes the chat model off the card first -- see server/vram.js.
    if (queued.unloaded?.length) addLog(`[vram] unloaded ${queued.unloaded.join(', ')} to make room for the picture`, 'info');
    if (queued.tags?.length) addLog(`[anima] tags: ${queued.tags.join(', ')}`, 'info');

    const state = await watchJob(queued.id, {
      prompt,
      signal,
      aspect: sizeRatio(size) ?? sizeRatio(settings.size),
      // An edit starts from a picture, and the card shows it until the first frame.
      source: edit?.dataUrl || null,
      batch: opts.batch || null,
    });
    const output = finalOutput(state.outputs);
    const dataUrl = await outputAsDataUrl(output.url, signal);
    // The prompt it was actually drawn from, which for Anima is the shaped one,
    // and everything else it was drawn with -- see readSettings on the server.
    return {
      dataUrl, filename: output.filename, seed: queued.seed, model, prompt: queued.prompt || prompt, style, negative,
      ...(queued.settings ? { settings: queued.settings } : {}),
    };
  };

  /**
   * Several of the same picture, each with its own seed.
   *
   * Queued one after another rather than as one batch: the workflows finish
   * with an upscaler that holds a batch of four full-size pictures in VRAM at
   * once, and a card that fits one comfortably does not fit four.
   */
  const generateImages = async (count, prompt, style, negative, edit, signal, opts = {}) => {
    const pictures = [];
    const total = Math.min(Math.max(Math.round(Number(count) || 1), 1), 4);
    // `batch` is for the progress card: which of how many, and those already made.
    for (let i = 0; i < total; i += 1) {
      if (signal?.aborted) break;
      const batch = total > 1 ? { n: i + 1, of: total, made: pictures.map(p => p.dataUrl) } : null;
      pictures.push(await generateOneImage(prompt, style, negative, edit, signal, { ...opts, batch }));
    }
    return pictures;
  };

  /**
   * Something done to a picture: `rmbg`, `upscale`, or `tag`. Returns the new
   * picture, or for `tag` the tags as one comma-separated string.
   */
  const runPictureOp = async (op, picture, { factor, signal } = {}) => {
    const image = await uploadToComfy(picture.dataUrl, `${op}-${Date.now()}.png`, signal);
    const size = op === 'upscale' ? await pictureSize(picture.dataUrl).catch(() => null) : null;
    const res = await fetch('/studio/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, image, ...(factor ? { factor } : {}), ...(size || {}), requestId: `${op}-${Date.now()}` }),
      signal,
    }).then(r => r.json());
    if (!res?.success) throw new Error(res?.error || 'ComfyUI refused the job');
    if (res.unloaded?.length) addLog(`[vram] unloaded ${res.unloaded.join(', ')} for ${op}`, 'info');

    const state = await watchJob(res.id, {
      prompt: picture.prompt || '', signal, deadlineMs: 600000, every: 1000,
      kind: 'edit', source: picture.dataUrl, aspect: sizeRatio(size),
    });
    if (op === 'tag') return { tags: (state.texts || []).join(', ') };
    const output = finalOutput(state.outputs);
    return {
      dataUrl: await outputAsDataUrl(output.url, signal),
      filename: output.filename,
      prompt: picture.prompt || '',
      op,
      ...(res.factor ? { factor: res.factor } : {}),
    };
  };

  /**
   * More of the scene around a picture, with the picture itself untouched.
   * See src/pictureTools.js for the canvas and mask.
   */
  const extendPicture = async (picture, { direction, amount, prompt, style, negative }, signal) => {
    const padded = await padForExtension(picture.dataUrl, { direction, amount });
    const model = chatImageModel(style);
    const settings = await studioSettingsFor(model, signal);
    // The workflow's own area, in the new shape: the canvas is wider (or taller)
    // than anything it was set up for.
    const area = workflowArea(model, settings);
    return generateOneImage(prompt, style, negative, {
      blob: padded.padded,
      dataUrl: picture.dataUrl,
      // The margin is empty: it has to be drawn outright, not retouched.
      change: 1,
      seed: picture.seed,
      seedModel: picture.model,
    }, signal, { mask: padded.mask, size: samplingSize(padded, area) });
  };

  /**
   * The most recent picture in this conversation, as a data URL.
   *
   * Generated images first, then attachments, newest first — which is what
   * "이걸 영상으로 만들어줘" means when there are several. Reading the transcript
   * rather than asking the model is the point: a model asked to describe a
   * picture so another model can redraw it produces a *different* picture, and
   * the whole request was to animate this one.
   */
  const latestPictureInChat = () => {
    const history = messagesRef.current || [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      const drawn = [...(message.generated || [])].reverse().find(p => p.dataUrl && !p.video);
      // With what drew it -- seed, model, prompt, style -- so an edit can draw
      // the changed part the same way.
      if (drawn) return { ...drawn };
      /* A picture they attached. The question keeps it as bare base64 in
         `images` -- the shape Ollama wants -- and this used to look for an
         `attachments` list no message has, so "animate the picture I sent" and
         "fix this photo" found nothing and said there was no picture. The last
         one attached is the one they mean. */
      const images = message.role === 'user' ? (message.images || []) : [];
      if (images.length) return { dataUrl: asImageDataUrl(images[images.length - 1]), attached: true };
      const attached = [...(message.attachments || [])].reverse().find(a => a.type === 'image' && a.preview);
      if (attached) return { dataUrl: attached.preview, attached: true };
    }
    return null;
  };
  const latestImageInChat = () => latestPictureInChat()?.dataUrl || null;

  /** One particular picture in this conversation, by the file ComfyUI made it as. */
  const pictureByFilename = (filename) => {
    if (!filename) return null;
    for (const message of messagesRef.current || []) {
      const found = (message.generated || []).find(p => p.filename === filename && p.dataUrl);
      if (found) return { ...found };
    }
    return null;
  };

  /**
   * One video, for the model's `generate_video` tool.
   *
   * A reference picture has to reach ComfyUI's own input folder before a
   * workflow can load it by name, so it is uploaded first and the returned name
   * is what the job carries. Everything after that is the image path with a
   * longer deadline: a few seconds of video is minutes of GPU, not one.
   */
  const generateOneVideo = async (rawPrompt, referenceDataUrl, signal, opts = {}) => {
    let referenceImage;
    if (referenceDataUrl) {
      const blob = await (await fetch(referenceDataUrl)).blob();
      const form = new FormData();
      form.append('image', blob, `reference-${Date.now()}.png`);
      const up = await fetch('/studio/upload', { method: 'POST', body: form, signal }).then(r => r.json());
      if (!up?.success) throw new Error(up?.error || 'the reference image could not be uploaded');
      referenceImage = up.name;
    }

    const settings = await studioSettingsFor('minimax-h3', signal);

    /* How long: what the model said, else where its timeline ends, else the
       Studio's length. Then the timeline is made to agree with it -- starting
       at 0s, without gaps, ending exactly there. See src/videoPrompt.js. */
    const duration = clampSeconds(opts.duration)
      ?? clampSeconds(durationFromTimeline(rawPrompt))
      ?? clampSeconds(settings.duration)
      ?? VIDEO_SECONDS.fallback;
    const prompt = normalizeTimeline(rawPrompt, duration);

    /* The shape: one they asked for, else the picture being animated -- a
       portrait photo should not come back as a square with its head cut off --
       else the Studio's. On a grid of 32, which H3's latents divide by. */
    const area = workflowArea('minimax-h3', settings);
    const ratio = parseAspect(opts.aspect);
    let size = ratio ? sizeForAspect(ratio, area, 32) : null;
    if (!size && referenceDataUrl) {
      const dims = await pictureSize(referenceDataUrl).catch(() => null);
      if (dims) size = sizeForAspect({ w: dims.width, h: dims.height }, area, 32);
    }

    const queued = await fetch('/studio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...settings,
        model: 'minimax-h3',
        prompt,
        duration,
        ...(size ? { size: `${size.width}x${size.height}` } : {}),
        ...(referenceImage ? { referenceImage } : {}),
      }),
      signal,
    }).then(r => r.json());
    if (!queued?.success) throw new Error(queued?.error || 'the generator refused the job');
    if (queued.unloaded?.length) addLog(`[vram] unloaded ${queued.unloaded.join(', ')} to make room for the video`, 'info');

    // Fifteen minutes. A video is minutes of work and the ceiling is for
    // "something is wrong", not for the expected wait.
    const deadline = Date.now() + 900000;
    let output = null;
    setDrawing({ id: queued.id, video: true, prompt, kind: 'video',
      aspect: sizeRatio(size) ?? sizeRatio(settings.size),
      // Animating a picture: that picture is on the card until the clip starts.
      source: referenceDataUrl || null,
    });
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('stopped');
        await new Promise(r => setTimeout(r, 2500));
        const state = await fetch(`/studio/job?id=${encodeURIComponent(queued.id)}`, { signal })
          .then(r => r.json()).catch(() => null);
        if (state?.state === 'failed') throw new Error(state.error || 'the generation failed');
        if (state?.state === 'done' && state.outputs?.length) {
          output = state.outputs.find(o => o.media === 'video') || state.outputs[0];
          break;
        }
      }
    } finally {
      setDrawing(null);
      // As above: a stopped video is a stopped video in ComfyUI too.
      if (!output) stopDrawing(queued.id);
    }
    if (!output) throw new Error('the generation did not finish in time');

    const blob = await fetch(output.url, { signal }).then(r => {
      if (!r.ok) throw new Error(`could not read the result (HTTP ${r.status})`);
      return r.blob();
    });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    // The timeline it was actually made from, which is what the caption shows.
    return {
      dataUrl, filename: output.filename, seed: queued.seed, model: 'minimax-h3', prompt, duration,
      ...(queued.settings ? { settings: queued.settings } : {}),
    };
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

  /* Numbered from `offset`, so web results and document passages share one
     numbering. Two independent lists each starting at 1 would mean the model
     writes `[1]` with no way for anyone — reader or code — to tell which of
     the two sources it meant. */
  const formatSearchResults = (results, offset = 0) => results
    .map((r, i) => `[${offset + i + 1}] ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');

  // Every generation request shares these sampling options.
  // Models answer from a training snapshot and rarely know today's date, which
  // is how "what is new in 2026" turns into a confident answer from 2024. State
  // the date, and say plainly that the weights may be stale.
  const environmentPreamble = () => {
    const now = new Date();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    const lines = [
      '[Environment]',
      `Current date and time: ${now.toISOString()} (${zone}).`,
      `Today is ${now.toLocaleDateString('en-CA')}.`,
      `The interface language is ${promptLanguageName(lang)}.`,
    ];

    // Where the user says they are. Typed in Settings rather than taken from
    // the browser: geolocation needs a permission prompt *and* a secure
    // context, and this app is routinely opened over plain HTTP so that a
    // phone can reach it — the same reason copying needed a fallback. A line
    // the user chose to write is also the version that respects them.
    if (userLocation.trim()) {
      lines.push(`The user is in ${userLocation.trim()}. Use this for anything local`
        + ' — weather, time zones, opening hours, currency, distances — rather than'
        + ' guessing or asking again.');
    } else {
      /* Nothing typed, so the time zone stands in for it.
       *
       * `navigator.geolocation` is not available here: it needs a secure
       * context, and this app is routinely opened over plain HTTP so that a
       * phone can reach it. But an IANA zone is named after a representative
       * city — `Asia/Seoul`, `America/New_York`, `Europe/Paris` — and the
       * browser reports it without a permission prompt, without a network
       * request, and on any origin.
       *
       * It is a coarse answer and is offered as one: a zone covers a country
       * in Korea and a third of a continent in parts of Russia. Said plainly,
       * that is still the difference between "I don't know where you are" and
       * a sensible guess at which city's weather was meant. */
      const city = (zone.split('/').pop() || '').replace(/_/g, ' ').trim();
      if (city && city !== 'local time') {
        lines.push(`No location has been set, but the browser's time zone is ${zone},`
          + ` which suggests somewhere around ${city}. Treat that as a rough guess:`
          + ' use it rather than asking, and say which place you assumed.');
      }
    }

    // Only when the file tools are actually switched on. Without them the
    // model can do nothing with a path, and naming somebody's home directory
    // in every prompt for no reason is not a neutral act.
    if (mcpEnabled && hostInfo) {
      const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[hostInfo.platform] || hostInfo.platform;
      lines.push(`The machine running this is ${osName}${hostInfo.hostname ? ` (${hostInfo.hostname})` : ''}.`);
      if (hostInfo.home) {
        lines.push(`The user's home directory is ${hostInfo.home}, and paths use "${hostInfo.separator || '/'}".`
          + ' Build absolute paths from that home directory rather than guessing a'
          + ' Unix-style one, and list a directory before assuming what is in it.');
      }
    }

    lines.push(
      'Your training data ends before this date, so anything you "remember" about',
      'recent events, releases, versions, prices or people may be out of date.',
      'When a question depends on current facts, prefer information supplied in this',
      'conversation over your own recollection, and say when you are unsure.',
    );
    return lines.join('\n');
  };

  /**
   * Options for a model call that is not the conversation.
   *
   * Titles, summaries, compaction, verification, research steps -- everything
   * that asks the model something on the side.
   *
   * `num_ctx` is not optional and not a smaller number. Ollama keeps one
   * loaded instance per context size, so a helper call that omits it, or sets
   * it lower to be frugal, does not save anything: it makes Ollama *reload the
   * whole model* at a different size, and then the next real turn reloads it
   * back. Measured on this machine with gemma4:31b on a 16GB card:
   *
   *     chat turn, num_ctx 8192      68% on GPU   7.9 tok/s
   *     one call with no num_ctx     34% on GPU   4.6 tok/s   (17.7s reload)
   *     next chat turn again         68% on GPU   9.8 tok/s   (15.4s reload)
   *
   * The default context of a modern model is enormous -- 262,144 here, whose
   * KV cache alone is 16GB -- so "no num_ctx" is not "a small default", it is
   * the largest possible allocation. Every call sends the same number or the
   * model thrashes.
   */
  const helperOptions = (extra = {}) => ({
    ...(numCtx ? { num_ctx: numCtx } : {}),
    ...extra,
  });

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

  // Tabs are independent, and there is exactly one thing that makes them so:
  // each holds the *id* of a session the server issued, and nothing else. What
  // used to be here was a per-tab profile — an identity the tab decided for
  // itself — and that meant a tab could be signed out on the server while still
  // showing, writing to and uploading an account's chats. A tab now says which
  // session it is asking about and the server says who that is, or that it is
  // nobody; the provider remounts this tree around the answer.

  // ---- Signing in and out ----
  //
  // Every one of these is short now, and that is the point. Signing in used to
  // mean reconciling a browser-local profile with a server account, deciding
  // which won, remapping storage buckets and merging one into the other — and
  // each of those steps was a chance to put the wrong person's chats somewhere.
  // A sign-in is a session; a sign-out is the end of one; the tree remounts
  // around the new identity and reads the new bucket from scratch.

  /**
   * Adopt the session a sign-in just produced.
   *
   * The tree remounts on the identity change, so there is deliberately no state
   * to shuffle here: the new App reads the new account's storage on mount. All
   * this does is record the outcome and then reconcile with the account.
   */
  const handleSignedIn = async (result, { created } = {}) => {
    const account = result?.user;
    if (!account) return;

    setSetting('authIntroSeen', 'true');

    // Adopting the session changes the identity, which remounts this whole tree
    // against the new account's storage. Nothing set on *this* instance
    // survives that, so what should be said afterwards is left for the next one.
    leaveHandoff({ kind: 'signed-in', name: account.name, provider: account.provider, created });
    authSession.adopt(result);
  };

  /**
   * Bring the account's state down after a sign-in, or seed it from this device.
   *
   * Runs once per identity, after the remount, so `profileScope` is already the
   * new account's and cannot be the old one's. That ordering is not incidental:
   * doing this during the sign-in — as it used to — is precisely how a pull for
   * one account landed in another account's bucket.
   */
  const reconcileWithAccount = async () => {
    if (!accountId) return;
    try {
      // One exchange, both directions: what this device has that the account
      // does not goes up, what the account has that this device does not comes
      // down. There is no "push or pull" decision to get wrong any more, and no
      // window in which one side's copy replaces the other's wholesale.
      const result = await syncFully(profileScope);
      syncStampRef.current = result.rev;
      setSyncInfo(await accountStamp());

      if (result.changedLocally > 0) {
        // Put what arrived on screen rather than asking for it to be put there.
        // This ran at boot and offered a Reload button, which meant a refresh —
        // the ordinary way to check whether another device's chat had come
        // through — showed nothing, and the answer was to refresh a second
        // time. The chats were already here; only the screen had not been told.
        const shown = await refreshChatsFromStorage();
        // Settings that came down are read into state at mount and cannot be
        // swapped in underneath the app, so those still want a reload. Chats no
        // longer do, and chats are what somebody refreshing is looking for.
        if (!shown || result.applied.settings > 0) {
          toast(t('sync.pulled', { chats: result.applied.chats }), 'success', 8000, {
            label: t('backup.reload'),
            onClick: () => window.location.reload(),
          });
        }
      }
    } catch (e) {
      if (e instanceof OwnerMismatch) {
        // The server and this browser disagree about who is signed in. Never
        // guess: ask again, and let the answer remount the tree.
        addLog('[sync] the account changed underneath this tab; re-reading the session.', 'info');
        authSession.refresh();
        return;
      }
      // Sync is a bonus; a failure here must not break being signed in.
      addLog(`[sync] could not reconcile with the account: ${e.message}`, 'info');
    }
  };

  const reconciledRef = useRef('');
  useEffect(() => {
    if (!accountId || !isStorageLoaded) return;
    if (reconciledRef.current === accountId) return;
    reconciledRef.current = accountId;
    reconcileWithAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isStorageLoaded]);

  const handleGuest = async () => {
    setSetting('authIntroSeen', 'true');
    // Pin the tab to the guest even though it is already showing nobody. An
    // unpinned tab follows the newest session, so without this a sign-in in
    // another tab would quietly sign this one in too — which is not what
    // somebody who just chose to carry on without an account asked for.
    await authSession.addAccount();
    setShowAuthScreen(false);
  };

  /**
   * Add another account in this tab, without signing the current one out.
   *
   * The distinction from signing out is the whole point of the feature: the
   * account stays signed in — another tab may be looking at it, and it is one
   * click away in the switcher — while this tab stops acting as it. What is
   * pending still has to go up first, because this tab is about to stop being
   * the thing that would send it.
   *
   * The cached settings are deliberately *not* cleared, unlike a sign-out: the
   * account has not left this browser, and clearing them would pull the rug out
   * from under whichever tab is still showing it.
   */
  const handleAddAccount = async () => {
    try {
      await syncRef.current?.flush();
    } catch (e) {
      addLog(`[sync] the final upload failed: ${e.message}`, 'error');
    }
    syncRef.current?.cancel();
    syncRef.current = null;

    // The tree remounts as the guest, so the sign-in screen has to be asked for
    // on the far side of the remount rather than on this one.
    leaveHandoff({ kind: 'signed-out' });
    await authSession.addAccount();
  };

  /**
   * The accounts signed in on this browser that this tab is not showing.
   *
   * Keyed by account rather than by session, deliberately. A tab is a session,
   * so the same account open in three tabs arrives here three times, and a
   * switcher listing one person three times is noise — offering to switch to
   * the account you are already looking at even more so. One row per account,
   * carrying whichever session was listed first; switching to it hands this tab
   * a session on that account, which is all "switch" has ever meant.
   */
  const otherAccounts = useMemo(() => {
    const byAccount = new Map();
    for (const entry of authSession.accounts || []) {
      const id = entry.user?.id;
      if (!id || id === user?.id || byAccount.has(id)) continue;
      byAccount.set(id, entry);
    }
    return [...byAccount.values()];
  }, [authSession.accounts, user?.id]);

  // Called rather than rendered as a component: a component defined inside a
  // render is a new type on every pass, and React throws the old one away each
  // time. This is markup, so it is written as markup.
  const otherAccountItems = () => (otherAccounts.length ? (
    <>
      <div className="cmd-section">{t('auth.otherAccounts')}</div>
      {otherAccounts.map(account => (
        <button
          key={account.sessionId}
          className="cmd-item"
          title={account.user.email || account.user.name}
          onClick={() => { setShowProfileMenu(false); handleSwitchTo(account.sessionId); }}
        >
          <ProfileAvatar user={account.user} size={20} />
          <span className="cmd-label stacked">
            {account.user.name}
            {account.user.email && <span className="cmd-sub">{account.user.email}</span>}
          </span>
        </button>
      ))}
    </>
  ) : null);

  /** Point this tab at an account already signed in on this browser. */
  const handleSwitchTo = async (sessionId) => {
    try {
      await syncRef.current?.flush();
    } catch (e) {
      addLog(`[sync] the final upload failed: ${e.message}`, 'error');
    }
    syncRef.current?.cancel();
    syncRef.current = null;
    await authSession.switchTo(sessionId);
  };

  /**
   * Sign out.
   *
   * The pending upload is flushed first so nothing written in the last few
   * seconds is lost, and cancelled after, so nothing in flight can be
   * attributed to the account once it has been left. The account's cached
   * settings go too: on a shared computer they are the next person's to read,
   * and a stale cache is its own source of "why am I seeing that".
   */
  const handleSignOut = async () => {
    /* Signing out while a reply is still arriving.
     *
     * The reply cannot outlive the sign-out, and that is a decision rather
     * than a limitation. Signing out changes which account's storage the whole
     * app is pointed at -- the tree is rebuilt against the new scope, by
     * design, because one render against the wrong account's storage is how
     * chats used to end up in the wrong bucket. A generation that kept running
     * across that boundary would be writing an answer into an account nobody
     * is signed into any more.
     *
     * What can be saved is the answer so far, and that is what was actually
     * being lost: the transcript is written to storage on a debounce, so
     * whatever arrived in the last second of a stream had not been stored yet,
     * and the final upload had nothing to send. The stream is closed, the
     * partial answer is written immediately, and only then does the sign-out
     * proceed -- so signing back in finds the reply where it stopped, and
     * "carry on" continues it.
     */
    if (isGeneratingRef.current) {
      if (!window.confirm(t('auth.signOutWhileGenerating'))) return;
      abortControllerRef.current?.abort();
      setIsGenerating(false);
      setGeneratingSessionId(null);
      try { await persistChatsNow(sessionsRef.current); } catch (e) { /* keep going */ }
    }

    const leaving = profileScope;

    // flush() reports whether the account really is up to date, rather than
    // merely that a push was attempted. The distinction decides whether this
    // device's cache can be cleared below, so it must not be guessed at.
    let flushed = true;
    try {
      const scheduler = syncRef.current;
      flushed = scheduler ? await scheduler.flush() : true;
      if (!flushed) addLog('[sync] the final upload did not land; keeping the local copy.', 'error');
    } catch (e) {
      // The sign-out still proceeds — staying signed in is the worse outcome —
      // but this device's cache is now the only copy of whatever did not go up.
      flushed = false;
      addLog(`[sync] the final upload failed: ${e.message}`, 'error');
    }
    syncRef.current?.cancel();
    syncRef.current = null;

    forgetGoogleAutoSelect();

    // Only once what was pending is safely on the server. Clearing the cache
    // first would turn a failed upload into lost settings, and the whole reason
    // an account has a server copy is so that leaving a device costs nothing.
    if (flushed) clearScopeSettings(leaving);

    leaveHandoff({ kind: 'signed-out' });
    await authSession.signOut();
    addLog('Signed out.', 'info');
  };

  /** End every other session. What to reach for when a device goes missing. */
  const handleSignOutOthers = async () => {
    setSyncBusy('auth');
    try {
      const result = await signOutOtherDevices();
      toast(t('auth.otherSessionsEnded', { count: result.ended }), 'success');
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;
    if (!window.confirm(`${t('auth.deleteAccount')}\n\n${t('auth.deleteWarning')}`)) return;

    const leaving = profileScope;
    syncRef.current?.cancel();
    syncRef.current = null;

    try {
      // Deleting the account withdraws the app's permission at the provider
      // too, and removes the account's state from the server.
      await deleteServerAccount();
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 7000);
      return;
    }

    // Only now: the account is gone, so its cache here is orphaned.
    await localforage.removeItem(sessionStorageKeyFor(leaving));
    clearScopeSettings(leaving);
    forgetGoogleAutoSelect();

    leaveHandoff({ kind: 'signed-out' });
    await authSession.refresh();
    addLog('Account deleted.', 'info');
  };

  /** Sever the Kakao connection without deleting the account. */
  const handleKakaoUnlink = async () => {
    try {
      const result = await kakaoUnlink();
      if (result?.success) toast(t('auth.kakaoUnlinked'), 'success');
      else toast(result?.error || t('auth.kakaoFailed'), 'error', 6000);
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  };

  // Settings always lands on General unless a caller asks for a specific tab,
  // so reopening never drops you back into whatever you last poked at.
  // ---- Memory ----

  const rememberFromChat = async () => {
    if (extractingMemory || messages.length < 2) return;
    setExtractingMemory(true);
    try {
      const transcript = safeHead(messages
        .filter(m => !String(m.content).trim().startsWith('<TOOL_RESULT>'))
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${safeHead(cleanForExport(m.content), 1500)}`)
        .filter(line => line.length > 12)
        .join('\n\n'), 12000);

      const candidates = await extractMemories(transcript, selectedModel,
        { options: helperOptions() });
      const { memories: next, added } = await addMemories(profileScope, candidates);
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
    await saveMemories(profileScope, next);
    setMemories(next);
  };

  const deleteMemory = async (id) => setMemories(await removeMemory(profileScope, id));

  const addManualMemory = async (text, kind) => {
    const { memories: next, added } = await addMemories(profileScope, [{ text, kind }]);
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
      const transcript = safeHead(older
        .filter(m => !String(m.content).trim().startsWith('<TOOL_RESULT>'))
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${safeHead(cleanForExport(m.content), 2000)}`)
        .join('\n\n'), 20000);

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
          options: helperOptions({ temperature: 0.2, num_predict: 900 }),
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
        onClick: () => reviseSession(sid, x => ({ ...x, messages: previous })),
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

  /**
   * As a PDF, by way of the browser's own printer.
   *
   * There is no PDF library here and there should not be: "Save as PDF" is
   * already installed, already knows the reader's paper size, and already has
   * the fonts. Laying out a PDF in JavaScript instead would mean embedding a
   * Korean font to avoid a page of boxes, and getting page breaks right by
   * hand — a great deal of work to arrive back at what the print dialog does.
   *
   * A window rather than an iframe: an iframe's print dialog is the parent
   * page's in some browsers, and what would be saved is the app rather than
   * the transcript.
   */
  const printSession = (session) => {
    const target = session || currentSession;
    if (!target) return;

    const win = window.open('', '_blank');
    if (!win) {
      // Blocked. Worth saying, because nothing at all happened and the reason
      // is not visible anywhere.
      toast(t('export.popupBlocked'), 'error', 8000);
      return;
    }
    win.document.write(sessionToPrintableHtml(target));
    win.document.close();
    addLog(`Printing "${target.title}".`, 'success');
  };

  // The app's public identity — client IDs, and which sign-in methods this
  // server can actually complete. Nothing about *who* is signed in comes from
  // here; that was asked and answered before this component existed.
  useEffect(() => {
    let cancelled = false;
    fetchServerConfig().then(config => {
      if (cancelled || !config) return;
      // Set before anything renders a sign-in button, or the button reads the
      // config as absent and hides itself.
      setServerSocialConfig(config);
      setServerConfig(config);

      // Two addresses reaching one server are still two websites to a browser:
      // chats, settings and the sign-in cookie are all kept per origin. So a
      // desktop on http://localhost:5173 and a phone on a hostname are one
      // person signed in twice, with two local caches. The server database is
      // the same file either way -- it is the browser that splits -- and the
      // only fix is to be on one address, which is what this offers.
      //
      // Said once per tab, and not at all when there is nothing to say: a
      // server with no PUBLIC_ORIGIN configured sends an empty string, and
      // every address is then equally right.
      const canonical = config.canonicalOrigin || '';
      if (!canonical || canonical === window.location.origin) return;
      toast(t('origin.split', { origin: canonical }), 'info', 20000, {
        label: t('origin.openShared'),
        // Path and query carried across: whatever was being looked at is
        // still what should be on screen at the other address.
        onClick: () => { window.location.href = canonical + window.location.pathname + window.location.search; },
      });
    });
    return () => { cancelled = true; };
  }, []);

  // ---- Whole-state backup ----
  // Browser storage is per origin, so opening this app on a phone, or on a
  // different port, starts from nothing. This is how state moves.

  const [restoring, setRestoring] = useState(false);
  const backupInputRef = useRef(null);
  const backupRestoreMode = useRef('merge');

  const exportBackup = async () => {
    try {
      // A file backup takes the whole browser, which is what backing up a
      // browser means. It carries no credentials: accounts live on the server
      // now, so there is nothing here to leak into a file people email around.
      const backup = await collectBackup();
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

  /**
   * Reload the page to show what a sync just wrote -- once per revision.
   *
   * Reloading is how another device's change becomes visible: chats and
   * settings are read into React state at mount, so a store that changed
   * underneath is not on screen until the page is built again.
   *
   * The counter is what stops that becoming a loop. A device that cannot write
   * to `localStorage` -- private browsing, storage blocked, a full quota --
   * cannot remember how far it has synced either, so every sync pulls the
   * whole account down again, every one of them counts as a change, and every
   * one of them would reload. Recording the revision we reloaded for makes the
   * second one a no-op; failing to record it means we cannot promise that, and
   * the honest answer is then to offer the reload rather than to take it.
   */
  // Per account: revisions are an account's own counter, so a tab that has
  // switched to a different one would otherwise be comparing two unrelated
  // numbers and could refuse a reload it needs.
  /**
   * Show what a sync just brought down.
   *
   * Reloading was the only answer here, and for settings it still is: they are
   * read into some fifty `useState` initialisers when the app mounts, so a
   * changed value in storage is not on screen until the app is built again.
   *
   * Chats are not like that. They live in one piece of state that can simply be
   * re-read, and re-reading is the difference between a reply appearing on the
   * phone as it is written and the phone reloading itself every three seconds
   * for as long as the model is talking. So a sync that touched only chats is
   * applied in place, and only the rest is worth a reload.
   */
  const showRemoteChanges = (result) => {
    const applied = result.applied || {};
    const beyondChats = (applied.settings || 0) + (applied.lists || 0)
      + (applied.documents || 0) + (applied.memories || 0);

    /* The Studio re-reads its own records in place, so a change to them is
       never a reason to rebuild the page. It used to be one: every job the
       Studio ran was a write, every write came back from the account, and each
       return reloaded the page out from under whatever was being typed. */
    if (applied.studio > 0) window.dispatchEvent(new Event('webui:studio-synced'));
    if (!beyondChats && !(applied.chats > 0)) return true;

    if (!beyondChats && applied.chats > 0) {
      // Deliberately not gated on whether the user is busy. That guard exists
      // because a reload throws away a half-written message and a half-streamed
      // reply; re-reading the chat list throws away neither. The composer is
      // untouched, and `refreshChatsFromStorage` already declines outright
      // while this device is generating, because the reply being streamed here
      // is in state and not yet in storage.
      refreshChatsFromStorage();
      return true;
    }

    // Anything else means settings, folders, presets, documents or memories,
    // every one of which was read into state at mount. Only a reload shows
    // them -- so here the guard does apply, and a busy device is asked rather
    // than interrupted.
    if (isGeneratingRef.current || inputRef.current.trim().length > 0) return false;
    return reloadForRev(result.rev);
  };

  const reloadedRevKey = `syncReloadedRev@${accountId || 'guest'}`;
  const reloadForRev = (rev) => {
    try {
      const seen = Number(sessionStorage.getItem(reloadedRevKey)) || 0;
      if (rev && rev <= seen) return false;
      sessionStorage.setItem(reloadedRevKey, String(rev || 0));
    } catch (e) {
      return false;
    }
    window.location.reload();
    return true;
  };

  // Changes go up on their own, coalesced: settings change on every keystroke
  // and the payload is the whole history, so one upload per character would be
  // absurd. Signed out, nothing is scheduled and nothing leaves the browser.
  useEffect(() => {
    if (!accountId) { syncRef.current?.cancel(); syncRef.current = null; return undefined; }

    syncRef.current = createSyncScheduler({
      // The other devices are now told the moment this one uploads, so the
      // wait before uploading is the whole of the delay they see. Five seconds
      // was chosen when nothing was listening; it only has to be long enough
      // to coalesce a burst of edits, which one is.
      delay: 1000,
      // ...but a streaming reply changes the chat several times a second, and
      // a plain debounce under that never fires: the answer only went up once
      // it was finished. This is the ceiling that makes the reply appear on
      // the other device while it is still being written -- and it is also the
      // size of the step it appears in. At three seconds the answer arrived on
      // the phone in visible lurches; at one it reads as text being written.
      //
      // One a second is the floor worth having. Below it the round trip stops
      // being the limit -- upload, doorbell, stat, fetch, apply -- and the
      // phone spends its time syncing rather than showing what it synced.
      maxDelay: 1000,
      // Read at push time, not captured: the scope is what the payload is
      // stamped with, and a stamp taken when the timer was set could name an
      // account that has since been signed out of.
      scope: () => profileScopeRef.current,
      onResult: (result) => {
        syncStampRef.current = result.rev || syncStampRef.current;
        if (result.changedLocally <= 0) return;

        // An upload is also a download -- one round trip does both -- so this
        // is one of the two places another device's change actually lands, and
        // in practice the commoner one: it runs on every local edit, while the
        // poll runs on a timer. It has to *show* what it brought down for the
        // same reason the poll does. Chats and settings were read into React
        // state when the page mounted, so a store that has changed underneath
        // is not yet anything the user can see.
        //
        // Read through refs. This closure was made when the scheduler was, so
        // the state variables it can see are the ones from that render and
        // will never change again -- which is how an earlier version of this
        // guard read `isGenerating` as false forever.
        if (showRemoteChanges(result)) return;

        // Busy, or a reload already made for this revision. Offer it instead:
        // throwing away a half-written message or a half-streamed reply to
        // show a change from another device is never the right trade.
        toast(t('sync.remoteChanges'), 'info', 10000, {
          label: t('backup.reload'),
          onClick: () => window.location.reload(),
        });
      },
      onError: (e) => addLog(`[sync] upload failed: ${e.message}`, 'error'),
      onOwnerMismatch: () => {
        // The server says this session belongs to someone else. Uploading again
        // would be equally wrong, so the scheduler has already stopped itself;
        // all that is left is to find out who we actually are.
        addLog('[sync] the signed-in account changed; re-reading the session.', 'info');
        toast(t('sync.accountChanged'), 'info', 10000);
        authSession.refresh();
      },
    });

    // Same reasoning as the storage flush above, and the stakes are higher: a
    // pending upload that never leaves is a change the account never hears
    // about, and the next load pulls the old version back over it.
    const flush = () => { syncRef.current?.flush?.(); };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      syncRef.current?.cancel();
      syncRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Anything that lands in browser storage is worth sending up. Watching the
  // session list plus the settings that are saved separately covers it.
  useEffect(() => {
    if (!accountId || !isStorageLoaded) return;
    syncRef.current?.schedule();
  }, [accountId, isStorageLoaded, sessions, folders, presets, memories, systemPrompt,
      temperature, maxTokens, topP, topK, repeatPenalty, numCtx, lang, theme]);

  /**
   * Bring down whatever another device has changed, and apply it.
   *
   * Settings are taken from the account rather than merged: every setting
   * already exists locally, since the app writes its defaults at startup, so
   * "keep what is here" would mean never applying anything.
   */
  const pullRemoteChanges = async ({ announce = true } = {}) => {
    const result = await syncFully(profileScope);
    syncStampRef.current = result.rev;
    settingsPrintRef.current = settingsFingerprint();

    if (!result.changedLocally) return result;

    addLog(`[sync] ${result.applied.chats} chats and ${result.applied.settings} settings arrived from the account.`, 'info');

    // Storage having changed is not enough: what is on screen was read into
    // React state when the app mounted. `showRemoteChanges` decides how to fix
    // that -- re-reading the chats where that is enough, reloading where it is
    // not -- and reports whether it managed it.
    if (showRemoteChanges(result)) return result;
    // It did not: this device is busy and the change needs a reload. Say so and
    // let the reload be a choice, because throwing away a half-written message
    // or a half-streamed reply to show a change from another device is never
    // the right trade.
    if (announce) {
      toast(t('sync.remoteChanges'), 'info', 10000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
    }
    return result;
  };

  // Local changes: settings are spread across some fifty pieces of state, so
  // rather than listing them all — and missing the fifty-first — the stored
  // values are fingerprinted on a slow interval.
  useEffect(() => {
    if (!accountId || !isStorageLoaded) return undefined;
    settingsPrintRef.current = settingsFingerprint();

    const timer = setInterval(() => {
      const now = settingsFingerprint();
      if (now === settingsPrintRef.current) return;
      settingsPrintRef.current = now;
      syncRef.current?.schedule();
    }, 3000);
    return () => clearInterval(timer);
  }, [accountId, isStorageLoaded]);

  // Remote changes: ask only for the timestamp, and download the state itself
  // only when it is newer than what this device already has.
  useEffect(() => {
    if (!accountId) return undefined;

    let stopped = false;
    /**
     * `known` is the revision the stream just carried.
     *
     * Without it this asks the server what the server has already said, which
     * is a whole round trip added to every update — and during a streaming
     * reply on another device there is one of those every second, so it is
     * half the delay the reader sees. The owner guard is not lost by skipping
     * it: `syncFully` throws `OwnerMismatch` when the server answers for an
     * account other than the one on screen, which is the same check one step
     * later and against the same answer.
     */
    const check = async ({ known = 0 } = {}) => {
      if (stopped || document.hidden) return;

      // Nothing at all while a reply is streaming. Restoring the account's
      // chats writes the session store underneath the message being appended
      // to, and the in-memory copy is written back over it a moment later — so
      // the pull is both disruptive and pointless. It runs when the answer
      // finishes instead.
      if (isGeneratingRef.current) return;

      // Nor while this device's own upload is queued or in flight: the stamp it
      // is about to write is not a change from somewhere else.
      if (syncRef.current?.pending()) return;

      if (known > syncStampRef.current) {
        try {
          await pullRemoteChanges();
        } catch (e) {
          if (e instanceof OwnerMismatch) { stopped = true; authSession.refresh(); return; }
          addLog(`[sync] could not fetch remote changes: ${e.message}`, 'info');
        }
        return;
      }

      const stamp = await accountStamp();
      if (stopped || !stamp) return;

      // The account behind the session is not the one on screen. That means
      // another tab signed in as somebody else, and every store this tree is
      // reading and writing now belongs to the wrong person — so stop, and let
      // the session provider remount the tree around whoever it really is.
      if (stamp.ownerId !== accountId) {
        stopped = true;
        addLog('[sync] the signed-in account changed in another tab.', 'info');
        authSession.refresh();
        return;
      }
      // The account's revision, not a wall clock. It only moves when something
      // was actually written, so this cannot be fooled by clock skew between a
      // phone and a laptop — which a timestamp comparison could be, and was.
      if (stamp.rev <= syncStampRef.current) return;
      try {
        await pullRemoteChanges();
      } catch (e) {
        if (e instanceof OwnerMismatch) { stopped = true; authSession.refresh(); return; }
        addLog(`[sync] could not fetch remote changes: ${e.message}`, 'info');
      }
    };

    // Being told, rather than asking. The stream carries the account's new
    // revision the moment another device writes one, which is what makes a
    // change on the laptop show up on the phone at once instead of on the
    // phone's next poll -- and a phone's polls are exactly what its browser
    // suspends while the screen is off or another app is in front.
    //
    // A hidden page still declines to act on it -- `check` returns early, and
    // reloading a page nobody is looking at is not worth the risk of the
    // browser discarding it mid-flight. The `visibilitychange` listener below
    // is what catches it up, and catching up on being looked at is precisely
    // what a phone needs.
    const unsubscribe = subscribeToAccount({
      onRev: (rev) => {
        if (rev <= syncStampRef.current) return;
        check({ known: rev });
      },
    });

    // The poll stays, at a slower rate, and it is not redundant: a stream can
    // be refused by a proxy, dropped by a phone changing network, or never
    // reach a browser without EventSource. It is the floor under the stream,
    // not the mechanism.
    const timer = setInterval(check, 30000);
    // A device that was asleep should catch up the moment it is looked at, and
    // one that was mid-answer the moment it is not.
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('webui:generation-ended', check);
    check();

    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('webui:generation-ended', check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, storageKey]);

  // The login ends in a redirect, so its result arrives in the address bar.
  useEffect(() => {
    const result = readKakaoOutcome();
    if (!result) return;
    if (result.outcome === 'ok') toast(t('auth.kakaoSignedIn'), 'success');
    else if (result.outcome === 'cancelled') toast(t('auth.kakaoCancelled'), 'info');
    else toast(result.detail || t('auth.kakaoFailed'), 'error', 12000);
  }, []);

  // ---- The account's state ----
  //
  // Signing in *is* linking now, so the three functions that used to live here
  // — link this device with Google, sign in to the sync service, sign out of
  // the sync service — have no job left. There was only ever one account; the
  // second login was an artefact of identity being kept in two places.

  const syncNow = async () => {
    setSyncBusy('push');
    try {
      const result = await syncFully(profileScope);
      syncStampRef.current = result.rev;
      const stats = await accountStamp();
      setSyncInfo(stats);
      toast(t('sync.pushed', { chats: stats?.chats ?? 0 }), 'success');
      if (result.changedLocally > 0) {
        toast(t('sync.remoteChanges'), 'info', 10000, {
          label: t('backup.reload'),
          onClick: () => window.location.reload(),
        });
      }
    } catch (e) {
      if (e instanceof OwnerMismatch) {
        toast(t('sync.accountChanged'), 'error', 9000);
        authSession.refresh();
        return;
      }
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  const syncPull = async (mode) => {
    setSyncBusy('pull');
    try {
      // 'replace' forgets where this device had got to, so the account is
      // downloaded in full. That is the recovery path when a device's local
      // copy is wrong: the account is authoritative, and starting again from it
      // is more honest than trying to reconcile a mess.
      if (mode === 'replace') resetSyncPosition(profileScope);
      const result = await syncFully(profileScope, { full: mode === 'replace' });
      syncStampRef.current = result.rev;
      setSyncInfo(await accountStamp());

      if (!result.changedLocally) { toast(t('sync.upToDate'), 'info'); return; }
      toast(t('sync.pulled', { chats: result.applied.chats }), 'success', 8000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
    } catch (e) {
      if (e instanceof OwnerMismatch) {
        // Refusing is the feature. The alternative — merging it in anyway — is
        // literally the bug: one account's chats arriving in another's list.
        toast(t('sync.accountChanged'), 'error', 9000);
        authSession.refresh();
        return;
      }
      toast(t('sync.failed', { error: e.message }), 'error', 6000);
    } finally {
      setSyncBusy('');
    }
  };

  // ---- Bringing forward what the old login left behind ----
  //
  // Offered once per account on this device, and never applied without being
  // asked for: silently folding whatever is lying around in a browser into the
  // first account that signs in is the same failure this rework is about,
  // arriving through the front door.

  const [legacyOffer, setLegacyOffer] = useState(null);
  const [legacyBusy, setLegacyBusy] = useState(false);

  useEffect(() => {
    if (!accountId || !isStorageLoaded) return;
    if (wasOffered(profileScope)) return;

    let cancelled = false;
    (async () => {
      const taken = alreadyImported(profileScope);
      const found = (await findLegacyData({ currentScope: profileScope }))
        .filter(entry => !taken.has(entry.scope || '(guest)'));
      if (cancelled) return;
      if (!found.length) { markOffered(profileScope); return; }
      setLegacyOffer(found);
    })();
    return () => { cancelled = true; };
  }, [accountId, isStorageLoaded, profileScope]);

  const acceptLegacy = async (entry) => {
    setLegacyBusy(true);
    try {
      const imported = await importLegacyBucket(entry.scope, profileScope);
      addLog(`[import] took ${imported.chats} chats into this account.`, 'success');
      toast(t('legacy.imported', { chats: imported.chats }), 'success', 9000, {
        label: t('backup.reload'),
        onClick: () => window.location.reload(),
      });
      setLegacyOffer(list => (list || []).filter(e => e.key !== entry.key));
    } catch (e) {
      toast(t('sync.failed', { error: e.message }), 'error', 7000);
    } finally {
      setLegacyBusy(false);
    }
  };

  const dismissLegacy = () => {
    markOffered(profileScope);
    setLegacyOffer(null);
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
    /* What the search index costs, separately.
       The browser's own estimate is one number for everything, and the index
       is the part that grows on its own without anybody asking it to -- so it
       is the part worth naming, and the part worth being able to delete. */
    try {
      const index = await loadIndex(profileScopeRef.current);
      setIndexUsage(index ? { entries: index.entries.length, bytes: indexBytes(index) } : null);
    } catch (e) {
      setIndexUsage(null);
    }
  };

  const openPalette = () => {
    setPaletteQuery('');
    setPaletteIndex(0);
    setShowPalette(true);
  };

  /**
   * Follow the end of the conversation.
   *
   * Two details, and both are the difference between a transcript that follows
   * a reply and one that fights the reader for the scrollbar.
   *
   * It moves the scroll container itself rather than calling `scrollIntoView`
   * on a marker inside it. `scrollIntoView` walks up the tree and scrolls
   * every ancestor that can move, which on a phone includes the page -- so the
   * header would be taken off the top of the screen as a side effect of
   * keeping up with a reply.
   *
   * And it says so first. The browser fires `scroll` for this exactly as it
   * would for a finger, and the handler below has no other way to tell them
   * apart: without the flag, every automatic scroll to the bottom is read back
   * as "the reader is at the bottom, keep following", which is how a reader
   * who scrolled up to re-read something got dragged back down by the next
   * token. One frame is the whole window -- `scroll` is dispatched before the
   * next one -- and the flag is cleared there rather than on a timer.
   */
  const followTail = useCallback((smooth = false) => {
    const area = scrollAreaRef.current;
    if (!area) return;
    selfScrollRef.current = true;
    if (smooth) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
    else area.scrollTop = area.scrollHeight;
    requestAnimationFrame(() => { selfScrollRef.current = false; });
  }, []);

  const scrollToBottom = () => {
    isAutoScrollRef.current = true;
    followTail(true);
  };

  /**
   * The reader has taken the scroll for themselves.
   *
   * Called from the wheel and touch handlers rather than worked out from the
   * scroll position, because position alone cannot tell the two apart quickly
   * enough. A reply being streamed rewrites the transcript several times a
   * second; someone dragging the list up passes through every distance from
   * the bottom on the way, and while they are still inside whatever slack the
   * scroll handler allows, the next token arrives and puts them back. They
   * never get out. Answering the gesture instead of the position means one
   * flick is enough, however fast the model is talking.
   */
  const releaseTail = useCallback(() => { isAutoScrollRef.current = false; }, []);

  /**
   * Focusing the composer means the keyboard is on its way up.
   *
   * The app shrinks to fit above it (see src/viewport.js), and shrinking a
   * scrolled-to-the-bottom list does not keep it at the bottom -- the last
   * reply slides up out of view behind the composer, which is the opposite of
   * what someone about to answer it wants. The delay is the keyboard's
   * animation: scrolling before the layout has settled scrolls to the wrong
   * place, and there is no event for "the keyboard has finished".
   */
  const handleComposerFocus = () => {
    if (!isTouchUi) return;
    setOpenActionsIndex(null);
    window.setTimeout(() => {
      isAutoScrollRef.current = true;
      followTail();
    }, 250);
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

  /* What the installed models cost, and in what order to consider them.
     Sorted largest first: this list is read when somebody is trying to free
     space, and alphabetical order answers a question nobody asked. */
  const modelDiskTotal = models.reduce((sum, m) => sum + (m.size || 0), 0);
  const modelsBySize = [...models].sort((a, b) => (b.size || 0) - (a.size || 0));

  /**
   * Pin documents to a folder, so every chat in it can be asked about them.
   *
   * The same indexing the composer does for an oversized attachment, with a
   * `folderId` instead of a `chatId` — which is the only difference between
   * "this file belongs to this conversation" and "this file belongs to this
   * project". See `visibleDocuments`.
   */
  const pinToFolder = async (folderId, files) => {
    for (const file of files) {
      if (!file) continue;
      setFolderIngest(file.name);
      try {
        const { doc, library } = await ingestDocument(file, {
          userId: profileScopeRef.current,
          embedModel,
          folderId,
          onProgress: ({ stage, done, total }) => setFolderIngest(
            total ? `${file.name} — ${stage} ${done}/${total}` : file.name,
          ),
        });
        setKnowledge(library);
        if (!ragEnabled) setRagEnabled(true);
        addLog(`[knowledge] pinned ${file.name} to a folder as ${doc.chunks.length} passages`, 'success');
      } catch (e) {
        if (e.code === 'binary') toast(t('attach.unsupported', { name: file.name }), 'error', 8000);
        else toast(t('attach.failed', { name: file.name, error: e.message }), 'error', 8000);
      } finally {
        setFolderIngest(null);
      }
    }
  };

  const deleteModel = async (name) => {
    if (!window.confirm(t('models.deleteConfirm', { name }))) return;
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

  /* The embedder the recall tier uses.
     Normalised here rather than in convMemory.js, because `embedTexts` returns
     what Ollama returns and the similarity there is a plain dot product --
     unnormalised vectors would make a long turn score higher than a relevant
     one purely for being long. */
  const embedForMemory = async (texts) => {
    const vectors = await embedTexts(texts, embedModel);
    return vectors.map(normalise);
  };
  /* Whether the model does tool calls itself, rather than being asked to spell
     tags in prose. Asked rather than assumed: sending `tools` to a model
     without them is not an error the server reports -- the model ignores them
     and writes about what it would have done, which reads as the tool silently
     failing. `/api/show` already tells us, and was already being read for
     vision. */
  const modelSupportsTools = (name) => hasCapability(name, 'tools');

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
    if (!isAutoScrollRef.current) return;
    // Smooth scrolling on every streamed token fights itself and stutters;
    // jump instantly while generating, animate only for finished turns.
    followTail(!isGenerating);
  }, [messages, isGenerating, followTail]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // How close to the bottom still counts as "reading the end of the answer".
  // It was 100px, which sounds small and is not: a reader who nudged the list
  // up by less than that was still considered to be following, so the next
  // token pulled them back -- and on a phone, where a flick starts slowly, that
  // was most attempts to scroll during a reply.
  const STICK_SLACK = 40;

  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // A scroll this code caused says nothing about where the reader wants to
    // be, and reading it as though it did is what made following inescapable.
    if (!selfScrollRef.current) {
      isAutoScrollRef.current = distanceFromBottom <= STICK_SLACK;
    }
    setShowScrollBtn(distanceFromBottom > 240);

    // How far through the conversation the reader is, as a percentage.
    //
    // A long answer has no other scale on it: the scrollbar is the browser's,
    // it is a few pixels wide, and on a phone it is not drawn at all until you
    // are already moving. The bar under the header is the same information at
    // a size a thumb can see, and it is also what makes "back to the top" mean
    // something -- a button offering to jump somewhere is worth more when you
    // can see how far away that is.
    //
    // The denominator can be zero (a chat shorter than the screen) and a
    // division by it is NaN, which CSS silently drops -- leaving whatever
    // width the bar last had, stuck.
    const scrollable = scrollHeight - clientHeight;
    setScrollProgress(scrollable > 40 ? Math.min(1, Math.max(0, scrollTop / scrollable)) : 0);
    setShowTopBtn(scrollTop > clientHeight);

    // Where the reader is in this chat, remembered as they go. See the effect
    // that swaps drafts for why it cannot be captured at the moment of
    // leaving: by then the container is already showing the chat being opened.
    //
    // `atBottom` rather than the number, for the commonest case: a chat read
    // to the end should reopen at the end even though the answer has grown
    // since, and a stored offset would land slightly above wherever the end
    // now is.
    scrollMemoryRef.current.set(currentSessionIdRef.current, {
      top: scrollTop,
      atBottom: distanceFromBottom <= STICK_SLACK,
    });
  }, []);

  const scrollToTop = () => {
    isAutoScrollRef.current = false;
    scrollAreaRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    haptic('light');
  };

  const handleInputResize = (e) => {
    setInput(e.target.value);
    // Typing means this is your prompt now, not a recalled one: the next up
    // arrow should start again from the newest rather than from wherever the
    // last walk had got to.
    historyIndexRef.current = NOT_BROWSING;
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const applySlashCommand = (cmd) => {
    if (cmd.chain) {
      setArmedChain(cmd.chain);
      setInput('');
      setSlashIndex(0);
      setTimeout(() => textareaRef.current?.focus(), 50);
      return;
    }
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

    /* Shell-style recall. Only when the caret is on the first line with
       nothing selected, so editing a multi-line prompt still works — see
       `wantsHistory`. Escape leaves history and puts the draft back. */
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && wantsHistory(e.currentTarget, e.key === 'ArrowUp' ? 'back' : 'forward')) {
      const prompts = promptsFrom(messages);
      if (prompts.length > 0) {
        const at = historyIndexRef.current;
        // The box itself, not `input`: a key repeat arrives before React has
        // re-rendered, so the state variable is a step behind and the element
        // is not.
        const typed = e.currentTarget.value;
        const draft = at === NOT_BROWSING ? typed : historyDraftRef.current;
        const step = stepHistory(prompts, at, e.key === 'ArrowUp' ? 'back' : 'forward', draft);
        if (step) {
          e.preventDefault();
          if (at === NOT_BROWSING) historyDraftRef.current = typed;
          historyIndexRef.current = step.index;
          setInput(step.value);
          // The caret goes to the end, as it does in a shell: the point of
          // recalling a prompt is nearly always to add to it.
          requestAnimationFrame(() => {
            const box = textareaRef.current;
            if (!box) return;
            box.selectionStart = box.selectionEnd = box.value.length;
            box.style.height = 'auto';
            box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
          });
          return;
        }
      }
    }
    if (e.key === 'Escape' && historyIndexRef.current !== NOT_BROWSING) {
      e.preventDefault();
      setInput(historyDraftRef.current);
      historyIndexRef.current = NOT_BROWSING;
      return;
    }

    const wantsSend = sendKey === 'ctrlEnter'
      ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
      : (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey);

    if (wantsSend) {
      e.preventDefault();
      if (input.trim() || attachments.length > 0) handleSend();
    }
  };

  /* How much of a document is worth putting in a message.
   *
   * An attachment is context for a question, not the corpus. Past this it
   * stops being either: it fills the window, pushes the actual question out of
   * it, and costs a proportional amount of time on every later turn -- because
   * the whole conversation is re-sent with every message.
   *
   * The knowledge library exists for documents bigger than this. It indexes
   * them and retrieves only the passages a question needs, which is the right
   * shape for a long PDF and the wrong shape for a one-page invoice. */
  const MAX_ATTACHMENT_CHARS = 30000;

  /**
   * Turn dropped, pasted or picked files into attachments.
   *
   * Images go through as images. Everything else is *extracted*, and that is
   * the fix: this used to call `reader.readAsText(file)` on anything that was
   * not an image, which for a PDF means decoding compressed binary as UTF-8.
   * The model received a hundred thousand characters of `%PDF-1.4`, stream
   * markers and mojibake -- an enormous token bill for an attachment
   * containing no readable text at all, and a prompt so far from language that
   * what came back had little to do with the question. A tuition invoice went
   * in; nonsense came out.
   *
   * `extractDocument` was already here, doing this correctly for the knowledge
   * library. The chat composer simply never called it.
   */
  const addFiles = async (files) => {
    for (const file of files) {
      if (!file) continue;

      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }).catch(() => null);
        if (!dataUrl) { toast(t('attach.unreadable', { name: file.name }), 'error', 6000); continue; }
        setAttachments(prev => [...prev, {
          name: file.name || `pasted-image-${Date.now()}.png`,
          type: 'image',
          data: dataUrl.split(',')[1],
          preview: dataUrl,
        }]);
        continue;
      }

      /* Every file is attempted.
       *
       * There used to be a list of extensions here and it was wrong in both
       * directions, as such a list always is: it refused `.env`, `.bat`,
       * `.ini`, `.toml`, `.rs`, `.go`, `Dockerfile` and `Makefile` -- all of
       * them plainly text -- while a zip renamed to `.txt` would have been
       * decoded as mojibake anyway. Whether a file can be read is now decided
       * by looking at its bytes, in `sniffKind`, and the only refusal left is
       * the one that is actually true: this is not text and nothing here can
       * turn it into any. */
      const needsWork = /\.(pdf|docx)$/i.test(file.name || '') || file.size > 400_000;
      if (needsWork) toast(t('attach.reading', { name: file.name }), 'info', 3000);

      let text;
      try {
        const pages = await extractDocument(file);
        // Page markers matter for a document with more than one: without them
        // a model asked "what does page 2 say" has no way to tell.
        text = pages.length > 1
          ? pages.map(p => `--- page ${p.page} ---\n${p.text}`).join('\n\n')
          : (pages[0]?.text || '');
      } catch (err) {
        if (err.code === 'binary') {
          toast(t('attach.unsupported', { name: file.name }), 'error', 8000);
        } else {
          toast(t('attach.failed', { name: file.name, error: err.message || String(err) }), 'error', 8000);
        }
        continue;
      }

      if (!text.trim()) {
        /* No text in it. Two quite different documents land here.
         *
         * One is a scan: a photograph of a page, with no characters in the
         * file at all. The other is a page exported as a single flat image by
         * a reporting tool, which is the same thing by another route.
         *
         * Either way the words are visible, just not as text — so the pages
         * are drawn and attached as pictures, and a model that can see reads
         * them. Telling somebody their invoice cannot be read is true and
         * useless when the answer is to look at it.
         */
        if (/\.pdf$/i.test(file.name || '')) {
          toast(t('attach.rendering', { name: file.name }), 'info', 4000);
          try {
            const { pages, total } = await renderPdfPages(await file.arrayBuffer());
            if (pages.length > 0) {
              setAttachments(prev => [...prev, ...pages.map(p => ({
                name: total > 1 ? `${file.name} (p${p.page})` : file.name,
                type: 'image',
                data: p.dataUrl.split(',')[1],
                preview: p.dataUrl,
              }))]);
              toast(
                total > pages.length
                  ? t('attach.renderedSome', { name: file.name, shown: pages.length, total })
                  : t('attach.rendered', { name: file.name, count: pages.length }),
                'success', 9000,
              );
              continue;
            }
          } catch (err) {
            // Fall through to the message below, which at least says what
            // kind of file this is and what to do about it.
          }
        }
        toast(t('attach.noText', { name: file.name }), 'error', 9000);
        continue;
      }

      /* Too long to send whole: index it instead of cutting it off.
       *
       * Cutting it off was the old behaviour and it is the worst of the three
       * options. A fifty-page report arrived as its first ten pages, the model
       * answered confidently about a document it had only seen the start of,
       * and nothing in the answer said which part it was based on. Refusing
       * the file would at least have been honest.
       *
       * The knowledge library already solves this properly -- it splits the
       * document, embeds every piece, and retrieves the passages a question
       * actually needs. It was one click away in Settings and the composer
       * never used it. Now the composer does it for you, because "this file is
       * too big" is not a problem anybody wants handed back to them. */
      if (text.length > MAX_ATTACHMENT_CHARS) {
        const bigFile = file;
        setAttachments(prev => [...prev, {
          name: bigFile.name, type: 'indexing', data: '', chars: text.length,
        }]);
        try {
          const { doc, library } = await ingestDocument(bigFile, {
            userId: profileScopeRef.current,
            embedModel,
            // Whose document this is. Without it the library is a shared pile
            // and every chat searches every file anybody ever attached.
            chatId: currentSessionId,
            onProgress: ({ stage, done, total }) => {
              setAttachments(prev => prev.map(a => (
                a.name === bigFile.name && (a.type === 'indexing' || a.type === 'indexed')
                  ? { ...a, stage, done, total }
                  : a
              )));
            },
          });
          setKnowledge(library);
          // Retrieval only runs when the library is switched on, and a person
          // who just attached a file plainly wants it read.
          if (!ragEnabled) setRagEnabled(true);
          setAttachments(prev => prev.map(a => (
            a.name === bigFile.name && a.type === 'indexing'
              ? { name: bigFile.name, type: 'indexed', data: '', docId: doc.id,
                  chars: text.length, pages: doc.pages, pieces: doc.chunks.length }
              : a
          )));
          toast(t('attach.indexed', { name: bigFile.name, pieces: doc.chunks.length }), 'success', 8000);
          addLog(`[knowledge] indexed ${bigFile.name} as ${doc.chunks.length} passages`, 'success');
        } catch (err) {
          // An excerpt is worse than the whole document and better than
          // nothing, so this falls back rather than refusing -- but it says
          // plainly that it is an excerpt, which the old path also did.
          addLog(`[knowledge] could not index ${bigFile.name}: ${err.message}`, 'error');
          setAttachments(prev => prev
            .filter(a => !(a.name === bigFile.name && a.type === 'indexing'))
            .concat([{ name: bigFile.name, type: 'text', data: safeHead(text, MAX_ATTACHMENT_CHARS), truncated: true }]));
          toast(t('attach.indexFailed', { name: bigFile.name, kept: MAX_ATTACHMENT_CHARS.toLocaleString() }), 'info', 10000);
        }
        continue;
      }

      setAttachments(prev => [...prev, { name: file.name, type: 'text', data: text, truncated: false }]);
    }
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
      return;
    }

    /* A long paste becomes an attachment rather than filling the box.
     *
     * Four hundred lines of a stack trace pasted into a one-line composer
     * buries the question underneath it: you cannot see what you are typing,
     * and you cannot see what you pasted either, because the box scrolls to
     * the bottom of it. As a chip it is one line, it says what it is, and it
     * can be opened and read.
     *
     * Only a paste that is genuinely long -- see `shouldPasteAsFile`. A normal
     * paste of a sentence or a URL must go into the composer as it always has,
     * or this feature is an obstacle rather than a convenience. */
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!shouldPasteAsFile(text)) return;

    e.preventDefault();
    const name = namePastedText(text);
    setAttachments(prev => [...prev, {
      // `pasted` rather than `text` only so the chip can say where it came
      // from; it is sent exactly as a text attachment is.
      name, type: 'pasted', data: text, truncated: false,
      lines: text.split('\n').length,
    }]);
    haptic('light');
    addLog(`Pasted ${text.length.toLocaleString()} characters as ${name}.`, 'success');
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
        `User: ${safeHead(cleanForExport(userText), 1200)}`,
        '',
        `Assistant: ${safeHead(cleanForExport(assistantText), 1200)}`,
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
          options: helperOptions({ temperature: 0.3, num_predict: 40 })
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

        reviseSession(sessionId, s => ({ ...s, title: newTitle, titleGenerated: true }));
        addLog(`Named this chat "${newTitle}".`, 'info');
      }
    } catch (e) {
      console.warn("Failed to generate title", e);
    }
  };

  /* ------------------------------------------------------------- deep research

     A question no single page answers. The loop itself -- plan, search, read,
     write -- lives in research.js with the model, the search and the page
     fetch injected; everything here is the wiring: which model answers, where
     the steps are rendered, and what the finished report becomes in the
     transcript.

     It deliberately does not go through `handleSend`. That path exists to hold
     a conversation: history, retrieval, grounding, tools, a streaming reply.
     A research run is a different shape -- one question, a dozen model turns,
     no history -- and threading it through there would have meant a flag
     checked in fifteen places, each of which would have been a way for an
     ordinary chat to break. */

  /** One model turn, with no history and nothing streamed. */
  const researchAsk = async (prompt, { signal, long } = {}) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        /* A reasoning model asked for five search queries spends the whole
           num_predict budget deciding which five and returns nothing -- the
           same failure that made auto-titling come back empty. */
        think: false,
        options: helperOptions({
          temperature: long ? 0.4 : 0.2,
          num_predict: long ? 2048 : 320,
        }),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return decodeByteFallback(data.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
  };

  const startDeepResearch = async (question) => {
    const asked = String(question || '').trim();
    if (isGenerating || !asked || !selectedModel) return;

    writeDraft(currentSessionId, '');
    isAutoScrollRef.current = true;
    setInput('');
    setAttachments([]);
    historyIndexRef.current = NOT_BROWSING;
    historyDraftRef.current = '';
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const startedIn = currentSessionId;
    const askedAt = Date.now();
    setIsGenerating(true);
    setGeneratingSessionId(startedIn);
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const asking = [...messages, { role: 'user', content: asked, at: askedAt }];
    // Fixed now, because every write below lands at this index and the reader
    // may well start another chat while this one runs.
    const index = asking.length;
    reviseSession(startedIn, s => promoted({
      ...s,
      messages: [...asking, {
        role: 'assistant',
        content: '',
        at: Date.now(),
        model: selectedModel,
        research: { question: asked, depth: researchDepth, steps: [], running: true },
      }],
      title: messages.length === 0 ? asked.substring(0, 30) : s.title,
      lastModel: selectedModel,
    }));

    const writeResearch = (patch) => {
      reviseSession(startedIn, s => {
        const msgs = [...s.messages];
        const held = msgs[index];
        // Deleted, or the chat was cleared while this ran. Dropping the write
        // is right: there is nothing left to write it to.
        if (!held || held.role !== 'assistant') return s;
        msgs[index] = {
          ...held,
          ...patch,
          research: { ...held.research, ...(patch.research || {}) },
        };
        return { ...s, messages: msgs };
      });
    };

    const startedAt = performance.now();
    addLog(`[research] ${researchDepth}: ${asked}`, 'info');
    try {
      const run = await runResearch({
        question: asked,
        depth: researchDepth,
        language: promptLanguageName(lang),
        signal,
        ask: researchAsk,
        search: async (query, limit) => (await mcpSearchWeb(query, limit)).results,
        fetchPage: (url, limit, sig) => mcpFetchUrl(url, limit, sig),
        // Rendered as they arrive rather than at the end: see ResearchTrace.
        onStep: (_step, steps) => writeResearch({ research: { steps: [...steps] } }),
      });

      const seconds = Math.round((performance.now() - startedAt) / 1000);
      if (run.cancelled) {
        writeResearch({
          content: t('research.stopped'),
          research: { steps: run.steps, running: false, seconds },
        });
        addLog('[research] stopped', 'info');
      } else if (run.empty) {
        writeResearch({
          content: t('research.nothingFound'),
          research: { steps: run.steps, running: false, failed: true, seconds },
        });
        addLog('[research] nothing found', 'error');
      } else if (run.failed) {
        writeResearch({
          content: t('research.writeFailed', { error: run.failed }),
          research: {
            steps: run.steps, running: false, failed: true, seconds,
            sources: run.sources.map(x => ({ url: x.url, title: x.title, read: x.read })),
          },
        });
        addLog(`[research] the write step failed: ${run.failed}`, 'error');
      } else {
        writeResearch({
          content: run.report,
          // The same shape an ordinary grounded answer carries, so `[3]` in the
          // report is pressable through the machinery that already exists.
          citations: run.citations,
          research: {
            steps: run.steps, running: false, seconds,
            sources: run.sources.map(x => ({ url: x.url, title: x.title, read: x.read })),
          },
        });
        addLog(`[research] done in ${seconds}s over ${run.sources.length} sources`, 'success');
      }
    } catch (e) {
      writeResearch({
        content: t('research.failed', { error: e.message }),
        research: { running: false, failed: true },
      });
      addLog(`[research] failed: ${e.message}`, 'error');
    } finally {
      markAnswered(startedIn, askedAt);
      setIsGenerating(false);
      setGeneratingSessionId(null);
      abortControllerRef.current = null;
      if (currentSessionIdRef.current !== startedIn) {
        const named = sessionsRef.current.find(x => x.id === startedIn);
        toast(t('chat.answerReady', { title: named?.title || '' }), 'success', 8000, {
          label: t('chat.goThere'),
          onClick: () => setCurrentSessionId(startedIn),
        });
      }
    }
  };

  /* ------------------------------------------------------------- verifying

     The one thing this app did not do. Every other feature makes answers
     arrive; none of them made an answer checkable, and for a model small
     enough to run on one machine that is the gap that matters -- the failure
     is never being wrong loudly, it is one wrong sentence in nine, in the same
     confident register as the other eight.

     A second pass does something the first structurally could not: the answer
     and its sources are both in front of the model, and comparing two texts is
     a job a 7B is markedly better at than recalling a fact. */
  const verifyAnswer = async (index) => {
    const target = messagesRef.current[index];
    if (!target || target.role !== 'assistant' || isGenerating) return;

    const answer = cleanForExport(target.content || '').trim();
    if (!answer) return;

    const startedIn = currentSessionId;
    const evidence = evidenceFor(messagesRef.current, index);
    const model = selectedModel;

    const write = (patch) => reviseSession(startedIn, sess => {
      const msgs = [...sess.messages];
      const held = msgs[index];
      if (!held || held.role !== 'assistant') return sess;
      msgs[index] = { ...held, verification: { ...held.verification, ...patch } };
      return { ...sess, messages: msgs };
    });

    write({ status: 'running', model, hasEvidence: evidence.trim().length > 0, at: Date.now() });
    addLog(`[verify] checking an answer against ${evidence ? 'its sources' : 'nothing'}`, 'info');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: verifyPrompt({
              question: questionFor(messagesRef.current, index),
              answer,
              evidence,
              language: promptLanguageName(lang),
            }),
          }],
          stream: false,
          think: false,
          // Checking, not writing. A high temperature here produces invented
          // objections, which is the one output worse than no output.
          options: helperOptions({ temperature: 0.1, num_predict: 900 }),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw = decodeByteFallback(data.message?.content || '');
      // Located against the answer, because a verdict quoting words the answer
      // does not contain is a verdict about something the checker made up --
      // the likeliest way this feature misleads anybody.
      const verdicts = locateQuotes(parseVerdicts(raw), answer);

      write({ status: 'done', verdicts, raw, at: Date.now() });
      const found = summariseVerdicts(verdicts);
      addLog(`[verify] ${found.total} claims, ${found.problems} worth a look`,
        found.problems > 0 ? 'error' : 'success');
    } catch (e) {
      write({ status: 'failed', error: e.message });
      addLog(`[verify] failed: ${e.message}`, 'error');
    }
  };

  /* ------------------------------------------------------------- chains

     A saved sequence of prompts, run against whatever is in the composer.

     Every step is asked on its own rather than appended to one growing
     conversation -- see chains.js. On a 4k context the alternative runs out of
     room halfway through and does it silently, because a model given too much
     context does not error, it forgets the beginning. */
  const startChain = async (chain, question) => {
    const asked = String(question || '').trim();
    if (isGenerating || !chain || !selectedModel) return;

    const problems = blocking(validateChain(chain));
    if (problems.length > 0) {
      // Before anybody waits four minutes on it.
      toast(t('chains.broken', { name: chain.name }), 'error', 7000);
      return;
    }

    writeDraft(currentSessionId, '');
    isAutoScrollRef.current = true;
    setInput('');
    historyIndexRef.current = NOT_BROWSING;
    historyDraftRef.current = '';
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const startedIn = currentSessionId;
    const askedAt = Date.now();
    setIsGenerating(true);
    setGeneratingSessionId(startedIn);
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const asking = [...messages, { role: 'user', content: asked, at: askedAt }];
    const index = asking.length;
    reviseSession(startedIn, sess => promoted({
      ...sess,
      messages: [...asking, {
        role: 'assistant',
        content: '',
        at: Date.now(),
        model: selectedModel,
        chainRun: { name: chain.name, steps: [], running: true, total: chain.steps.length },
      }],
      title: messages.length === 0 ? (asked || chain.name).substring(0, 30) : sess.title,
      lastModel: selectedModel,
    }));

    const write = (patch) => reviseSession(startedIn, sess => {
      const msgs = [...sess.messages];
      const held = msgs[index];
      if (!held || held.role !== 'assistant') return sess;
      msgs[index] = { ...held, ...patch, chainRun: { ...held.chainRun, ...(patch.chainRun || {}) } };
      return { ...sess, messages: msgs };
    });

    const startedAt = performance.now();
    addLog(`[chain] ${chain.name}: ${chain.steps.length} steps`, 'info');
    try {
      const run = await runChain({
        chain,
        input: asked,
        signal,
        ask: async (prompt) => {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: selectedModel,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              options: buildOptions(),
            }),
            signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          return decodeByteFallback(data.message?.content || '');
        },
        // The intermediate outputs are most of the value, and four minutes of
        // silence is indistinguishable from a hang.
        onStep: (_entry, steps) => write({ chainRun: { steps: steps.map(x => ({ ...x })) } }),
      });

      const seconds = Math.round((performance.now() - startedAt) / 1000);
      if (run.cancelled) {
        write({ content: run.output || t('chains.stopped'), chainRun: { steps: run.steps, running: false, seconds } });
      } else if (run.failed) {
        write({
          content: run.output
            ? `${run.output}\n\n---\n\n_${t('chains.failed', { error: run.failed })}_`
            : t('chains.failed', { error: run.failed }),
          chainRun: { steps: run.steps, running: false, failed: true, seconds },
        });
        addLog(`[chain] stopped at step ${run.steps.length}: ${run.failed}`, 'error');
      } else {
        write({ content: run.output, chainRun: { steps: run.steps, running: false, seconds } });
        addLog(`[chain] ${chain.name} finished in ${seconds}s`, 'success');
      }
    } catch (e) {
      write({ content: t('chains.failed', { error: e.message }), chainRun: { running: false, failed: true } });
      addLog(`[chain] failed: ${e.message}`, 'error');
    } finally {
      markAnswered(startedIn, askedAt);
      setIsGenerating(false);
      setGeneratingSessionId(null);
      abortControllerRef.current = null;
      if (currentSessionIdRef.current !== startedIn) {
        const named = sessionsRef.current.find(x => x.id === startedIn);
        toast(t('chat.answerReady', { title: named?.title || '' }), 'success', 8000, {
          label: t('chat.goThere'),
          onClick: () => setCurrentSessionId(startedIn),
        });
      }
    }
  };

  /* ------------------------------------------------- the running summary

     The middle tier. Retrieval alone loses the thread -- ask "so what did we
     decide" and similarity search returns three passages about the topic and
     nothing about the decision -- so a few hundred words of summary carry
     continuity at a cost that does not grow with the conversation.

     Written after a turn rather than before one, and never blocking: the
     summary is for the *next* question, so making somebody wait for it would
     be paying a cost now for a benefit later. If it is not ready in time, the
     turn goes out with the previous summary, which is what a rolling summary
     is for. */
  const summaryPendingRef = useRef(new Set());

  const updateRunningSummary = async (sessionId) => {
    if (summaryPendingRef.current.has(sessionId)) return;
    const session = sessionsRef.current.find(x => x.id === sessionId);
    if (!session || !convMemoryRef.current || !selectedModel) return;

    const turns = asTurns((session.messages || []).map(m => ({ ...m, content: forHistory(m.content) })));
    const held = session.memorySummary;
    const covered = held?.throughTurn ?? 0;
    // Everything except the turns that are still being sent verbatim -- there
    // is nothing to gain from summarising what the model can already read.
    const summarisable = Math.max(0, turns.length - MIN_RECENT_TURNS);
    const fresh = turns.slice(covered, summarisable);

    // Two whole turns' worth of new material before spending a model call.
    // Re-summarising after every message would cost more than it saves.
    if (fresh.length < 2) return;

    summaryPendingRef.current.add(sessionId);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{
            role: 'user',
            content: summaryPrompt(fresh, held?.text || '', promptLanguageName(lang)),
          }],
          stream: false,
          think: false,
          options: helperOptions({ temperature: 0.2, num_predict: 400 }),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = decodeByteFallback(data.message?.content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
      if (!text) return;

      reviseSession(sessionId, x => ({
        ...x,
        memorySummary: { text, throughTurn: summarisable, at: Date.now() },
      }));
      addLog(`[memory] summary updated through turn ${summarisable}`, 'success');
    } catch (e) {
      // The next turn simply uses the older summary. Nothing is lost that was
      // not already going to be lost.
      addLog(`[memory] summary not updated: ${e.message}`, 'error');
    } finally {
      summaryPendingRef.current.delete(sessionId);
    }
  };

  const handleSend = async (e = null, customMessages = null, overrideModel = null) => {
    /* Two models, on purpose. `chosenModel` is what the reader asked for and
       is what the chat remembers; `activeModel` is what actually answers,
       which a routing rule may change for this one message. Collapsing them
       would make a rule that fired once silently become the chat's model. */
    const chosenModel = overrideModel || selectedModel;
    let activeModel = chosenModel;
    e?.preventDefault();
    if (isGenerating || (!input.trim() && attachments.length === 0 && !customMessages)) return;

    // A chain is several turns wearing one message, so it leaves here too --
    // and before research, because arming a chain is the more specific act of
    // the two and the composer shows it.
    if (armedChain && !customMessages) {
      const chain = armedChain;
      setArmedChain(null);
      startChain(chain, input);
      return;
    }

    // A research run is not a chat turn -- it plans, searches, reads and only
    // then writes -- so it leaves here rather than becoming a branch inside.
    // Never for a tool loop: that is the model continuing a turn of its own,
    // not a person asking a question.
    if (researchMode && !customMessages) { startDeepResearch(input); return; }

    // The draft became a message; leaving it stored would restore it into the
    // composer the next time this chat is opened.
    writeDraft(currentSessionId, '');

    // Asking something is asking to see the answer. Without this, a reader who
    // had scrolled up to re-read an earlier turn -- which is now a thing they
    // can do while a reply streams -- would send a question and watch nothing
    // happen, with the reply arriving somewhere below the fold.
    isAutoScrollRef.current = true;

    const originalInput = input;
    const currentAttachments = [...attachments];
    const isAutoTool = !!customMessages;
    
    // 1. Immediately update UI
    if (!isAutoTool) {
      setInput('');
      setAttachments([]);
      // Sending ends the walk, and the draft it would have restored is now the
      // message that was just sent.
      historyIndexRef.current = NOT_BROWSING;
      historyDraftRef.current = '';
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
    
    const turnStartedAt = performance.now();
    // The same moment on the wall clock, which is what message times are in.
    const turnBegan = Date.now();
    let firstTokenAt = null;

    setIsGenerating(true);
    // Captured here, not read later: every write this turn makes goes to the
    // chat that asked, whichever one is on screen by the time the answer
    // arrives.
    setGeneratingSessionId(currentSessionId);
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    // The chat this turn belongs to, for the finally block far below -- by the
    // time it runs, the reader may be looking at a different one.
    const startedIn = currentSessionId;

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
          toast(t('toast.searchFailed', { error: e.message }), 'error', 6000);
        }
      }
      // ----------------------------
      
      let messageImages = [];
      // The passages this turn was given, in citation order. Attached to the
      // finished message so `[1]` stays pressable after a reload.
      let turnCitations = null;
      /* Pictures the model drew during this turn.
       *
       * Held here rather than pushed into the message as they arrive, because a
       * turn can call the tool more than once and the message is only written
       * whole. Attached as data URLs so they survive a reload, a sync and an
       * export -- a `/studio/view` link points at a file on one machine's
       * ComfyUI, which the phone opening the same conversation cannot reach and
       * which ComfyUI will eventually tidy away regardless. */
      const turnImages = [];

      // Process Attachments (synchronous)
      if (currentAttachments.length > 0) {
        currentAttachments.forEach(att => {
          // A pasted block travels exactly as an attached file does; the two
          // differ only in where they came from and what the chip says.
          if (att.type === 'text' || att.type === 'pasted') {
            finalInputText += fileMarker(att.name, att.data);
          } else if (att.type === 'image') {
            messageImages.push(att.data);
          } else if (att.type === 'indexed') {
            // The document itself is not in the message: it is in the library,
            // and retrieval puts the passages the question needs in front of
            // the model a few lines below this. The marker is what tells the
            // model those passages are the file it was just handed -- and what
            // tells the transcript to draw a chip for it like any other
            // attachment, rather than leaving the sentence on screen.
            finalInputText += indexedMarker(att);
          }
        });
      }


      /* ---- which model answers this one ----
         After the attachments, because whether there is an image is one of the
         things the rules turn on -- and before the message is written, so the
         placeholder can say which rule moved it.

         Never for a tool loop or a retry: the first is the model continuing
         its own turn, and the second is somebody naming a model explicitly. */
      let routedBy = null;
      if (!isAutoTool && !overrideModel && routingEnabledRef.current) {
        const route = routeFor({
          rules: modelRulesRef.current,
          signals: signalsFor({
            text: finalInputText,
            images: messageImages.length,
            // The whole turn, not the sentence just typed: a one-word
            // follow-up in a chat 20k tokens deep is a long request.
            tokens: estimateTokens(finalInputText)
              + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
          }),
          installed: models.map(m => m.name),
          current: activeModel,
          manual: !!currentSession.manualModel,
          supportsVision: modelSupportsVision,
        });
        if (route) {
          activeModel = route.model;
          routedBy = { model: route.model, when: route.when, forced: !!route.forced };
          addLog(`[routing] ${route.when} -> ${route.model}`, 'info');
        }
      }

      if (!isAutoTool) {
        const tempUserMessage = { role: 'user', content: finalInputText, at: Date.now() };
        if (messageImages.length > 0) tempUserMessage.images = messageImages;
        /* A painted edit rides on the question: the mask and which picture it
           was painted on. The executor reads it from there -- see
           TOOL_GENERATE_IMAGE -- and the model is told, on the wire only,
           that the area has been marked and what to call. */
        const paint = pendingPaintRef.current;
        pendingPaintRef.current = null;
        if (paint) {
          tempUserMessage.paint = paint;
          finalInputText += '\n\n[They painted over the part of the picture to change. Call generate_image '
            + 'with from="last_image" now; only the painted area is redrawn and the rest stays exactly as it '
            + 'is. Describe the whole finished picture as it should look, in English, with change 0.9.]';
        }
        
        initialMessages = [...messages, tempUserMessage];
        
        let newTitle = currentSession.title;
        if (messages.length === 0 && finalInputText.trim()) {
           newTitle = finalInputText.trim().substring(0, 30);
        }
        // Saying something is what turns a draft into a conversation. The
        // promotion goes through draftChat.js rather than clearing the flag by
        // hand, so what "no longer a draft" means lives in one place.
        reviseSession(currentSessionId, s => promoted({
          ...s, messages: initialMessages, title: newTitle, lastModel: chosenModel,
        }));
        
        newMessageIndex = initialMessages.length;
        const isUrlFetching = mcpEnabled && finalInputText.match(/(https?:\/\/[^\s]+)/g);
        updateCurrentSession({
           messages: [...initialMessages, {
             role: 'assistant', content: '', metrics: null, at: Date.now(),
             isMcpFetching: !!isUrlFetching,
             ...(routedBy ? { routedBy } : {}),
           }]
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
                toast(t('toast.fetchFailed', { url, error: err.message }), 'error', 6000);
              }
            }
          }
          
          reviseSession(currentSessionId, s => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: initialAssistantContent };
            return { ...s, messages: msgs };
          });
        }
      }

      // --- Retrieval over attached documents ---
      // Runs before the web grounding: a document the user supplied is more
      // authoritative for their question than anything a search turns up.
      /* Scoped, not the whole library.
       *
       * An attachment is indexed rather than truncated now, and an indexed
       * document that belonged to nobody was searched by every later chat: a
       * tuition invoice attached on Monday still turned up inside an unrelated
       * question about code on Friday. `visibleDocuments` is the rule -- see
       * rag.js -- and this is where the chat says who it is. */
      const currentFolderId = folderOf(currentSession, folders)?.id ?? null;
      const inScope = visibleDocuments(knowledge, {
        chatId: currentSessionId,
        folderId: currentFolderId,
      });
      if (ragEnabled && !isAutoTool && originalInput.trim() && inScope.length > 0) {
        try {
          const hits = await retrieve(originalInput, knowledge, {
            model: embedModel,
            topK: ragTopK,
            chatId: currentSessionId,
            folderId: currentFolderId,
            signal,
          });
          if (hits.length > 0) {
            /* Kept as data as well as as text.
               The block below is what the model reads; this is what makes the
               `[1]` it writes back into something the reader can press. The
               order is the citation numbering, so index 0 is `[1]`. */
            turnCitations = hits.map(h => ({
              docName: h.docName, page: h.page, score: h.score, text: h.text,
            }));
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
          const { results, provider } = await mcpSearchWeb(safeHead(originalInput, 200), 5);
          if (results.length > 0) {
            /* Web results are citable sources too.
               A document passage opens a panel; a web result should open the
               page it came from, because the page *is* the source and a panel
               quoting a snippet of it would be a worse version of the thing
               one click away. Numbered after any document passages, so `[1]`
               means the same to the reader as it does to the model. */
            // Continue the numbering rather than restarting it.
            const base = (turnCitations || []).length;
            turnCitations = [
              ...(turnCitations || []),
              ...results.map(r => ({ url: r.url, docName: r.title || r.url, text: r.snippet || '' })),
            ];
            const block = `--- [Grounding] Web results for "${safeHead(originalInput, 120)}" `
              + `(via ${provider}, fetched ${new Date().toLocaleDateString('en-CA')}) ---\n`
              + `${formatSearchResults(results, base)}\n`
              + `--- Cite these as [${base + 1}]${results.length > 1 ? `, [${base + 2}] …` : ''} when you use them. ---`;
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

        reviseSession(currentSessionId, s => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: `${initialAssistantContent}\n</think>\n\n`,
            isMcpFetching: true,
          };
          return { ...s, messages: msgs };
        });
        
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

              // The end of the body is a frame boundary, not a reason to stop
              // reading: the last object is only left in the buffer when there
              // is no trailing newline, and dropping it drops the end of the
              // analysis. The bare `decode()` flushes a character cut in half
              // by the final chunk, which in Korean is a whole syllable.
              visionBuffer += done ? visionDecoder.decode() : visionDecoder.decode(value, { stream: true });
              const lines = visionBuffer.split('\n');
              visionBuffer = done ? '' : (lines.pop() || '');
              if (done && lines.length === 0) break;

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
                reviseSession(currentSessionId, s => {
                  const msgs = [...s.messages];
                  msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: currentDisplay };
                  return { ...s, messages: msgs };
                });
              }

              if (done) break;
            }

            const analysisText = decodeByteFallback(rawAnalysisText);
            finalInputText += `\n\n--- Image Analysis by ${selectedVisionModel} ---\n${analysisText}\n-------------------\n`;
            addLog(`Image analysis complete.`, 'success');
            
            // DO NOT mutate initialMessages[newMessageIndex - 1].content so UI's user bubble remains clean.
            // finalInputText handles sending it to Ollama later.
            initialAssistantContent = initialAssistantContent + analysisText + '\n</think>\n\n';
            
            reviseSession(currentSessionId, s => {
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isMcpFetching: false };
              return { ...s, messages: msgs };
            });
          } else {
            addLog(`Vision analysis returned error status`, 'error');
          }
        } catch (e) {
          addLog(`Vision analysis failed: ${e.message}`, 'error');
        }
      } else if (!isAutoTool) {
        reviseSession(currentSessionId, s => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isMcpFetching: false };
          return { ...s, messages: msgs };
        });
      }

      /* History goes up without the scaffolding that was put into it to be read.
       *
       * Retrieved passages, fetched pages and the model's own reasoning are
       * written into the transcript on purpose: the thinking dropdown is how
       * you check what a citation was based on. Sending them back on the next
       * turn is a different question, and the answer is no.
       *
       * It was yes, and it compounded. Every turn wrote its retrieved passages
       * into the answer as a `<think>` block, and every later turn sent that
       * block back along with its own. The prompt grew by the size of the
       * retrieval on each turn regardless of what was said:
       *
       *     16,253 + 534 tok  ->  24,761 + 468 tok  ->  32,850 + 543 tok
       *
       * Eight thousand tokens a turn for answers of five hundred, and a chat
       * that runs out of context in a dozen questions.
       *
       * The current turn is exempt: `finalInputText` at `newMessageIndex - 1`
       * is this question *with* its retrieval, which is the whole point of
       * retrieving it. What is dropped is the copy from turns already answered.
       *
       * Dropping reasoning from history is also just correct. Thinking models
       * are meant to be re-prompted without their previous thinking, and
       * feeding it back makes them worse as well as more expensive.
       */
      const turnFrom = turnStart(initialMessages);
      const thisTurn = initialMessages.slice(turnFrom);
      let conversation = initialMessages.map((m, idx) => {
        const msgData = { role: m.role, content: wireText(m, idx > turnFrom) };
        /* The question being asked now, with its retrieval -- on the leg that
           asks it. On a tool leg the last message is the tool's result, and
           `finalInputText` there is still the original question (this closure
           is the one the question was sent from). Writing it over the result
           sent the question twice and the result never: after a picture, the
           model was asked to draw again with no tools in its prompt, and
           answered that it cannot draw. */
        if (!isAutoTool && idx === newMessageIndex - 1) {
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
      /* A chat belonging to a persona uses that persona's prompt, unless the
         chat has been given an override of its own -- which is a deliberate
         act and beats everything. The global box is the last resort.

         Read from the persona rather than from the settings box because the
         box is shared: switching to another chat and back would otherwise
         answer as whoever was applied most recently. */
      const persona = personaOf(personasRef.current, currentSession);
      const chatPrompt = currentSession.systemPrompt !== undefined
        ? currentSession.systemPrompt
        : (persona?.body || systemPrompt);
      const effectiveSystemPrompt = [folderPrompt, chatPrompt].filter(Boolean).join('\n\n');

      /* Hoisted out of the system-message assembly below, because both are
         paid for on every turn and the history budget has to be told what is
         already spoken for. */
      const memoryBlock = memoryEnabled ? formatMemories(memories) : '';
      const profileBlock = formatProfile(userProfile);

      /* ---- long-conversation memory ----
       *
       * Ollama re-reads the whole prompt every turn, so a forty-turn chat is
       * not the model remembering turn one -- it is the model reading turn one
       * again, which is why `prompt_eval_duration` climbs while the answers
       * stay the same length.
       *
       * What goes out instead: the recent turns verbatim, a running summary of
       * everything older, and whichever older turns look relevant to *this*
       * question. Three tiers because they answer different questions -- see
       * convMemory.js.
       *
       * Built from the history that has already been through `forHistory`, so
       * nothing here needs to know about think blocks or tool results. The
       * current question is inside the last turn, which is always kept. */
      let memoryNote = null;
      let memoryContext = null;
      if (!isAutoTool && convMemoryRef.current) {
        try {
          memoryContext = await buildContext({
            messages: conversation,
            question: finalInputText,
            numCtx,
            // Everything else in the prompt comes out of the same window.
            reserve: estimateTokens(effectiveSystemPrompt) + estimateTokens(memoryBlock)
              + estimateTokens(profileBlock),
            summary: currentSession.memorySummary?.text || '',
            embed: embedForMemory,
            enabled: true,
          });

          if (memoryContext.compressed) {
            const keep = new Set();
            for (const turn of memoryContext.recent) {
              for (let i = turn.from; i <= turn.to; i++) keep.add(i);
            }
            conversation = conversation.filter((m, idx) => keep.has(idx) || m.role === 'system');

            const saved = savings(memoryContext);
            memoryNote = {
              dropped: memoryContext.older.length,
              recalled: memoryContext.recalled.length,
              kept: memoryContext.recent.length,
              how: memoryContext.how,
              saved: saved.saved,
              whole: saved.whole,
              summarised: !!memoryContext.summary,
            };
            addLog(`[memory] ${memoryContext.older.length} older turns compressed, `
              + `${memoryContext.recalled.length} recalled via ${memoryContext.how}, `
              + `~${saved.saved} tokens saved`, 'info');
          }
        } catch (e) {
          /* Never a reason not to send. Falling back to the whole transcript is
             slow -- which is the problem this fixes -- and a message that does
             not send at all is worse than a slow one. */
          addLog(`[memory] not compressed: ${e.message}`, 'error');
        }
      }

      /* Which tool protocol this turn uses.
       *
       * Native where the model advertises it, tags everywhere else. The two
       * are mutually exclusive on purpose: sending schemas *and* a page of
       * instructions about tags gives the model two ways to do one thing and
       * it will sometimes do both, emitting a tag inside an answer that also
       * carries a structured call. */
      /* Drawing needs no switch; everything else does. See `DRAWING_TOOLS`.
         A model that can call tools is therefore always given the two drawing
         schemas, and the web and filesystem ones only when they are armed. */
      const useNativeTools = modelSupportsTools(activeModel);

      /* Has this turn already made a picture?
       *
       * Searching is iterative — a query, a page, another query — and the
       * tool loop is built around that: it hands the result back, says how
       * many calls are left, and asks the model to continue. Drawing is not.
       * One picture is the whole of the answer, and the same encouragement
       * ("you have 9 tool calls left") reads to a model as an invitation, so
       * it drew again, and again.
       *
       * The fix is not to *ask* it to stop. It is to stop offering: once a
       * picture exists this turn, the drawing tools are withdrawn from the
       * schemas and from the tag registry, so a second call has nothing to
       * call. Asking a model not to do something it is still being handed is
       * how the first version of this behaved. */
      const drewThisTurn = thisTurn.some(m =>
        isToolResult(m) && /--- TOOL_GENERATE_(IMAGE|VIDEO) ---/.test(String(m.content)));

      /* Also when there is no system prompt at all: a chat with none still has
         a profile, memories and -- once it is long -- a summary and recalled
         turns, and those have nowhere else to go. */
      const wantsSystem = effectiveSystemPrompt || profileBlock || memoryBlock
        || memoryContext?.summary || (memoryContext?.recalled || []).length > 0;
      if (wantsSystem && !conversation.find(m => m.role === 'system')) {
        let mcpPrompt = '';
        const mcpToolCallsInTurnForSystem = thisTurn.filter(isToolResult).length;

        /* Drawing, for a model that cannot make a structured call.
         *
         * This block did not exist, and its absence was the whole of "the
         * model describes the picture instead of drawing it": the tag syntax
         * was documented for web, filesystem and environment tools and not for
         * these two, so a model on the tag path was never told drawing was
         * possible. Asked for a picture, it did the only thing it knew how to
         * do and wrote one out in prose. */
        /* How to write the prompt depends on who draws it: Anima learned from
           danbooru tags and captions and reads both best; Krea 2 reads plain
           English. Which one draws is the Studio's setting for chat. */
        const pictureModel = readChatPictureModel(profileScopeRef.current);
        const tagsAdvice = 'write the prompt as danbooru tags first — e.g. 1girl, solo, short hair, bob cut, '
          + 'sailor collar, smile, looking at viewer — spelled with spaces, not underscores, then one plain '
          + 'English sentence for what tags cannot say: mood, light, composition';
        const promptAdvice = pictureModel === 'anima-base'
          ? `Every picture is drawn by Anima, an anime model: ${tagsAdvice}.`
          : pictureModel === 'krea2-turbo'
            ? 'Every picture is drawn by Krea 2, which reads plain descriptive English: write a description, not tags.'
            : `With style="anime" the picture is drawn by Anima: ${tagsAdvice}. With style="photo" write plain descriptive English.`;

        /* The shape rule, said once for both protocols. */
        const shapeAdvice = 'When they ask for a shape or orientation — 16:9, 9:16, 1:1, 가로, 세로, '
          + '정사각형 — set aspect to the ratio ("16:9"). Otherwise leave aspect out: a picture or clip made '
          + 'from another picture keeps that picture\'s shape (the last one they attached, or the one being '
          + 'edited or animated), and the app knows which. An edit always keeps the edited picture\'s shape; '
          + 'to change a picture\'s shape, extend it.';
        /* The video guide only when the question is about video: it is long, and
           a turn about anything else pays for it for nothing. */
        const videoGuide = asksForVideo(thisTurn[0]?.content) ? `\n\n${H3_GUIDE}` : '';

        const drawPrompt = `Pictures and video
  <TOOL_GENERATE_IMAGE style="photo|anime" negative="what must not appear"
                       from="none|last_image" change="0.1-1.0" region="hair" count="1-4" aspect="16:9">
  the finished picture, described
  </TOOL_GENERATE_IMAGE>
  <TOOL_REMOVE_BACKGROUND></TOOL_REMOVE_BACKGROUND>        the newest picture, cut out on transparency
  <TOOL_UPSCALE_IMAGE factor="2|4"></TOOL_UPSCALE_IMAGE>   the newest picture, bigger and sharper
  <TOOL_EXTEND_IMAGE direction="left|right|up|down|horizontal|vertical|all" amount="0.1-1">
  the whole finished picture, described, including what the new margins show
  </TOOL_EXTEND_IMAGE>
  <TOOL_GENERATE_VIDEO from="last_image|none" duration="5-20" aspect="16:9">
  [0s-2s] what happens first  [2s-5s] what happens next
  </TOOL_GENERATE_VIDEO>

  ${promptAdvice}
  ${shapeAdvice}
  The prompt goes between the opening and the closing tag, exactly as shown —
  not as a prompt="…" attribute and not in a self-closing <TOOL_… />. Quote
  every attribute value.
  \`count\` makes several with different seeds — only when they ask for a few or
  for options. "배경 지워줘" is TOOL_REMOVE_BACKGROUND, "더 크게/고화질로" is
  TOOL_UPSCALE_IMAGE, "옆으로 늘려줘/전신이 보이게" is TOOL_EXTEND_IMAGE.

  When they ask for a picture — "그림 그려줘", "draw me one", an illustration, a
  mock-up — emit the tag. Do not describe the picture in words instead: that is
  not an answer to the request, and the tag is what puts an actual image in
  front of them.

  Emit it once. One picture is the whole answer; do not draw a second unless
  they ask for another.

  The prompt is not a request, it is a description of the finished picture:
  subject, setting, lighting, framing. Write it in English whatever language
  the conversation is in, because that is what these models were trained on.
  \`negative\` is what must not appear, as comma-separated words — the flaws
  this particular subject tends to come out with. \`style="anime"\` for anime
  and character art, \`"photo"\` for everything else.

  To *change* a picture they can already see — "머리를 파랗게", "make it night",
  "fix her hand" — set \`from="last_image"\` rather than drawing a new one. The
  app finds the picture; the prompt then describes the whole finished picture as
  it should now be, not only the part that changes. \`change\` is how far to go,
  and these numbers were measured rather than guessed: 0.5 retouches and keeps
  the colours; 0.65 restyles clothing and details; 0.8 is what it takes to
  change a colour — hair, eyes — while keeping the pose. Above 0.85 it is a
  different picture.

  When the change is to one part — a hairstyle, hair or eye colour, an outfit,
  the background — also set \`region\` to that part as a short English noun
  ("hair", "eyes", "clothes", "background"; up to three, comma-separated, e.g.
  "hair, shoulders" for hair that gets longer). Only that part is redrawn and
  everything else stays exactly as it was, so \`change\` can be high (0.9).
  Leave \`region\` out only for changes to the whole picture: style, lighting,
  time of day, pose.

  For video, \`from="last_image"\` animates the picture already in this
  conversation. The prompt is a timeline — [0s-2s] … [2s-5s] … — ending at
  \`duration\`. It takes minutes, so never use it unasked.${videoGuide}`;

        if (!mcpEnabled && !useNativeTools && mcpToolCallsInTurnForSystem === 0) {
          mcpPrompt = `[Tools]
You can call a tool by emitting one tag. Emit exactly one, then stop; the result
comes back in a <TOOL_RESULT> block and you continue from there.

${drawPrompt}`;
        }

        if (mcpEnabled && !useNativeTools && mcpToolCallsInTurnForSystem === 0) {
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

${drawPrompt}

Rules
1. Use a tool whenever the answer depends on current facts, on this machine, or
   on anything you cannot verify from memory. Do not guess at recent events.
2. Emit the tag and nothing after it. Never write a tool result yourself.
3. You have up to ${toolBudget} tool calls this turn. Spend them: a search
   followed by fetching the most relevant URL is the normal pattern.
4. When you have enough, answer in natural language and cite the URLs you used.
5. If a tool reports a failure, say so plainly instead of inventing the answer.`;
        }
        
        /* The schemas describe each tool; they cannot describe when to bother.
           This is the part of that page of instructions that was never really
           about syntax, kept for the native path -- three lines instead of
           forty, because the model no longer has to be taught to spell. */
        if (useNativeTools && mcpToolCallsInTurnForSystem === 0) {
          /* Two paragraphs, and only the first is always true. With the web and
             filesystem tools switched off the only ones on offer are the two
             drawing ones, and telling a model to "use a tool whenever the
             answer depends on current facts" when it has no way to look
             anything up is an instruction it cannot follow. */
          mcpPrompt = `[Tools]
`
            + `When they ask for a picture or a video — "그림 그려줘", "draw me one", an `
            + `illustration, a mock-up, "animate that" — call generate_image or `
            + `generate_video. Describing the picture in words is not an answer to that `
            + `request. Call it once: one picture is the whole answer. To change a picture `
            + `they can already see, call generate_image with from="last_image" rather than `
            + `drawing a new one, and when only one part changes (hair, eyes, clothes, `
            + `background) set region to that part so the rest stays exactly as it is. `
            + `To cut the picture out, enlarge it, or show more around it, call remove_background, `
            + `upscale_image or extend_image. Never call any of them unasked.
${promptAdvice}
${shapeAdvice}
A video prompt is a timeline — [0s-2s] … [2s-5s] … — that ends at the clip's duration.${videoGuide}
`
            + (mcpEnabled
              ? `Use the other tools whenever the answer depends on current facts, on this `
                + `machine, or on anything you cannot verify from memory. Do not guess at `
                + `recent events. You have up to ${toolBudget} tool calls this turn; a search `
                + `followed by fetching the best result is the normal pattern. When you have `
                + `enough, answer and cite the URLs you used.
`
              : '')
            + `If a tool reports a failure, say so plainly rather than inventing the answer.`;
        }

        const finalSystemPrompt = [
          environmentPreamble(),
          /* Who is asking, before what is known about them: the profile is
             stated fact and the memories are things inferred from earlier
             conversations, and a model reading them in that order treats a
             contradiction the right way round. */
          profileBlock,
          memoryBlock,
          // What happened earlier in *this* conversation, when most of it is
          // no longer being sent verbatim.
          formatSummary(memoryContext?.summary),
          formatRecalled(memoryContext?.recalled || []),
          mcpPrompt,
          `[System Instructions]\n${effectiveSystemPrompt}`,
        ].filter(Boolean).join('\n\n');
        conversation = [{ role: 'system', content: finalSystemPrompt }, ...conversation];
      }

      const targetModel = activeModel;
      addLog(`Sending message to ${targetModel}...`, 'info');

      // 4. Send to Ollama
      const askOllama = (think) => fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          model: targetModel,
          messages: conversation,
          // Omitted entirely on 'auto' so each model keeps its own default.
          ...think,
          // Ollama parses a string as a Go duration ("5m"), so the sentinels
          // -1 (keep forever) and 0 (unload now) must go over as numbers —
          // "-1" fails with: time: missing unit in duration "-1".
          ...(keepAlive ? { keep_alive: /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive } : {}),
          ...(resolvedFormat ? { format: resolvedFormat } : {}),
          // Structured tool calls, for a model that does them.
          ...(useNativeTools ? { tools: schemasFor({ web: mcpEnabled, drawing: !drewThisTurn }) } : {}),
          options: buildOptions()
        })
      });

      const wanted = thinkField(thinkMode);
      let res = await askOllama(wanted);

      /* A level is not something every model — or every version of Ollama —
         can be asked for. The ones that cannot refuse the whole request, and a
         reasoning setting is not worth losing a turn over: asked for "medium"
         and told no, ask for thinking without saying how much. */
      if (!res.ok && typeof wanted.think === 'string') {
        const why = await res.clone().text().catch(() => '');
        if (/think|effort|level/i.test(why) || res.status === 400) {
          addLog(`${targetModel} does not take a thinking level; asking for thinking without one.`, 'info');
          res = await askOllama({ think: true });
        }
      }

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
      // What the `done` frame measured. Kept out here because the tool loop
      // near the end of this function has to carry it forward -- see
      // `finishedLeg` for what went wrong when it did not.
      let legMetrics = null;
      let buffer = '';
      // Tool calls the model made as structured data rather than as tag text.
      const nativeCalls = [];
      /* What has been sent to the voice, and what has not yet.
         Speaking only after the answer finishes means a minute or two of
         silence on a local 31B -- and in hands-free mode, where nobody is
         looking at the screen, silence is indistinguishable from the app
         having died. Pieces go out at sentence ends; see src/speechChunks.js. */
      let spokenUpTo = 0;
      const speakAsItArrives = (finalPass) => {
        if (!(ttsAutoPlay || voiceModeRef.current)) return;
        const said = stripForSpeech(decodeByteFallback(rawAnswerText));
        let pending = said.slice(spokenUpTo);
        for (;;) {
          const { piece, rest } = takeSpeakable(pending, { final: finalPass });
          if (!piece) break;
          spokenUpTo = said.length - rest.length;
          enqueueSpeech(piece, newMessageIndex);
          pending = rest;
          if (finalPass) break;
        }
      };

      // Byte-fallback runs arrive one byte per chunk, so the decode has to see
      // the whole accumulated text — it is a no-op once nothing is left to join.
      const composeContent = (closeThinking) => {
        /* `stripLoneSurrogates` is the last line of defence, not the fix.
           The cuts that used to produce half a character have all been made
           safe (see src/textCut.js), but this text is about to be written to
           IndexedDB, uploaded to the account and fed back as the next turn's
           prompt — and every one of those encodes it, turning half a character
           into U+FFFD. Somewhere in the middle of an answer, only sometimes,
           with nothing in the log. Whatever produced it, it does not get to
           travel: a half-character was never a character to begin with. */
        const thinkingText = stripLoneSurrogates(decodeByteFallback(rawThinkingText));
        const answerText = stripLoneSurrogates(decodeByteFallback(rawAnswerText));
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
      //
      // ...but an animation frame is a *painting* clock, and a page that is not
      // on screen is not painting: switch to another window and rAF stops
      // firing entirely. The reply kept arriving into `assistantContent` and
      // was never committed, so the chat record never changed, so nothing was
      // uploaded, so the phone watching the same account saw the answer freeze
      // until the laptop window came back to the front. That is the whole of
      // the "it only updates while I'm looking at it" bug.
      //
      // The answer is to stop treating the frame clock as the only clock. The
      // chunks themselves arrive over the network, which is throttled by
      // nothing, so a hidden page commits on the data instead — see the read
      // loop below. Timers are no use here either: Chrome clamps them to once
      // a second in a hidden page and once a *minute* after five minutes of it.
      const HIDDEN_COMMIT_MS = 250;
      let flushHandle = null;
      let lastCommitAt = 0;
      const flushNow = () => {
        flushHandle = null;
        lastCommitAt = Date.now();
        reviseSession(currentSessionId, s => {
          const msgs = [...s.messages];
          msgs[newMessageIndex] = { ...msgs[newMessageIndex], content: assistantContent, isMcpFetching: false };
          return { ...s, messages: msgs };
        });
      };
      const scheduleFlush = () => {
        // Hidden: commit straight off the chunk, at most four times a second.
        // The rate limit is what keeps this from being one React commit per
        // token; the clock is `Date.now()` rather than a timer precisely
        // because timers are the thing that does not work here.
        if (document.visibilityState === 'hidden') {
          if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
          if (Date.now() - lastCommitAt >= HIDDEN_COMMIT_MS) flushNow();
          return;
        }
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

        /* The end of the stream is a frame boundary, not a reason to stop
           reading.
         *
         * Ollama writes a newline after each JSON object, so `buffer` is
         * normally empty by the time the body closes and breaking here cost
         * nothing. "Normally" is doing a lot of work in that sentence: a proxy
         * that ends the response on the last byte of the last object, or a
         * chunk boundary that lands on the newline, leaves the final frame
         * sitting in `buffer` — and the final frame is the `done` frame, the
         * one carrying every timing in the footer. The answer arrived
         * complete and the numbers under it simply did not, intermittently and
         * for no reason anyone could see from the screen.
         *
         * `decoder.decode()` with no argument is the matching flush: it emits
         * whatever multi-byte character was cut in half by the last chunk,
         * which is the same class of bug one layer down and would eat the last
         * Hangul syllable of an answer. */
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Mid-stream the last piece is half a JSON object; at the end it is a
        // whole one, and there is nothing left to complete it.
        buffer = done ? '' : (lines.pop() || '');
        if (done && lines.length === 0) break;

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch (e) { continue; }

          const delta = parsed.message || {};
          if (delta.thinking) rawThinkingText += delta.thinking;
          if (delta.content) rawAnswerText += delta.content;

          /* Structured tool calls arrive on the frame rather than in the text.
             Collected here and acted on after the stream ends, because a call
             is only meaningful once the model has stopped -- and because the
             executor below wants the whole turn, not a fragment of it. */
          for (const call of toolCallsIn(parsed)) nativeCalls.push(call);

          if (delta.thinking || delta.content) {
            // The first thing the reader could possibly see. Reasoning counts:
            // a model that thinks visibly for four seconds has responded, even
            // though its answer has not started.
            if (firstTokenAt === null) firstTokenAt = performance.now();
            assistantContent = composeContent(false);
            scheduleFlush();
            // Only whole sentences leave here, so this is cheap on most frames.
            if (delta.content) speakAsItArrives(false);
          }

          if (parsed.done) {
            cancelFlush();
            assistantContent = composeContent(true);
            /* The footer's three numbers, and why each has a fallback.

               Ollama's `done` frame is supposed to carry `total_duration`,
               `eval_duration`, `eval_count` and `prompt_eval_count`, and
               most of the time it does. It does not when a proxy sits in
               front of it, when the model is served by something
               Ollama-compatible rather than by Ollama, or when the run was
               cut short — and `undefined / 1e9` is NaN, so what reached the
               screen was `NaN s` or, once the falsy checks had done their
               work, no footer at all. That is the "sometimes there is no
               s, no tokens/s, no tok".

               The clock on this machine can answer the first two honestly:
               it is what the reader actually waited, which is the number
               they were reading anyway. `~` marks the ones measured here
               rather than reported by the server, because a rate derived
               from wall time includes the network and the server's does
               not. */
            const wallSeconds = (performance.now() - turnStartedAt) / 1000;
            const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

            const serverTotal = finite(parsed.total_duration);
            const totalTime = (serverTotal !== null ? serverTotal / 1e9 : wallSeconds).toFixed(2);

            const evalCount = finite(parsed.eval_count);
            const evalDuration = finite(parsed.eval_duration);
            // Seconds spent generating: the server's own figure, or the time
            // between the first visible token and now, which is the same
            // span measured from outside.
            const generatingFor = evalDuration ? evalDuration / 1e9
              : (firstTokenAt === null ? 0 : (performance.now() - firstTokenAt) / 1000);
            const counted = evalCount ?? estimateTokens(rawAnswerText + rawThinkingText);
            const tokensPerSec = counted > 0 && generatingFor > 0.05
              ? (counted / generatingFor).toFixed(2)
              : null;

            const ms = (nanoseconds) => (Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : null);
            const metrics = {
              totalTime,
              tokensPerSec,
              evalCount: counted,
              promptTokens: finite(parsed.prompt_eval_count),
              // Which of these the server told us and which this machine
              // worked out. The footer marks the estimates, because a
              // number nobody can tell apart from a measurement is worse
              // than no number.
              estimated: serverTotal === null || evalCount === null,
              // Kept rather than discarded: these are what explain a slow turn.
              // `load` is the weights being read in — the whole of "why was the
              // first message so slow" — and `promptEval` grows with the
              // conversation while the answer does not, which is why a long
              // chat feels slower than a fresh one at the same speed.
              ttft: firstTokenAt === null ? null : Math.round(firstTokenAt - turnStartedAt),
              load: ms(parsed.load_duration),
              promptEval: ms(parsed.prompt_eval_duration),
            };
            legMetrics = metrics;

            // Only measurements. "On this machine" is a claim about the GPU,
            // and a rate worked out from wall time includes the network — one
            // of those in the median quietly makes the whole row a lie.
            if (!metrics.estimated) {
              recordRun(perfKey, {
                model: targetModel,
                tokensPerSec,
                ttft: metrics.ttft,
                load: metrics.load,
                promptEval: metrics.promptEval,
                outTokens: evalCount,
                inTokens: metrics.promptTokens,
              });
            }
            // A retry set this; the finished answer joins the earlier ones
            // instead of overwriting them.
            const carried = pendingVariantsRef.current;
            pendingVariantsRef.current = null;
            truncated = wasTruncated(parsed);

            reviseSession(currentSessionId, s => {
              const msgs = [...s.messages];
              const base = {
                ...msgs[newMessageIndex],
                content: assistantContent,
                // When it finished, which a regeneration keeps with its variant.
                at: Date.now(),
                // prompt_eval_count is the tokeniser's own count of everything sent;
                // the composer only ever had a heuristic before this.
                metrics,
                model: targetModel,
                isMcpFetching: false,
                // Only when there were any, so an ordinary answer carries no
                // empty array into storage and over the sync.
                ...(turnCitations ? { citations: turnCitations } : {}),
                // Only when there are any, so an ordinary answer carries no
                // empty array into storage and over the sync.
                ...(turnImages.length ? { generated: turnImages } : {}),
                // What was left out of the prompt. On the message rather than
                // in a log, because a model that has forgotten turn nine while
                // the screen still shows turn nine is a bug nobody can
                // diagnose from the outside.
                ...(memoryNote ? { memoryNote } : {}),
              };
              msgs[newMessageIndex] = carried
                ? appendVariant({ ...base, variants: carried, variantIndex: carried.length - 1 }, base)
                : base;
              return { ...s, messages: msgs };
            });
          }
        }

        if (done) break;
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

      /* A stream that ended without a `done` frame.
       *
       * It happens: a proxy that closes the connection when the body is
       * complete, an Ollama-compatible server that never sends the final
       * object, a run that finished exactly on a chunk boundary. The answer is
       * on screen and correct, and the footer under it was simply absent —
       * which reads as the app having lost the numbers rather than as never
       * having been given them. The clock here knows enough to say what the
       * reader waited and roughly how fast it arrived, so it says that,
       * marked as estimated. */
      if (!legMetrics && (rawAnswerText || rawThinkingText)) {
        const generatingFor = firstTokenAt === null ? 0 : (performance.now() - firstTokenAt) / 1000;
        const counted = estimateTokens(rawAnswerText + rawThinkingText);
        legMetrics = {
          totalTime: ((performance.now() - turnStartedAt) / 1000).toFixed(2),
          tokensPerSec: counted > 0 && generatingFor > 0.05 ? (counted / generatingFor).toFixed(2) : null,
          evalCount: counted,
          promptTokens: null,
          estimated: true,
          ttft: firstTokenAt === null ? null : Math.round(firstTokenAt - turnStartedAt),
          load: null,
          promptEval: null,
        };
        const carriedMetrics = legMetrics;
        reviseSession(currentSessionId, s => {
          const msgs = [...s.messages];
          if (!msgs[newMessageIndex] || msgs[newMessageIndex].metrics) return s;
          msgs[newMessageIndex] = { ...msgs[newMessageIndex], metrics: carriedMetrics, model: targetModel };
          return { ...s, messages: msgs };
        });
      }

      // One decoded view for everything downstream: tool tags, TTS and memory
      // all have to see the real characters, not the byte spellings — and not
      // half of one, for the reasons in `composeContent` above.
      const answerText = stripLoneSurrogates(decodeByteFallback(rawAnswerText));

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
          reviseSession(currentSessionId, x =>
            ({ ...x, messages: x.messages.filter((_, i) => i <= continuation.index) }));
          setIsGenerating(false);
          setTimeout(() => continueResponse(continuation.index), 120);
          return;
        }

        reviseSession(currentSessionId, x => {
          const msgs = [...x.messages];
          if (!msgs[continuation.index]) return x;
          msgs[continuation.index] = {
            ...msgs[continuation.index],
            content: joinContinuation(continuation.before, answerText, continuation.mode),
            // Carried on, so it finished now rather than when it first stopped.
            at: Date.now(),
          };
          // Drop the hidden instruction turn and the bubble it produced.
          return { ...x, messages: msgs.filter((_, i) => i <= continuation.index || i > newMessageIndex) };
        });
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

      /* The leg that has just finished, as a message.
       *
       * The tool loop below restarts the turn, and it does so by handing
       * `handleSend` a whole new message array — which replaces the chat's
       * own. That array used to be built as `{ role: 'assistant', content:
       * assistantContent }`: a bare object, next to a snapshot of the messages
       * taken *before* the reply began. So everything the `done` frame had
       * written to this message a tenth of a second earlier was thrown away —
       * the timings, the model that wrote it, the citations.
       *
       * That is the whole of "the tokens/s number appears and then vanishes".
       * It was never a render glitch: the numbers were deleted from the record
       * as soon as the model reached for a tool.
       */
      const finishedLeg = () => ({
        role: 'assistant',
        content: assistantContent,
        at: Date.now(),
        model: targetModel,
        ...(routedBy ? { routedBy } : {}),
        ...(legMetrics ? { metrics: legMetrics } : {}),
        ...(turnCitations ? { citations: turnCitations } : {}),
        // Pictures the model drew this turn, carried into the leg the tool
        // loop hands on, so a turn that drew and then kept talking does not
        // lose the picture when the next request replaces the message array.
        ...(turnImages.length ? { generated: turnImages } : {}),
        ...(memoryNote ? { memoryNote } : {}),
      });

      /* ---- Agent tools ----
       *
       * A registry rather than a chain of ifs: each entry owns its pattern and
       * its execution, so adding a tool is one object.
       *
       * Built whatever the switch says, and filtered afterwards: the drawing
       * tools are always available and the rest are not. Building it
       * conditionally is what made drawing unreachable — the two entries were
       * inside `if (mcpEnabled)` along with everything that genuinely needs
       * permission. */
      {
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
          /* Drawing, from inside a conversation.
           *
           * The picture is attached to the *message*, not returned as text: a
           * model handed a data URL as a tool result will try to describe it,
           * or worse, repeat it. What goes back to the model is one sentence
           * saying it worked and that the reader can already see it — which is
           * what stops the next turn opening with "here is the image:" followed
           * by nothing.
           *
           * The whole call blocks the turn for as long as the generation takes.
           * That is the honest arrangement: the answer genuinely is not ready
           * until the picture is, and a turn that finished first would have to
           * come back and edit itself afterwards. */
          {
            name: 'TOOL_GENERATE_IMAGE',
            /* Every attribute is optional, and they are read by name: a model
               that writes only a style, or writes `negative` before `style`,
               still produces a call this matches. A fixed order did not match
               the second, and the call was never run. */
            pattern: new RegExp(`<TOOL_GENERATE_IMAGE${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_GENERATE_IMAGE>`),
            run: async (m) => {
              const attrs = tagAttrs(m[1]);
              const prompt = (m[2] || '').trim();
              const style = (attrs.style || 'photo').toLowerCase();
              /* Written by the model, because what must not appear depends on
                 what is being drawn: a portrait wants "extra fingers, deformed
                 hands" and a landscape wants "people, text, watermark". */
              const negative = (attrs.negative || '').trim();
              if (!prompt) return 'Error: generate_image needs a prompt describing the picture.';

              /* Which picture to edit is resolved here, from the transcript,
                 rather than asked of the model. A model asked to re-describe
                 an image so another model can redraw it describes a different
                 image — the same reason `generate_video` resolves it here. */
              let edit = null;
              /* A painted edit: the reader marked the area on a particular
                 picture before asking, and that picture and that area win over
                 anything the model says -- it cannot see the brush strokes. */
              const paint = thisTurn[0]?.paint || null;
              if (paint || (attrs.from || '').toLowerCase() === 'last_image') {
                const picture = (paint && pictureByFilename(paint.target)) || latestPictureInChat();
                if (!picture) {
                  return 'There is no picture in this conversation to edit. Draw one first, '
                    + 'or ask them to attach the picture they mean.';
                }
                const asked = Number(attrs.change);
                // What to redraw. Up to three nouns; the rest of the picture is kept.
                const region = (attrs.region || '').split(',').map(s => s.trim()).filter(Boolean)
                  .slice(0, 3).join(', ');
                edit = {
                  dataUrl: picture.dataUrl,
                  region,
                  /* The seed the picture was drawn with, so what is redrawn is
                     drawn the same way. Only meaningful to the model that drew it. */
                  seed: picture.seed,
                  seedModel: picture.model,
                  /* Clamped: 1.0 ignores the picture completely, which is not
                     an edit, and 0 returns it untouched. The default is 0.65
                     because 0.5 was measured to change almost nothing — the
                     reference dominates, and a request to make the hair blue
                     came back blonde.

                     With a region the rest of the picture is untouched whatever
                     this says, so the region itself can be redrawn outright:
                     long hair does not become a bob by being retouched. */
                  change: (region || paint)
                    ? (Number.isFinite(asked) ? Math.min(Math.max(asked, 0.3), 1) : 0.9)
                    : (Number.isFinite(asked) ? Math.min(Math.max(asked, 0.1), 0.9) : 0.65),
                };
              }

              const count = Math.min(Math.max(Math.round(Number(attrs.count) || 1), 1), 4);
              addLog(`[tool] ${edit ? 'edit' : 'generate'} image${count > 1 ? ` ×${count}` : ''}: ${prompt.slice(0, 80)}`, 'info');
              /* A new picture asked for alongside one they just attached takes
                 that picture's shape unless they named one. An edit keeps the
                 edited picture's shape whatever -- see generateOneImage. */
              const attachedNow = (thisTurn[0]?.images || []).slice(-1)[0];
              const shape = {
                ...(attrs.aspect ? { aspect: attrs.aspect } : {}),
                ...(!edit && attachedNow ? { shapeFrom: asImageDataUrl(attachedNow) } : {}),
              };
              try {
                const pictures = await generateImages(count, prompt, style, negative, edit,
                  abortControllerRef.current?.signal,
                  // A painted area is grown a little: a brush stroke stops just short of an edge.
                  { ...shape, ...(paint ? { mask: paint.mask, maskGrow: 12 } : {}) });
                for (const picture of pictures) turnImages.push({ ...picture, edited: !!edit });
                return `${pictures.length > 1 ? `${pictures.length} images were` : 'The image was'} generated `
                  + `and ${pictures.length > 1 ? 'are' : 'is'} already displayed to the user beneath your `
                  + `reply. Do not describe ${pictures.length > 1 ? 'them' : 'it'}, do not link to `
                  + `${pictures.length > 1 ? 'them' : 'it'}, and do not repeat the prompt. `
                  + `Say at most one short sentence about it, or nothing.`;
              } catch (e) {
                return `IMAGE GENERATION FAILED: ${e.message}. This is a tooling failure — say so `
                  + `plainly rather than describing a picture that does not exist.`;
              }
            },
          },
          /* Three things done to the picture already there. The picture is the
             newest one in the conversation, found here, and what comes back is
             attached to the message like a drawing -- the model is told it
             worked and that the reader can see it, nothing more. */
          {
            name: 'TOOL_REMOVE_BACKGROUND',
            pattern: new RegExp(`<TOOL_REMOVE_BACKGROUND${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_REMOVE_BACKGROUND>`),
            run: async () => {
              const picture = latestPictureInChat();
              if (!picture) return 'There is no picture in this conversation to cut out. Draw one first, or ask them to attach it.';
              addLog('[tool] remove background', 'info');
              try {
                turnImages.push(await runPictureOp('rmbg', picture, { signal: abortControllerRef.current?.signal }));
                return 'The background was removed and the cut-out, on transparency, is already displayed '
                  + 'to the user beneath your reply. Say at most one short sentence about it, or nothing.';
              } catch (e) {
                return `IMAGE TOOL FAILED: ${e.message}. Say so plainly.`;
              }
            },
          },
          {
            name: 'TOOL_UPSCALE_IMAGE',
            pattern: new RegExp(`<TOOL_UPSCALE_IMAGE${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_UPSCALE_IMAGE>`),
            run: async (m) => {
              const picture = latestPictureInChat();
              if (!picture) return 'There is no picture in this conversation to upscale. Draw one first, or ask them to attach it.';
              const factor = Number(tagAttrs(m[1]).factor) >= 3 ? 4 : 2;
              addLog(`[tool] upscale ×${factor}`, 'info');
              try {
                const result = await runPictureOp('upscale', picture, { factor, signal: abortControllerRef.current?.signal });
                turnImages.push(result);
                return `The picture was enlarged ${result.factor || factor}× and is already displayed to the user `
                  + 'beneath your reply. Say at most one short sentence about it, or nothing.';
              } catch (e) {
                return `IMAGE TOOL FAILED: ${e.message}. Say so plainly.`;
              }
            },
          },
          {
            name: 'TOOL_EXTEND_IMAGE',
            pattern: new RegExp(`<TOOL_EXTEND_IMAGE${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_EXTEND_IMAGE>`),
            run: async (m) => {
              const attrs = tagAttrs(m[1]);
              const prompt = (m[2] || '').trim();
              const picture = latestPictureInChat();
              if (!picture) return 'There is no picture in this conversation to extend. Draw one first, or ask them to attach it.';
              if (!prompt) return 'Error: extend_image needs a prompt describing the whole finished picture.';
              const direction = ['left', 'right', 'up', 'down', 'horizontal', 'vertical', 'all']
                .includes(attrs.direction) ? attrs.direction : 'horizontal';
              // The style it was drawn in, so the margin is drawn by the same model.
              const style = picture.model === 'anima-base' ? 'anime' : (picture.style || 'photo');
              addLog(`[tool] extend ${direction}: ${prompt.slice(0, 80)}`, 'info');
              try {
                const result = await extendPicture(picture, {
                  direction, amount: attrs.amount, prompt, style, negative: attrs.negative || picture.negative || '',
                }, abortControllerRef.current?.signal);
                turnImages.push({ ...result, edited: true });
                return 'The picture was extended and is already displayed to the user beneath your reply. '
                  + 'Say at most one short sentence about it, or nothing.';
              } catch (e) {
                return `IMAGE TOOL FAILED: ${e.message}. Say so plainly.`;
              }
            },
          },
          /* Making something move.
           *
           * `from="last_image"` is the request people actually make — "이걸
           * 영상으로 만들어줘" — and it is deliberately not the model's job to
           * answer. Asked to re-describe a picture so a video model can redraw
           * it, a model describes it differently and the video is of something
           * else. So the picture is found here, in the transcript, by the code
           * that can see the actual bytes: the newest generated image, or
           * failing that the newest one the reader attached. */
          {
            name: 'TOOL_GENERATE_VIDEO',
            // Attributes by name, like the drawing tag: from, duration, aspect.
            pattern: new RegExp(`<TOOL_GENERATE_VIDEO${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_GENERATE_VIDEO>`),
            run: async (m) => {
              const attrs = tagAttrs(m[1]);
              const prompt = (m[2] || '').trim();
              const from = (attrs.from || 'none').toLowerCase();
              if (!prompt) return 'Error: generate_video needs a prompt describing the shot.';

              let reference = null;
              if (from === 'last_image') {
                reference = latestImageInChat();
                if (!reference) {
                  return 'There is no picture in this conversation to animate. Ask them to '
                    + 'attach one, or offer to generate one first.';
                }
              }
              /* Made from nothing, but asked for alongside a picture they just
                 attached: that picture's shape, unless they named one. */
              const attachedNow = (thisTurn[0]?.images || []).slice(-1)[0];
              const aspect = attrs.aspect || (!reference && attachedNow
                ? await pictureSize(asImageDataUrl(attachedNow)).then(d => `${d.width}:${d.height}`).catch(() => '')
                : '');

              addLog(`[tool] generate video: ${prompt.slice(0, 80)}`, 'info');
              try {
                const film = await generateOneVideo(prompt, reference, abortControllerRef.current?.signal, {
                  duration: attrs.duration,
                  aspect,
                });
                turnImages.push({ ...film, video: true });
                return `The video was generated and is already displayed to the user beneath `
                  + `your reply. Do not describe it and do not repeat the prompt. Say at most `
                  + `one short sentence about it, or nothing.`;
              } catch (e) {
                return `VIDEO GENERATION FAILED: ${e.message}. This is a tooling failure — say `
                  + `so plainly rather than describing a video that does not exist.`;
              }
            },
          },
        ];

        /* One executor, two ways in.
         *
         * A model with native tools returns `tool_calls`; one without is asked
         * to write a tag. Rather than keep two implementations of the same ten
         * tools -- which would drift, and where the second would be the one
         * nobody tested -- a native call is rendered back into the tag it
         * would have been and matched by the same patterns. `nativeCallToTag`
         * returns null for a name that is not a tool, which is how an invented
         * function is refused rather than run. */
        const nativeText = nativeCalls
          .map(call => {
            const tag = nativeCallToTag(call.name, call.args);
            if (!tag) addLog(`[tool] model asked for '${call.name}', which does not exist`, 'error');
            return tag;
          })
          .filter(Boolean)
          .join('\n');
        if (nativeText) addLog(`[tool] ${nativeCalls.length} native call(s)`, 'info');

        // The model's own text first: a tag it wrote is still honoured for a
        // model that has both, and a native call cannot appear in prose.
        // Read in the documented form whatever form it was written in -- a
        // self-closing tag with the prompt as an attribute was never run.
        const toolSource = canonicalToolTags(nativeText || answerText);

        /* Every call the model made, not just the first.
         *
         * The tag protocol asks for one tag and a stop, so there is only ever
         * one to find in prose — but a model with native tools returns an
         * *array*, and taking `[0]` threw the rest away. "Search for this and
         * also tell me the time" came back having done half of it, with
         * nothing to say the other half had been dropped.
         *
         * Ordered by where each appears, so a chain the model intended in a
         * particular order happens in that order. */
        const allowed = TOOLS.filter(tool => (mcpEnabled || DRAWING_TAGS.has(tool.name))
          && !(drewThisTurn && DRAWING_TAGS.has(tool.name)));
        const invocations = allowed
          .flatMap(tool => [...toolSource.matchAll(new RegExp(tool.pattern, 'g'))]
            .map(match => ({ tool, match })))
          .sort((a, b) => a.match.index - b.match.index);

        if (invocations.length > 0) {
          /* What the turn has spent so far.
           *
           * Counted from the results themselves rather than from the number of
           * messages, because one message can now carry several. Each result
           * is introduced by its tool's name, and that marker is what is
           * countable — see how the block is built below. */
          const spent = thisTurn
            .filter(isToolResult)
            .reduce((n, m) => n + Math.max(1, (m.content.match(/^--- TOOL_[A-Z_]+ ---$/gm) || []).length), 0);

          if (spent >= toolBudget) {
            const nextMessages = [
              ...initialMessages,
              finishedLeg(),
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

          /* Only as many as the budget still allows, and the rest are said to
             be dropped rather than silently ignored — a model that asked for
             four things and got two back should be told which two. */
          const affordable = Math.max(1, toolBudget - spent);
          const running = invocations.slice(0, affordable);
          const dropped = invocations.slice(affordable);

          /* Run them one at a time.
             In parallel would be faster by a second or two, and would also
             fire three web searches at one provider simultaneously, which is
             how a free search backend starts refusing. These are not slow
             enough to be worth that. */
          const results = [];
          const picturesBefore = turnImages.length;
          for (const invoked of running) {
            let text;
            try {
              text = await invoked.tool.run(invoked.match);
            } catch (e) {
              text = `Error running ${invoked.tool.name}: ${e.message}`;
              addLog(`[tool] ${invoked.tool.name} failed: ${e.message}`, 'error');
            }
            // The marker is what makes the budget countable above, and it also
            // tells the model which answer belongs to which request.
            results.push(`--- ${invoked.tool.name} ---\n${text}`);
          }
          if (dropped.length > 0) {
            results.push(`--- SKIPPED ---\nThe tool budget did not stretch to `
              + `${dropped.map(d => d.tool.name).join(', ')}. Ask again next turn if you still need them.`);
          }
          const toolResultText = results.join('\n\n');

          /* A picture that worked is the whole answer, so the turn ends here.
           *
           * The leg after it existed to let the model say "here you go", and
           * the most it was allowed was one sentence. What it cost was a second
           * generation -- often a reload, the image model having just had the
           * GPU -- and a model that had drawn a picture it could not see would
           * sometimes use its sentence to say it cannot draw, under the
           * picture. Its words from before the call are already the reply.
           *
           * Only when every call was a drawing and each one produced its
           * picture: a failure, a missing picture to edit, or a search
           * alongside all still need the model to say something. */
          // `>=`: one call can make several pictures now (`count`).
          const drewEverything = dropped.length === 0
            && running.every(r => DRAWING_TAGS.has(r.tool.name))
            && turnImages.length - picturesBefore >= running.length;
          if (drewEverything) {
            const pictures = [...turnImages];
            /* A structured call leaves no trace in the text. Written in, it
               shows as the drawing it was and is remembered as the model's own
               action -- and a reply with no text at all would sit under a
               "thinking" spinner that never stops. */
            const content = nativeText
              ? [assistantContent, nativeText].filter(Boolean).join('\n\n')
              : assistantContent;
            reviseSession(currentSessionId, s => {
              const msgs = [...s.messages];
              if (!msgs[newMessageIndex]) return s;
              msgs[newMessageIndex] = {
                ...msgs[newMessageIndex], content, generated: pictures, isMcpFetching: false,
              };
              return { ...s, messages: msgs };
            });
            addLog('[tool] picture delivered; the turn ends with it', 'info');
          } else {
            const remaining = Math.max(0, toolBudget - spent - running.length);
            /* A picture ends the tool use, so the note after it says so rather
               than counting down a budget the model can no longer spend. Telling
               it to "cite any URLs you used" after drawing is worse than useless:
               there are none, and being asked for them is what sends a model
               looking for another tool to call.

               Made, not merely asked for: after a failed drawing this note
               would tell the model a picture exists, right under the failure. */
            const drew = turnImages.length > picturesBefore;
            const suffix = drew
              ? '\n\nThe picture is made and the reader can see it. This turn is finished: '
                + 'do not call any tool again, and reply with at most one short sentence.'
              : remaining > 0
                ? `\n\nYou have ${remaining} tool call(s) left. Use another only if you still need it; `
                  + 'otherwise answer now, citing any URLs you used.'
                : '\n\nThis was your last tool call. Answer now, citing any URLs you used.';

            const nextMessages = [
              ...initialMessages,
              finishedLeg(),
              { role: 'user', content: `<TOOL_RESULT>\n${toolResultText}${suffix}\n</TOOL_RESULT>` },
            ];

            setTimeout(() => handleSend(null, nextMessages, activeModel), 100);
            return; // Keep isGenerating true
          }
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
      // Hands-free implies auto-play: the answer being read out is the half of
      // the loop that makes it hands-free, and having to also find the setting
      // for it would be a mode that does not work until configured.
      if ((ttsAutoPlay || voiceModeRef.current) && stripForSpeech(answerText)) {
        // Most of it has already been said while it was arriving; this is the
        // last part of the last sentence, which had no full stop to trigger on.
        speakAsItArrives(true);
      }

    } catch (err) {
      if (err.name === 'AbortError' || err.message.includes('abort')) {
        addLog('Generation stopped by user.', 'info');
        // Stopping mid-thought leaves an unterminated <think>, which would
        // keep the "Thinking..." spinner running forever. Close it.
        reviseSession(currentSessionId, s => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (!last || last.role !== 'assistant') return s;
          const opens = (last.content.match(/<think>/g) || []).length;
          const closes = (last.content.match(/<\/think>/g) || []).length;
          if (opens <= closes) return s;
          msgs[msgs.length - 1] = { ...last, content: `${last.content}\n</think>\n\n`, isMcpFetching: false };
          return { ...s, messages: msgs };
        });
      } else if (isRetryable(err) && !isAutoTool && originalInput.trim()) {
        /* The wifi dropped, or Ollama was still loading, or the laptop was
           asleep. All three are ordinary and all three used to lose the
           question: the composer had already been cleared, so `**Error:**
           Failed to fetch` was the only thing left of two minutes' writing.
           It goes in the queue instead, which survives a reload and retries
           on its own when the network comes back -- the moment connectivity
           returns being exactly when nobody is watching. */
        addLog(`[queue] ${err.message} — the question is kept and will be retried`, 'info');
        const queued = enqueue(profileScopeRef.current, makeEntry({
          sessionId: currentSessionId,
          model: activeModel,
          text: originalInput,
          attachments: currentAttachments,
        }));
        setSendQueue(queued);
        // The half-written assistant bubble is removed rather than left saying
        // nothing: the queue is what represents this turn now.
        if (initialMessages) {
          updateCurrentSession({ messages: initialMessages.slice(0, -1) });
        }
        toast(t('queue.held'), 'info', 8000);
      } else {
        addLog(`Error: ${err.message}`, 'error');
        if (initialMessages) {
          updateCurrentSession({
             messages: [...initialMessages, { role: 'assistant', content: `**Error:** ${err.message}` }]
          });
        }
      }
    } finally {
      markAnswered(startedIn, turnBegan);
      setIsGenerating(false);
      setGeneratingSessionId(null);
      /* Deliberately not awaited. The summary is for the next question, so
         making this turn wait for it would pay the cost now for a benefit
         later -- and the composer would sit disabled while it ran. */
      if (!isAutoTool) updateRunningSummary(startedIn);
      // Somewhere else when it landed: say so, and offer the way back. An
      // answer that finishes in a chat nobody is looking at is otherwise
      // silent, and leaving a long reply to read something else is now a
      // thing people can do.
      if (currentSessionIdRef.current !== startedIn) {
        const named = sessionsRef.current.find(x => x.id === startedIn);
        toast(t('chat.answerReady', { title: named?.title || '' }), 'success', 8000, {
          label: t('chat.goThere'),
          onClick: () => setCurrentSessionId(startedIn),
        });
      }
    }
  };

  // Hands-free reaches the send path through this rather than by closing over
  // it: the transcript handler was attached at mount and would otherwise be
  // calling the very first render's copy for the life of the tab.
  handleSendRef.current = handleSend;

  const stopGeneration = (e) => {
    if (e) e.preventDefault();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsGenerating(false);
    setGeneratingSessionId(null);
    addLog('User requested to stop generation.', 'info');
  };

  /**
   * Quote a message into the composer, to ask something about it.
   *
   * The follow-up question is the commonest thing anyone does with a long
   * answer -- "what did you mean by this bit" -- and until now it meant
   * selecting the passage, copying it, scrolling to the composer, pasting it
   * and typing `>` in front of every line. Or, far more often, describing the
   * passage in words and hoping the model worked out which one.
   *
   * A selection inside this message wins over the message itself: quoting the
   * paragraph you highlighted is almost always what you meant, and quoting
   * eight hundred words when you highlighted one sentence is not. The check
   * that the selection is *inside this message* matters -- a selection left
   * over from somewhere else would otherwise be quoted under this message's
   * button.
   */
  /* ---------------------------- doing something with a passage you selected
   *
   * The commonest follow-up to a long answer is about one part of it, and the
   * only way to ask was to describe that part in words and hope the model
   * worked out which one — or select it, copy it, scroll to the composer,
   * paste it, and type `>` in front of every line.
   *
   * Selecting text is already the gesture that says "this bit". A small bar
   * where the selection ends turns it into the question, and the four things
   * it offers are the four things people actually ask about a passage.
   */
  /* Every dialog keeps the keyboard inside itself and hands focus back when it
     closes. All of them were plain `<div>`s: nothing said they were dialogs,
     so a screen reader kept announcing the conversation behind the overlay;
     Tab walked out into the chat list underneath it; and closing one left the
     next Tab starting from the top of the document. */
  const settingsDialogRef = useDialog(showSettings);
  const chatInfoDialogRef = useDialog(showChatInfo);
  const personaPickerRef = useDialog(showPersonaPicker);
  const shortcutsDialogRef = useDialog(showShortcuts);
  const paletteDialogRef = useDialog(showPalette);
  const folderDialogRef = useDialog(!!folderDialog);
  const promptFillDialogRef = useDialog(!!promptFill);
  const tagDialogRef = useDialog(tagEditorFor !== null);
  const chainDialogRef = useDialog(!!chainEditor);

  /** The attachment being looked at, or null. */
  const [viewingAttachment, setViewingAttachment] = useState(null);
  const attachmentDialogRef = useDialog(!!viewingAttachment);

  /* The passage behind a citation the reader pressed, or null.
     One listener on the transcript rather than a handler per marker: the
     markers are produced by a rehype plugin as plain DOM, so there is nowhere
     to hang a React prop, and delegation is the shape that fits. */
  const [openCitation, setOpenCitation] = useState(null);
  const citationDialogRef = useDialog(!!openCitation);

  useEffect(() => {
    const onClick = (e) => {
      const mark = e.target.closest?.('.citation-mark');
      if (!mark) return;
      e.preventDefault();
      const row = mark.closest('[data-message-index]');
      const index = Number(row?.dataset.messageIndex);
      const n = Number(mark.dataset.citation);
      const passage = messagesRef.current?.[index]?.citations?.[n - 1];
      // A number with nothing behind it should never have been a button; if it
      // somehow is, do nothing rather than open an empty panel.
      if (!passage) return;
      /* A web source opens the page. The page *is* the source, and a panel
         quoting a search snippet of it would be a worse version of the thing
         one click away. A document passage has no page to open, so it opens
         the passage. */
      if (passage.url) {
        window.open(passage.url, '_blank', 'noopener,noreferrer');
        return;
      }
      setOpenCitation({ n, ...passage });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  /**
   * What an indexed document can show of itself.
   *
   * Its text is not on the attachment -- it was split into passages and put in
   * the library, which is the whole point -- so this reads them back out. The
   * first few are enough to confirm the right file was picked up and that its
   * text came out as text rather than as mojibake, which is what somebody
   * opening it actually wants to know.
   */
  /* What an indexed document can show of itself.
   *
   * By id where there is one — a chip in the composer knows which document it
   * just created — and otherwise by filename, which is all a chip recovered
   * from a sent message has. Without the fallback, opening an attachment in
   * the transcript showed "nothing to show" for exactly the files that were
   * too long to send whole, which is the opposite of useful. */
  const indexedPreview = (att) => {
    if (att?.type !== 'indexed') return '';
    const doc = knowledge.find(d => d.id === att.docId)
      || knowledge.find(d => d.name === att.name);
    if (!doc) return '';
    return doc.chunks.slice(0, 12).map(c => c.text).join('\n\n');
  };

  const [selectionBar, setSelectionBar] = useState(null);

  useEffect(() => {
    // `selectionchange` fires continuously while dragging, so the bar is
    // placed when the gesture ends rather than following the cursor.
    const settle = () => {
      const selection = window.getSelection?.();
      const text = selection ? selectionTarget(selection) : null;
      if (!text) { setSelectionBar(null); return; }

      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { setSelectionBar(null); return; }

      /* Above the selection where there is room, below it where there is not.
         A bar that is only ever placed above has to be clamped when the
         selection is near the top of the screen, and a clamped bar lands on
         top of the very words it is asking about. Flipping is the difference
         between covering the line before the passage -- which the reader has
         already read -- and covering the passage itself. */
      const BAR_HEIGHT = 44;
      const GAP = 8;
      const TOP_LIMIT = 56; // clear of the header
      const above = rect.top - BAR_HEIGHT - GAP;

      setSelectionBar({
        text,
        // Fixed coordinates, so the bar does not need to live inside the
        // scrolling transcript and be clipped by it.
        top: above >= TOP_LIMIT ? above : rect.bottom + GAP,
        left: rect.left + rect.width / 2,
      });
    };

    document.addEventListener('mouseup', settle);
    document.addEventListener('touchend', settle);
    // Clicking elsewhere collapses the selection; this is what dismisses it.
    document.addEventListener('selectionchange', () => {
      if (!(window.getSelection?.().toString() || '').trim()) setSelectionBar(null);
    });
    return () => {
      document.removeEventListener('mouseup', settle);
      document.removeEventListener('touchend', settle);
    };
  }, []);

  /** Turn the selection into a question and send it. */
  const askAboutSelection = (kind) => {
    const bar = selectionBar;
    if (!bar) return;

    setSelectionBar(null);
    window.getSelection?.().removeAllRanges();
    haptic('light');

    setInput(buildSelectionPrompt(
      bar.text,
      t(`selection.${kind}Prompt`, { language: promptLanguageName(lang) }),
    ));
    setTimeout(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
      handleSendRef.current?.();
    }, 40);
  };

  /**
   * Hand an answer to whatever else is on the phone.
   *
   * The question goes with it. A passage of prose arriving in someone's chat
   * app with no question above it is a puzzle, and the person sharing it
   * should not have to type the context back in by hand.
   */
  const shareMessage = async (index) => {
    const msg = messages[index];
    if (!msg) return;

    // The nearest question above this answer, which is the one it answers.
    let question = '';
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') { question = messages[i].content || ''; break; }
    }

    const body = shareBody({
      question,
      answer: cleanForExport(msg.content || ''),
      model: msg.model || '',
    });

    const outcome = await shareText({ title: currentSession?.title || '', text: body });
    if (outcome === 'shared') { haptic('light'); return; }
    // Dismissing the sheet is a decision, not a failure, and saying anything
    // about it would be arguing with the person who made it.
    if (outcome === 'cancelled') return;
    // No sheet, or it refused: the clipboard is the fallback that always works.
    if (await copyText(body)) haptic('light');
    else toast(t('msg.copyFailed'), 'error', 6000);
  };

  const quoteMessage = (index) => {
    const msg = messages[index];
    if (!msg) return;

    const selection = window.getSelection?.();
    const picked = (selection?.toString() || '').trim();
    const row = messageRefs.current[index];
    const insideThisMessage = picked
      && selection.anchorNode
      && row?.contains(selection.anchorNode);

    // Reasoning, tool blocks and injected context are scaffolding; quoting
    // them back at the model is quoting it things it did not say to you.
    const whole = cleanForExport(msg.content).trim();
    const source = insideThisMessage ? picked : whole;
    if (!source) return;

    // A quote is context, not the question. Past a few hundred characters it
    // stops being either -- it is the answer pasted back in, filling the
    // context window with what the model already has.
    const QUOTE_LIMIT = 600;
    const trimmed = source.length > QUOTE_LIMIT
      ? `${source.slice(0, QUOTE_LIMIT).trimEnd()}…`
      : source;

    const quoted = trimmed.split('\n').map(line => `> ${line}`).join('\n');
    setInput(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n` : '') + `${quoted}\n\n`);
    selection?.removeAllRanges();
    setOpenActionsIndex(null);
    haptic('light');
    // The textarea has to grow to fit what was just put in it, and it only
    // does that from its own input handler -- which nothing fired here.
    setTimeout(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.focus();
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
      box.setSelectionRange(box.value.length, box.value.length);
    }, 0);
  };

  const copyToClipboard = async (text, index) => {
    // Awaited, and the tick only shown if it worked. The old version called
    // `navigator.clipboard.writeText` unguarded: on a plain-HTTP address --
    // which is every device except the one serving the app -- `navigator
    // .clipboard` is undefined, so that line threw and even the tick never
    // appeared. See src/clipboard.js.
    const copied = await copyText(text);
    if (!copied) { toast(t('msg.copyFailed'), 'error', 6000); return; }
    haptic('light');
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
      onClick: () => reviseSession(sid, x => ({ ...x, messages: previous })),
    });
  };

  // ---- Chat folders ----

  const persistFolders = (next) => { setFolders(next); saveFolders(profileScope, next); };

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
    // Stamp the chats that actually moved. `removeFolder` returns the list it
    // was given for the ones it did not touch, so identity is the test.
    const now = Date.now();
    setSessions(nextSessions.map((next, i) =>
      next === sessions[i] ? next : { ...next, updatedAt: now }));
    setFolderDialog(null);
    toast(t('folders.deleted'), 'info');
  };

  // Through `reviseSession` so the move is stamped and therefore syncs: the
  // folder id lives on the chat record, and an unstamped move stays on this
  // device while every other one keeps the chat in the old folder.
  const moveSessionToFolder = (sessionId, folderId) =>
    reviseSession(sessionId, s => assignToFolder([s], sessionId, folderId)[0]);

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

  const persistPresets = (next) => { setPresets(next); savePresets(profileScope, next); };

  /**
   * Search your own history by meaning.
   *
   * Deliberately something you press rather than something that happens as you
   * type. The first run has to embed every message you have ever sent, which
   * is a round trip per batch; after that the index is cached and keyed on
   * what the text actually says, so it is only rebuilt when you have said
   * something new. See src/chatSearch.js.
   */
  const runSemanticSearch = async () => {
    const q = sessionSearchQuery.trim();
    if (!q || semanticState === 'working') return;

    setSemanticState('working');
    setSemanticProgress(null);
    try {
      const index = await buildIndex(profileScope, sessionsRef.current, {
        model: embedModel,
        onProgress: ({ done, total }) => setSemanticProgress({ done, total }),
      });
      const hits = await searchIndex(index, q, { model: embedModel, topK: 8 });
      setSemanticHits(hits);
      setSemanticState('done');
      addLog(`[search] ${hits.length} chat(s) by meaning, from ${index.entries.length} indexed messages`, 'success');
      if (hits.length === 0) toast(t('search.noneFound'), 'info', 5000);
    } catch (e) {
      setSemanticState('failed');
      addLog(`[search] semantic search failed: ${e.message}`, 'error');
      toast(t('search.failed', { error: e.message }), 'error', 7000);
    } finally {
      setSemanticProgress(null);
    }
  };

  // A new query invalidates the previous answer; leaving it would show chats
  // matching what you typed a moment ago.
  useEffect(() => {
    setSemanticHits([]);
    setSemanticState('idle');
  }, [sessionSearchQuery]);

  /* ------------------------------------------------------- share links */

  const refreshShares = useCallback(async () => {
    if (!user) { setShares([]); return; }
    try { setShares(await listShares()); } catch (e) { /* offline; the list is not urgent */ }
  }, [user]);

  // Loaded when the panel that shows them opens, rather than at boot: this is
  // a request most sessions never need.
  useEffect(() => {
    if (!showChatInfo) return;
    setShareUrls(loadShareUrls(getSetting));
    refreshShares();
  }, [showChatInfo, refreshShares]);

  const publishShare = async () => {
    if (!user) { toast(t('share.signInFirst'), 'info', 7000); return; }
    const snapshot = buildSnapshot(currentSession);
    if (snapshot.messages.length === 0) { toast(t('chat.nothingToSummarize'), 'info'); return; }
    setShareBusy(true);
    try {
      const made = await createShare({
        chatId: currentSessionId,
        title: currentSession.title,
        snapshot,
        expiresInDays: shareExpiryDays,
      });
      // Remembered before anything else can fail: this is the only moment the
      // URL exists anywhere outside the reply that just arrived.
      setShareUrls(rememberShareUrl(getSetting, setSetting, made.id, made.url));
      setJustShared(made.url);
      await copyText(made.url);
      toast(t('share.copied'), 'success');
      addLog(`[share] published "${currentSession.title}"`, 'success');
      refreshShares();
    } catch (e) {
      toast(t('share.failed', { error: e.message }), 'error', 8000);
    } finally {
      setShareBusy(false);
    }
  };

  const revokeOneShare = async (id) => {
    try {
      await revokeShare(id);
      setShareUrls(forgetShareUrl(getSetting, setSetting, id));
      setJustShared('');
      toast(t('share.revoked'), 'info');
      refreshShares();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const savePresetFromCurrent = () => {
    if (!newPresetName.trim()) return;
    persistPresets([...presets, newPreset(newPresetName, currentSamplingValues())]);
    setNewPresetName('');
    toast(t('presets.saved'), 'success');
  };

  const deletePreset = (id) => persistPresets(presets.filter(x => x.id !== id));

  /* ------------------------------------------------- saved system prompts */

  const persistPersonas = (next) => { setPersonas(next); savePersonas(profileScope, next); };

  /* Applying one writes into the live box rather than pointing at the saved
   * entry. That is what keeps a prompt editable after it has been chosen: the
   * library is a set of starting points, not a set of modes. */
  /* Applying a persona to the chat on screen: its prompt, its model and its
     sampling, all of which stay editable afterwards. The library is a set of
     starting points, not a set of modes. */
  const applyPersona = (persona) => {
    setSystemPrompt(persona.body);
    if (persona.model && models.some(m => m.name === persona.model)) setSelectedModel(persona.model);
    for (const [field, value] of Object.entries(sanitiseSampling(persona.sampling))) {
      SAMPLING_SETTERS[field]?.(value);
    }
    updateCurrentSession({ personaId: persona.id });
    // A chat holding its own override would silently ignore the prompt, which
    // reads as the button not working. Say so instead.
    if (currentSession?.systemPrompt !== undefined) toast(t('persona.chatOverrides'), 'info', 7000);
    else toast(t('persona.applied', { name: persona.name }), 'success');
  };

  /* A new conversation *with* somebody.

     The greeting is written in as an ordinary assistant message, which is
     also what promotes the draft into a real chat -- so a persona opened and
     then abandoned still leaves a row behind. That is deliberate: the
     greeting is the persona talking, and a conversation that has been talked
     in has started. */
  const startChatAsPersona = (persona) => {
    if (isNarrow) setIsSidebarOpen(false);
    const model = persona.model && models.some(m => m.name === persona.model)
      ? persona.model
      : (defaultModel && models.some(m => m.name === defaultModel) ? defaultModel : selectedModel);
    if (model) setSelectedModel(model);
    setSystemPrompt(persona.body);
    for (const [field, value] of Object.entries(sanitiseSampling(persona.sampling))) {
      SAMPLING_SETTERS[field]?.(value);
    }

    const opening = openingMessages({ ...persona, model });
    const fresh = {
      ...newDraft(model),
      title: persona.name,
      titleLocked: true,
      personaId: persona.id,
      messages: opening,
      // A greeting is something said, so this is a conversation already.
      draft: opening.length > 0 ? undefined : true,
    };
    setSessions(prev => [fresh, ...withoutStaleDrafts(prev, fresh.id)]);
    setCurrentSessionId(fresh.id);
    setAttachments([]);
    setShowPersonaPicker(false);
    addLog(`Started a chat as ${persona.name}`, 'info');
  };

  const savePersonaFromCurrent = () => {
    const name = newPersonaName.trim();
    if (!name) return;
    persistPersonas(upsertPersona(personas, name, {
      // Which row is being edited. Without it the save matched by name alone,
      // so renaming one from the Edit button left the old entry in place and
      // added a second — the rename read as a failure to save.
      ...(editingPersonaId ? { id: editingPersonaId } : {}),
      body: systemPrompt,
      avatar: newPersonaAvatar,
      greeting: newPersonaGreeting,
      // Only when asked. Everything absent means "whatever the app is
      // already set to", which is what makes a persona portable between
      // machines with different models on them.
      model: pinPersonaSetup ? selectedModel : '',
      sampling: pinPersonaSetup ? currentSamplingValues() : {},
    }));
    setNewPersonaName('');
    setNewPersonaAvatar('');
    setNewPersonaGreeting('');
    setPinPersonaSetup(false);
    setEditingPersonaId(null);
    toast(t('persona.savedAs', { name }), 'success');
  };

  /* Editing one loads it back into the boxes *and* into the live settings,
     so what is on screen is what would be saved. Loading only the name and
     prompt would make the next save silently drop its model and sampling. */
  const editPersona = (persona) => {
    setNewPersonaName(persona.name);
    setNewPersonaAvatar(persona.avatar || '');
    setNewPersonaGreeting(persona.greeting || '');
    setSystemPrompt(persona.body);
    const pinned = !!persona.model || Object.keys(persona.sampling || {}).length > 0;
    setPinPersonaSetup(pinned);
    if (persona.model && models.some(m => m.name === persona.model)) setSelectedModel(persona.model);
    for (const [field, value] of Object.entries(sanitiseSampling(persona.sampling))) {
      SAMPLING_SETTERS[field]?.(value);
    }
    setEditingPersonaId(persona.id);
  };

  const deletePersona = (id) => {
    const gone = personas.find(p => p.id === id);
    persistPersonas(removePersona(personas, id));
    toast(t('persona.deleted'), 'info', 6000, {
      label: t('common.undo'),
      onClick: () => persistPersonas(gone ? [...removePersona(personas, id), gone] : personas),
    });
  };

  /* Who this chat is with.

     By the id the chat carries, not by matching the prompt text: a chat
     belongs to a persona even after its prompt has been edited, and two
     personas that happen to share a prompt are still two people. The
     prompt match stays for the settings panel, which is answering a
     different question -- "is this text one of the saved ones". */
  const chatPersona = personaOf(personas, currentSession);
  const activePersona = matchPersona(personas, systemPrompt);

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
    toast(t('toast.messageDeleted'), 'info', 6000, {
      label: t('common.undo'),
      onClick: () => reviseSession(sid, s => ({ ...s, messages: previous })),
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
  /* Ordered by when each chat was last talked in, not by when its record last
     changed. Those were the same number until now, so filing a chat into a
     folder -- an edit, and one that must move the sync clock or never sync --
     jumped it to the top of the list. See `conversationTime`. */
  const sortedSessions = [...sessions].sort((a, b) => conversationTime(b) - conversationTime(a));
  
  const archivedCount = sessions.filter(s => s.archived).length;

  // The archive is a view, not a place: `showArchived` swaps which half of the
  // list is on screen rather than adding a section to it. A chat you are
  // reading stays visible whichever view is on, because hiding the open chat
  // out from under someone who just archived it is how you lose your place.
  /* A draft is never listed, not even while it is the chat on screen.
     That is the whole point of it: the row appears when the conversation
     starts, not when the button is pressed. */
  const visibleSessions = sortedSessions.filter(s => !isDraft(s) && (
    (showArchived ? !!s.archived : !s.archived) || s.id === currentSessionId
  ));

  /* Which chats the sidebar shows.
   *
   * Substring matching, as before -- and then, if `semanticHits` has anything,
   * the chats it found too. Substring first on purpose: typing a filename or
   * an error code should find that string, and the five conversations most
   * *like* it are the feature getting in the way rather than helping. */
  const filteredSessions = (() => {
    /* One box, two questions. `#rust deadlock` is the chats tagged rust whose
       text mentions a deadlock -- typing `#` is how people write a tag anyway,
       and a second control for it would be a second thing to find. */
    const { tags: typedTags, text: typedText } = parseTagQuery(sessionSearchQuery);
    const tagged = filterByTags(visibleSessions, [...tagFilter, ...typedTags]);

    const q = typedText.trim().toLowerCase();
    if (!q) return tagged;

    const literal = tagged.filter(s => (
      s.title.toLowerCase().includes(q)
      || s.messages.some(m => typeof m.content === 'string' && m.content.toLowerCase().includes(q))
    ));
    if (semanticHits.length === 0) return literal;

    const seen = new Set(literal.map(s => String(s.id)));
    // A semantic hit still has to satisfy the tag filter: a narrowing the
    // reader set explicitly outranks a similarity the app inferred.
    const allowed = new Set(tagged.map(s => String(s.id)));
    const extra = semanticHits
      .filter(hit => !seen.has(hit.sessionId) && allowed.has(hit.sessionId))
      .map(hit => visibleSessions.find(s => String(s.id) === hit.sessionId))
      .filter(Boolean);
    return [...literal, ...extra];
  })();

  // Folders take precedence over the date buckets: a filed chat appears in its
  // folder, and only what is left is grouped by when it was last touched.
  const { grouped: folderGroups, loose: unfiledSessions } = groupByFolder(filteredSessions, folders);

  const groupedSessions = categories.reduce((acc, cat) => { acc[cat] = []; return acc; }, {});
  
  unfiledSessions.forEach(session => {
    const category = session.pinned ? 'Pinned' : categorizeSession(conversationTime(session));
    if (groupedSessions[category]) {
      groupedSessions[category].push(session);
    } else {
      groupedSessions['Older'].push(session);
    }
  });

  // ---- Filing a chat by dragging it ----
  //
  // The row menu could already move a chat into a folder, in a submenu five
  // items down. That is fine for one chat and absurd for ten, and it is also
  // not what anyone tries first: a list of things and a list of folders beside
  // it reads as somewhere to drag to.
  //
  // A private MIME type rather than `text/plain` alone. Dropping a file, a
  // selection of text or a link onto a folder must do nothing, and the only
  // way to tell those apart from one of our rows is to look for a type nobody
  // else sets. `text/plain` is set as well, so a chat dragged out of the app
  // entirely arrives somewhere as its title instead of as nothing.
  /* ---------------------------------------------------------------- tags

     A folder is where a chat lives; a tag is what it is also about. Both go
     through `reviseSession`, which stamps the chat -- without that a tag added
     here would be silently dropped the next time the account synced, because
     the copy on the server would look newer. */

  const tagSession = (id, tag) => {
    const session = sessionsRef.current.find(x => x.id === id);
    if (!session) return;
    const next = addTag(session, tag);
    if (next.length === tagsOf(session).length) return;   // already there, or full
    reviseSession(id, s => ({ ...s, tags: next }));
  };

  const untagSession = (id, tag) => {
    const session = sessionsRef.current.find(x => x.id === id);
    if (!session) return;
    reviseSession(id, s => ({ ...s, tags: removeTag(session, tag) }));
  };

  const toggleTagFilter = (tag) => {
    const key = cleanTag(tag).toLowerCase();
    setTagFilter(prev => (prev.some(t => t.toLowerCase() === key)
      ? prev.filter(t => t.toLowerCase() !== key)
      : [...prev, cleanTag(tag)]));
  };

  // Derived from the chats rather than kept in a register, so a tag stops
  // existing when the last chat carrying it does.
  const tagVocabulary = allTags(sessions);

  const CHAT_DRAG_TYPE = 'application/x-ollama-webui-chat';
  const [draggingId, setDraggingId] = useState(null);
  // `undefined` means nothing is being hovered; `null` is a real target -- the
  // unfiled heading -- so the two cannot share a value.
  const [dropFolderId, setDropFolderId] = useState(undefined);

  const acceptsChatDrag = (e) => e.dataTransfer?.types?.includes(CHAT_DRAG_TYPE);

  const folderDropProps = (folderId) => ({
    onDragOver: (e) => {
      if (!acceptsChatDrag(e)) return;
      // Without preventDefault the browser refuses the drop, and the only
      // symptom is a cursor that never changes and a drop that never fires.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropFolderId !== folderId) setDropFolderId(folderId);
    },
    onDragLeave: (e) => {
      // Moving between a row's children fires dragleave on the parent; only a
      // pointer that has actually left the box counts.
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDropFolderId(prev => (prev === folderId ? undefined : prev));
    },
    onDrop: (e) => {
      if (!acceptsChatDrag(e)) return;
      e.preventDefault();
      setDropFolderId(undefined);
      setDraggingId(null);
      const raw = e.dataTransfer.getData(CHAT_DRAG_TYPE);
      // Ids are numbers in the list and strings on the clipboard.
      const chat = sessions.find(x => String(x.id) === raw);
      if (!chat || (chat.folderId || null) === folderId) return;
      moveSessionToFolder(chat.id, folderId);
      haptic('medium');
      toast(
        folderId
          ? t('folders.movedTo', { name: folders.find(f => f.id === folderId)?.name || '' })
          : t('folders.unfiled'),
        'success'
      );
    },
  });

  // One row, rendered from two places: inside a folder and under a date
  // heading. Keeping it in one function is what stops the two drifting apart.
  const renderSessionRow = (s) => (
    <div
      key={s.id}
      className={`history-item ${currentSessionId === s.id ? 'active' : ''} ${selectedIds.has(s.id) ? 'picked' : ''} ${draggingId === s.id ? 'dragging' : ''}`}
      // Only outside selection mode. A drag inside it would be ambiguous --
      // is it moving this chat, or all the selected ones? -- and the bulk bar
      // already offers the answer.
      draggable={!selectMode && !renamingId}
      onDragStart={(e) => {
        setDraggingId(s.id);
        // A plain-text id as well as the private type, so dropping a chat
        // somewhere that is not a folder pastes something legible rather than
        // nothing at all.
        e.dataTransfer.setData(CHAT_DRAG_TYPE, String(s.id));
        e.dataTransfer.setData('text/plain', s.title);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => { setDraggingId(null); setDropFolderId(undefined); }}
      onClick={() => {
        if (selectMode) { toggleSelected(s.id); return; }
        // Deliberately not guarded on `isGenerating`. The reply is being
        // written to the chat that asked for it, so leaving is safe -- and
        // coming back shows however much of it has arrived.
        openChat(s.id);
      }}
    >
      {selectMode && (
        <span className={`row-check ${selectedIds.has(s.id) ? 'on' : ''}`} aria-hidden="true">
          {selectedIds.has(s.id) && <Check size={11} />}
        </span>
      )}
      {generatingSessionId === s.id && (
        <RefreshCcw size={12} className="spin row-generating" aria-label={t('chat.generatingHere')} />
      )}
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
          {/* When you last spoke in it. Filing it away is not speaking in
              it, and labelling a three-week-old conversation "just now"
              because it was tidied into a folder is a small lie the sidebar
              used to tell. */}
          <span className="history-meta" title={absoluteTime(conversationTime(s), lang)}>
            {relativeTime(conversationTime(s), lang)}
          </span>
          {/* Under the title rather than beside it: a chat can carry several,
              and squeezing them onto the title line would cost the title the
              width it needs to be recognisable. */}
          {tagsOf(s).length > 0 && (
            <span className="history-tags">
              {/* Buttons, not spans with a click handler.
                  These filter the sidebar, so they are controls -- and a span
                  is not reachable by Tab, not activated by Enter, and is
                  announced as text rather than as something that does
                  anything. A button inside the row's div is legal; the row is
                  not itself a button, precisely because it already holds
                  several. */}
              {tagsOf(s).map(tag => (
                <button
                  type="button"
                  className="chat-tag"
                  key={tag}
                  title={t('tags.filterOne', { tag })}
                  onClick={(e) => { e.stopPropagation(); toggleTagFilter(tag); }}
                >
                  {tag}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="history-actions" style={selectMode ? { display: 'none' } : undefined}>
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
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); toggleArchived(s.id); }}>
              <Archive size={13} />
              <span className="cmd-label">{s.archived ? t('sidebar.unarchive') : t('sidebar.archive')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); exportSessionMarkdown(s); }}>
              <FileDown size={13} /><span className="cmd-label">{t('sidebar.exportMd')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); printSession(s); }}>
              <FileDown size={13} /><span className="cmd-label">{t('sidebar.exportPdf')}</span>
            </button>
            <button className="cmd-item" onClick={() => { setRowMenuFor(null); exportSessionHtml(s); }}>
              <Globe size={13} /><span className="cmd-label">{t('sidebar.exportHtml')}</span>
            </button>

            <button className="cmd-item" onClick={() => { setTagEditorFor(s.id); setTagDraft(''); setRowMenuFor(null); }}>
              <ListTree size={13} /><span className="cmd-label">{t('tags.edit')}</span>
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
      const freshSession = { id: nextSessionId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now(), lastModel: '' };
      // Every one of them, deliberately, so the merge does not put them back.
      for (const chat of sessionsRef.current) removedIdsRef.current.add(String(chat.id));
      setSessions([freshSession]);
      setCurrentSessionId(freshSession.id);
      // There is no undo on this one, so there is nothing to wait for either.
      persistChatsNow([freshSession]);
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

        // The end of the body is a frame boundary. The last object here is the
        // "success" status, and a body that ends without a trailing newline
        // leaves it in the buffer -- so a pull that finished showed as a bar
        // stuck at 99%.
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() || '');   // else: a partial line
        if (done && lines.length === 0) break;

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

        if (done) break;
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
    /* A chain is not a template -- there is nothing to paste into the box,
       because the box is what the chain runs *on*. Picking one arms the
       composer instead, and the strip under it says so. */
    const fromChains = chains.map(c => ({
      name: `/${slugify(c.name).toLowerCase()}`,
      desc: t('chains.stepCount', { count: c.steps.length }),
      chain: c,
    }));
    return [...SLASH_COMMANDS, ...fromLibrary, ...fromChains]
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
      { section: 'Actions', label: t('sidebar.exportPdf'), icon: <FileDown size={15} />, action: () => printSession() },
      { section: 'Actions', label: t('folders.new'), icon: <FolderPlus size={15} />, action: () => setFolderDialog({ name: '', systemPrompt: '' }) },
      { section: 'Actions', label: t('memory.extract'), icon: <Sparkles size={15} />, action: () => rememberFromChat() },
      { section: 'Actions', label: t('compact.action'), icon: <Layers size={15} />, action: () => compactConversation() },
      { section: 'Actions', label: t('data.exportJson'), icon: <Download size={15} />, action: exportSessions },
      { section: 'Actions', label: t('sidebar.rename'), icon: <Edit size={15} />, action: () => startRename(currentSession) },
      { section: 'Actions', label: currentSession?.pinned ? 'Unpin this chat' : 'Pin this chat', icon: <Pin size={15} />, action: () => togglePin(currentSessionId) },
      { section: 'Actions', label: t('sidebar.duplicate'), icon: <Copy size={15} />, action: () => duplicateSession(currentSessionId) },
      { section: 'Actions', label: `Web Fetch (MCP): turn ${mcpEnabled ? 'off' : 'on'}`, icon: <Terminal size={15} />, action: () => setMcpEnabled(v => !v) },
      { section: 'Actions', label: `Thinking: ${thinkMode} (cycle auto/on/off)`, icon: <Zap size={15} />, action: () => setThinkMode(m => m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto') },
      { section: 'Actions', label: t('profile.title'), icon: <User size={15} />, action: () => (user ? setShowProfileDialog(true) : setShowAuthScreen(true)) },
      { section: 'Appearance', label: `${t('settings.animations')}: ${motionMode}`, icon: <Zap size={15} />, action: () => setMotionMode(m => (m === 'system' ? 'full' : m === 'full' ? 'reduced' : 'system')) },
      { section: 'Actions', label: t('sysmon.title'), icon: <Activity size={15} />, action: () => { setMonitorTab('system'); setShowSystemMonitor(true); } },
      { section: 'Actions', label: t('usage.title'), icon: <Activity size={15} />, action: () => { setMonitorTab('usage'); setShowSystemMonitor(true); } },
      { section: 'Actions', label: t('studio.title'), icon: <Wand2 size={15} />, action: () => { setStudioOpened(true); setSidebarPlace('studio'); } },
      { section: 'Actions', label: t('settings.knowledge'), icon: <FileText size={15} />, action: () => openSettings('knowledge') },
      { section: 'Actions', label: t('compare.title'), icon: <Layers size={15} />, action: () => setShowCompare(true) },
      { section: 'Appearance', label: `${t('behaviour.systemStrip')}: ${showSystemStrip ? t('common.on') : t('common.off')}`, icon: <Activity size={15} />, action: () => setShowSystemStrip(v => !v) },
      { section: 'Actions', label: t('chat.info'), icon: <Info size={15} />, action: () => setShowChatInfo(true) },
      { section: 'Actions', label: starredOnly ? t('header.showAll') : t('header.starredOnly'), icon: <Star size={15} />, action: () => setStarredOnly(v => !v) },
      { section: 'Actions', label: t('header.searchInChat'), icon: <Search size={15} />, hint: 'Ctrl+F', action: () => { setSearchOpen(true); setTimeout(() => chatSearchRef.current?.focus(), 60); } },
      { section: 'Actions', label: t('settings.shortcuts'), icon: <Command size={15} />, hint: 'Ctrl+/', action: () => setShowShortcuts(true) },
      { section: 'Voice', label: voiceMode ? t('voice.stopMode') : t('voice.startMode'), icon: <Mic size={15} />, action: toggleVoiceMode },
      { section: 'Voice', label: t('msg.stopReading'), icon: <Square size={15} />, action: stopSpeaking },
      { section: 'Voice', label: `${t('voice.autoPlay')}: ${ttsAutoPlay ? t('common.off') : t('common.on')}`, icon: <Volume2 size={15} />, action: () => setTtsAutoPlay(v => !v) },
      { section: 'Voice', label: t('settings.voice'), icon: <Volume2 size={15} />, action: () => openSettings('voice') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.light')}`, icon: <Sun size={15} />, action: () => setTheme('light') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.dark')}`, icon: <Moon size={15} />, action: () => setTheme('dark') },
      { section: 'Appearance', label: `${t('header.theme')}: ${t('settings.system')}`, icon: <Monitor size={15} />, action: () => setTheme('system') },
      { section: 'Appearance', label: `Density: switch to ${chatDensity === 'compact' ? 'comfortable' : 'compact'}`, icon: <Layers size={15} />, action: () => setChatDensity(d => (d === 'compact' ? 'comfortable' : 'compact')) },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.small')}`, icon: <Layers size={15} />, action: () => setChatFontSize('small') },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.medium')}`, icon: <Layers size={15} />, action: () => setChatFontSize('medium') },
      { section: 'Appearance', label: `${t('settings.textSize')}: ${t('settings.large')}`, icon: <Layers size={15} />, action: () => setChatFontSize('large') },
      { section: 'Appearance', label: `${t('settings.contentWidth')}: ${t('settings.widthNarrow')}`, icon: <StretchHorizontal size={15} />, action: () => setContentWidth('narrow') },
      { section: 'Appearance', label: `${t('settings.contentWidth')}: ${t('settings.widthMedium')}`, icon: <StretchHorizontal size={15} />, action: () => setContentWidth('medium') },
      { section: 'Appearance', label: `${t('settings.contentWidth')}: ${t('settings.widthWide')}`, icon: <StretchHorizontal size={15} />, action: () => setContentWidth('wide') },
      { section: 'Appearance', label: t('settings.resetPanels'), icon: <PanelLeft size={15} />, action: () => { setSidebarWidth(DEFAULT_SIDEBAR_WIDTH); setArtifactWidth(DEFAULT_ARTIFACT_WIDTH); setConsoleDockHeight(DEFAULT_CONSOLE_HEIGHT); setArtifactMaximized(false); } },
      { section: 'Actions', label: t('bulk.select'), icon: <ListChecks size={15} />, action: () => { setIsSidebarOpen(true); setSelectMode(true); } },
    ];

    // Only while the browser is holding an install prompt. See the settings
    // panel for why that is not the same as "can be installed".
    if (installReady) {
      items.push({ section: 'Actions', label: t('pwa.install'), icon: <Smartphone size={15} />, action: promptInstall });
    }
    if (hapticsSupported() && isTouchUi) {
      items.push({
        section: 'Appearance',
        label: `${t('settings.haptics')}: ${hapticsOn ? t('common.on') : t('common.off')}`,
        icon: <Vibrate size={15} />,
        action: () => setHapticsOn(v => !v),
      });
    }

    // Switching the system prompt is a thing you do *between* questions, so it
    // belongs where the other between-questions switches are rather than four
    // clicks deep in Settings.
    /* Two entries per persona, because they are two different intentions:
       start a new conversation with them, or turn the conversation you are
       already having into one with them. */
    personas.forEach(p => items.push({
      section: t('persona.startSection'),
      label: `${p.avatar ? `${p.avatar} ` : ''}${p.name}`,
      icon: <Users size={15} />,
      action: () => startChatAsPersona(p),
    }));
    personas.forEach(p => items.push({
      section: t('persona.switch'),
      label: p.name,
      hint: chatPersona?.id === p.id ? t('persona.inUse') : '',
      icon: <Brain size={15} />,
      action: () => applyPersona(p),
    }));

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
        action: () => openChat(s.id),
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

  /**
   * The installed app's "New chat" shortcut.
   *
   * A manifest shortcut can only name a URL, so it names `/?new=1` and this is
   * the other half. The query string is cleared with `replaceState` rather
   * than left alone: it is an instruction that has been carried out, and a
   * reload with it still in the address bar would carry it out again --
   * silently creating a chat every time somebody refreshed.
   *
   * Guarded by a ref because the effect runs twice under StrictMode, and two
   * chats from one launch is exactly the bug this is meant to avoid.
   */
  const launchHandledRef = useRef(false);
  useEffect(() => {
    if (launchHandledRef.current) return;
    launchHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') !== '1') return;
    params.delete('new');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    createNewSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = (e.key || '').toLowerCase();
      const inField = ['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable;

      /* Stepping through the transcript by message rather than by pixel.
         `j`/`k` where nothing is being typed into, Alt+arrows anywhere -- see
         `wantsNavigation`, which is where the "not while typing" rule lives,
         because a shortcut that eats a letter inside the composer is a
         shortcut that gets removed again a week later. */
      if (wantsNavigation(e, { editing: editingMessageIndex !== null })) {
        const direction = NAV_KEYS[e.key] ?? 0;
        if (direction) {
          e.preventDefault();
          const target = step(messagesRef.current, navIndexRef.current, direction);
          if (target !== null) {
            setNavIndex(target);
            // Centred rather than merely brought on screen: a message scrolled
            // to the very bottom edge is one you then have to scroll again.
            const row = document.querySelector(`[data-message-index="${target}"]`);
            row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          return;
        }
      }

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
        // The field may be behind its button on a narrow window, and focusing
        // something that is not on screen does nothing anyone can see.
        setSearchOpen(true);
        setTimeout(() => {
          chatSearchRef.current?.focus();
          chatSearchRef.current?.select();
        }, 0);
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
        if (chainEditor) { setChainEditor(null); return; }
        if (tagEditorFor !== null) { setTagEditorFor(null); return; }
        if (showSystemMonitor) { setShowSystemMonitor(false); return; }
        if (showSettings) { setShowSettings(false); return; }
        if (activeArtifact) { setActiveArtifact(null); return; }
        // Last, because it is the least modal of them: everything above is
        // covering the screen and this is a mode the list is in.
        if (selectMode) { exitSelectMode(); return; }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPalette, showShortcuts, showSettings, showSystemMonitor, showCompare, activeArtifact, codeArtifacts, selectMode]);

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

  // No loading branch here: the session provider does not mount this tree until
  // the server has said who is signed in, so by now the answer is known and the
  // storage scope it implies is already active.
  if (showAuthScreen) {
    return (
      <AuthScreen
        onSignedIn={handleSignedIn}
        onGuest={handleGuest}
        accounts={otherAccounts}
        onUse={handleSwitchTo}
      />
    );
  }

  return (
    <div
      className={`claude-app ${activeArtifact ? 'has-artifact' : ''} ${artifactMaximized ? 'artifact-maximized' : ''}`}
      style={{ '--artifact-width': `${artifactWidth}px`, '--sidebar-width': `${sidebarWidth}px` }}
    >
      {/* Tapping the conversation behind an open drawer closes it, which is
          what every drawer on a phone does. A button so it is reachable by
          keyboard and announced, rather than a bare div. */}
      {isNarrow && isSidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label={t('sidebar.close')}
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`claude-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
        {/* Two places to be, at the top of the panel where you choose.
         *
         * The studio was a tab inside the system monitor, which is where you go
         * to look at a graph of GPU temperature — a reasonable place to *put* a
         * panel and a terrible place to *find* one. Making a picture is a thing
         * you set out to do, so it sits beside the conversations as the other
         * half of what this app is, and the chat list collapses out of the way
         * when you are in it. */}
        <div className="sidebar-places" role="tablist" aria-label={t('studio.places')}>
          {[['home', t('studio.home')], ['studio', t('studio.tab')], ['gallery', t('gallery.tab')]].map(([place, label]) => (
            <button
              key={place}
              type="button"
              role="tab"
              aria-selected={sidebarPlace === place}
              className={sidebarPlace === place ? 'is-on' : ''}
              onClick={() => {
                setSidebarPlace(place);
                if (place === 'studio') setStudioOpened(true);
                if (place !== 'home' && isNarrow) setIsSidebarOpen(false);
              }}
            >
              {place === 'home' ? <MessageSquare size={14} /> : place === 'studio' ? <Wand2 size={14} /> : <Images size={14} />}
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={createNewSession}>
            <div className="claude-logo-icon">
              <Logo size={16} />
            </div>
            <span>{t('sidebar.newChat')}</span>
            <Edit size={16} className="edit-icon" />
          </button>
          {/* Starting a chat *with somebody* is a different act from
              starting a blank one, so it is a different button rather than
              a mode of that one. */}
          <button
            className="icon-btn persona-open"
            title={t('persona.pickTitle')}
            onClick={() => setShowPersonaPicker(true)}
          >
            <Users size={16} />
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
              // Enter is what people press in a search box, and it is the
              // gesture that means "actually look" rather than "keep typing".
              onKeyDown={e => { if (e.key === 'Enter') runSemanticSearch(); }}
            />
            {/* Searching by meaning, on request.
                Substring matching happens as you type and costs nothing. This
                embeds the query and compares it against your history, which
                costs a round trip -- so it is a thing you ask for, not a thing
                that happens to you on every keystroke. */}
            {sessionSearchQuery.trim() && (
              <button
                type="button"
                className={`icon-btn sidebar-semantic ${semanticState === 'done' ? 'toggled' : ''}`}
                title={t('search.byMeaning')}
                onClick={runSemanticSearch}
                disabled={semanticState === 'working'}
              >
                {semanticState === 'working' ? <RefreshCcw size={13} className="spin" /> : <Sparkles size={13} />}
              </button>
            )}
          </div>
          {semanticState === 'working' && semanticProgress && (
            <div className="sidebar-search-note">
              {t('search.indexing', { done: semanticProgress.done, total: semanticProgress.total })}
            </div>
          )}
          {semanticState === 'done' && semanticHits.length > 0 && (
            <div className="sidebar-search-note">
              {t('search.alsoFound', { count: semanticHits.length })}
            </div>
          )}
          {/* Only once there is an archive to look at. A button that opens an
              empty view is a button that teaches people it does nothing. */}
          {(archivedCount > 0 || showArchived) && (
            <button
              className={`icon-btn bordered sidebar-select-toggle ${showArchived ? 'toggled' : ''}`}
              title={showArchived ? t('sidebar.showActive') : t('sidebar.showArchived', { count: archivedCount })}
              aria-pressed={showArchived}
              onClick={() => { setShowArchived(v => !v); haptic('light'); }}
            >
              <Archive size={15} />
            </button>
          )}
          <button
            className={`icon-btn bordered sidebar-select-toggle ${selectMode ? 'toggled' : ''}`}
            title={selectMode ? t('bulk.cancel') : t('bulk.select')}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            <ListChecks size={15} />
          </button>
        </div>

        {/* Only when there are tags. A row of controls for a feature nobody
            has used yet is a row of controls that teaches people to ignore
            that part of the screen. */}
        {tagVocabulary.length > 0 && (
          <div className="tag-filter-bar">
            {tagVocabulary.slice(0, 12).map(entry => {
              const on = tagFilter.some(t => t.toLowerCase() === entry.tag.toLowerCase());
              return (
                <button
                  type="button"
                  key={entry.tag}
                  className={`chat-tag is-filter ${on ? 'is-on' : ''}`}
                  aria-pressed={on}
                  title={t('tags.filterBy', { tag: entry.tag, count: entry.count })}
                  onClick={() => toggleTagFilter(entry.tag)}
                >
                  {entry.tag}
                  <span className="chat-tag-count">{entry.count}</span>
                </button>
              );
            })}
            {tagFilter.length > 0 && (
              <button type="button" className="tag-clear" onClick={() => setTagFilter([])}>
                {t('tags.clearFilter')}
              </button>
            )}
          </div>
        )}

        <div className="sidebar-content">
          {showArchived && (
            <div className="archive-banner">
              <Archive size={13} />
              <span>{t('sidebar.archiveBanner', { count: archivedCount })}</span>
              <button onClick={() => setShowArchived(false)}>{t('sidebar.showActive')}</button>
            </div>
          )}

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
              <div
                className={`folder-head ${dropFolderId === folder.id ? 'drop-target' : ''}`}
                onClick={() => toggleFolderCollapsed(folder.id)}
                {...folderDropProps(folder.id)}
              >
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
              {/* Dropping a filed chat here takes it out of its folder --
                  the reverse of the gesture that put it in one, in the place
                  it would land anyway. */}
              <div
                className={`recents-label ${dropFolderId === null ? 'drop-target' : ''}`}
                {...folderDropProps(null)}
              >{t(CATEGORY_KEYS[category])}</div>
              {groupedSessions[category].map(renderSessionRow)}
            </div>
          ))}
        </div>

        {/* The bulk bar takes the footer's place rather than sitting above it:
            on a phone the sidebar is the whole screen and two stacked bars at
            the bottom is one more than there is room for. */}
        {selectMode ? (
          <div className="bulk-bar">
            <div className="bulk-count">
              <button
                className="bulk-all"
                onClick={() => selectAllVisible(filteredSessions)}
              >
                {filteredSessions.length > 0 && filteredSessions.every(s => selectedIds.has(s.id))
                  ? t('bulk.none')
                  : t('bulk.all')}
              </button>
              <span>{t('bulk.count', { count: selectedIds.size })}</span>
            </div>
            <div className="bulk-actions">
              <span className="bulk-move-wrap">
                <button
                  ref={el => { rowMenuAnchors.current.__bulk = el; }}
                  className="icon-btn bordered"
                  title={t('folders.move')}
                  disabled={selectedIds.size === 0}
                  onClick={() => setBulkMoveOpen(v => !v)}
                >
                  <FolderInput size={15} />
                </button>
                <AnchoredMenu
                  open={bulkMoveOpen}
                  onClose={() => setBulkMoveOpen(false)}
                  anchorRef={{ current: rowMenuAnchors.current.__bulk }}
                  className="row-menu"
                  width={215}
                >
                  <button className="cmd-item" onClick={() => { setBulkMoveOpen(false); moveSelectedToFolder(null); }}>
                    <span className="cmd-label">{t('folders.none')}</span>
                  </button>
                  {folders.map(f => (
                    <button key={f.id} className="cmd-item" onClick={() => { setBulkMoveOpen(false); moveSelectedToFolder(f.id); }}>
                      <Folder size={13} />
                      <span className="cmd-label">{f.name}</span>
                    </button>
                  ))}
                </AnchoredMenu>
              </span>
              <button
                className="icon-btn bordered"
                title={t('bulk.export')}
                disabled={selectedIds.size === 0}
                onClick={exportSelected}
              >
                <FileDown size={15} />
              </button>
              <button
                className="icon-btn bordered danger"
                title={t('bulk.delete')}
                disabled={selectedIds.size === 0}
                onClick={deleteSelected}
              >
                <Trash2 size={15} />
              </button>
              <button className="icon-btn bordered" title={t('bulk.cancel')} onClick={exitSelectMode}>
                <X size={15} />
              </button>
            </div>
          </div>
        ) : (
        <div className="sidebar-footer">
          <div className="profile-wrap">
            <button className="settings-toggle" onClick={() => setShowProfileMenu(v => !v)}>
              <ProfileAvatar user={user || { name: t('sidebar.guest') }} size={28} />
              <span className="user-name">{user?.name || t('sidebar.guest')}</span>
              <ChevronDown size={14} className="settings-icon" />
            </button>

            <Popover open={showProfileMenu} onClose={() => setShowProfileMenu(false)} className="profile-menu">
              {user ? (
                <>
                  <div className="profile-head">
                    <div className="profile-name">{user.name}</div>
                    {user.email && <div className="profile-email">{user.email}</div>}
                    <div className="profile-provider">{user.provider}</div>
                  </div>
                  <button className="cmd-item" onClick={() => { setShowProfileMenu(false); setShowProfileDialog(true); }}>
                    <User size={15} /><span className="cmd-label">{t('profile.title')}</span>
                  </button>
                  <button className="cmd-item" onClick={() => { openSettings(); setShowProfileMenu(false); }}>
                    <Settings size={15} /><span className="cmd-label">{t('sidebar.settings')}</span>
                  </button>
                  {otherAccountItems()}
                  <button className="cmd-item" onClick={() => { setShowProfileMenu(false); handleAddAccount(); }}>
                    <UserPlus size={15} /><span className="cmd-label">{t('auth.addAccount')}</span>
                  </button>
                  <button className="cmd-item" onClick={handleSignOut}>
                    <LogOut size={15} /><span className="cmd-label">{t('auth.signOut')}</span>
                  </button>
                  <button className="cmd-item danger" onClick={handleDeleteAccount}>
                    <Trash2 size={15} /><span className="cmd-label">{t('auth.deleteAccount')}</span>
                  </button>
                </>
              ) : (
                <>
                  <div className="profile-head">
                    <div className="profile-name">{t('sidebar.guest')}</div>
                    <div className="profile-email">{t('auth.guestNote')}</div>
                  </div>
                  {otherAccountItems()}
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
        )}

        {isSidebarOpen && (
          <ResizeHandle
            label={t('sidebar.resize')}
            direction={1}
            getSize={() => sidebarWidth}
            setSize={setSidebarWidth}
            min={240}
            max={() => Math.min(560, window.innerWidth - 320)}
            onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        )}
      </div>

      {/* Main Chat Area */}
      <div className={`claude-main${messages.length === 0 ? ' is-blank' : ''}`}>
        {/* Top Navigation */}
        <div className="main-header">
          <button
            className="toggle-sidebar"
            aria-label={isSidebarOpen ? t('sidebar.close') : t('sidebar.open')}
            aria-expanded={isSidebarOpen}
            onClick={() => { setIsSidebarOpen(!isSidebarOpen); haptic('light'); }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
          </button>
          
          <div className="header-tools">
            {showSystemStrip && <SystemStrip onOpen={() => setShowSystemMonitor(true)} inHeader />}

            {/* The button that reaches the field below. Only a phone shows it;
                on a wide screen the field is already on the row. */}
            <button
              className={`icon-btn bordered header-compact-only ${searchOpen ? 'toggled' : ''}`}
              title={t('header.searchInChat')}
              aria-expanded={searchOpen}
              onClick={() => {
                const next = !searchOpen;
                setSearchOpen(next);
                if (next) setTimeout(() => chatSearchRef.current?.focus(), 60);
                else setChatSearchQuery('');
              }}
            >
              <Search size={16} />
            </button>

            <div className={`sidebar-search-inner header-search ${searchOpen ? 'is-open' : ''}`}>
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
                  if (e.key === 'Escape') { e.preventDefault(); setChatSearchQuery(''); setSearchOpen(false); }
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
                  <button title={t('header.clearSearch')} onClick={() => { setChatSearchQuery(''); setSearchOpen(false); }}>
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>

            <button
              className={`icon-btn bordered header-secondary ${starredOnly ? 'toggled' : ''}`}
              title={starredOnly ? t('header.showAll') : t('header.starredOnly')}
              onClick={() => setStarredOnly(v => !v)}
            >
              <Star size={16} fill={starredOnly ? 'currentColor' : 'none'} />
            </button>

            <div className="outline-wrap header-secondary">
              <button
                className={`icon-btn bordered header-secondary ${showOutline ? 'toggled' : ''}`}
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
              className={`icon-btn bordered header-secondary ${showSystemMonitor && monitorTab !== 'studio' ? 'toggled' : ''}`}
              title={t('sysmon.title')}
              onClick={() => {
                if (showSystemMonitor && monitorTab !== 'studio') { setShowSystemMonitor(false); return; }
                setMonitorTab('system');
                setShowSystemMonitor(true);
              }}
            >
              <Activity size={16} />
            </button>

            {/* Generating a picture is a thing people come to the app to do
                rather than a setting they occasionally check, so it gets its own
                way in rather than living three clicks inside the monitor. */}
            <button
              className={`icon-btn bordered ${sidebarPlace === 'studio' ? 'toggled' : ''}`}
              title={t('studio.title')}
              onClick={() => {
                if (sidebarPlace !== 'studio') setStudioOpened(true);
                setSidebarPlace(sidebarPlace === 'studio' ? 'home' : 'studio');
              }}
            >
              <Wand2 size={16} />
            </button>

            <button
              className="icon-btn bordered header-secondary"
              title={t('header.chatInfo')}
              onClick={() => setShowChatInfo(true)}
            >
              <Info size={16} />
            </button>

            {/* `header-secondary`, because there are two of these now. The one
                on the composer row is the one that matters -- it sits beside
                the send button, where the decision is actually made, and it
                carries the thinking effort with it. This one is still useful on
                a wide window, where the title bar has room to say what is
                selected without being asked; on a phone it is the same control
                twice on a screen with room for neither. */}
            <div className="model-selector-container header-secondary" ref={dropdownRef}>
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
                      onClick={() => { modelPickedByHand(m.name); setIsModelDropdownOpen(false); }}
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
            <div className="model-selector-container header-secondary" ref={visionDropdownRef}>
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
              className="icon-btn bordered header-secondary"
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
              className="icon-btn bordered header-secondary"
              title={t('header.exportChat')}
              onClick={() => exportSessionMarkdown()}
              disabled={messages.length === 0}
            >
              <FileDown size={16} />
            </button>

            <button
              className="icon-btn bordered header-secondary"
              title={`${t('header.theme')}: ${theme}`}
              onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
            >
              {theme === 'light' ? <Sun size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Monitor size={16} />}
            </button>
          </div>
        </div>

        {/* Chat Messages */}
        {/* A hairline under the header rather than a bar of its own: it is
            orientation, not a control, and it must not cost a row of the
            screen on a phone. Zero-width and transparent at the top of a
            chat, so an unscrolled conversation shows nothing at all. */}
        <div
          className="read-progress"
          role="presentation"
          style={{ transform: `scaleX(${scrollProgress})` }}
        />

        {/* The passage a citation points at.
            The whole value of a citation is that checking it is cheap. Before
            this, `[2]` was a number: to see whether the claim was really in
            the document you had to open the collapsed reasoning block and
            count paragraphs. */}
        {openCitation && (
          <div className="attachment-viewer" onClick={() => setOpenCitation(null)}>
            <div className="attachment-viewer-box" role="dialog" aria-modal="true"
              aria-label={openCitation ? `[${openCitation.n}] ${openCitation.docName}` : ''} ref={citationDialogRef}
              onClick={e => e.stopPropagation()}>
              <div className="attachment-viewer-head">
                <span className="attachment-viewer-name">
                  [{openCitation.n}] {openCitation.docName}
                  {openCitation.page > 1 ? `, p.${openCitation.page}` : ''}
                </span>
                <span className="attachment-viewer-meta">
                  {t('rag.relevance', { score: openCitation.score.toFixed(2) })}
                </span>
                <button
                  className="icon-btn"
                  title={t('common.copy')}
                  onClick={async () => {
                    if (await copyText(openCitation.text)) haptic('light');
                    else toast(t('msg.copyFailed'), 'error', 6000);
                  }}
                >
                  <Copy size={16} />
                </button>
                <button className="icon-btn" title={t('common.close')} onClick={() => setOpenCitation(null)}>
                  <X size={18} />
                </button>
              </div>
              <div className="attachment-viewer-body"><pre>{openCitation.text}</pre></div>
            </div>
          </div>
        )}

        {/* Looking at what you attached, before you send it.
            An image opens big enough to read; a document opens as its text.
            An indexed document has no text here on purpose -- it was split
            into passages and the passages are what the model will see -- so it
            says so and shows the first of them rather than pretending. */}
        {paintTarget && (
          <MaskEditor picture={paintTarget} t={t} onCancel={() => setPaintTarget(null)} onSubmit={submitPaint} />
        )}
        {tagSheet && (
          <PictureTags
            state={tagSheet}
            t={t}
            onClose={() => setTagSheet(null)}
            onCopy={(text) => copyText(text)}
            onUse={(tags) => {
              setTagSheet(null);
              setInput(prev => (prev.trim() ? `${prev.trimEnd()}\n${tags}` : tags));
              setTimeout(() => textareaRef.current?.focus(), 30);
            }}
          />
        )}
        {viewingAttachment && (
          <div className="attachment-viewer" onClick={() => setViewingAttachment(null)}>
            <div className="attachment-viewer-box" role="dialog" aria-modal="true"
              aria-label={viewingAttachment?.name || ''} ref={attachmentDialogRef}
              onClick={e => e.stopPropagation()}>
              <div className="attachment-viewer-head">
                <span className="attachment-viewer-name">{viewingAttachment.name}</span>
                <span className="attachment-viewer-meta">
                  {viewingAttachment.type === 'indexed'
                    ? t('attach.indexedTag', { pieces: viewingAttachment.pieces })
                    : viewingAttachment.type === 'image'
                      ? t('attach.image')
                      : viewingAttachment.type === 'video'
                        ? t('attach.video')
                        : t('attach.chars', { count: (viewingAttachment.data || '').length.toLocaleString() })}
                </span>
                {viewingAttachment.type === 'video' && (
                  <button
                    className="icon-btn"
                    title={t('picture.download')}
                    onClick={() => downloadPicture({ full: viewingAttachment.preview, filename: viewingAttachment.name })}
                  >
                    <Download size={16} />
                  </button>
                )}
                {viewingAttachment.type !== 'image' && viewingAttachment.type !== 'video' && (
                  <button
                    className="icon-btn"
                    title={t('common.copy')}
                    onClick={async () => {
                      const body = viewingAttachment.data || indexedPreview(viewingAttachment) || '';
                      if (await copyText(body)) haptic('light');
                      else toast(t('msg.copyFailed'), 'error', 6000);
                    }}
                  >
                    <Copy size={16} />
                  </button>
                )}
                <button className="icon-btn" title={t('common.close')} onClick={() => setViewingAttachment(null)}>
                  <X size={18} />
                </button>
              </div>
              <div className="attachment-viewer-body">
                {viewingAttachment.type === 'image' ? (
                  <img src={viewingAttachment.preview || viewingAttachment.data} alt={viewingAttachment.name} />
                ) : viewingAttachment.type === 'video' ? (
                  <video src={viewingAttachment.preview} controls autoPlay loop playsInline className="attachment-viewer-video" />
                ) : (
                  <pre>{viewingAttachment.data || indexedPreview(viewingAttachment) || t('attach.nothingToShow')}</pre>
                )}
              </div>
            </div>
          </div>
        )}

        {/* The bar that appears where a selection ends. Fixed-positioned and
            rendered outside the transcript so the scroller cannot clip it.
            Above the passage where there is room and below it where there is
            not -- see where `top` is worked out. */}
        {selectionBar && (
          <div
            className="selection-bar"
            /* `top` is already the final position: whether the bar goes above
               the passage or below it was decided where the selection was
               measured, because that is the only place both of its edges are
               known. Offsetting again here is what put it back on the words. */
            style={{ top: `${selectionBar.top}px`, left: `${selectionBar.left}px` }}
            /* Keep the selection alive: losing it on mousedown would leave
               nothing for the button to act on by the time it fires. */
            onMouseDown={(e) => e.preventDefault()}
          >
            {SELECTION_ACTIONS.map(kind => {
              const Icon = { explain: HelpCircle, expand: Maximize2, simplify: Baby, translate: Languages }[kind];
              return (
                <button key={kind} type="button" onClick={() => askAboutSelection(kind)} title={t(`selection.${kind}`)}>
                  <Icon size={13} />
                  <span>{t(`selection.${kind}`)}</span>
                </button>
              );
            })}
            <span className="selection-bar-sep" />
            <button
              type="button"
              title={t('common.copy')}
              onClick={async () => {
                await copyText(selectionBar.text);
                setSelectionBar(null);
                haptic('light');
              }}
            >
              <Copy size={13} />
            </button>
          </div>
        )}

        {/* `onWheel` and `onTouchMove` are what let a reader out of a
            streaming reply. They say "this scroll is mine" before the position
            has moved far enough for the scroll handler to work it out on its
            own -- which, while an answer is arriving, it never quite does.
            Coming back is left to the scroll handler: reaching the bottom
            resumes following, whether the reader got there by flicking or by
            pressing the jump-to-latest button. */}
        {/* The studio, over the conversation rather than instead of it.
         *
         * Laid on top of the chat body below the header, which keeps the chat's
         * own state — the half-written message, the scroll position, the reply
         * still streaming into it — exactly as it was. Switching back to Home
         * is then genuinely free, and a generation started here does not cost
         * you the sentence you were in the middle of. */}
        {/* Mounted once opened, then hidden rather than removed.
         *
         * Unmounting it took the gallery with it: a generation still running in
         * ComfyUI kept running, but the card tracking it was gone, its poller
         * was cleared and its progress stream was closed — so switching to a
         * chat for ten seconds lost the picture being made, and switching back
         * showed an empty Studio while the GPU was still working.
         *
         * `hidden` rather than `display: none` in a class, because that is the
         * one way of hiding an element that also takes it out of the tab order
         * and out of the accessibility tree.
         *
         * Still lazy: `studioOpened` stays false until the tab is used, so an
         * install whose owner never makes a picture never mounts the panel and
         * never asks ComfyUI anything. */}
        {/* Every picture made, from every chat and the Studio. Mounted only
            while it is open: it reads every session, and holding that open
            behind the chat for nothing is memory a phone does not have. */}
        {sidebarPlace === 'gallery' && (
          <div className="studio-place gallery-place">
            <PictureGallery
              sessions={sessions}
              studioJobs={loadStudioHistory(profileScope)}
              thumbOf={thumbOf}
              t={t}
              /* A film opens and plays in the same viewer a picture does. It
                 used to be handed to the download instead, which is not what
                 pressing on something in a gallery means. */
              onOpen={(item) => setViewingAttachment({
                name: item.filename || item.prompt,
                type: item.video ? 'video' : 'image',
                preview: item.full,
                data: !item.video && String(item.full || '').startsWith('data:') ? String(item.full).split(',')[1] : '',
              })}
              onGoTo={(item) => {
                setCurrentSessionId(item.sessionId);
                setSidebarPlace('home');
                setTimeout(() => messageRefs.current[item.index]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
              }}
              onAttach={(item) => { attachPicture(item); setSidebarPlace('home'); }}
              onDownload={downloadPicture}
            />
          </div>
        )}
        {studioOpened && (
          <div className="studio-place" hidden={sidebarPlace !== 'studio'}>
            <StudioPanel
              scope={profileScope}
              onAttachToChat={(job) => {
                attachGeneratedImage(job);
                setSidebarPlace('home');
              }}
            />
          </div>
        )}

        <div
          className="messages-scroll-area"
          ref={scrollAreaRef}
          onScroll={handleScroll}
          onWheel={releaseTail}
          onTouchMove={releaseTail}
        >
          {messages.length === 0 ? (
            /* Greeting only. The starters used to sit here, above the
               composer, which put the thing you type into below the
               suggestions for what to type. They are rendered under the
               composer now, and the two are centred together as one
               group -- see `.claude-main.is-blank`. */
            <div className="empty-state">
              <div className="empty-logo">
                <Logo size={44} />
              </div>
              <h1>{t(greetingKey())}</h1>
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
                  className={`message-row ${msg.role} ${msg.starred ? 'starred' : ''} ${searchHits[searchHitIndex] === i ? 'search-current' : ''} ${openActionsIndex === i ? 'actions-open' : ''} ${navIndex === i ? 'nav-focus' : ''}`}
                  // How the keyboard finds a row to scroll to. An index rather
                  // than a ref array: rows come and go as the transcript grows
                  // and a ref array would have to be kept in step with it.
                  data-message-index={i}
                  onClick={isTouchUi ? (e => toggleMessageActions(e, i)) : undefined}
                >
                  {/* Whose answer this is. Two chats with two personas should
                      not look like the same assistant twice. */}
                  {msg.role === 'assistant' && (
                    <div className="message-avatar assistant-avatar" title={chatPersona?.name || undefined}>
                      {chatPersona?.avatar
                        ? <span className="persona-avatar-glyph">{chatPersona.avatar}</span>
                        : <Sparkles size={16} />}
                    </div>
                  )}
                  
                  <div className="message-content">
                    {msg.role === 'assistant' ? (
                      <>
                        {(() => {
                          const allBlocks = [];
                          const streamingNow = isThisChatGenerating && i + group.length - 1 >= messages.length - 1;
                          group.forEach((gMsg, n) => {
                            if (gMsg.role === 'user' && gMsg.content.trim().startsWith('<TOOL_RESULT>')) {
                              const match = gMsg.content.match(/<TOOL_RESULT>([\s\S]*?)<\/TOOL_RESULT>/i);
                              if (match) {
                                allBlocks.push({ type: 'tool_result', content: match[1] });
                              }
                            } else {
                              allBlocks.push(...parseAssistantMessage(gMsg.content, {
                                // Only the message still arriving can hold a half-written call.
                                streaming: streamingNow && n === group.length - 1,
                              }));
                            }
                          });
                          const drewInGroup = group.some(g => (g.generated || []).length > 0);

                          const internalBlocks = allBlocks.filter(b => b.type !== 'text');
                          const textBlocks = allBlocks.filter(b => b.type === 'text');
                          const isFetching = group[group.length - 1].isMcpFetching;
                          const isThinkingOnly = group[group.length - 1].content === '' && !isFetching;
                          const isThinkingIncomplete = internalBlocks.some(b => b.type === 'think' && !b.isComplete);
                          const shouldOpenDropdown = isFetching || isThinkingOnly || isThinkingIncomplete;
                          // Auto-open while the model is still thinking, but an
                          // explicit click always wins from then on.
                          const thinkIsOpen = thinkOverrides[i] !== undefined ? thinkOverrides[i] : shouldOpenDropdown;
                          const isStreamingRow = streamingNow;

                          return (
                            <>
                              {/* Above the answer, because while the run is going
                                  there is no answer -- and afterwards the steps
                                  are what makes the citations checkable. */}
                              {msg.research && <ResearchTrace research={msg.research} />}
                              {msg.chainRun && <ChainTrace run={msg.chainRun} />}

                              {/* A picture being drawn for this answer.
                                  It blocks the turn -- the answer is not ready
                                  until the picture is -- so without this the
                                  whole two minutes is three dots that mean
                                  "thinking", which is what they also mean when
                                  the GPU has fallen over. */}
                              {isStreamingRow && drawing && (
                                <JobProgress
                                  // A card per job, so a batch's next picture
                                  // starts with its own clock and frame.
                                  key={drawing.id}
                                  snapshot={drawingLive}
                                  jobId={drawing.id}
                                  queuedAhead={drawing.ahead || 0}
                                  t={t}
                                  compact
                                  kind={drawing.kind || (drawing.video ? 'video' : 'image')}
                                  prompt={drawing.prompt}
                                  aspect={drawing.aspect}
                                  source={drawing.source}
                                  batch={drawing.batch}
                                  veil={shouldVeil(promptSignal(drawing.prompt), safeLevel)}
                                />
                              )}

                              {isStreamingRow && !drawing && textBlocks.length === 0 && !isFetching && !isThinkingOnly && !msg.research && !msg.chainRun && (
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
                                        // Everything that ends in a picture, which is also
                                        // what "answered by the picture on the message" means.
                                        const isDrawing = DRAWING_TAGS.has(part.tool);
                                        // For an edit, which part of the picture it was
                                        // allowed to touch; the prompt is shown below.
                                        const target = isSearch
                                          ? (part.content || part.query || '').trim()
                                          : isDrawing
                                            ? (part.attrs?.region || '')
                                            : (part.path || part.query || '');
                                        /* Did it run? A call is answered by a result after it, or,
                                           for a drawing that ended the turn, by the picture on the
                                           message. A finished answer with neither is a call that was
                                           never carried out -- refused, over budget, or a tool the
                                           turn no longer offered -- and says so the way a failed
                                           tool does, rather than looking like it worked. */
                                        const answered = internalBlocks.slice(idx + 1).some(b => b.type === 'tool_result')
                                          || (isDrawing && drewInGroup);
                                        const notRun = !answered && !isStreamingRow && !part.pending;
                                        return (
                                          <div key={`tc-${idx}`} className={`tool-block${part.pending ? ' is-pending' : ''}`}>
                                            <div className="tool-block-head">
                                              {isSearch ? <Search size={13} />
                                              : isDrawing ? <Wand2 size={13} />
                                                : <Terminal size={13} />}
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
                                                {/* The drawing tools were missing from this list, so a
                                                    request to draw rendered as an unnamed box with the
                                                    prompt in monospace under it. */}
                                                {part.tool === 'TOOL_GENERATE_IMAGE' && t('tool.drawImage')}
                                                {part.tool === 'TOOL_GENERATE_VIDEO' && t('tool.drawVideo')}
                                                {part.tool === 'TOOL_REMOVE_BACKGROUND' && t('picture.rmbg')}
                                                {part.tool === 'TOOL_UPSCALE_IMAGE' && t('picture.upscale')}
                                                {part.tool === 'TOOL_EXTEND_IMAGE' && t('picture.extend')}
                                              </span>
                                              {target && <code className="tool-block-target">{target}</code>}
                                            </div>
                                            {/* The prompt is prose somebody wrote, not output: it reads
                                                as a sentence and should be set as one. */}
                                            {part.content && !isSearch && (
                                              isDrawing
                                                ? <p className="tool-block-prompt">{part.content}</p>
                                                : <pre className="tool-block-body">{part.content}</pre>
                                            )}
                                            {notRun && (
                                              <div className="tool-receipt is-failed">
                                                <div className="tool-receipt-head">
                                                  <TriangleAlert size={12} />
                                                  <span className="tool-receipt-verb">{t('tool.notRun')}</span>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      } else if (part.type === 'tool_result') {
                                        const search = parseSearchResults(part.content);

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

                                        /* A receipt, not a transcript.
                                         *
                                         * What a tool returns is addressed to
                                         * the model — "do not describe it",
                                         * "you have 9 tool calls left" — and
                                         * all of it used to go on screen in a
                                         * monospace box. See `toolResults.js`:
                                         * the instructions are stripped, each
                                         * tool gets a line saying what it did,
                                         * and a body only where the body is
                                         * information rather than housekeeping. */
                                        const entries = parseToolResults(part.content);
                                        if (entries.length === 0) return null;

                                        return (
                                          <div key={`tr-${idx}`} className="tool-receipts">
                                            {entries.map((entry, n) => (
                                              <div
                                                key={`${entry.name}-${n}`}
                                                className={`tool-receipt ${entry.failed ? 'is-failed' : ''}`}
                                              >
                                                <div className="tool-receipt-head">
                                                  {entry.failed
                                                    ? <TriangleAlert size={12} />
                                                    : <ToolVerbIcon name={entry.name} />}
                                                  <span className="tool-receipt-verb">
                                                    {entry.failed ? t('tool.failed') : t(verbKey(entry.name))}
                                                  </span>
                                                </div>
                                                {showsBody(entry) && (
                                                  <pre className="tool-receipt-body">{entry.body}</pre>
                                                )}
                                              </div>
                                            ))}
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
                                      /* Citations are per message, so the
                                         plugin has to be built per message
                                         rather than shared -- the shared list
                                         above knows nothing about which
                                         passages this answer was given. */
                                      (msg.citations?.length
                                        ? [...(isStreamingRow && idx === textBlocks.length - 1
                                            ? streamingRehypePlugins : markdownRehypePlugins),
                                           createCitationLinker(msg.citations.length, msg.citations.map(c => (c.url ? 'url' : 'passage')))]
                                        : (isStreamingRow && idx === textBlocks.length - 1
                                            ? streamingRehypePlugins : markdownRehypePlugins))
                                    }
                                    components={{
                                      // `pre`, not `code`: a fence is the only
                                      // thing that arrives as a <pre>, so this
                                      // cannot be handed a word from the
                                      // middle of a sentence. Inline code is
                                      // left to render as plain <code>.
                                      pre: (props) => <MarkdownCodeBlock {...props} onOpenArtifact={handleOpenArtifact} />,
                                      /* A link in an answer opens a new tab.
                                         Without this it replaces the app, and
                                         a model is very often still writing
                                         when somebody follows a source it just
                                         cited -- so the cost of a click was
                                         the rest of the answer. `noopener` as
                                         well, because the page being opened is
                                         one a search engine chose. */
                                      a: ({ node, ...props }) => (
                                        <a {...props} target="_blank" rel="noopener noreferrer" />
                                      ),
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
                            {/* Only where there is a previous answer to
                                compare against: on the first variant the
                                button would be a button that does nothing. */}
                            {variantIndexOf(group[group.length - 1]) > 0 && (
                              <button
                                className={`variant-btn ${diffFor === i ? 'is-on' : ''}`}
                                onClick={() => setDiffFor(diffFor === i ? null : i)}
                                title={diffFor === i ? t('diff.hide') : t('diff.show')}
                              >
                                <TextQuote size={12} />
                              </button>
                            )}
                            <button className="variant-btn" onClick={() => dropVariant(i)} title={t('variants.drop')}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}

                        {/* What the model drew.
                            Under the text rather than inside it: the picture is
                            the answer, and threading it into the markdown would
                            mean a model that has to place it correctly as well
                            as describe it. Full width, because a generated
                            image shown at thumbnail size is one nobody can
                            judge — which is the only thing anyone does with a
                            picture they asked for. */}
                        {(msg.generated || []).length > 0 && (
                          <div className="msg-generated">
                            {msg.generated.map((picture, n) => (
                              <figure key={picture.filename || n}>
                                {/* A film plays where a picture would open. */}
                                <SafePicture src={picture.dataUrl} prompt={picture.prompt} t={t}>
                                {picture.video ? (
                                  <video src={picture.dataUrl} controls loop playsInline />
                                ) : (
                                <button
                                  type="button"
                                  onClick={() => setViewingAttachment({
                                    name: picture.filename || picture.prompt,
                                    type: 'image',
                                    preview: picture.dataUrl,
                                    data: String(picture.dataUrl || '').split(',')[1],
                                  })}
                                  title={t('attach.open')}
                                >
                                  <img src={picture.dataUrl} alt={picture.prompt || ''} loading="lazy" />
                                </button>
                                )}
                                </SafePicture>
                                {/* The prompt it was actually drawn from, which
                                    is not the sentence the reader typed and is
                                    the only way to tell a good result from a
                                    lucky one. */}
                                <figcaption title={picture.prompt}>{picture.prompt}</figcaption>
                                {/* What can be done with it from here, without
                                    having to find the words for it. */}
                                <div className="picture-actions">
                                  {!picture.video && (
                                    <>
                                      <button type="button" onClick={() => pictureAction('redraw', picture)}
                                        disabled={isGenerating || !picture.prompt} title={t('picture.redraw')}>
                                        <RefreshCcw size={13} /><span>{t('picture.redraw')}</span>
                                      </button>
                                      <button type="button" onClick={() => pictureAction('paint', picture)}
                                        disabled={isGenerating} title={t('picture.paint')}>
                                        <Brush size={13} /><span>{t('picture.paint')}</span>
                                      </button>
                                      <button type="button" onClick={() => pictureAction('rmbg', picture)}
                                        disabled={isGenerating} title={t('picture.rmbg')}>
                                        <Scissors size={13} /><span>{t('picture.rmbg')}</span>
                                      </button>
                                      <button type="button" onClick={() => pictureAction('upscale', picture)}
                                        disabled={isGenerating} title={t('picture.upscale')}>
                                        <Maximize2 size={13} /><span>{t('picture.upscale')}</span>
                                      </button>
                                      <button type="button" onClick={() => pictureAction('tags', picture)}
                                        title={t('picture.tags')}>
                                        <Tags size={13} /><span>{t('picture.tags')}</span>
                                      </button>
                                    </>
                                  )}
                                  {/* What it was made with. See PictureSettings. */}
                                  <button
                                    type="button"
                                    className={shownSettings[`${i}:${n}`] ? 'is-on' : ''}
                                    aria-expanded={!!shownSettings[`${i}:${n}`]}
                                    onClick={() => setShownSettings(open => ({ ...open, [`${i}:${n}`]: !open[`${i}:${n}`] }))}
                                    title={t('picset.title')}
                                  >
                                    <SlidersHorizontal size={13} /><span>{t('picset.title')}</span>
                                  </button>
                                  <button type="button" onClick={() => pictureAction('download', picture)} title={t('picture.download')}>
                                    <Download size={13} /><span>{t('picture.download')}</span>
                                  </button>
                                </div>
                                {shownSettings[`${i}:${n}`] && <PictureSettings picture={picture} t={t} />}
                              </figure>
                            ))}
                          </div>
                        )}

                        {msg.verification && <VerifyPanel verification={msg.verification} />}

                        {diffFor === i && variantIndexOf(group[group.length - 1]) > 0 && (() => {
                          const held = group[group.length - 1];
                          const list = variantsOf(held);
                          const now = variantIndexOf(held);
                          return (
                            <VariantDiff
                              before={list[now - 1]?.content || ''}
                              after={list[now]?.content || ''}
                              onClose={() => setDiffFor(null)}
                            />
                          );
                        })()}

                        {truncatedIndex === i && !isThisChatGenerating && (
                          <button className="continue-btn" onClick={() => continueResponse(i)}>
                            <CornerDownRight size={14} />
                            <span>{t('continue.action')}</span>
                            <span className="continue-hint">{t('continue.hint')}</span>
                          </button>
                        )}

                        {/* The whole turn, not its last leg. A group is a run
                            of bubbles, and a turn that called a tool ends on
                            a tool result with no timings at all -- so this
                            used to read the numbers, then blank them a
                            tenth of a second later. See src/turnMetrics.js. */}
                        {(() => {
                          const spent = turnMetrics(group);
                          if (!spent) return null;
                          const answer = group[group.length - 1];
                          return (
                            <div className="claude-metrics">
                              {/* Measurements on one line, explanations on
                                  another, and the explanations quieter.

                                  They had all been one row of nine chips of
                                  equal weight, which wrapped to two lines on a
                                  desktop and *seven* on a phone -- and the two
                                  loudest were the two that are not numbers.
                                  What was taken out of the prompt is a
                                  footnote about the timings; it is not itself
                                  a timing. */}
                              <div className="metrics-numbers">
                              {/* `~` where this machine's clock supplied the
                                  figure because the server did not. The numbers
                                  used to vanish entirely in that case, which
                                  read as the app losing them. */}
                              <span title={[
                                spent.legs > 1 ? t('msg.turnLegs', { legs: spent.legs }) : '',
                                spent.estimated ? t('msg.metricsEstimated') : '',
                              ].filter(Boolean).join(' ') || undefined}>
                                {spent.estimated ? '~' : ''}{spent.totalTime}s{spent.legs > 1 ? ` ×${spent.legs}` : ''}
                              </span>
                              {spent.tokensPerSec && (
                                <>
                                  <span className="dot">•</span>
                                  <span title={spent.estimated ? t('msg.metricsEstimated') : undefined}>
                                    {spent.estimated ? '~' : ''}{spent.tokensPerSec} tokens/s
                                  </span>
                                </>
                              )}
                              {/* Shown whenever either half is known. Gating on
                                  the prompt size alone hid the answer's own
                                  token count with it, and a server that reports
                                  one but not the other is the common case. */}
                              {(spent.promptTokens != null || spent.evalCount > 0) && (
                                <>
                                  <span className="dot">•</span>
                                  <span title={t('msg.promptTokens')}>
                                    {spent.promptTokens != null
                                      ? `${spent.promptTokens.toLocaleString()} + `
                                      : ''}
                                    {spent.estimated ? '~' : ''}{(spent.evalCount || 0).toLocaleString()} tok
                                  </span>
                                </>
                              )}
                              </div>

                              {/* Why the numbers above look the way they do.
                                  A second line rather than more chips on the
                                  first: these are sentences, and a sentence
                                  wedged between two figures is what turned
                                  this row into seven lines on a phone. */}
                              {(answer.routedBy || answer.memoryNote) && (
                                <div className="metrics-why">
                                  {answer.routedBy && (
                                    <span title={t('routing.routedHelp')}>
                                      {answer.routedBy.forced
                                        ? t('routing.forced', { model: answer.routedBy.model })
                                        : t('routing.routed', {
                                          model: answer.routedBy.model,
                                          when: t(`routing.when.${answer.routedBy.when}`),
                                        })}
                                    </span>
                                  )}
                                  {answer.memoryNote && (
                                    <span title={t('convmem.noteHelp', {
                                      whole: answer.memoryNote.whole.toLocaleString(),
                                      kept: answer.memoryNote.kept,
                                    })}>
                                      {t('convmem.compressed', {
                                        dropped: answer.memoryNote.dropped,
                                        saved: answer.memoryNote.saved.toLocaleString(),
                                      })}
                                      {answer.memoryNote.recalled > 0 && ` · ${t('convmem.recalled', {
                                        count: answer.memoryNote.recalled,
                                        how: t(`convmem.${answer.memoryNote.how}`),
                                      })}`}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
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
                          {/* A painted edit: the words are below, the marked
                              area is what they apply to. */}
                          {msg.paint?.mask && (
                            <button
                              type="button"
                              className="user-paint-chip"
                              onClick={() => setViewingAttachment({ name: t('picture.paintedArea'), type: 'image', preview: msg.paint.mask, data: String(msg.paint.mask).split(',')[1] })}
                              title={t('picture.paintedArea')}
                            >
                              <Brush size={12} /> {t('picture.paintedArea')}
                            </button>
                          )}
                          {/* Openable after sending, not only before.
                              The thumbnail is 200x150 and cropped to fill, so
                              a screenshot of a terminal is unreadable in the
                              transcript -- and the moment you most want to
                              check what you sent is while reading the answer
                              about it. Same viewer the composer uses. */}
                          {msg.images && (
                            <div className="user-attachments-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              {msg.images.map((img, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  className="attachment-open"
                                  title={t('attach.open')}
                                  onClick={() => setViewingAttachment({
                                    type: 'image',
                                    name: `${t('attach.image')} ${idx + 1}`,
                                    preview: `data:image/jpeg;base64,${img}`,
                                  })}
                                >
                                  <img src={`data:image/jpeg;base64,${img}`} alt={t('attach.image')} style={{maxWidth: '200px', maxHeight: '150px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border-color)'}} />
                                </button>
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
                                    {/* One card for every kind. A file too long
                                        to send whole was indexed instead, and
                                        that is a fact about where its text is
                                        kept, not about what the reader
                                        attached -- it used to leave the
                                        sentence "[Attached document: … has
                                        been indexed …]" sitting in the message
                                        while every other file got a chip. What
                                        differs goes in the tooltip. */}
                                    {attachments.map((att, aIdx) => {
                                      // A fetched page has nothing stored to
                                      // show; the other two kinds do -- the
                                      // file's own text, or the passages the
                                      // library holds for an indexed one.
                                      const canOpen = att.type !== 'url';
                                      return (
                                        <button
                                          key={aIdx}
                                          type="button"
                                          className="user-attachment-card"
                                          disabled={!canOpen}
                                          title={att.type === 'indexed'
                                            ? `${att.name} — ${t('attach.indexedFull')}${att.pages ? ` (${att.pages}p)` : ''}`
                                            : canOpen ? `${att.name} — ${t('attach.open')}` : att.name}
                                          onClick={() => canOpen && setViewingAttachment(att)}
                                          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.4rem 0.6rem', borderRadius: '6px', fontSize: '0.8rem', border: '1px solid var(--border-color)', color: 'inherit', font: 'inherit', cursor: canOpen ? 'pointer' : 'default' }}
                                        >
                                          <Paperclip size={14} />
                                          <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                                        </button>
                                      );
                                    })}
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
                  
                  {/* An answer's time is when it finished (see markAnswered), so
                      there is none to show while it is still arriving. */}
                  {showTimestamps && group[group.length - 1].at
                    && !(msg.role === 'assistant' && isThisChatGenerating && i + group.length - 1 >= messages.length - 1) && (
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
                          <button className="action-btn" onClick={() => toggleStar(i)} title={msg.starred ? t('msg.unstar') : t('msg.star')}>
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
                          <button className="action-btn" onClick={() => quoteMessage(i)} title={t('msg.quote')}>
                            <TextQuote size={14} />
                          </button>
                          {/* Only where the operating system has a share sheet
                              to open, which in practice means a phone. On a
                              desktop the copy button beside this one is the
                              better answer and a second button that opens
                              nothing would be worse than none. */}
                          {canShare() && (
                            <button
                              className="action-btn"
                              title={t('msg.share')}
                              onClick={() => shareMessage(i)}
                            >
                              <Share2 size={14} />
                            </button>
                          )}
                          <button className="action-btn" onClick={() => branchFromMessage(i)} title={t('msg.branch')}>
                            <GitBranch size={14} />
                          </button>
                          {/* Only on answers, and only when there is a model to
                              do the checking. Verifying your own question is
                              not a thing. */}
                          {msg.role === 'assistant' && selectedModel && (
                            <button
                              className={`action-btn ${msg.verification?.status === 'done' ? 'is-on' : ''}`}
                              onClick={() => verifyAnswer(i)}
                              disabled={isGenerating || msg.verification?.status === 'running'}
                              title={t('verify.action')}
                            >
                              {msg.verification?.status === 'running'
                                ? <RefreshCcw size={14} className="spin" />
                                : <ShieldCheck size={14} />}
                            </button>
                          )}
                          <button className="action-btn" onClick={() => toggleStar(i)} title={msg.starred ? t('msg.unstar') : t('msg.star')}>
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
          {/* One centred row rather than two absolutely positioned buttons:
              either can be showing without the other, and a button that
              shifts sideways depending on whether its neighbour happens to be
              there is a button that moves under the finger reaching for it. */}
          {/* The chat's, so not over the Studio or the gallery laid on top of it. */}
          {(showTopBtn || showScrollBtn) && (
            <div className="scroll-nudges" hidden={sidebarPlace !== 'home'}>
              {showTopBtn && (
                <button className="scroll-nudge" title={t('composer.jumpTop')} onClick={scrollToTop}>
                  <ChevronUp size={16} />
                </button>
              )}
              {showScrollBtn && (
                <button className="scroll-nudge" title={t('composer.jumpLatest')} onClick={scrollToBottom}>
                  <ArrowDown size={16} />
                </button>
              )}
            </div>
          )}

          <form className="input-container composer-stack" onSubmit={e => { e.preventDefault(); if(input.trim() || attachments.length > 0) handleSend(e); }}>

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

            {/* Questions that could not be sent.
                Visible on purpose: a queue that retries silently is one you
                cannot tell apart from an app that has lost your question, and
                the entries that have run out of attempts need a person to
                decide about them. */}
            {sendQueue.length > 0 && (
              <div className="send-queue">
                {sendQueue.map(entry => {
                  const done = (entry.attempts || 0) >= MAX_ATTEMPTS;
                  return (
                    <div key={entry.id} className={`send-queue-item ${done ? 'is-stalled' : ''}`}>
                      {done ? <TriangleAlert size={13} /> : <RefreshCcw size={13} className="spin" />}
                      <span className="send-queue-text" title={entry.text}>
                        {done
                          ? t('queue.gaveUp', { error: entry.lastError || t('queue.unknownError') })
                          : t('queue.waiting', { attempt: (entry.attempts || 0) + 1, max: MAX_ATTEMPTS })}
                        {' — '}{entry.text.slice(0, 70)}{entry.text.length > 70 ? '…' : ''}
                      </span>
                      {done && (
                        <button
                          className="icon-btn"
                          title={t('queue.retryNow')}
                          onClick={() => {
                            // A fresh entry rather than a reset attempt count:
                            // the person asking is new information, and the
                            // backoff should start over with it.
                            const again = { ...entry, attempts: 0, lastTriedAt: 0 };
                            setSendQueue(enqueue(profileScope, again));
                            setSendQueue(removeEntry(profileScope, entry.id));
                          }}
                        >
                          <RefreshCcw size={13} />
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title={t('queue.discard')}
                        onClick={() => setSendQueue(removeEntry(profileScope, entry.id))}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div className="attachments-preview">
                {attachments.map((att, i) => (
                  <div key={i} className="attachment-item">
                    {/* The whole chip opens it. An attachment you cannot look
                        at is a thing you have to take on trust -- and the one
                        moment you most want to check what you attached is
                        before you send it, not after. */}
                    {att.type === 'image' ? (
                      <button
                        type="button"
                        className="attachment-open"
                        onClick={() => setViewingAttachment(att)}
                        title={`${att.name} — ${t('attach.open')}`}
                      >
                        <img src={att.preview} alt={att.name} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="attachment-doc"
                        onClick={() => att.type !== 'indexing' && setViewingAttachment(att)}
                        disabled={att.type === 'indexing'}
                        title={att.type === 'indexing' ? att.name : `${att.name} — ${t('attach.open')}`}
                      >
                        {att.type === 'indexing'
                          ? <RefreshCcw size={14} className="spin" />
                          : att.type === 'indexed' ? <Layers size={14} />
                          : att.type === 'pasted' ? <ClipboardPaste size={14} />
                          : <FileText size={14} />}
                        <span className="attachment-name">{att.name}</span>
                        {/* What the chip says instead of the content, which is
                            the whole point of collapsing it. */}
                        {att.type === 'indexing' && (
                          <span className="attachment-tag">
                            {att.stage === 'embed' && att.total
                              ? t('attach.embedding', { done: att.done || 0, total: att.total })
                              : t('attach.readingShort')}
                          </span>
                        )}
                        {att.type === 'indexed' && (
                          <span className="attachment-tag ok">{t('attach.indexedTag', { pieces: att.pieces })}</span>
                        )}
                        {att.type === 'pasted' && (
                          <span className="attachment-tag">{t('attach.lines', { count: att.lines })}</span>
                        )}
                        {att.truncated && <span className="attachment-cut">{t('attach.truncatedTag')}</span>}
                      </button>
                    )}
                    <button type="button" className="attachment-remove" onClick={() => removeAttachment(i)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {/* The box first, on a line of its own.

                It used to sit fourth in a row of six, between the research
                telescope and the send button, which made the thing you type
                into the narrowest control on the widest row -- and put three
                icons where the first word of the message should be. The box
                has the top line now and the controls have the one under it,
                which is the shape every composer worth using has settled on. */}
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder={isNarrow
                ? t('composer.placeholderShort')
                : t('composer.placeholder', { model: selectedModel || 'Ollama' })}
              value={input}
              onChange={handleInputResize}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={handleComposerFocus}
              rows="1"
            />

            <div className="composer-row">
              <input
                type="file"
                multiple
                ref={fileInputRef}
                onChange={handleFileChange}
                style={{ display: 'none' }}
                /* No `accept`, on purpose. It used to name a dozen extensions
                   and the picker would then grey out `.env`, `.bat`, `.toml`,
                   `.rs` and everything else not on the list -- files it can
                   read perfectly well. A filter that hides readable files is
                   worse than no filter: what a file is, is decided by reading
                   it, and a file that turns out not to be text is refused
                   afterwards with a message that says so. */
              />
              {/* Everything you can add to a message, behind one button.

                  Attach, deep research and web access are three different
                  things to *do to* a message rather than three things to look
                  at, and as three permanent icons they cost the same room as
                  the message itself while being wanted perhaps one send in ten.
                  Under a `+` they are one button until they are needed, and the
                  two that are modes say so in the menu and again on a strip
                  under the composer once they are on. */}
              <div className="composer-add">
                {/* A dot when something inside is switched on.

                    Both entries in this menu are modes that outlive the message
                    that turned them on, and folding them behind a button means
                    folding away the only thing that said so. Research also gets
                    its own strip under the composer; web access does not, being
                    the quieter of the two — so the dot is what stops it being
                    left on for a week unnoticed. */}
                <button
                  type="button"
                  className={`composer-plus ${showAddMenu ? 'is-open' : ''}${researchMode || mcpEnabled ? ' is-armed' : ''}`}
                  title={t('composer.addTitle')}
                  aria-label={t('composer.addTitle')}
                  aria-expanded={showAddMenu}
                  onClick={() => { setShowAddMenu(v => !v); setShowModelMenu(false); }}
                >
                  <Plus size={18} />
                </button>

                <Popover open={showAddMenu} onClose={() => setShowAddMenu(false)} className="composer-menu">
                  <button
                    type="button"
                    className="composer-menu-item"
                    onClick={() => { setShowAddMenu(false); fileInputRef.current?.click(); }}
                  >
                    <Paperclip size={15} />
                    <span className="composer-menu-label">
                      {t('composer.attach')}
                      <em>{t('composer.attachHelp')}</em>
                    </span>
                  </button>

                  {/* Research is a mode rather than a command, because it
                      changes what sending means: minutes instead of seconds,
                      and a cited report instead of a reply. It disarms on
                      every reload. */}
                  <button
                    type="button"
                    className={`composer-menu-item ${researchMode ? 'is-on' : ''}`}
                    aria-pressed={researchMode}
                    onClick={() => { setResearchMode(v => !v); setShowAddMenu(false); }}
                  >
                    <Telescope size={15} />
                    <span className="composer-menu-label">
                      {t('research.turnOn')}
                      <em>{t('research.menuHelp')}</em>
                    </span>
                    {researchMode && <Check size={14} className="composer-menu-check" />}
                  </button>

                  <div className="mcp-toggle-container">
                    <button
                      type="button"
                      className={`composer-menu-item ${mcpEnabled ? 'is-on' : ''}`}
                      aria-pressed={mcpEnabled}
                      title={t('composer.mcpTitle')}
                      onClick={() => setMcpEnabled(v => !v)}
                    >
                      <Globe size={15} />
                      <span className="composer-menu-label">
                        {t('composer.webFetch')}
                        <em>{t('composer.webFetchHelp')}</em>
                      </span>
                      {mcpEnabled && <Check size={14} className="composer-menu-check" />}
                    </button>
                  </div>
                </Popover>
              </div>

              {/* Two microphones would be two things to explain. One button:
                  a tap dictates into the composer as it always has, and a
                  long press (or a right-click, on a machine with one) starts
                  the hands-free loop. The status strip above the composer is
                  what makes the difference visible once it is running. */}
              <button
                type="button"
                className={`attach-btn ${voiceMode ? 'voice-mode-on' : ''}`}
                title={voiceMode ? t('voice.stopMode') : `${t('composer.voice')} · ${t('voice.holdForMode')}`}
                onClick={() => {
                  // The long press already acted; the click that follows it is
                  // the same gesture arriving a second time.
                  if (voiceHoldFiredRef.current) { voiceHoldFiredRef.current = false; return; }
                  if (voiceMode) stopVoiceMode(); else toggleListening();
                }}
                onContextMenu={(e) => { e.preventDefault(); toggleVoiceMode(); }}
                onPointerDown={() => {
                  voiceHoldRef.current = window.setTimeout(() => {
                    voiceHoldRef.current = null;
                    voiceHoldFiredRef.current = true;
                    toggleVoiceMode();
                  }, 550);
                }}
                onPointerUp={() => { window.clearTimeout(voiceHoldRef.current); voiceHoldRef.current = null; }}
                onPointerLeave={() => { window.clearTimeout(voiceHoldRef.current); voiceHoldRef.current = null; }}
                style={{ color: voiceMode ? 'var(--primary)' : isListening ? '#EF4444' : 'var(--text-muted)' }}
                disabled={isTranscribing}
              >
                {/* Three states, and they are not the same thing: waiting for
                    you to speak, sending the clip to the transcriber, and off.
                    A spinner for the middle one, because a microphone icon
                    that has stopped listening but has not answered yet reads
                    as broken. */}
                {isTranscribing ? <RefreshCcw size={20} className="spin" />
                  : isListening || voiceMode ? <Mic size={20} />
                  : <MicOff size={20} />}
              </button>
              
              {/* Everything on the left is about the message. Everything after
                  this is about the answer, and the gap is what says so. */}
              <div className="composer-spacer" />

              {/* Which model, and how hard it should think.

                  One control, because they are one decision. Choosing a model
                  and then choosing how much of it to use are the two halves of
                  "how should this be answered", and they were three clicks
                  apart -- the picker in the title bar, the effort in a row of
                  small buttons under the composer that most of the width of a
                  phone could not hold. */}
              <div className="composer-model">
                <button
                  type="button"
                  className={`composer-model-trigger ${showModelMenu ? 'is-open' : ''}`}
                  aria-expanded={showModelMenu}
                  title={t('composer.modelTitle')}
                  onClick={() => { setShowModelMenu(v => !v); setShowAddMenu(false); }}
                >
                  <span className="composer-model-name">{selectedModel || t('header.selectModel')}</span>
                  {thinkMode !== 'auto' && (
                    <span className="composer-effort-tag">{t(`think.${thinkMode}`)}</span>
                  )}
                  <ChevronDown size={13} />
                </button>

                <Popover open={showModelMenu} onClose={() => setShowModelMenu(false)} className="composer-menu composer-model-menu">
                  <div className="composer-menu-heading">{t('composer.modelHeading')}</div>
                  {models.length === 0 && (
                    <div className="composer-menu-empty">{t('header.noModels')}</div>
                  )}
                  {models.map(m => (
                    <button
                      key={m.name}
                      type="button"
                      className={`composer-menu-item ${selectedModel === m.name ? 'is-on' : ''}`}
                      onClick={() => { modelPickedByHand(m.name); setShowModelMenu(false); }}
                    >
                      <span className="composer-menu-label">{m.name}</span>
                      {modelSupportsVision(m.name) && (
                        <span className="cap-badge" title={t('model.visionCapable')}>👁</span>
                      )}
                      {selectedModel === m.name && <Check size={14} className="composer-menu-check" />}
                    </button>
                  ))}

                  {/* Thinking, where it is decided rather than where it is
                      configured. It changes per question -- a quick factual one
                      does not want thirty seconds of reasoning and a hard one
                      does -- so it belongs beside the send button and not two
                      clicks deep in Settings.

                      "Auto" is not the middle of the scale. It leaves the field
                      out of the request entirely, which is the only value under
                      which the model's own default survives; every other entry
                      overrides it. */}
                  <div className="composer-menu-heading">{t('gen.thinking')}</div>
                  <div className="think-toggle" role="group" aria-label={t('gen.thinking')}>
                    <Brain size={13} className="think-icon" />
                    {THINK_IDS.map(mode => (
                      <button
                        key={mode}
                        type="button"
                        className={thinkMode === mode ? 'active' : ''}
                        aria-pressed={thinkMode === mode}
                        title={t(`think.${mode}Help`)}
                        onClick={() => { setThinkMode(mode); haptic('light'); }}
                      >
                        {t(`think.${mode}`)}
                      </button>
                    ))}
                  </div>
                  <div className="composer-menu-note">{t('think.scaleNote')}</div>
                </Popover>
              </div>

              {/* Stop belongs to the chat being written to. In any other chat
                  the composer is an ordinary composer -- it just cannot send
                  yet, because one model is answering one question at a time,
                  and the footer says so. */}
              {isThisChatGenerating ? (
                <button type="button" className="send-btn active" onClick={stopGeneration} title={t('composer.stop')}>
                  <Square size={14} fill="currentColor" stroke="none" />
                </button>
              ) : (
                <button 
                  type="submit"
                  className={`send-btn ${(input.trim() || attachments.length > 0) && !isGenerating ? 'active' : ''}`}
                  title={isGenerating ? t('chat.busyElsewhere') : undefined}
                  disabled={isGenerating || (!input.trim() && attachments.length === 0) || !selectedModel}
                >
                  <ArrowUp size={18} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </form>

          {/* What "deep" is going to cost, before it is spent. The numbers are
              the plan's own budgets rather than prose, because the difference
              between quick and thorough is the difference between one minute
              and ten and nobody should have to find that out by waiting. */}
          {/* What is about to run, and on what. A chain armed with nothing
              visible under the composer is a send button that does something
              surprising. */}
          {armedChain && (
            <div className="research-strip chain-strip">
              <ListTree size={13} />
              <span className="research-strip-title">{armedChain.name}</span>
              <span className="research-strip-cost">
                {t('chains.stepCount', { count: armedChain.steps.length })}
              </span>
              <button type="button" className="variant-btn" onClick={() => setArmedChain(null)}>
                <X size={12} />
              </button>
            </div>
          )}

          {researchMode && (
            <div className="research-strip">
              <Telescope size={13} />
              <span className="research-strip-title">{t('research.armed')}</span>
              <div className="research-depths">
                {Object.keys(DEPTHS).map(depth => (
                  <button
                    key={depth}
                    type="button"
                    className={researchDepth === depth ? 'is-on' : ''}
                    aria-pressed={researchDepth === depth}
                    title={t('research.depthCost', {
                      queries: DEPTHS[depth].questions,
                      pages: DEPTHS[depth].totalPages,
                    })}
                    onClick={() => setResearchDepth(depth)}
                  >
                    {t(`research.depth.${depth}`)}
                  </button>
                ))}
              </div>
              <span className="research-strip-cost">
                {t('research.depthCost', {
                  queries: (DEPTHS[researchDepth] || DEPTHS.normal).questions,
                  pages: (DEPTHS[researchDepth] || DEPTHS.normal).totalPages,
                })}
              </span>
              {/* The way off, in the same place the armed-chain strip puts it.
                  The telescope lives inside the `+` menu now, and a mode you can
                  only turn off by reopening the menu you turned it on from is a
                  mode people leave on by accident. */}
              <button
                type="button"
                className="variant-btn"
                title={t('research.turnOff')}
                aria-label={t('research.turnOff')}
                onClick={() => setResearchMode(false)}
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Hands-free takes over the microphone and the speaker, so it says
              so, and says which of the four things it is doing -- otherwise a
              mode that spends ten seconds silently thinking is
              indistinguishable from one that has crashed. */}
          {voiceMode && (
            <div className="voice-strip">
              <span className={`voice-dot ${isListening ? 'listening' : isGenerating ? 'thinking' : (speakingIndex !== null || isSynthesizing) ? 'speaking' : ''}`} />
              <span className="voice-state">
                {isListening ? t('voice.listening')
                  : isGenerating ? t('voice.thinking')
                  : (speakingIndex !== null || isSynthesizing) ? t('voice.speaking')
                  : t('voice.waiting')}
              </span>
              <button type="button" onClick={stopVoiceMode}>{t('voice.stopMode')}</button>
            </div>
          )}

          {/* Only when the answer is landing somewhere else. Without it the
              composer is simply unresponsive and there is nothing on screen
              explaining why. */}
          {isGenerating && !isThisChatGenerating && (
            <div className="busy-elsewhere">
              <RefreshCcw size={12} className="spin" />
              <span>{t('chat.busyElsewhere')}</span>
              <button type="button" onClick={() => openChat(generatingSessionId)}>
                {t('chat.goThere')}
              </button>
            </div>
          )}

          {/* Classes rather than inline styles, because the phone rules have to
              be able to change `flex-wrap` and the gap — and an inline style
              cannot be overridden by a media query without `!important` on
              every line of it. This row is three controls now, and three of
              them do not fit across a phone on one line. */}
          <div className="input-footer">
            <span className="composer-disclaimer">{t('composer.disclaimer', { slash: '/' })}</span>

            <div className="composer-controls">
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

            {/* Thinking and web access used to stand here as a row of small
                buttons and a switch, beside the context meter. Both have moved
                into the composer row above -- the effort into the model picker,
                because they are one decision, and web access into the `+` menu
                with the other two things you can add to a message. What is left
                here is the one item that is a *reading*: how full the context
                is, which is not something to press. */}
            </div>
          </div>
        </div>

        {/* Suggestions, under the composer rather than over it.

            Above the composer they were the first thing read and the
            last thing wanted: a list of things to type, sitting where
            the box you type into should be. Under it they are what
            they are -- something to fall back on if nothing comes to
            mind. They go with the first message. */}
        {messages.length === 0 && (
          <div className="starter-grid">
            {STARTER_PROMPTS.map(starter => (
              <button
                key={starter.labelKey}
                className="starter-card"
                onClick={() => {
                  setInput(starter.prompt);
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
              >
                <starter.Icon size={16} />
                <span>{t(starter.labelKey)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Settings Overlay */}
        <Transition open={showSettings} duration={200} className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('settings.title')} ref={settingsDialogRef} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h2 style={{ marginBottom: 0 }}>{t('settings.title')}</h2>
                <button className="icon-btn" onClick={() => setShowSettings(false)} title={`${t('common.close')} (Esc)`}><X size={18} /></button>
              </div>

              <div
                className="settings-tabs"
                ref={setTabStrip}
                onScroll={e => measureTabOverflow(e.currentTarget)}
                // Absent rather than empty when everything fits: the fade is
                // selected by attribute, and `data-overflow=""` would match a
                // rule meant for a strip that actually has more behind it.
                data-overflow={tabOverflow || undefined}
              >
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
                    aria-current={settingsTab === tab.id ? 'true' : undefined}
                    onClick={(e) => {
                      setSettingsTab(tab.id);
                      haptic('light');
                      // The panel keeps its scroll position when the content
                      // under it is replaced, so a tab tapped from halfway
                      // down Generation opens Voice halfway down Voice.
                      e.currentTarget.closest('.settings-modal')?.scrollTo({ top: 0 });
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {settingsTab === 'general' && (
                <>
                  {/* ---- who is asking ----
                      The other half of the persona pair. Personas say who the
                      assistant is; nothing said who the person is, so every
                      conversation opened with a model that did not know your
                      name, your language or what you already know. */}
                  {/* Folded.
                      This is seven fields, and putting them open at the top of
                      the first tab pushed the things people actually come here
                      to change -- theme, text size, language -- below the fold.
                      Collapsed it is one line that still says what it is and
                      whether it has been filled in, which is the discoverable
                      part; the form is one click away for the once anybody
                      writes it. */}
                  <details className="settings-fold">
                    <summary>
                      {/* `about.title`, not `profile.title`: the latter already
                          meant the account dialog -- display name, avatar,
                          password -- and reusing it put those words on this. */}
                      <span>{t('about.title')}</span>
                      <span className="settings-fold-state">
                        {isProfileEmpty(userProfile)
                          ? t('profile.notSet')
                          : PROFILE_FIELDS.map(f => userProfile[f.key]).filter(Boolean).join(' · ').slice(0, 48)}
                      </span>
                    </summary>

                    <div className="settings-group">
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                      {t('profile.help')}
                    </div>

                    {PROFILE_FIELDS.map(field => (
                      <div className="profile-field" key={field.key}>
                        <label htmlFor={`profile-${field.key}`}>{t(`profile.${field.key}`)}</label>
                        {field.key === 'notes' ? (
                          <textarea
                            id={`profile-${field.key}`}
                            className="settings-textarea"
                            style={{ minHeight: '70px' }}
                            placeholder={t(`profile.${field.key}Hint`)}
                            value={userProfile[field.key] || ''}
                            maxLength={field.max}
                            onChange={e => persistProfile({
                              ...userProfile, [field.key]: clampField(field.key, e.target.value),
                            })}
                          />
                        ) : (
                          <input
                            id={`profile-${field.key}`}
                            type="text"
                            className="settings-input"
                            placeholder={t(`profile.${field.key}Hint`)}
                            value={userProfile[field.key] || ''}
                            maxLength={field.max}
                            onChange={e => persistProfile({
                              ...userProfile, [field.key]: clampField(field.key, e.target.value),
                            })}
                          />
                        )}
                      </div>
                    ))}

                    {/* This is the one piece of prompt that is never dropped,
                        never summarised and never retrieved conditionally, so
                        the meter moves while you type. */}
                    <div className="usage-detail profile-cost">
                      {t('profile.cost', { tokens: profileCost(userProfile).tokens })}
                      {nextProfileField(userProfile) && (
                        <> · {t('profile.suggest', { field: t(`profile.${nextProfileField(userProfile)}`) })}</>
                      )}
                    </div>
                    </div>
                  </details>

                  {/* ---- long-conversation memory ---- */}
                  <div className="settings-group">
                    <SettingToggle
                      checked={convMemory}
                      onChange={setConvMemory}
                      label={t('convmem.title')}
                      description={t('convmem.help')}
                    />
                    {convMemory && currentSession.memorySummary?.text && (
                      <details className="memory-summary">
                        <summary>{t('convmem.summaryOf', { turns: currentSession.memorySummary.throughTurn })}</summary>
                        <p>{currentSession.memorySummary.text}</p>
                        <button
                          className="tag-clear"
                          onClick={() => reviseSession(currentSessionId, x => ({ ...x, memorySummary: undefined }))}
                        >
                          {t('convmem.forget')}
                        </button>
                      </details>
                    )}
                  </div>

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
                    <label>{t('settings.location')}</label>
                    <input
                      className="settings-input"
                      value={userLocation}
                      placeholder={t('settings.locationPlaceholder')}
                      onChange={e => setUserLocation(e.target.value)}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('settings.locationHelp')}
                    </div>
                  </div>

                  <div className="settings-group">
                    <label>{t('settings.contentWidth')}</label>
                    <div className="theme-switch">
                      <button className={contentWidth === 'narrow' ? 'active' : ''} onClick={() => setContentWidth('narrow')}>{t('settings.widthNarrow')}</button>
                      <button className={contentWidth === 'medium' ? 'active' : ''} onClick={() => setContentWidth('medium')}>{t('settings.widthMedium')}</button>
                      <button className={contentWidth === 'wide' ? 'active' : ''} onClick={() => setContentWidth('wide')}>{t('settings.widthWide')}</button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('settings.contentWidthHelp')}
                    </div>
                  </div>

                  {/* Only where there is a motor to buzz. `navigator.vibrate`
                      is not that test on its own -- desktop Chrome defines it
                      and does nothing with it -- so the pointer is asked as
                      well. A machine with a mouse does not vibrate, and a
                      switch that does nothing is worse than no switch. */}
                  {hapticsSupported() && isTouchUi && (
                    <div className="settings-group">
                      <label>{t('settings.haptics')}</label>
                      <SettingToggle
                        checked={hapticsOn}
                        onChange={(value) => {
                          setHapticsOn(value);
                          // The switch demonstrates itself: turning it on with
                          // no buzz leaves you wondering whether it worked.
                          if (value) { setHapticsEnabled(true); haptic('medium'); }
                        }}
                        label={t('settings.hapticsLabel')}
                        description={t('settings.hapticsHelp')}
                      />
                    </div>
                  )}

                  {/* Half a dozen things are simply absent on a plain-HTTP
                      address, and the browser says nothing about why: the
                      passkey button does not appear, "install" does not
                      appear, hands-free reports no microphone. Each looks like
                      a separate fault. They are one, and it has a name. */}
                  {!window.isSecureContext && (
                    <div className="settings-group">
                      <label>{t('settings.insecure')}</label>
                      <div className="setup-why">
                        <div>{t('settings.insecureWhy', { origin: window.location.origin })}</div>
                        <ul className="insecure-list">
                          <li>{t('settings.insecurePasskeys')}</li>
                          <li>{t('settings.insecureInstall')}</li>
                          <li>{t('settings.insecureMic')}</li>
                        </ul>
                        <div>{t('settings.insecureFix')}</div>
                      </div>
                    </div>
                  )}

                  {/* The install button appears only while the browser is
                      actually holding a prompt for us: Firefox and Safari
                      never offer one, and neither does a browser showing the
                      app it has already installed. Where there is no prompt
                      there is still a note, because "add to home screen" is
                      in every one of those browsers' own menus and people do
                      not think to look. */}
                  {!runningAsApp && supportsServiceWorker() && (
                    <div className="settings-group">
                      <label>{t('settings.installApp')}</label>
                      {installReady ? (
                        <button className="icon-btn bordered" onClick={promptInstall}>
                          <Smartphone size={14} /> {t('pwa.install')}
                        </button>
                      ) : (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {t('pwa.installManual')}
                        </div>
                      )}
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                        {t('pwa.installHelp')}
                      </div>
                    </div>
                  )}

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
                        toast(t('toast.panelsReset'), 'success', 2000);
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

                  {/* A library, because one box is enough only while the app is
                      used for one thing. The prompt that makes a model a terse
                      reviewer is the wrong prompt for translating a letter, and
                      keeping both used to mean keeping them in a file
                      somewhere and pasting whichever was wanted. */}
                  <div className="settings-group">
                    <label>{t('persona.saved')} ({personas.length})</label>
                    <div className="setting-desc">{t('persona.help')}</div>

                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      {/* One or two characters. An uploaded picture would be
                          the largest thing in the record by two orders of
                          magnitude, for a mark drawn at 28 pixels. */}
                      <input
                        type="text"
                        className="settings-input persona-avatar-input"
                        placeholder="🙂"
                        aria-label={t('persona.avatar')}
                        value={newPersonaAvatar}
                        onChange={e => setNewPersonaAvatar(e.target.value)}
                      />
                      <input
                        type="text"
                        className="settings-input"
                        placeholder={t('persona.namePlaceholder')}
                        value={newPersonaName}
                        onChange={e => setNewPersonaName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') savePersonaFromCurrent(); }}
                      />
                      <button className="btn pull-btn" disabled={!newPersonaName.trim()} onClick={savePersonaFromCurrent}>
                        <Save size={14} /> {editingPersonaId ? t('persona.update') : t('persona.save')}
                      </button>
                    </div>

                    <input
                      type="text"
                      className="settings-input"
                      style={{ marginTop: '0.5rem' }}
                      placeholder={t('persona.greetingPlaceholder')}
                      value={newPersonaGreeting}
                      onChange={e => setNewPersonaGreeting(e.target.value)}
                    />

                    <div className="setting-toggle-row" style={{ marginTop: '0.6rem' }}>
                      <div>
                        <label style={{ marginBottom: 0 }}>{t('persona.pinSetup')}</label>
                        <div className="setting-desc">{t('persona.pinSetupHelp', { model: selectedModel || t('persona.anyModel') })}</div>
                      </div>
                      <Switch
                        checked={pinPersonaSetup}
                        onChange={setPinPersonaSetup}
                        label={t('persona.pinSetup')}
                      />
                    </div>

                    {personas.length === 0 ? (
                      <div className="setting-desc" style={{ marginTop: '0.5rem' }}>{t('persona.none')}</div>
                    ) : (
                      <div className="share-list" style={{ marginTop: '0.5rem' }}>
                        {personas.map(p => {
                          const inUse = activePersona?.id === p.id;
                          return (
                            <div key={p.id} className={`share-row${inUse ? ' active' : ''}`}>
                              <span className="persona-row-avatar">{p.avatar || p.name.slice(0, 1)}</span>
                              <div className="share-row-main">
                                <div className="share-row-title">
                                  {p.name}
                                  {inUse && <span className="attachment-tag ok" style={{ marginLeft: '0.4rem' }}>{t('persona.inUse')}</span>}
                                </div>
                                <div className="share-row-meta">{p.body.slice(0, 90)}{p.body.length > 90 ? '…' : ''}</div>
                              </div>
                              <button className="icon-btn" title={t('persona.startChat')}
                                onClick={() => startChatAsPersona(p)}>
                                <MessageSquare size={14} />
                              </button>
                              <button className="icon-btn" title={t('persona.apply')}
                                onClick={() => applyPersona(p)} disabled={inUse}>
                                <Play size={14} />
                              </button>
                              <button className="icon-btn" title={t('persona.edit')}
                                onClick={() => editPersona(p)}>
                                <Edit size={14} />
                              </button>
                              <button className="icon-btn" title={t('persona.delete')}
                                onClick={() => deletePersona(p.id)} style={{ color: '#EF4444' }}>
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
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
                  {/* ---- which model answers what ----
                      Under the model list rather than in a tab of its own,
                      because a rule is about the models above it and reads as
                      nonsense before you have seen what is installed. */}
                  <div className="settings-group">
                    <SettingToggle
                      checked={routingEnabled}
                      onChange={setRoutingEnabled}
                      label={t('routing.title')}
                      description={t('routing.help')}
                    />

                    {routingEnabled && (
                      <div className="routing-rules">
                        {modelRules.length === 0 && (
                          <div className="usage-detail">{t('routing.none')}</div>
                        )}

                        {modelRules.map((rule, index) => (
                          <div className={`routing-rule ${rule.enabled ? '' : 'is-off'}`} key={rule.id}>
                            <select
                              className="compare-judge"
                              value={rule.when}
                              onChange={e => persistModelRules(modelRules.map(
                                (r, n) => (n === index ? { ...r, when: e.target.value } : r),
                              ))}
                            >
                              {CONDITIONS.map(when => (
                                <option key={when} value={when}>{t(`routing.when.${when}`)}</option>
                              ))}
                            </select>

                            <span className="routing-arrow">→</span>

                            <select
                              className="compare-judge"
                              value={rule.model}
                              onChange={e => persistModelRules(modelRules.map(
                                (r, n) => (n === index ? { ...r, model: e.target.value } : r),
                              ))}
                            >
                              {/* A rule may name a model this machine does not
                                  have -- the library travels between machines --
                                  so its own value is always an option, marked. */}
                              {!models.some(m => m.name === rule.model) && rule.model && (
                                <option value={rule.model}>{t('routing.missing', { model: rule.model })}</option>
                              )}
                              {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                            </select>

                            <button
                              className="variant-btn"
                              title={rule.enabled ? t('routing.disable') : t('routing.enable')}
                              onClick={() => persistModelRules(modelRules.map(
                                (r, n) => (n === index ? { ...r, enabled: !r.enabled } : r),
                              ))}
                            >
                              {rule.enabled ? <Check size={13} /> : <X size={13} />}
                            </button>
                            <button
                              className="variant-btn"
                              title={t('common.remove')}
                              onClick={() => persistModelRules(modelRules.filter((r, n) => n !== index))}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}

                        <div className="routing-actions">
                          <button
                            className="icon-btn bordered"
                            onClick={() => persistModelRules([
                              ...modelRules,
                              newModelRule('code', selectedModel || models[0]?.name || ''),
                            ])}
                            disabled={models.length === 0}
                          >
                            <Plus size={13} />
                            <span style={{ marginInlineStart: '0.3rem' }}>{t('routing.add')}</span>
                          </button>

                          {/* Filled in, not applied. The guesses come from model
                              names, which is a real signal and not a reliable
                              one, so what is accepted is visible first. */}
                          {modelRules.length === 0 && (
                            <button
                              className="icon-btn bordered"
                              onClick={() => persistModelRules(
                                suggestRules(models.map(m => m.name), { supportsVision: modelSupportsVision }),
                              )}
                              disabled={models.length < 2}
                            >
                              <Sparkles size={13} />
                              <span style={{ marginInlineStart: '0.3rem' }}>{t('routing.suggest')}</span>
                            </button>
                          )}
                        </div>

                        {currentSession.manualModel && (
                          <div className="usage-detail routing-manual">
                            {t('routing.manualHere')}
                            <button
                              className="tag-clear"
                              onClick={() => reviseSession(currentSessionId, x => ({ ...x, manualModel: false }))}
                            >
                              {t('routing.resumeHere')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

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
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Cpu size={13} /> {t('models.installed')} ({models.length})
                        {/* What all of them cost together. The per-model size
                            was already here and it is the wrong number for the
                            question people actually have, which is "how much
                            of my disk is this and what should I delete". */}
                        {modelDiskTotal > 0 && (
                          <span className="manager-total">{formatBytes(modelDiskTotal)}</span>
                        )}
                      </span>
                      <button className="icon-btn" title={t('models.refresh')} onClick={() => { fetchModels(); fetchRunningModels(); }}><RefreshCcw size={13} /></button>
                    </label>
                    {/* Largest first, because that is the order you read this
                        list in when you are trying to free space. */}
                    {modelsBySize.map(m => (
                      <div className="manager-row" key={`inst-${m.name}`}>
                        <Cpu size={14} color={selectedModel === m.name ? 'var(--primary)' : 'var(--text-muted)'} />
                        <span className="manager-name">
                          {m.name}
                          {/* Read from /api/show, which is already being asked
                              for every model to decide about images. */}
                          {modelSupportsVision(m.name) && <span className="cap-badge" title={t('model.visionCapable')}>👁</span>}
                          {modelSupportsTools(m.name) && <span className="cap-badge" title={t('models.toolsCapable')}>🔧</span>}
                        </span>
                        <span className="manager-meta">
                          {formatBytes(m.size)}
                          {modelDiskTotal > 0 ? ` · ${Math.round((m.size / modelDiskTotal) * 100)}%` : ''}
                          {m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ''}
                          {m.details?.quantization_level ? ` · ${m.details.quantization_level}` : ''}
                        </span>
                        {/* A bar makes the difference between 6 GB and 33 GB
                            legible at a glance; two numbers in a column do not. */}
                        <span className="manager-bar" aria-hidden="true">
                          <span style={{ width: `${modelDiskTotal ? (m.size / modelDiskTotal) * 100 : 0}%` }} />
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
                  {/* ---- chains ----
                      Beside the saved prompts, because a chain is what you make
                      once you have three of them and keep running them in the
                      same order. */}
                  <div className="settings-group">
                    <label>{t('chains.title')} ({chains.length})</label>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                      {t('chains.hint', { slash: '/' })}
                    </div>

                    {chains.map(c => {
                      const problems = blocking(validateChain(c));
                      return (
                        <div className={`prompt-lib-item ${problems.length ? 'has-problems' : ''}`} key={c.id}>
                          <span className="prompt-lib-name">{c.name}</span>
                          <span className="prompt-lib-body">
                            {c.steps.map((step, n) => step.title || t('chains.step', { n: n + 1 })).join(' → ')}
                          </span>
                          {problems.length > 0 && (
                            <span className="chain-problem">{t('chains.broken', { name: '' })}</span>
                          )}
                          <button className="icon-btn bordered" title={t('common.edit')} onClick={() => setChainEditor({ ...c, steps: c.steps.map(x => ({ ...x })) })}>
                            <Edit size={14} />
                          </button>
                          <button className="icon-btn bordered danger" title={t('common.remove')} onClick={() => persistChains(chains.filter(x => x.id !== c.id))}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      );
                    })}

                    <div className="routing-actions">
                      <button className="icon-btn bordered" onClick={() => setChainEditor(newChain(''))}>
                        <Plus size={13} />
                        <span style={{ marginInlineStart: '0.3rem' }}>{t('chains.add')}</span>
                      </button>
                      {chains.length === 0 && (
                        <button
                          className="icon-btn bordered"
                          onClick={() => persistChains(STARTER_CHAINS.map(starter => newChain(
                            t(starter.nameKey),
                            starter.steps.map(step => newStep(t(step.titleKey), step.prompt)),
                          )))}
                        >
                          <Sparkles size={13} />
                          <span style={{ marginInlineStart: '0.3rem' }}>{t('chains.starters')}</span>
                        </button>
                      )}
                    </div>
                  </div>

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
                    /* The scope, not the bare account id.
                       These are two different keys once somebody signs in:
                       `deriveScope` yields `srv-42` and the id is `42`, so the
                       panel was saving to `knowledge:42` while the chat read
                       `knowledge:srv-42` and the sync engine synced
                       `knowledge:srv-42`. A document added in Settings was
                       therefore listed in the panel, never retrieved, and
                       never synced. It worked for the guest -- both spell
                       `knowledge:guest` -- which is why it went unnoticed. */
                    userId={profileScope}
                    models={models}
                    embedModel={embedModel}
                    onEmbedModelChange={setEmbedModel}
                    onLibraryChange={setKnowledge}
                    // So a document can say which chat or folder it belongs
                    // to by name rather than by id.
                    chats={sessions}
                    folders={folders}
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
                  {/* Speech *in*. The engine below it is speech out; these were
                      never the same setting and the tab only ever had one. */}
                  <div className="settings-group">
                    <label>{t('voice.localStt')}</label>
                    <input
                      className="settings-input"
                      value={sttModel}
                      onChange={e => setSttModel(e.target.value)}
                      placeholder="Systran/faster-whisper-small"
                      spellCheck={false}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                      {t('voice.localSttHelp')}
                    </div>
                  </div>

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
                          toast(t('toast.sovitsLaunch'), 'info');
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
                    {user ? (
                      <div className="account-card">
                        <ProfileAvatar user={user} size={42} />
                        <div className="account-meta">
                          <div className="account-name">{user.name}</div>
                          {user.email && <div className="account-email">{user.email}</div>}
                          <div className="account-provider">{user.provider}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="account-card">
                        <div className="account-avatar">{t('sidebar.guest').charAt(0)}</div>
                        <div className="account-meta">
                          <div className="account-name">{t('sidebar.guest')}</div>
                          <div className="account-email">{t('auth.guestNote')}</div>
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                      {user && (
                        <button className="icon-btn bordered" onClick={() => { setShowSettings(false); setShowProfileDialog(true); }}>
                          <User size={14} /> {t('profile.title')}
                        </button>
                      )}
                      <button
                        className="icon-btn bordered"
                        onClick={() => {
                          setShowSettings(false);
                          if (user) handleAddAccount(); else setShowAuthScreen(true);
                        }}
                      >
                        <UserPlus size={14} /> {user ? t('auth.addAccount') : t('auth.signIn')}
                      </button>
                      {user && (
                        <>
                          <button className="icon-btn bordered" onClick={() => { setShowSettings(false); handleSignOut(); }}>
                            <LogOut size={14} /> {t('auth.signOut')}
                          </button>
                          <SignOutOthersButton busy={!!syncBusy} onClick={handleSignOutOthers} />
                          <button className="icon-btn bordered" style={{ color: 'var(--danger)' }} onClick={handleDeleteAccount}>
                            <Trash2 size={14} /> {t('auth.deleteAccount')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {user && (
                    <SecurityPanel user={user} onUserChanged={authSession.setUser} toast={toast} />
                  )}

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
                    <label>{t('sync.title')}</label>
                    <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('sync.help')}</div>

                    {!serverConfig && (
                      <div className="auth-note" style={{ margin: 0 }}>{t('sync.noServer')}</div>
                    )}

                    {/* There is no separate sync login any more. Being signed
                        in is what syncs; the second account people had to find
                        in this panel was an artefact of identity living in two
                        places, and of the two disagreeing. */}
                    {serverConfig && !user && (
                      <div className="auth-note" style={{ margin: 0 }}>{t('sync.signInFirst')}</div>
                    )}

                    {serverConfig && user && (
                      <>
                        <div className="sync-status">
                          <Check size={14} />
                          <span>{t('sync.signedInAs', { name: user.name, email: user.email })}</span>
                        </div>
                        <div className="setting-help" style={{ marginBottom: '0.6rem' }}>
                          {syncInfo?.savedAt
                            ? t('sync.holds', {
                                chats: syncInfo.chats ?? 0,
                                when: relativeTime(syncInfo.savedAt, lang),
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
                          <button
                            className="icon-btn bordered"
                            style={{ color: 'var(--danger)' }}
                            disabled={!!syncBusy}
                            onClick={() => {
                              // The recovery path when a device's local copy is
                              // wrong: the account is authoritative, so throw
                              // the local one away rather than merging the mess
                              // back in.
                              if (window.confirm(t('sync.confirmReplace'))) syncPull('replace');
                            }}
                          >
                            <TriangleAlert size={14} /> {t('sync.pullReplace')}
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

                    {/* The search index, named separately.
                        The browser's estimate is one number for everything,
                        and this is the part that grows on its own without
                        anybody asking it to — so it is the part worth naming,
                        and the part worth being able to delete. It is rebuilt
                        on the next search, so deleting it costs only the time
                        to build it again. */}
                    {indexUsage && (
                      <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          {t('data.searchIndex', {
                            size: formatBytes(indexUsage.bytes),
                            messages: indexUsage.entries.toLocaleString(),
                            max: MAX_INDEXED.toLocaleString(),
                          })}
                        </span>
                        <button
                          className="icon-btn bordered"
                          title={t('data.clearIndex')}
                          onClick={async () => {
                            await clearIndex(profileScope);
                            setIndexUsage(null);
                            setSemanticHits([]);
                            setSemanticState('idle');
                            toast(t('data.indexCleared'), 'success', 4000);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
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
                <button className="icon-btn bordered" title={t('common.copy')} onClick={() => { copyToClipboard(activeArtifactSource); toast(t('toast.codeCopied'), 'success', 2000); }}>
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

        {/* Who to start a chat with.

            A dialog rather than a submenu because the choice is made of
            prose -- a name means little without the opening line under it,
            and a menu row cannot carry two lines legibly. */}
        <Transition open={showPersonaPicker} duration={200} className="settings-overlay"
          onClick={() => setShowPersonaPicker(false)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('persona.pickTitle')} ref={personaPickerRef} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <h2 style={{ marginBottom: 0 }}>{t('persona.pickTitle')}</h2>
              <button className="icon-btn" onClick={() => setShowPersonaPicker(false)}><X size={18} /></button>
            </div>
            <div className="setting-desc" style={{ marginBottom: '0.75rem' }}>{t('persona.pickHelp')}</div>

            {personas.length === 0 ? (
              <div className="setting-desc">{t('persona.none')}</div>
            ) : (
              <div className="persona-grid">
                {personas.map(persona => (
                  <button
                    key={persona.id}
                    type="button"
                    className="persona-card"
                    onClick={() => startChatAsPersona(persona)}
                  >
                    <span className="persona-card-avatar">
                      {persona.avatar || persona.name.slice(0, 1)}
                    </span>
                    <span className="persona-card-body">
                      <span className="persona-card-name">{persona.name}</span>
                      <span className="persona-card-line">
                        {persona.greeting || persona.body.slice(0, 110)}
                      </span>
                      <span className="persona-card-meta">
                        {persona.model || t('persona.anyModel')}
                        {Object.keys(persona.sampling || {}).length > 0
                          ? ` · ${t('persona.pinnedSampling', { count: Object.keys(persona.sampling).length })}`
                          : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.9rem' }}>
              <button className="btn" onClick={() => { setShowPersonaPicker(false); openSettings(); }}>
                <Settings size={14} /> {t('persona.manage')}
              </button>
            </div>
          </div>
        </Transition>

        {/* Chat info + per-chat overrides */}
        <Transition open={showChatInfo} duration={200} className="settings-overlay" onClick={() => setShowChatInfo(false)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('chat.info')} ref={chatInfoDialogRef} onClick={e => e.stopPropagation()}>
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

              {/* Publishing a copy. Kept in the chat panel rather than in
                  Settings because it is an act on *this* conversation, and the
                  thing most worth reading before pressing it — that a copy is
                  published, so later messages stay private — belongs next to
                  the button rather than in a manual. */}
              <div className="settings-group">
                <label>{t('share.title')}</label>
                <div className="setting-desc">{t('share.explain')}</div>
                <div className="setting-desc" style={{ marginTop: '0.35rem' }}>{t('share.snapshotNote')}</div>

                {!user ? (
                  <div className="setting-desc" style={{ marginTop: '0.6rem' }}>{t('share.signInFirst')}</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                      <label style={{ marginBottom: 0, fontSize: '0.8rem' }}>{t('share.expiry')}</label>
                      <select
                        className="settings-input"
                        style={{ width: 'auto' }}
                        value={shareExpiryDays}
                        onChange={e => setShareExpiryDays(Number(e.target.value))}
                      >
                        <option value={0}>{t('share.never')}</option>
                        <option value={1}>{t('share.days', { count: 1 })}</option>
                        <option value={7}>{t('share.days', { count: 7 })}</option>
                        <option value={30}>{t('share.days', { count: 30 })}</option>
                      </select>
                      <button className="btn pull-btn" disabled={shareBusy} onClick={publishShare}>
                        {shareBusy ? <RefreshCcw size={14} className="spin" /> : <Share2 size={14} />}
                        {' '}{t('share.publish')}
                      </button>
                    </div>

                    {justShared && (
                      <div className="share-url-row">
                        <input type="text" className="settings-input" readOnly value={justShared}
                          onFocus={e => e.target.select()} />
                        <button className="icon-btn bordered" title={t('share.copy')}
                          onClick={() => { copyText(justShared); toast(t('share.copied'), 'success'); }}>
                          <Copy size={14} />
                        </button>
                        <a className="icon-btn bordered" href={justShared} target="_blank" rel="noreferrer"
                          title={t('share.open')}>
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    )}

                    <label style={{ marginTop: '0.9rem' }}>{t('share.existing')}</label>
                    {shares.length === 0 ? (
                      <div className="setting-desc">{t('share.none')}</div>
                    ) : (
                      <div className="share-list">
                        {shares.map(s => (
                          <div key={s.id} className="share-row">
                            <div className="share-row-main">
                              <div className="share-row-title">{s.title || t('share.untitled')}</div>
                              <div className="share-row-meta">
                                {new Date(s.createdAt).toLocaleDateString()}
                                {' · '}{t('share.views', { count: s.views })}
                                {s.expiresAt ? ` · ${t('share.expiresOn', { date: new Date(s.expiresAt).toLocaleDateString() })}` : ''}
                              </div>
                            </div>
                            {shareUrls[s.id] ? (
                              <button className="icon-btn" title={t('share.copy')}
                                onClick={() => { copyText(shareUrls[s.id]); toast(t('share.copied'), 'success'); }}>
                                <Copy size={14} />
                              </button>
                            ) : (
                              // Published from another device, or from this one
                              // before its storage was cleared. The server
                              // cannot help: it holds a hash, not the link.
                              <button className="icon-btn" title={t('share.urlLost')} disabled>
                                <HelpCircle size={14} />
                              </button>
                            )}
                            <button className="icon-btn" title={t('share.revoke')}
                              onClick={() => revokeOneShare(s.id)} style={{ color: '#EF4444' }}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
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
                        label: t('common.undo'),
                        onClick: () => reviseSession(sid, s => ({ ...s, messages: previous })),
                      });
                    }}
                  >
                    <Trash2 size={14} /> {t('chat.clearMessages')}
                  </button>
                </div>
              </div>
          </div>
        </Transition>

        {/* Everything the old browser-local login left behind, offered once.
            Never applied without being asked for: on a shared computer, folding
            whatever is lying around into the first account that signs in is the
            same failure this rework is about, arriving through the front door. */}
        {legacyOffer && legacyOffer.length > 0 && (
          <div className="settings-overlay" onClick={dismissLegacy}>
            <div className="settings-modal" style={{ maxWidth: '30rem' }} role="dialog" aria-modal="true"
              aria-label={t('compare.title')} onClick={e => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>{t('legacy.title')}</h3>
              <p className="setting-help">{t('legacy.body', { name: user?.name || '' })}</p>

              {legacyOffer.map(entry => (
                <div className="account-card" key={entry.key} style={{ marginBottom: '0.5rem' }}>
                  <div className="account-avatar"><Archive size={16} /></div>
                  <div className="account-meta">
                    <div className="account-name">
                      {entry.guest ? t('legacy.guestBucket') : (entry.label || t('legacy.oldProfile'))}
                    </div>
                    <div className="account-email">{t('legacy.chatCount', { chats: entry.chats })}</div>
                  </div>
                  <button
                    className="icon-btn bordered"
                    disabled={legacyBusy}
                    onClick={() => acceptLegacy(entry)}
                  >
                    {legacyBusy ? <RefreshCcw size={14} className="spin" /> : <ArrowDown size={14} />}
                    {t('legacy.import')}
                  </button>
                </div>
              ))}

              <p className="setting-help" style={{ marginTop: '0.6rem' }}>{t('legacy.note')}</p>
              <button className="icon-btn bordered" onClick={dismissLegacy} disabled={legacyBusy}>
                {t('legacy.notNow')}
              </button>
            </div>
          </div>
        )}

        {showProfileDialog && user && (
          <ProfileDialog
            user={user}
            onClose={() => setShowProfileDialog(false)}
            onUpdated={(updated) => { authSession.setUser(updated); toast(t('profile.saved'), 'success', 2000); }}
            onSignOut={() => { setShowProfileDialog(false); handleSignOut(); }}
            onSwitch={async () => {
              // Not a sign-out. This tab stops acting as the account and the
              // sign-in that follows adds a session beside it — which is what
              // lets a second tab stay signed in as the first account. What
              // must not happen is this tab going on reading and writing that
              // account's storage afterwards, and it does not: the tree is
              // remounted around the guest before the sign-in screen appears.
              setShowProfileDialog(false);
              await handleAddAccount();
            }}
            onDelete={() => { setShowProfileDialog(false); handleDeleteAccount(); }}
            onUnlinkKakao={handleKakaoUnlink}
          />
        )}

        <Transition open={showSystemMonitor} duration={200} className="settings-overlay" onClick={() => setShowSystemMonitor(false)}>
          <div className="settings-modal sysmon-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>
                {monitorTab === 'system' ? t('sysmon.title')
                  : monitorTab === 'usage' ? t('usage.title')
                  : t('studio.title')}
              </h2>
              <button className="icon-btn" onClick={() => setShowSystemMonitor(false)} title={`${t('common.close')} (Esc)`}>
                <X size={18} />
              </button>
            </div>

            {/* Three tabs now, and the third is a different kind of thing from
                the other two: system and usage are readings, and the studio is
                somewhere you do work. It sits here anyway because it is the
                same shape of surface -- full screen, opened from the header,
                closed with Escape -- and a fourth top-level overlay for it
                would be a fourth thing to learn where to find. */}
            <div className="sysmon-tabs">
              {[
                ['system', t('sysmon.tabSystem')],
                ['usage', t('sysmon.tabUsage')],
              ].map(([tab, label]) => (
                <button
                  type="button"
                  key={tab}
                  className={monitorTab === tab ? 'is-on' : ''}
                  aria-pressed={monitorTab === tab}
                  onClick={() => setMonitorTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>

            {showSystemMonitor && monitorTab === 'system' && (
              <SystemMonitor
                runningModels={runningModels}
                perfKey={perfKey}
                currentModel={selectedModel}
                /* The installed list, for the disk block: the panel should not
                   fetch what the app already has on screen. */
                models={models}
                numCtx={numCtx}
              />
            )}
            {showSystemMonitor && monitorTab === 'usage' && (
              <UsagePanel
                sessions={sessions}
                currentModel={selectedModel}
                onOpenChat={(id) => { setCurrentSessionId(id); setShowSystemMonitor(false); }}
                /* The panel suggests; this is the only thing that acts, and it
                   goes through the same two functions the sidebar uses -- so a
                   deletion from here is undoable by the same toast. */
                onHousekeep={(what, id) => {
                  if (what === 'delete') deleteSession(id);
                  if (what === 'archive') toggleArchived(id);
                }}
              />
            )}
                      </div>
        </Transition>

        {showCompare && (
          <ModelCompare
            models={models}
            defaultPrompt={input || [...messages].reverse().find(m => m.role === 'user')?.content || ''}
            systemPrompt={currentSession.systemPrompt !== undefined ? currentSession.systemPrompt : systemPrompt}
            options={buildOptions()}
            /* So the synthesis is written in the language being read, rather
               than in whatever the answers happened to come back in. */
            language={promptLanguageName(lang)}
            onClose={() => setShowCompare(false)}
          />
        )}

        <Transition open={!!promptFill} duration={180} className="settings-overlay" onClick={() => setPromptFill(null)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={promptFill?.name || t('prompts.fillTitle')} ref={promptFillDialogRef}
            onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
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

        {/* Tagging a chat.
            A dialog rather than an inline field on the row, because the useful
            half of this is the suggestion list -- the tags already in use --
            and a list that pushes every row below it down as you type is one
            people close before reading. */}
        {/* Editing a chain.
            The problems are listed as you type rather than on save: a chain is
            minutes long to run, so "step 2 refers to step 3" has to be
            something you are told while writing it, not something you discover
            three minutes into a run. */}
        <Transition open={!!chainEditor} duration={180} className="settings-overlay"
          onClick={() => setChainEditor(null)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('chains.title')} ref={chainDialogRef}
            onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>{t('chains.title')}</h2>
              <button className="icon-btn" onClick={() => setChainEditor(null)}><X size={18} /></button>
            </div>

            {chainEditor && (() => {
              const problems = validateChain(chainEditor);
              const patchStep = (n, patch) => setChainEditor(c => ({
                ...c,
                steps: c.steps.map((step, i) => (i === n ? { ...step, ...patch } : step)),
              }));
              const problemsFor = (n) => problems.filter(x => x.step === n + 1);

              return (
                <div className="settings-group chain-editor">
                  <label>{t('chains.name')}</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={chainEditor.name}
                    autoFocus
                    maxLength={60}
                    onChange={e => setChainEditor(c => ({ ...c, name: e.target.value }))}
                  />

                  {chainEditor.steps.map((step, n) => (
                    <div className="chain-editor-step" key={step.id}>
                      <div className="chain-editor-head">
                        <span className="chain-step-n">{n + 1}</span>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder={t('chains.stepTitle')}
                          value={step.title}
                          maxLength={60}
                          onChange={e => patchStep(n, { title: e.target.value })}
                        />
                        <button
                          className="variant-btn"
                          title={t('common.remove')}
                          disabled={chainEditor.steps.length <= 1}
                          onClick={() => setChainEditor(c => ({ ...c, steps: c.steps.filter((x, i) => i !== n) }))}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <textarea
                        className="settings-textarea"
                        placeholder={t('chains.stepPrompt')}
                        value={step.prompt}
                        style={{ minHeight: '70px' }}
                        onChange={e => patchStep(n, { prompt: e.target.value })}
                      />
                      {/* What this step will actually be handed. */}
                      <div className="chain-editor-refs">
                        {referencesIn(step.prompt).map(ref => (
                          <code key={ref}>{`{{${ref}}}`}</code>
                        ))}
                      </div>
                      {problemsFor(n).map((problem, i) => (
                        <div className={`chain-editor-problem is-${problem.kind}`} key={i}>
                          {problem.kind === 'forward' && t('chains.forward', { step: problem.step, refers: problem.refers })}
                          {problem.kind === 'noPrevious' && t('chains.noPrevious')}
                          {problem.kind === 'blank' && t('chains.blank')}
                          {problem.kind === 'noInput' && t('chains.noInput')}
                        </div>
                      ))}
                    </div>
                  ))}

                  <div className="routing-actions">
                    <button
                      className="icon-btn bordered"
                      disabled={chainEditor.steps.length >= MAX_STEPS}
                      onClick={() => setChainEditor(c => ({ ...c, steps: [...c.steps, newStep('', '{{previous}}')] }))}
                    >
                      <Plus size={13} />
                      <span style={{ marginInlineStart: '0.3rem' }}>{t('chains.addStep')}</span>
                    </button>
                    <button
                      className="auth-submit profile-save"
                      disabled={blocking(problems).length > 0}
                      onClick={() => {
                        const held = chains.some(c => c.id === chainEditor.id);
                        persistChains(held
                          ? chains.map(c => (c.id === chainEditor.id ? chainEditor : c))
                          : [...chains, chainEditor]);
                        setChainEditor(null);
                      }}
                    >
                      {t('common.save')}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </Transition>

        <Transition open={tagEditorFor !== null} duration={180} className="settings-overlay"
          onClick={() => setTagEditorFor(null)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('tags.edit')} ref={tagDialogRef}
            onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ marginBottom: 0 }}>{t('tags.edit')}</h2>
              <button className="icon-btn" onClick={() => setTagEditorFor(null)}><X size={18} /></button>
            </div>

            {(() => {
              const target = sessions.find(x => x.id === tagEditorFor);
              if (!target) return null;
              const held = tagsOf(target);
              const offered = suggestTags(sessions, tagDraft)
                .filter(entry => !held.some(t => t.toLowerCase() === entry.tag.toLowerCase()));
              // Only for a chat with none: a chat that already carries tags has
              // been thought about, and second-guessing that is noise.
              const guessed = suggestForChat(sessions, target);
              const commit = () => {
                const clean = cleanTag(tagDraft);
                if (!clean) return;
                tagSession(target.id, clean);
                setTagDraft('');
              };

              return (
                <div className="settings-group tag-editor">
                  <div className="tag-editor-current">
                    {held.length === 0 && <span className="usage-detail">{t('tags.none')}</span>}
                    {held.map(tag => (
                      <span className="chat-tag is-editable" key={tag}>
                        {tag}
                        <button type="button" title={t('common.remove')}
                          onClick={() => untagSession(target.id, tag)}>
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>

                  <input
                    type="text"
                    className="settings-input"
                    placeholder={t('tags.add')}
                    value={tagDraft}
                    autoFocus
                    maxLength={40}
                    disabled={held.length >= MAX_PER_CHAT}
                    onChange={e => setTagDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commit(); }
                      // Backspace on an empty box takes the last one off, which
                      // is what every tag field anybody has used does.
                      if (e.key === 'Backspace' && !tagDraft && held.length) {
                        untagSession(target.id, held[held.length - 1]);
                      }
                    }}
                  />
                  {held.length >= MAX_PER_CHAT && (
                    <div className="usage-detail">{t('tags.full', { count: MAX_PER_CHAT })}</div>
                  )}

                  {offered.length > 0 && (
                    <div className="tag-editor-suggestions">
                      <div className="usage-detail">{t('tags.existing')}</div>
                      {offered.map(entry => (
                        <button type="button" className="chat-tag" key={entry.tag}
                          onClick={() => { tagSession(target.id, entry.tag); setTagDraft(''); }}>
                          {entry.tag}
                          <span className="chat-tag-count">{entry.count}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {guessed.length > 0 && !tagDraft && (
                    <div className="tag-editor-suggestions">
                      <div className="usage-detail">{t('tags.guessed')}</div>
                      {guessed.map(tag => (
                        <button type="button" className="chat-tag" key={tag}
                          onClick={() => tagSession(target.id, tag)}>
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </Transition>

        <Transition open={!!folderDialog} duration={180} className="settings-overlay" onClick={() => setFolderDialog(null)}>
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={folderDialog?.id ? t('folders.edit') : t('folders.new')} ref={folderDialogRef}
            onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
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

            {/* What turns a folder into a project.
                A folder already carries a system prompt, which says how to
                answer; documents say what to answer *from*. Together they are
                the two halves of "these chats are about this", and every chat
                in the folder gets both without attaching anything again. */}
            {folderDialog?.id && (
              <div className="settings-group">
                <label>{t('folders.documents')}</label>
                <input
                  type="file"
                  multiple
                  ref={folderDocRef}
                  style={{ display: 'none' }}
                  onChange={e => { pinToFolder(folderDialog.id, Array.from(e.target.files)); e.target.value = ''; }}
                />
                <button
                  className="icon-btn bordered"
                  onClick={() => folderDocRef.current?.click()}
                  disabled={!!folderIngest}
                >
                  {folderIngest
                    ? <><RefreshCcw size={13} className="spin" /> {folderIngest}</>
                    : <><Upload size={13} /> {t('folders.addDocument')}</>}
                </button>

                <div className="rag-list" style={{ marginTop: '0.5rem' }}>
                  {knowledge.filter(d => String(d.folderId) === String(folderDialog.id)).map(doc => (
                    <div className="rag-item" key={doc.id}>
                      <FileText size={14} />
                      <div className="rag-item-meta">
                        <div className="rag-item-name">{doc.name}</div>
                        <div className="rag-item-detail">{t('rag.chunks', { count: doc.chunks?.length || 0 })}</div>
                      </div>
                      <button
                        className="icon-btn"
                        style={{ color: 'var(--danger)' }}
                        title={t('common.delete')}
                        onClick={async () => setKnowledge(await removeDocument(profileScope, doc.id))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {knowledge.filter(d => String(d.folderId) === String(folderDialog.id)).length === 0 && !folderIngest && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{t('folders.noDocuments')}</div>
                  )}
                </div>
                <div className="setting-help">{t('folders.documentsHelp')}</div>
              </div>
            )}

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
          <div className="cmd-palette" role="dialog" aria-modal="true"
            aria-label={t('palette.placeholder')} ref={paletteDialogRef} onClick={e => e.stopPropagation()}>
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
          <div className="settings-modal" role="dialog" aria-modal="true"
            aria-label={t('settings.shortcuts')} ref={shortcutsDialogRef}
            onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h2 style={{ marginBottom: 0 }}>{t('settings.shortcuts')}</h2>
                <button className="icon-btn" onClick={() => setShowShortcuts(false)}><X size={18} /></button>
              </div>
              {[
                { keys: ['Ctrl', 'K'], desc: t('keys.palette') },
                { keys: ['Ctrl', 'Shift', 'O'], desc: t('keys.newChat') },
                { keys: ['Ctrl', 'B'], desc: t('keys.sidebar') },
                { keys: ['Ctrl', ','], desc: t('keys.settings') },
                { keys: ['Ctrl', 'F'], desc: t('keys.find') },
                { keys: ['Ctrl', '\\'], desc: t('keys.artifact') },
                { keys: ['Ctrl', '/'], desc: t('keys.thisList') },
                { keys: ['Esc'], desc: t('keys.escape') },
                { keys: ['Enter'], desc: t('keys.send') },
                { keys: ['Shift', 'Enter'], desc: t('keys.newline') },
                { keys: ['/'], desc: t('keys.slash') },
                { keys: ['↑'], desc: t('keys.recall') },
                { keys: ['Ctrl', 'V'], desc: t('keys.pasteImage') },
                { keys: ['Double-click'], desc: t('keys.doubleClick') },
                { keys: ['Drag'], desc: t('keys.drag') },
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
