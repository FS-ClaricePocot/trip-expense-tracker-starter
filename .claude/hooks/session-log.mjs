#!/usr/bin/env node
// Writes a usage log per Claude Code session to docs/activities-outputs/session-logs/.
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
const NON_PROMPT_TAGS = /^<(local-command-stdout|local-command-caveat|local-command-stderr|task-notification|side-sessions-event|ci-monitor-event|bash-stdout|bash-stderr)/;
const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const BUILT_IN_COMMANDS = new Set([
  'init', 'clear', 'compact', 'config', 'cost', 'doctor', 'help', 'hooks', 'login', 'logout',
  'mcp', 'memory', 'model', 'permissions', 'review', 'status', 'resume', 'rewind', 'context',
  'agents', 'add-dir', 'export', 'usage', 'plugin', 'effort', 'fast', 'rename', 'import',
]);

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
  const seenMsg = new Map(); // message.id -> { turn, usage }
  let first, last;
  for (const e of entries) {
    if (e.timestamp) { first = first || e.timestamp; last = e.timestamp; }
    const text = promptText(e);
    if (text !== null) {
      turns.push({ text, slash: parseSlash(text), models: new Set(), tokens: emptyTokens(), skills: {}, agents: {}, tools: {}, newPlan: false, msgIds: [] });
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain || !turns.length) continue;
    const turn = turns[turns.length - 1];
    const msg = e.message || {};
    if (msg.model && msg.model !== '<synthetic>') turn.models.add(msg.model);
    if (msg.id) {
      if (!seenMsg.has(msg.id)) turn.msgIds.push(msg.id);
      seenMsg.set(msg.id, { turn, usage: msg.usage });
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
  for (const { turn, usage } of seenMsg.values()) addUsage(turn.tokens, usage);
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
      skills, agents,
    };
  });

  const subagents = subagentUsage(transcriptPath, sessionId);
  const mainTokens = sumTokens(taskRows.map((t) => t.tokens));
  return {
    sessionId,
    title: title || 'Untitled session', // never fall back to prompt text (it shows in the log heading)
    start: first, end: last,
    prompts: turns.length,
    models: [...new Set([...taskRows.flatMap((t) => t.models), ...subagents.models])],
    tokens: mainTokens,
    subagentTokens: subagents.tokens,
    totalTokens: sumTokens([mainTokens, subagents.tokens]),
    skills: mergeCounts(taskRows.map((t) => t.skills)),
    agents: mergeCounts(taskRows.map((t) => t.agents)),
    tasks: taskRows,
  };
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
function subagentUsage(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  const tokens = emptyTokens();
  const models = new Set();
  if (!fs.existsSync(dir)) return { tokens, models: [] };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const seen = new Map();
    for (const e of readJsonl(path.join(dir, f))) {
      if (e.type !== 'assistant' || !e.message) continue;
      if (e.message.model && e.message.model !== '<synthetic>') models.add(e.message.model);
      if (e.message.id) seen.set(e.message.id, e.message.usage);
    }
    for (const u of seen.values()) addUsage(tokens, u);
  }
  return { tokens, models: [...models] };
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
  L.push('| Source | Input | Output | Cache write | Cache read | Total |', '|---|---:|---:|---:|---:|---:|');
  const row = (name, t) => L.push(`| ${name} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheWrite)} | ${fmt(t.cacheRead)} | ${fmt(total(t))} |`);
  row('Main conversation', log.tokens);
  if (total(log.subagentTokens)) row('Subagents', log.subagentTokens);
  row('**Session total**', log.totalTokens);
  L.push('');

  L.push('## Tasks', '');
  L.push('| # | Task | Prompts | Model | Input | Output | Cache write | Cache read | Total | Skills | Agents |');
  L.push('|---:|---|---:|---|---:|---:|---:|---:|---:|---|---|');
  log.tasks.forEach((t, i) => {
    L.push(`| ${i + 1} | ${cell(t.description)} | ${t.prompts} | ${t.models.join(', ') || '—'} | ${fmt(t.tokens.input)} | ${fmt(t.tokens.output)} | ${fmt(t.tokens.cacheWrite)} | ${fmt(t.tokens.cacheRead)} | ${fmt(total(t.tokens))} | ${cell(countList(t.skills))} | ${cell(countList(t.agents))} |`);
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

// Never fail the hook; errors go to .hook-errors.log in the log dir (stderr too with SESSION_LOG_DEBUG=1).
main().catch(logError).finally(() => process.exit(0));
