#!/usr/bin/env node
// Connects Claude Code in this project to OpenRouter.
//
// Run it once from the repository root:   node scripts/setup-openrouter.mjs
// It asks for your OpenRouter API key (the input is hidden) and writes it, with the OpenRouter base URL, to
// .claude/settings.local.json. That file is git-ignored and applies to this project only, so your other
// Claude Code projects are unchanged. The key is never printed or committed.
//
// Run it again to replace the key. To remove it:   node scripts/setup-openrouter.mjs --remove
// To pass the key without a prompt (for example in a script), set OPENROUTER_API_KEY before running it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const BASE_URL = 'https://openrouter.ai/api';
const root = process.cwd();
const settingsPath = path.join(root, '.claude', 'settings.local.json');

async function main() {
  if (!fs.existsSync(path.join(root, '.claude', 'settings.json'))) {
    fail('Run this from the repository root (the folder that contains .claude/).');
  }
  checkIgnored();

  const settings = readSettings();
  settings.env ??= {};

  if (process.argv.includes('--remove')) {
    delete settings.env.ANTHROPIC_BASE_URL;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    delete settings.env.ANTHROPIC_API_KEY;
    writeSettings(settings);
    console.log('Removed the OpenRouter settings from .claude/settings.local.json.');
    return;
  }

  const key = (process.env.OPENROUTER_API_KEY || (await askHidden('OpenRouter API key: '))).trim();
  if (!key) fail('No key entered. Nothing was changed.');
  if (!key.startsWith('sk-or-')) fail('That does not look like an OpenRouter key (they start with "sk-or-"). Nothing was changed.');

  settings.env.ANTHROPIC_BASE_URL = BASE_URL;
  settings.env.ANTHROPIC_AUTH_TOKEN = key;
  settings.env.ANTHROPIC_API_KEY = ''; // must be empty, so Claude Code uses the token above
  writeSettings(settings);

  console.log(`Saved your key (ending ${key.slice(-4)}) to .claude/settings.local.json. It is git-ignored.`);
  console.log('');
  console.log('Next:');
  console.log('  1. Open a new terminal in this folder and run: claude');
  console.log('  2. Run /status and check the base URL is https://openrouter.ai/api.');
  console.log('  3. Run /model and check it is Haiku.');
  console.log('If you are logged in to a Claude account, run /logout first, or that login is used instead.');
}

/** Stops if git would commit settings.local.json, so the key can't leak. */
function checkIgnored() {
  try {
    execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: root, stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') return; // git not installed: nothing can be committed anyway
    fail('.claude/settings.local.json is not git-ignored. Add it to .gitignore first, so your key is never committed.');
  }
}

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    fail('.claude/settings.local.json is not valid JSON. Fix or delete it, then run this again.');
  }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

/** Asks a question without echoing what is typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
