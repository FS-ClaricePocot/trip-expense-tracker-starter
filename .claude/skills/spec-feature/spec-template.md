# F<N> — <Feature name>

_Status: Draft · Last updated: <YYYY-MM-DD> · Source: product.md §3_

## Summary
What it does and why it matters to the user. 2–4 sentences.

## User stories
- As a <who>, I want <what>, so that <why>.

## Scope
**In:** …
**Out:** … (link the F-IDs that cover it, if any)

## User flow & screens
Step-by-step flow. Reference the mock screens on `docs/design` (if available) by screen name.

## Requirements
- **F<N>.R1** …

## Data & contract
Changes to schemas, browser storage, or the API (request and response, error shapes). Write "None" if there are none.

## States & errors
Loading, empty, validation errors, and the user-facing copy for each.

## Accessibility
Keyboard, focus, labels, contrast, and reduced motion, as they apply to this feature.

## Edge cases
- …

## Acceptance criteria
- **F<N>.AC1** Given … when … then …

## Dependencies
Other features (F-IDs), build-order step, and external services.

## Test plan
Unit tests only (project rules), each mapped to the AC IDs. For an AC that only a database or the full app can prove (ownership, constraints, cascades), say "code review" instead of a test.

## Open questions
- [ ] … (anything unanswered; never filled in with a guess)

## Decisions log
- <YYYY-MM-DD>: <question> → <user's answer>
