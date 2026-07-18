# Telegram Commands

> Every command currently recognized by the bot (`src/telegram/CommandParser.ts`), in plain
> language. For exact parsing rules, the approval-flow sequence diagram, and authorization
> details, see `TELEGRAM.md`; for what each task/workflow does step-by-step internally, see
> `EXECUTION_PIPELINE.md`.

## How to read this table

- **Manual** — runs immediately, no approval prompt, regardless of config.
- **Approval-gated** — may pause and send an "✅ Approve / ❌ Reject" prompt before continuing,
  depending on `config/controller.yaml`'s `approval.*` settings.
- **Autonomous** — this command manually triggers the same logic the system also runs on its
  own, unattended, once an hour.

Every command (and every approval button press) is checked against `security.allowed_users` in
`config/telegram.yaml` first. An unauthorized user gets a fixed refusal message and nothing
runs — this applies uniformly to all commands below, so it isn't repeated in each row.

You can prefix any command with `repo=<id>` to target a specific registered repository instead
of the default active one, e.g. `/repo=my-repo status`.

---

## Engineering task commands

### `/analyze [focus text]`
- **What it does**: Asks Claude Code to analyze the repository, optionally focused on a
  specific area if you give it one.
- **When to use**: When you want a general read on the state of a repository, or a deep dive
  into one part of it.
- **Type**: Manual.
- **Example**: `/analyze the authentication module`

### `/explain <target>`
- **What it does**: Asks Claude Code to explain a specific part of the codebase. The target is
  required.
- **When to use**: When you're trying to understand a file, function, or area of code without
  reading it yourself.
- **Type**: Manual.
- **Example**: `/explain src/approval/ApprovalEngine.ts`

### `/implement <description>`
- **What it does**: Asks Claude Code to implement the feature you describe. The description is
  required.
- **When to use**: When you want new code written for you.
- **Type**: Manual.
- **Example**: `/implement a rate limiter for the webhook endpoint`

### `/fix <description>`
- **What it does**: Asks Claude Code to fix the bug you describe. The description is required.
- **When to use**: When you know something is broken and want it fixed.
- **Type**: Manual.
- **Example**: `/fix the login form doesn't clear its error message on retry`

### `/commit <message>`
- **What it does**: Stages every change in the working tree and commits it with the message you
  give. The message is required.
- **When to use**: After `/implement` or `/fix` has produced changes you're ready to save as a
  commit.
- **Type**: Manual (never approval-gated, regardless of config).
- **Example**: `/commit Add rate limiting to the webhook endpoint`

### `/push`
- **What it does**: Pushes the current branch to its remote.
- **When to use**: After committing, when you're ready to publish your changes.
- **Type**: Approval-gated — requires approval whenever `approval.require_before_git_push` is
  `true` in `config/controller.yaml` (it is, by default, in the shipped config).
- **Example**: `/push`

### `/create-pr <title>`
- **What it does**: Opens a pull request with the given title against the repository's default
  base branch. Fails if the current branch is already the base branch.
- **When to use**: After pushing, when you're ready for review.
- **Type**: Approval-gated — requires approval whenever
  `approval.require_before_pull_request` is `true` (it is `false` in the shipped config, so this
  runs immediately by default).
- **Example**: `/create-pr Add rate limiting to the webhook endpoint`

### `/list-prs`
- **What it does**: Lists currently open pull requests for the repository.
- **When to use**: To check what's already up for review.
- **Type**: Manual.
- **Example**: `/list-prs`

---

## Workflow command

### `/ship <message>`
- **What it does**: Runs the full delivery sequence as one command: verify git status → commit
  (using your message) → push → open a pull request. If any step fails or an approval is
  rejected, the sequence stops immediately — there's no rollback of steps already completed.
- **When to use**: When you want to go from "changes in the working tree" to "pull request
  opened" in one message, instead of running `/commit`, `/push`, and `/create-pr` separately.
- **Type**: Approval-gated — the `push` and `create-pr` steps inside it are gated exactly like
  the standalone `/push` and `/create-pr` commands above; `verify-status` and `commit` never are.
