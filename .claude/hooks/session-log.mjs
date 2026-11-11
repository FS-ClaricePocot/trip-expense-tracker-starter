#!/usr/bin/env node
// Writes a usage log per Claude Code session to docs/activities-outputs/session-logs/,
// and one line per model run to docs/activities-outputs/usage.md, e.g.
// "2026-11-10 17:50:20 - 3104k (Haiku) | $0.20".
// A model run is a stretch of the session on one model: its token count and cost restart
// when the model changes, so each model change closes one line and starts the next.
//
// Runs as a Stop / SessionEnd hook (reads the hook JSON from stdin). It is
// idempotent: every run re-derives the whole log from the session transcript.
//
// Manual use:
//   node .claude/hooks/session-log.mjs --transcript <path-to-session.jsonl>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_SUBDIR = ['docs', 'activities-outputs', 'session-logs'];
const ERROR_FILE = '.hook-errors.log';
const USAGE_FILE = 'usage.md'; // sits next to the session-logs folder
const NON_PROMPT_TAGS = /^<(local-command-stdout|local-command-caveat|local-command-stderr|task-notification|side-sessions-event|ci-monitor-event|bash-stdout|bash-stderr)/;
const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const BUILT_IN_COMMANDS = new Set([
  'init', 'clear', 'compact', 'config', 'cost', 'doctor', 'help', 'hooks', 'login', 'logout',
  'mcp', 'memory', 'model', 'permissions', 'review', 'status', 'resume', 'rewind', 'context',
  'agents', 'add-dir', 'export', 'usage', 'plugin', 'effort', 'fast', 'rename', 'import',
]);

// ---------- pricing ----------
// USD per million tokens, from the Claude API pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-10).
// cw5m / cw1h: 5-minute / 1-hour cache writes. hit: cache read.
// Haiku 5.5 costs more on a request whose prompt (input + cache tokens) is over 100,000 tokens: `long`.
const price = (input, cw5m, cw1h, hit, output) => ({ input, cw5m, cw1h, hit, output });
const FABLE_5_2 = price(8, 10, 16, 0.20, 40);
const FABLE_5_1 = price(10, 12.5, 20, 0.25, 50);
const FABLE_5 = price(10, 12.5, 20, 1, 50);
const OPUS_5_5 = price(4, 5, 8, 0.20, 20);
const OPUS_5 = price(5, 6.25, 10, 0.50, 25);
const OPUS_4_1 = price(15, 18.75, 30, 1.50, 75);
const SONNET_5_5 = price(2, 2.5, 4, 0.10, 10);
const SONNET_5 = price(2, 2.5, 4, 0.20, 10);
const SONNET_4 = price(3, 3.75, 6, 0.30, 15);
const HAIKU_5_5 = { ...price(0.10, 0.125, 0.20, 0.01, 0.50), long: price(0.50, 0.625, 1, 0.05, 2.50) };
const HAIKU_4_5 = price(1, 1.25, 2, 0.10, 5);
const PRICE = {
  'fable-5-2': FABLE_5_2, 'mythos-5-2': FABLE_5_2,
  'fable-5-1': FABLE_5_1, 'mythos-5-1': FABLE_5_1,
  'fable-5': FABLE_5, 'mythos-5': FABLE_5,
  'opus-5-5': OPUS_5_5,
  'opus-5': OPUS_5, 'opus-4-8': OPUS_5, 'opus-4-7': OPUS_5, 'opus-4-6': OPUS_5, 'opus-4-5': OPUS_5,
  'opus-4-1': OPUS_4_1, 'opus-4': OPUS_4_1,
  'sonnet-5-5': SONNET_5_5,
  'sonnet-5': SONNET_5,
  'sonnet-4-6': SONNET_4, 'sonnet-4-5': SONNET_4, 'sonnet-4': SONNET_4,
  'haiku-5-5': HAIKU_5_5,
  'haiku-4-5': HAIKU_4_5,
};
const LONG_PROMPT_TOKENS = 100000;
const FAST_MULTIPLIER = 2;      // fast mode costs 2x standard on the models that offer it
const US_ONLY_MULTIPLIER = 1.1; // inference_geo "us"

