#!/usr/bin/env node
// Reminds you to /clear after a plan task is committed.
//
// Runs as a Stop hook after every reply. It remembers the git HEAD it last saw in this session.
// When HEAD has moved and the new commits include a plan task (a subject starting "F<N>.T<k>"),
// it shows a one-line reminder: the task is safe in git, so a fresh conversation can pick up
// from there. The reminder is a systemMessage: shown to you only, NOT sent to the model, so the
// hook costs no tokens.
//
// It only looks at git, so it can't tell when a background agent is still working. The wording
// says to wait for that before clearing.
//
// The first run in a session only records HEAD, so it never fires for commits made before the
// session started. Turn it off with TASK_REMINDER_OFF=1. It never blocks Claude: errors are ignored.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TASK_SUBJECT = /^F\d+\.T\d+\b/;

async function main() {
  const input = await readStdinJson(); // always drain stdin, even when turned off
  if (process.env.TASK_REMINDER_OFF === '1') return;

  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (!head) return;

  const stateFile = path.join(os.tmpdir(), `claude-task-reminder-${safe(input.session_id)}.json`);
  const seen = readState(stateFile);
  fs.writeFileSync(stateFile, JSON.stringify({ head }));
  if (!seen || seen === head) return;

  // Commits since the last reply. Fall back to the HEAD commit alone if the old HEAD is gone
  // (for example after switching branches or rewriting history).
  const range = git(cwd, ['merge-base', '--is-ancestor', seen, head]) !== null ? `${seen}..${head}` : '-1';
  const log = git(cwd, ['log', '--format=%h%x09%s', range]) || '';
  const tasks = log
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([, subject]) => subject && TASK_SUBJECT.test(subject));
  if (tasks.length === 0) return;

  const ids = tasks.map(([, subject]) => subject.match(TASK_SUBJECT)[0]).reverse().join(', ');
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  const note = dirty ? ' (You still have uncommitted changes to tracked files: commit or set them aside first.)' : '';
  const message =
    `${ids} committed. Progress is in git. Once nothing is running in the background and you've ` +
    `reviewed and committed, run /clear before the next task: /implement-feature picks up from ` +
    `the commit history.${note}`;
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

/** Runs git and returns trimmed stdout, or null if it fails (not a repo, unknown commit, ...). */
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).head || null;
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