- **Example**: `/ship Add rate limiting to the webhook endpoint`

---

## Autonomous execution command

### `/auto-execute`
- **What it does**: Manually triggers the same autonomous-execution logic that otherwise runs
  on its own once an hour: it looks at the system's own top-ranked recommendation across every
  registered repository, and — only if that recommendation is specifically "repository ready to
  ship" — submits a real `/ship`-equivalent request through the normal approval-gated pipeline.
  Any other kind of recommendation, or no eligible recommendation at all, results in no action.
  Takes no arguments and doesn't target a specific repository — the system decides that itself
  from its own ranked plan.
- **When to use**: To test or manually invoke the autonomous pipeline on demand, rather than
  waiting for its hourly tick.
- **Type**: Autonomous (manually triggered) + approval-gated — any push/PR step it reaches goes
  through the same `ApprovalEngine` gate as every other command.
- **Example**: `/auto-execute`

---

## Query commands (read-only)

### `/status [repo=<id>]`
- **What it does**: Returns a snapshot of the target repository's current state (git status,
  etc.).
- **When to use**: To check what's going on in a repository right now.
- **Type**: Manual, read-only.
- **Example**: `/status` or `/repo=my-repo status`

### `/history [N]`
- **What it does**: Returns recent execution history for the repository — what's been run
  against it and the outcome. `N`, if given, must be a positive integer and limits how many
  entries come back.
- **When to use**: To review what the controller (or you, through it) has recently done.
- **Type**: Manual, read-only.
- **Example**: `/history 10`

### `/insights`
- **What it does**: Returns the repository's current derived insights — the typed findings
  `DecisionEngine` produces from the repository's snapshot and history.
- **When to use**: To see what the system currently flags as noteworthy about a repository.
- **Type**: Manual, read-only.
- **Example**: `/insights`

### `/session`
- **What it does**: Returns the status of the current Claude Code session for the repository, if
  one is active.
- **When to use**: To check whether an in-progress Claude session exists before starting another
  task.
- **Type**: Manual, read-only.
- **Example**: `/session`

### `/runtime` (or `/runtime report`)
- **What it does**: Returns the full runtime operations report — combined status of the
  background workers, monitoring, policy, and attention/alerting subsystems. A bare `/runtime`
  is treated exactly the same as `/runtime report`.
- **When to use**: For a complete picture of what the background runtime is doing.
- **Type**: Manual, read-only.
- **Example**: `/runtime`

### `/runtime status`
- **What it does**: Same underlying report as `/runtime`, formatted to show just the runtime/
  worker status section.
- **When to use**: To quickly check whether the background workers are running.
- **Type**: Manual, read-only.
- **Example**: `/runtime status`

### `/runtime diagnostics`
- **What it does**: Same underlying report, formatted to show the diagnostics section
  (derived findings about the runtime's own health).
- **When to use**: When something seems off and you want the system's own self-diagnosis.
- **Type**: Manual, read-only.
- **Example**: `/runtime diagnostics`

### `/runtime monitoring`
- **What it does**: Same underlying report, formatted to show the proactive-monitoring section.
- **When to use**: To check what the monitoring worker has been observing across repositories.
- **Type**: Manual, read-only.
- **Example**: `/runtime monitoring`

### `/runtime policy`
- **What it does**: Same underlying report, formatted to show the governance-policy section
  (quiet hours, cooldowns, rate limits).
- **When to use**: To check current policy state, e.g. whether notifications are currently rate
  limited or quiet hours are in effect.
- **Type**: Manual, read-only.
- **Example**: `/runtime policy`

---

## Anything else

Any command not listed above (including a typo of one of these) gets a specific reply —
`Sorry, I don't recognize the command "<name>".` — and nothing runs. A recognized command missing
a required argument (e.g. `/implement` with no description) gets a specific, purpose-built error
message instead of running with empty input.

No command in this file was inferred or assumed — each one is taken directly from
`src/telegram/CommandParser.ts`'s command table as it exists in the codebase today.