// Price row for a model ID: "claude-haiku-5-5", "anthropic/claude-haiku-5.5" and
// "claude-haiku-4-5-20251001" map to "haiku-5-5", "haiku-5-5" and "haiku-4-5".
function priceKey(model) {
  const m = String(model || '').toLowerCase().match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:[-.](\d))?(?!\d)/);
  return m ? `${m[1]}-${m[2]}${m[3] === undefined ? '' : `-${m[3]}`}` : null;
}

// USD for one API call, priced from that call's own usage (Haiku 5.5's long-prompt rate applies per request).
// Returns null when the model has no price row.
function callCost(model, usage) {
  const base = PRICE[priceKey(model)];
  if (!base) return null;
  const u = usage || {};
  const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
  const input = u.input_tokens || 0;
  const hit = u.cache_read_input_tokens || 0;
  const output = u.output_tokens || 0;
  const r = base.long && input + cw5m + cw1h + hit > LONG_PROMPT_TOKENS ? base.long : base;
  let usd = (input * r.input + cw5m * r.cw5m + cw1h * r.cw1h + hit * r.hit + output * r.output) / 1e6;
  if (u.speed === 'fast') usd *= FAST_MULTIPLIER;
  if (u.inference_geo === 'us') usd *= US_ONLY_MULTIPLIER;
  return usd;
}

// Sums the cost of a list of calls. `unpriced` is true when a call's model has no price row,
// so the total is incomplete and is shown as n/a.
function costOf(calls) {
  let usd = 0;
  let unpriced = false;
  for (const c of calls) {
    const x = callCost(c.model, c.usage);
    if (x === null) unpriced = true;
    else usd += x;
  }
  return { usd, unpriced };
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.length ? {} : await readStdinJson();
  const projectDir = toNative(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const logDir = path.join(projectDir, ...LOG_SUBDIR);
  fs.mkdirSync(logDir, { recursive: true });
  errorLog = path.join(logDir, ERROR_FILE);
  flushErrors();

  const ignored = readIgnoreList(projectDir);
  // Drop logs of ignored sessions (sessions run in this folder that aren't TakeAway work).
  for (const f of fs.readdirSync(logDir)) {
    if ([...ignored].some((id) => f.endsWith(`-${id.slice(0, 8)}.md`))) fs.rmSync(path.join(logDir, f));
  }

  const ti = args.indexOf('--transcript');
  const transcriptPath = toNative(ti >= 0 ? args[ti + 1] : input.transcript_path);
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const log = buildSessionLog(transcriptPath, projectDir);
    if (log.prompts > 0 && !ignored.has(log.sessionId)) writeSessionLog(logDir, log);
  }
  writeUsageFile(logDir, path.join(logDir, '..', USAGE_FILE));
}

// Session IDs (one per line, # comments) that must never be logged.
function readIgnoreList(projectDir) {
  const file = path.join(projectDir, '.claude', 'hooks', 'session-log.ignore');
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}

