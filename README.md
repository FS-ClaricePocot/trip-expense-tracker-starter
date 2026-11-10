# Trip Expense Tracker

The sample app built in the L4 AI Developer Training. A user registers, creates a trip, adds the people on it, and records who paid for what. The app shows what each person owes or is owed, and the fewest payments needed to settle up. See [docs/specs/product.md](docs/specs/product.md) for the full requirements.

Over four weeks you build it with Claude Code: specs and plans (Week 1), a developer agent (Week 2), pull requests and an AI reviewer (Week 3), and an orchestrator that runs the loop (Week 4). Every session runs on Haiku, within a $15 budget.

## Prerequisites

- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** on your `PATH` (`claude --version`).
- **[Node.js](https://nodejs.org/)** (current LTS) on your `PATH` (`node --version`). The hooks and the setup script run with Node.
- **Git** and a **GitHub account**. On Windows, install [Git for Windows](https://git-scm.com/download/win); it includes Git Bash, which Claude Code uses to run hook commands.
- **The GitHub CLI** (`gh --version`), signed in once with `gh auth login`.
  - Windows: `winget install --id GitHub.cli`. If `winget` isn't recognised, run `& "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe" install --id GitHub.cli`, or use the installer from [cli.github.com](https://cli.github.com).
  - Mac: `brew install gh`.
- **An OpenRouter API key**, from your course organiser or [openrouter.ai](https://openrouter.ai).

## Getting started

1. **Create your private repository from this template and clone it.** On a Mac, work from your home folder (`cd ~`), not Desktop or Documents.

   ```bash
   gh repo create trip-expense-tracker --template FS-ClaricePocot/trip-expense-tracker-starter --private --clone
   ```

   Then add your mentor as a collaborator: on GitHub, open your repository's **Settings → Collaborators → Add people**.

2. **Connect Claude Code to OpenRouter.** (Skip this if you are using your own subscription, proceed to Step 4) From the repository root, run the setup script and paste your key when asked (the input is hidden):

   ```bash
   node scripts/setup-openrouter.mjs
   ```

   It saves the key and the OpenRouter address to `.claude/settings.local.json`, which is git-ignored and applies to this project only. Your key is never committed.

3. **Check the connection.** Open a new terminal in the repository root and run `claude`. If you're logged in to a Claude account, run `/logout` first. Then:
   - `/status` shows the base URL `https://openrouter.ai/api`
   - `/model` shows Haiku

4. **Start Week 1** on its own branch:

   ```bash
   git switch -c week-1
   ```

## What's in this repository

| Path | What it holds |
|---|---|
| `docs/specs/product.md` | The product requirements and the MVP feature list |
| `docs/rules/project-rules.md` | Coding, testing, logging, security and review rules |
| `.claude/settings.json` | The hooks and the Haiku model. No key |
| `.claude/hooks/` | The session-log hook and two warnings (context size, task committed) |
| `.claude/skills/spec-feature/` | The given `/spec-feature` skill and its spec template |
| `scripts/setup-openrouter.mjs` | Saves your OpenRouter key outside git |
| `docs/activities-outputs/` | Your session logs and `usage.md` (automatic), and screenshots |

You add the rest week by week: `CLAUDE.md` (your stack and test commands), the specs and plans, the skills and agent, the app in `app/`, and the GitHub workflow.

## Repository structure

Keep to this layout, so every participant's repository looks the same and mentors can find things quickly. Use these exact names. Only the inside of `app/` differs, depending on your stack.

```text
trip-expense-tracker/
├── CLAUDE.md                        Week 1: your stack, layout and unit test commands
├── README.md                        Week 2 onward: also how to run your app
├── .gitignore
├── .claude/
│   ├── settings.json                given: hooks, Haiku
│   ├── settings.local.json          your OpenRouter key (git-ignored, never committed)
│   ├── hooks/                       given: session log and warnings
│   ├── agents/
│   │   └── developer.md             Week 2
│   └── skills/
│       ├── spec-feature/            given (you may improve it)
│       ├── plan-feature/            Week 1
│       ├── implement-feature/       Week 2
│       ├── review-pr/               Week 3
│       ├── open-pr/                 Week 3
│       └── feature-loop/            Week 4
├── .github/
│   └── workflows/
│       └── pr-checks.yml            Week 3: tests and the AI reviewer
├── app/                             Week 2 onward: your application, in your stack
│   ├── api/                           for example, the back end and its unit tests
│   └── web/                           for example, the front end and its unit tests
├── docs/
│   ├── specs/
│   │   ├── product.md               given
│   │   ├── api.md                   Week 2 onward: endpoints, kept up to date
│   │   ├── data-model.md            Week 2 onward: tables and fields, kept up to date
│   │   └── features/
│   │       └── F1-<name>.md …       Week 1: one spec per feature (F1 to F6)
│   ├── plans/
│   │   └── F1-<name>.md …           Week 1: one plan per feature, same names as the specs
│   ├── rules/
│   │   └── project-rules.md         given
│   ├── design/                      optional: your UI mockups
│   └── activities-outputs/
│       ├── session-logs/            automatic
│       ├── usage.md                 automatic: tokens and model per session
│       └── screenshots/             what each week's deliverables ask for
└── scripts/
    └── setup-openrouter.mjs         given
```

Name specs and plans by feature ID and a short name in kebab-case, for example `docs/specs/features/F3-people.md` and `docs/plans/F3-people.md`. Name branches `week-1` and `week-2`, then by feature in Weeks 3 and 4, using the same name as the plan (for example `F3-people`).

## Ground rules

1. **Start Claude Code from the repository root**, so it loads the settings, skills and hooks. Sessions started elsewhere are not logged.
2. **Stay within the $15 budget.** Every session counts.
3. **Use Haiku only**, for every session, skill and agent.
4. **One task per session.** Run `/clear` between tasks. Long, open-ended chats are the most common cause of overspending.
5. **Work through pull requests.** In Weeks 1 and 2, do the week's work on one branch (`week-1`, `week-2`) and open one pull request for it. In Weeks 3 and 4, use one branch and one pull request per feature (for example `F3-people`), so each AI review stays small and cheap. Your mentor reviews each pull request, then you merge.
6. **Keep evidence.** Commit your session logs, `usage.md` and screenshots in `docs/activities-outputs/`. Always commit `usage.md` together with the session logs, since it summarises them.

## Session logs and warnings

Every Claude Code session in this project is logged to `docs/activities-outputs/session-logs/`, and a one-line summary of each session's tokens and model goes to `docs/activities-outputs/usage.md`, by [.claude/hooks/session-log.mjs](.claude/hooks/session-log.mjs). It runs after every turn and when the session ends. There is nothing to set up beyond the prerequisites.

| File | Contents |
|---|---|
| `YYYY-MM-DD-<session id>.md` | One per session: start and last activity time, prompt and task counts, models, token usage and estimated cost (main conversation and subagents), the model segments, each task's tokens and cost, and the skills and agents used |
| `docs/activities-outputs/usage.md` | One line per model run, oldest first: last activity time, total tokens, model and estimated cost, for example `2026-11-10 17:50:20 - 3104k (Haiku) \| $0.20`. A run is the stretch of a session on one model: its count and cost restart when the model changes. Costs use the Claude API list prices in the hook script, and show `$n/a` when a model has no price |
| `.hook-errors.log` | Only appears if the hook hit an error. Not committed (see `.gitignore`) |

What to know:

- **Your prompts are never recorded.** Each task is described from Claude's side: its plan steps if it made a plan, otherwise the opening sentence of its reply, otherwise the tools it used (e.g. `Tools: Bash ×2, Edit ×1`). A slash command is shown in front, e.g. `/spec-feature: …`.
- **Logs are committed** as evidence of each session's models and token use. Commit them with the work they belong to. A session that is still open keeps rewriting its log, so commit it after the session ends.
- **Commit `usage.md` with the session logs.** It is rebuilt from the logs after every turn, so commit it in the same commit as the logs they changed.
- **Files are regenerated; don't edit them.** Each run rebuilds the log from the session transcript, and rebuilds `usage.md` from the logs.
- **Dates use your local time zone.**

Two more hooks show a one-line warning after a reply. The warnings appear only to you and aren't sent to the model, so they cost no tokens:

- **Context warning:** at about 80k tokens, and every 40k after that, you're told to finish or commit the current task, then run `/clear` (or `/compact` to keep a short summary). Change the thresholds with `CONTEXT_WARN_TOKENS` and `CONTEXT_WARN_STEP`, or turn it off with `CONTEXT_WARN_OFF=1`.
- **Task reminder:** after you commit a plan task (a commit message starting `F<N>.T<k>`, such as `F1.T2`), you're reminded to run `/clear` before the next task. Turn it off with `TASK_REMINDER_OFF=1`.

To log a session by hand:

```bash
node .claude/hooks/session-log.mjs --transcript <path-to-session.jsonl>
```

To exclude a session, add its full session id (one per line, `#` for comments) to `.claude/hooks/session-log.ignore`; its log is removed on the next run.

If logs stop appearing, check `docs/activities-outputs/session-logs/.hook-errors.log`, or run the hook with `SESSION_LOG_DEBUG=1` set to print errors.
