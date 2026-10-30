#!/usr/bin/env node
// Warns when the main conversation's context gets large, so you know when to /clear or /compact.
//
// Runs as a Stop hook after every reply. It reads the size of the last main-conversation turn
// from the transcript (input + cache read + cache write tokens) and, once that passes a
// threshold, shows a one-line warning to you. The warning is a systemMessage: it is shown in
// the UI only and is NOT sent to the model, so the hook costs no tokens.
//
// It warns once per step (default: at 80k, then every further 40k), not on every reply.
// Settings (environment variables, optional):
//   CONTEXT_WARN_TOKENS  first warning, in tokens (default 80000)
//   CONTEXT_WARN_STEP    tokens between later warnings (default 40000)
//   CONTEXT_WARN_OFF=1   turn the warning off
//
// It never blocks Claude and never fails a turn: any error is ignored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIRST = Number(process.env.CONTEXT_WARN_TOKENS) || 80_000;
const STEP = Number(process.env.CONTEXT_WARN_STEP) || 40_000;
const TAIL_BYTES = 512 * 1024;

async function main() {
  const input = await readStdinJson(); // always drain stdin, even when turned off
  if (process.env.CONTEXT_WARN_OFF === '1') return;
  const transcript = input.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return;

  const tokens = lastMainContextTokens(transcript);
  if (!tokens || tokens < FIRST) return;

  // Warn once per step, remembered per session in the temp folder.
  const level = Math.floor((tokens - FIRST) / STEP);
  const stateFile = path.join(os.tmpdir(), `claude-context-warn-${safe(input.session_id)}.json`);
  const last = readState(stateFile);
  if (last !== null && level <= last) return;
  fs.writeFileSync(stateFile, JSON.stringify({ level }));

  const k = Math.round(tokens / 1000);
  const message =
    `Context is ~${k}k tokens. Every reply re-sends all of it, and after a pause of 5+ minutes it is ` +
    `re-cached at full price. Finish or commit the current task, then run /clear ` +
    `(or /compact to keep a short summary).`;
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

/** Size of the most recent main-conversation (not subagent) turn, from its usage block. */
function lastMainContextTokens(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the tail can be cut in half
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const u = entry.message?.usage;
    if (!u) continue;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return 0;
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).level;
  } catch {
    return null;
  }
}

function safe(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
}

function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

main().catch(() => {});