function readStdinJson() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => {
      // Windows tools (e.g. PowerShell pipes) may prepend a UTF-8 BOM, which JSON.parse rejects.
      try { resolve(JSON.parse(raw.replace(/^﻿/, '') || '{}')); } catch (e) { logError(e); resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

// Git Bash-style paths (/c/Users/...) are not understood by Node on Windows.
function toNative(p) {
  if (!p || process.platform !== 'win32') return p;
  return p.replace(/^\/([a-z])(?=\/|$)/i, (_, d) => `${d.toUpperCase()}:`);
}

// Windows can hold a brief lock on a file another hook run is writing (EBUSY/EPERM): retry.
function writeFileRetry(file, data, attempts = 5) {
  for (let i = 1; ; i++) {
    try { return fs.writeFileSync(file, data); } catch (e) {
      if (i >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}

// Errors go to <log dir>/.hook-errors.log (and stderr with SESSION_LOG_DEBUG=1); never fail the hook.
// Errors raised before the log dir is known (e.g. bad stdin) are held until it is.
let errorLog = null;
const pendingErrors = [];

function logError(e) {
  if (process.env.SESSION_LOG_DEBUG) console.error(e);
  pendingErrors.push(`${new Date().toISOString()} ${e?.stack || e}\n`);
  flushErrors();
}

function flushErrors() {
  if (!errorLog || !pendingErrors.length) return;
  try { fs.appendFileSync(errorLog, pendingErrors.splice(0).join('')); } catch {}
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// ---------- transcript parsing ----------

function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  const c = entry.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  } else return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || NON_PROMPT_TAGS.test(text) || text.startsWith('[Request interrupted')) return null;
  return text;
}

function parseSlash(text) {
  const m = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (!m) return null;
  const a = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return { name: m[1].trim(), args: (a?.[1] || '').trim() };
}

function emptyTokens() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function addUsage(t, u) {
  if (!u) return;
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheWrite += u.cache_creation_input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
}

function sumTokens(list) {
  const t = emptyTokens();
  for (const x of list) for (const k of Object.keys(t)) t[k] += x[k];
  return t;
}

// User-level skills/commands/agents live in CLAUDE_CONFIG_DIR when set (e.g. by claude-openrouter.ps1), else ~/.claude.
function userConfigDir() {
  return toNative(process.env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), '.claude');
}

function classifySkill(name, projectDir) {
  if (name.includes(':')) return 'plugin';
  if (fs.existsSync(path.join(projectDir, '.claude', 'skills', name))) return 'custom (project)';
  if (fs.existsSync(path.join(projectDir, '.claude', 'commands', `${name}.md`))) return 'custom (project)';
  if (fs.existsSync(path.join(userConfigDir(), 'skills', name))) return 'custom (user)';
  if (fs.existsSync(path.join(userConfigDir(), 'commands', `${name}.md`))) return 'custom (user)';
  if (BUILT_IN_COMMANDS.has(name)) return 'built-in command';
  return 'built-in / bundled';
}

function classifyAgent(name, projectDir) {
  if (fs.existsSync(path.join(projectDir, '.claude', 'agents', `${name}.md`))) return 'custom (project)';
  if (fs.existsSync(path.join(userConfigDir(), 'agents', `${name}.md`))) return 'custom (user)';
  return 'built-in';
}

function bump(map, key, kind) {
  map[key] = map[key] || { count: 0, kind };
  map[key].count++;
}

function buildSessionLog(transcriptPath, projectDir) {
  const entries = readJsonl(transcriptPath);
  const sessionId = entries.find((e) => e.sessionId)?.sessionId || path.basename(transcriptPath, '.jsonl');
  const title = [...entries].reverse().find((e) => e.type === 'custom-title')?.customTitle;
  const usesPlanTool = entries.some((e) => e.type === 'assistant'
    && e.message?.content?.some?.((b) => b.type === 'tool_use' && b.name === PLAN_TOOL));

  // One "turn" per user prompt; assistant messages attach to the latest prompt.
  const turns = [];
  const seenMsg = new Map(); // message.id -> { turn, usage, model, ts }
  let first, last;
  for (const e of entries) {
    if (e.timestamp) { first = first || e.timestamp; last = e.timestamp; }
    const text = promptText(e);
    if (text !== null) {
      turns.push({ text, slash: parseSlash(text), models: new Set(), tokens: emptyTokens(), calls: [], skills: {}, agents: {}, tools: {}, newPlan: false, msgIds: [] });
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain || !turns.length) continue;
    const turn = turns[turns.length - 1];
    const msg = e.message || {};
    if (msg.model && msg.model !== '<synthetic>') turn.models.add(msg.model);
    if (msg.id) {
      if (!seenMsg.has(msg.id)) turn.msgIds.push(msg.id);
      seenMsg.set(msg.id, { turn, usage: msg.usage, model: msg.model, ts: e.timestamp });
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      // Claude's last text in the turn is its final reply, which opens with a summary of the work.
      if (b.type === 'text' && b.text?.trim()) turn.reply = b.text;
      if (b.type !== 'tool_use') continue;
      turn.tools[b.name] = (turn.tools[b.name] || 0) + 1;
      if (b.name === PLAN_TOOL && Array.isArray(b.input?.items)) {
        turn.newPlan = true;
        // Claude's own step labels for the task: used as its summary (never the prompt text).
        turn.planSteps = turn.planSteps || b.input.items.map((i) => String(i?.content || '').trim()).filter(Boolean);
      }
      if (b.name === 'Skill' && b.input?.skill) bump(turn.skills, b.input.skill, classifySkill(b.input.skill, projectDir));
      if (AGENT_TOOLS.has(b.name)) {
        const type = b.input?.subagent_type || 'general-purpose';
        bump(turn.agents, type, classifyAgent(type, projectDir));
      }
    }
  }
  // Usage is repeated on every content block of a message: count each message once.
  const messages = [...seenMsg.values()];
  for (const { turn, usage } of messages) addUsage(turn.tokens, usage);
  // Priced calls: real models only (synthetic messages carry no usage).
  const calls = messages.filter((c) => c.model && c.model !== '<synthetic>');
  for (const c of calls) c.turn.calls.push(c);
  for (const t of turns) if (t.slash) bump(t.skills, t.slash.name, classifySkill(t.slash.name, projectDir));

  // Group turns into tasks. A task starts with the first prompt, a slash command,
  // or a turn that lays out a new plan; follow-ups without a new plan join the task.
  const tasks = [];
  turns.forEach((t, i) => {
    const starts = i === 0 || !usesPlanTool || t.slash || t.newPlan;
    if (starts) tasks.push({ turns: [] });
    tasks[tasks.length - 1].turns.push(t);
  });
  tasks.forEach((task, i) => { task.description = describe(task, i + 1); });

  const taskRows = tasks.map((task) => {
    const skills = {}, agents = {};
    for (const t of task.turns) {
      for (const [k, v] of Object.entries(t.skills)) { skills[k] = skills[k] || { count: 0, kind: v.kind }; skills[k].count += v.count; }
      for (const [k, v] of Object.entries(t.agents)) { agents[k] = agents[k] || { count: 0, kind: v.kind }; agents[k].count += v.count; }
    }
    return {
      description: task.description,
      prompts: task.turns.length,
      models: [...new Set(task.turns.flatMap((t) => [...t.models]))],
      tokens: sumTokens(task.turns.map((t) => t.tokens)),
      cost: costOf(task.turns.flatMap((t) => t.calls)),
      skills, agents,
    };
  });

  const subagents = subagentUsage(transcriptPath, sessionId);
  const mainTokens = sumTokens(taskRows.map((t) => t.tokens));
  const mainCalls = calls
    .map((c) => ({ model: c.model, ts: c.ts, usage: c.usage }))
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return {
    sessionId,
    title: title || 'Untitled session', // never fall back to prompt text (it shows in the log heading)
    start: first, end: last,
    prompts: turns.length,
    models: [...new Set([...taskRows.flatMap((t) => t.models), ...subagents.models])],
    tokens: mainTokens,
    subagentTokens: subagents.tokens,
    totalTokens: sumTokens([mainTokens, subagents.tokens]),
    mainCost: costOf(mainCalls),
    subagentCost: costOf(subagents.calls),
    cost: costOf([...mainCalls, ...subagents.calls]),
    segments: buildSegments(mainCalls, subagents.calls),
    skills: mergeCounts(taskRows.map((t) => t.skills)),
    agents: mergeCounts(taskRows.map((t) => t.agents)),
    tasks: taskRows,
  };
}

// A model run is a stretch of main-conversation calls on one model; a model change starts a new run,
// and its tokens and cost start from zero. Subagent calls count toward the run that was active when
// they ran (priced at their own model). Calls are {model, ts, usage}, sorted by ts.
function buildSegments(mainCalls, subCalls) {
  const same = (a, b) => (priceKey(a) || a) === (priceKey(b) || b);
  const segs = [];
  for (const c of mainCalls) {
    let seg = segs[segs.length - 1];
    if (!seg || !same(seg.model, c.model)) {
      seg = { model: c.model, start: c.ts, end: c.ts, tokens: emptyTokens(), calls: [] };
      segs.push(seg);
    }
    seg.end = c.ts;
    seg.calls.push(c);
  }
  for (const c of subCalls) {
    const seg = segs.findLast((s) => s.start <= c.ts) || segs[0];
    if (!seg) continue;
    seg.calls.push(c);
    if (c.ts > seg.end) seg.end = c.ts;
  }
  for (const seg of segs) {
    for (const c of seg.calls) addUsage(seg.tokens, c.usage);
    seg.cost = costOf(seg.calls);
  }
  return segs;
}

// Never record prompt text (or slash-command arguments). The summary comes from Claude's
// side only, prefixed with the slash command if any, in this order:
//   1. the task's first plan (Claude's step labels);
//   2. the opening sentence of Claude's final reply to the task's first prompt;
//   3. the tools Claude used ("Tools: Bash ×2, Edit ×1");
//   4. "Task N".
function describe(task, n) {
  const first = task.turns[0];
  const steps = task.turns.find((t) => t.planSteps?.length)?.planSteps;
  const tools = Object.entries(first.tools).map(([k, c]) => `${k} ×${c}`).join(', ');
  const summary = steps ? truncate(steps.join(' · '), 160)
    : replySummary(first.reply) || (tools ? `Tools: ${tools}` : '');
  const label = first.slash ? `/${first.slash.name}` : '';
  if (label && summary) return `${label}: ${summary}`;
  return label || summary || `Task ${n}`;
}

// Opening sentence of a reply as plain text: skips headings, tables and code, strips
// Markdown, and adds the next sentence when the first is a bare "Yes." / "Partly.".
function replySummary(reply) {
  if (!reply) return '';
  const para = reply.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)
    .map((p) => p.trim()).find((p) => p && !/^(#|\||>|-{3,})/.test(p));
  if (!para) return '';
  const plain = para
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images -> their text
    .replace(/\*\*|__|`/g, '')                 // bold and code marks (keeps CLAUDE_CONFIG_DIR intact)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')   // list markers
    .replace(/\s+/g, ' ').trim();
  // Sentence ends need trailing space, so "session-log.mjs" stays whole.
  const sentences = plain.split(/(?<=[.!?])\s+/);
  let s = sentences[0];
  if (s.length < 40 && sentences[1]) s += ` ${sentences[1]}`;
  return truncate(s, 160);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function mergeCounts(maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) {
    out[k] = out[k] || { count: 0, kind: v.kind };
    out[k].count += v.count;
  }
  return out;
}

// Subagent transcripts live next to the session transcript: <dir>/<sessionId>/subagents/*.jsonl
// Returns the token totals, the models, and each counted message as a call {model, ts, usage}.
function subagentUsage(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  const tokens = emptyTokens();
  const models = new Set();
  const calls = [];
  if (!fs.existsSync(dir)) return { tokens, models: [], calls };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const seen = new Map();
    for (const e of readJsonl(path.join(dir, f))) {
      if (e.type !== 'assistant' || !e.message) continue;
      if (e.message.model && e.message.model !== '<synthetic>') models.add(e.message.model);
      if (e.message.id) seen.set(e.message.id, { model: e.message.model, ts: e.timestamp, usage: e.message.usage });
    }
    for (const c of seen.values()) {
      addUsage(tokens, c.usage);
      if (c.model && c.model !== '<synthetic>') calls.push(c);
    }
  }
  return { tokens, models: [...models], calls };
}

// ---------- rendering ----------

const fmt = (n) => (n || 0).toLocaleString('en-US');
const total = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const cell = (s) => String(s).replace(/\|/g, '\\|');
const localDate = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const localTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { hour12: false }) : '');
const countList = (m) => Object.entries(m).map(([k, v]) => `${k} ×${v.count}`).join(', ') || '—';
const money = (c) => (c.unpriced ? 'n/a' : `$${c.usd.toFixed(4)}`);

function sessionFileName(log) {
  return `${localDate(log.start)}-${log.sessionId.slice(0, 8)}.md`;
}

function writeSessionLog(logDir, log) {
  const L = [];
  L.push(`# Session ${localDate(log.start)} · ${cell(log.title)}`, '');
  L.push('_Generated by `.claude/hooks/session-log.mjs`. Do not edit by hand; it is rewritten after every turn._', '');
  L.push(`- **Session ID:** \`${log.sessionId}\``);
  L.push(`- **Started:** ${localTime(log.start)} · **Last activity:** ${localTime(log.end)}`);
  L.push(`- **Prompts:** ${log.prompts} · **Tasks:** ${log.tasks.length}`);
  L.push(`- **Models:** ${log.models.join(', ') || '—'}`, '');

  L.push('## Token usage', '');
  L.push('Cost is estimated from the Claude API list prices in the hook script (USD).', '');
  L.push('| Source | Input | Output | Cache write | Cache read | Total | Cost |', '|---|---:|---:|---:|---:|---:|---:|');
  const row = (name, t, cost) => L.push(`| ${name} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheWrite)} | ${fmt(t.cacheRead)} | ${fmt(total(t))} | ${money(cost)} |`);
  row('Main conversation', log.tokens, log.mainCost);
  if (total(log.subagentTokens)) row('Subagents', log.subagentTokens, log.subagentCost);
  row('**Session total**', log.totalTokens, log.cost);
  L.push('');

  L.push('## Model segments', '');
  L.push('A segment is one run on a single model. Its count restarts when the model changes. Subagent usage counts toward the segment that was running when it ran.', '');
  L.push('| # | Model | Started | Last activity | Input | Output | Cache write | Cache read | Total | Cost |', '|---:|---|---|---|---:|---:|---:|---:|---:|---:|');
  log.segments.forEach((s, i) => {
    const t = s.tokens;
    L.push(`| ${i + 1} | ${cell(s.model)} | ${localTime(s.start)} | ${localTime(s.end)} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheWrite)} | ${fmt(t.cacheRead)} | ${fmt(total(t))} | ${money(s.cost)} |`);
  });
  if (!log.segments.length) L.push('None.');
  L.push('');

  L.push('## Tasks', '');
  L.push('| # | Task | Prompts | Model | Input | Output | Cache write | Cache read | Total | Cost | Skills | Agents |');
  L.push('|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---|---|');
  log.tasks.forEach((t, i) => {
    L.push(`| ${i + 1} | ${cell(t.description)} | ${t.prompts} | ${t.models.join(', ') || '—'} | ${fmt(t.tokens.input)} | ${fmt(t.tokens.output)} | ${fmt(t.tokens.cacheWrite)} | ${fmt(t.tokens.cacheRead)} | ${fmt(total(t.tokens))} | ${money(t.cost)} | ${cell(countList(t.skills))} | ${cell(countList(t.agents))} |`);
  });
  L.push('');

  L.push('## Skills & agents', '');
  const skillRows = Object.entries(log.skills);
  const agentRows = Object.entries(log.agents);
  if (!skillRows.length && !agentRows.length) L.push('None used.');
  else {
    L.push('| Name | Type | Kind | Uses |', '|---|---|---|---:|');
    for (const [k, v] of skillRows) L.push(`| ${k} | skill / command | ${v.kind} | ${v.count} |`);
    for (const [k, v] of agentRows) L.push(`| ${k} | agent | ${v.kind} | ${v.count} |`);
  }
  L.push('');

  // Remove an older file for this session if its name changed (e.g. date logic).
  for (const f of fs.readdirSync(logDir)) {
    if (f !== sessionFileName(log) && f.endsWith(`-${log.sessionId.slice(0, 8)}.md`)) fs.rmSync(path.join(logDir, f));
  }
  writeFileRetry(path.join(logDir, sessionFileName(log)), L.join('\n'));
}

// usage.md has no session IDs, and this hook runs after every turn, so it is rebuilt from the
// session logs each time: one line per model run, and the open run's line updates in place.
function writeUsageFile(logDir, usageFile) {
  const lines = [];
  for (const f of fs.readdirSync(logDir).filter((n) => n.endsWith('.md'))) {
    const found = usageLines(fs.readFileSync(path.join(logDir, f), 'utf8'));
    if (found.length) lines.push(...found);
    else logError(`usage.md: no model segments or session total found in ${f}`);
  }
  writeFileRetry(usageFile, lines.sort().map((l) => `${l}\n`).join(''));
}

// "2026-11-10 17:50:20 - 3104k (Haiku) | $0.20", one line per row of the log's Model segments table.
// The stamp is the run's last activity; the count is its total tokens, subagents included.
function usageLines(markdown) {
  const section = markdown.match(/## Model segments\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
  const lines = [];
  for (const row of section.split('\n').filter((l) => /^\| \d+ \|/.test(l))) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    // cells: #, Model, Started, Last activity, Input, Output, Cache write, Cache read, Total, Cost
    const stamp = dateStamp(cells[3]);
    const tokens = Number(cells[8].replace(/,/g, ''));
    if (!stamp || !Number.isFinite(tokens)) continue;
    const name = modelName(cells[1]);
    const cost = cells[9] === 'n/a' ? '$n/a' : `$${Number(cells[9].replace('$', '')).toFixed(2)}`;
    lines.push(`${stamp} - ${Math.round(tokens / 1000)}k${name ? ` (${name})` : ''} | ${cost}`);
  }
  if (lines.length) return lines;
  // Logs written before model segments: one line per session, cost unknown.
  const legacy = legacyUsageLine(markdown);
  return legacy ? [legacy] : [];
}

// "11/10/2026, 17:50:23" (as localTime writes it) -> "2026-11-10 17:50:23".
function dateStamp(text) {
  const m = String(text || '').match(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/);
  if (!m) return null;
  const [month, day, year, hour, minute, second] = m.slice(1).map(Number);
  const p = (n) => String(n).padStart(2, '0');
  // hour % 24: en-US with hour12:false renders midnight as 24:00:00.
  return `${year}-${p(month)}-${p(day)} ${p(hour % 24)}:${p(minute)}:${p(second)}`;
}

// Logs without a Model segments table: their Last activity and Session total, with cost n/a.
function legacyUsageLine(markdown) {
  const when = markdown.match(/\*\*Last activity:\*\* ([^·\n]+?)\s*$/m)?.[1];
  const tokens = markdown.match(/^\| \*\*Session total\*\* \|.*\| ([\d,]+) \|\s*$/m);
  const stamp = dateStamp(when);
  if (!stamp || !tokens) return null;
  return `${stamp} - ${Math.round(Number(tokens[1].replace(/,/g, '')) / 1000)}k${modelSuffix(markdown)} | $n/a`;
}

// " (Haiku)" or " (Haiku, Sonnet)" from the log's Models line; empty if the session used no model.
function modelSuffix(markdown) {
  const ids = markdown.match(/^- \*\*Models:\*\* (.*)$/m)?.[1].split(', ').filter((id) => id !== '—') || [];
  const names = [...new Set(ids.map(modelName))];
  return names.length ? ` (${names.join(', ')})` : '';
}

// Claude model family, whichever ID style is used (claude-haiku-5-5, anthropic/claude-haiku-5.5).
// Any other model keeps its full ID.
function modelName(id) {
  const family = String(id).match(/\b(haiku|sonnet|opus|fable|mythos)\b/i)?.[1];
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : id;
}

// Never fail the hook; errors go to .hook-errors.log in the log dir (stderr too with SESSION_LOG_DEBUG=1).
main().catch(logError).finally(() => process.exit(0));
