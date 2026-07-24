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

### `/review [focus text]`
- **What it does**: Asks Claude Code to review the repository (or code review a specific area,
  if you give it one), the same way `/analyze` does for general analysis.
- **When to use**: When you want a code-review pass over a repository or a specific area.
- **Type**: Manual.
- **Example**: `/review the payment webhook handler`

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
- **Type**: Approval-gated — requires approval whenever `push-changes` is listed in
  `approval.require_before` (it is, by default, in the shipped config). `require_before`, when
  present, takes full priority over the older `require_before_git_push` flag.
- **Example**: `/push`

### `/create-pr <title>`
- **What it does**: Opens a pull request with the given title against the repository's default
  base branch. Fails if the current branch is already the base branch.
- **When to use**: After pushing, when you're ready for review.
- **Type**: Approval-gated — requires approval whenever `create-pull-request` is listed in
  `approval.require_before` (it is not, in the shipped config, so this runs immediately by
  default).
- **Example**: `/create-pr Add rate limiting to the webhook endpoint`

### `/list-prs`
- **What it does**: Lists currently open pull requests for the repository.
- **When to use**: To check what's already up for review.
- **Type**: Manual.
- **Example**: `/list-prs`

---

## Git operation commands

### `/fetch`
- **What it does**: Runs `git fetch`, updating remote-tracking refs only. Never touches the
  working tree, the index, or the current branch.
- **When to use**: To check whether the remote has new commits before deciding to `/sync`.
- **Type**: Manual.
- **Example**: `/fetch`

### `/sync`
- **What it does**: Fetches, then fast-forwards the current branch to match its upstream. Fails
  with a clear error instead of merging or rebasing if a fast-forward isn't possible (the
  branches have diverged), if the current branch is detached, or if the working tree isn't
  clean.
- **When to use**: The safe way to pull in remote changes without risking a merge commit or a
  rebase.
- **Type**: Manual.
- **Example**: `/sync`

### `/merge <branch>`
- **What it does**: Merges the named branch into the current one. Fast-forwards when possible;
  otherwise attempts a real merge commit. On any conflict, automatically runs `git merge
  --abort` before reporting the failure, so the working tree is never left mid-conflict. Fails
  if the working tree isn't clean, the current branch is detached, or the named branch is the
  current branch. The branch name is required.
- **When to use**: To bring another branch's changes into the one you're on.
- **Type**: Approval-gated — requires approval whenever `merge` is listed in
  `approval.require_before` (it is, by default, in the shipped config).
- **Example**: `/merge main`

### `/branch [<name> | create <name>]`
- **What it does**: With no argument, reports the current branch (read-only). With a branch
  name, switches to it — refusing if the working tree isn't clean. With `create <name>`,
  creates the branch (at the current commit, carrying any uncommitted changes forward) and
  switches to it.
- **When to use**: To check, switch, or create a branch.
- **Type**: Manual. (The no-argument form is read-only; the other two are bypass-eligible task
  commands, same as `/commit`/`/push`.)
- **Example**: `/branch`, `/branch feature/login`, `/branch create feature/login`

### `/branches`
- **What it does**: Lists local branches for the repository.
- **When to use**: To see what branches already exist before switching or creating one.
- **Type**: Manual, read-only.
- **Example**: `/branches`

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

## Query commands

Parsed as `query`-kind commands (never a `Task`, never through `ExecutionPipeline`). Most are
pure reads; `/session reset`, `/session stop`, `/task cancel`, and `/undo` are the exceptions —
each answers with a query-shaped response but also performs a narrowly-scoped write, called out
individually below.

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

### `/help`
- **What it does**: Returns the list of commands the bot recognizes.
- **When to use**: As a reminder of available commands.
- **Type**: Manual, read-only.
- **Example**: `/help`

### `/recommendations`
- **What it does**: Returns the system's current ranked recommendations for the repository
  (the same engine that drives `/auto-execute` and proactive notifications).
- **When to use**: To see what the system currently suggests doing next.
- **Type**: Manual, read-only.
- **Example**: `/recommendations`

### `/session`
- **What it does**: Returns the status of the current Claude Code session for the repository, if
  one is active.
- **When to use**: To check whether an in-progress Claude session exists before starting another
  task.
- **Type**: Manual, read-only.
- **Example**: `/session`

### `/session reset`
- **What it does**: Clears the session record for the repository, without affecting any
  currently running task.
- **When to use**: To force the next task to start a fresh Claude session instead of
  continuing the previous one.
- **Type**: Manual (a targeted write, never approval-gated).
- **Example**: `/session reset`

### `/session stop`
- **What it does**: Cancels whatever task is currently running or awaiting approval for the
  repository (same effect as `/task cancel`), then clears the session record.
- **When to use**: To fully stop and reset a repository's session in one command.
- **Type**: Manual (a targeted write, never approval-gated).
- **Example**: `/session stop`

### `/task`
- **What it does**: Reports the task currently running (or awaiting approval) for the
  repository, if any.
- **When to use**: To check what's currently in progress before starting something else.
- **Type**: Manual, read-only.
- **Example**: `/task`

### `/task cancel`
- **What it does**: Cancels the currently running task, or rejects it if it's awaiting
  approval. Only `/analyze`, `/review`, `/explain`, `/implement`, and `/fix` are actually
  cancellable — these are the only task types whose execution observes an abort signal;
  cancelling any other in-progress task type returns a "not cancellable" result instead.
- **When to use**: To stop a task you no longer want running.
- **Type**: Manual (a targeted write, never approval-gated).
- **Example**: `/task cancel`

### `/undo`
- **What it does**: Reverses the most recent `/implement` or `/fix` task's file changes,
  provided nothing is currently running for the repository and none of the affected files have
  changed since. Refuses (with a specific reason) if there's nothing undoable, if a task is
  currently in progress, or if drift is detected.
- **When to use**: To roll back the last Claude-made code change.
- **Type**: Manual (a targeted write, never approval-gated).
- **Example**: `/undo`

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

## Artifact commands

Artifacts are the files `/analyze`, `/review`, and `/fix` generate along the way — a saved copy
of the analysis/review text, and for `/fix`, a unified diff plus the original and updated
content of every file it changed. They're created automatically; these commands are how you
list, retrieve, and (for admins) manage what's already been saved. See
[CONFIGURATION.md](./CONFIGURATION.md) for where they're stored on disk.

### `/artifact` (or `/artifact list`)
- **What it does**: Lists the most recently created artifacts (id, type, size, title).
- **When to use**: To see what's been generated recently, before fetching a specific one.
- **Type**: Manual, read-only. Available to any authorized user.
- **Example**: `/artifact`

### `/artifact search <query>`
- **What it does**: Searches artifact titles and tags (not file content) for the given text.
- **When to use**: To find a specific artifact when you don't have its id — e.g. by repository
  or task type, since those are reflected in the title/tags.
- **Type**: Manual, read-only. Available to any authorized user.
- **Example**: `/artifact search fix`

### `/artifact get <id>`
- **What it does**: Sends the artifact's actual content back as a Telegram document (a real
  file, not inlined text) — the id comes from `/artifact`, `/artifact search`, or the "📎
  Artifacts" footer on an `/analyze`/`/review`/`/fix` reply.
- **When to use**: To download a specific generated file — a fix's diff, a changed file's
  before/after content, or a full analyze/review write-up.
- **Type**: Manual, read-only. Available to any authorized user.
- **Example**: `/artifact get 0710a743-e73f-465a-a66a-a197434f07cc`

### `/artifact delete <id> [id2] [id3] ...`
- **What it does**: Permanently deletes one or more artifacts (content and metadata for each).
  Reports four outcomes separately: deleted, not found, skipped (an id repeated in the same
  request), and failed (existed but a storage error prevented removal — a failure removing one
  id never stops the rest of the batch from being attempted).
- **When to use**: Rarely — there is no automatic retention/cleanup, so this is currently the
  only way to reclaim space for specific artifacts.
- **Type**: Manual, destructive. **Admin-only** — gated by `security.admin_user_id`
  (`config/telegram.yaml`), on top of the usual `allowed_users` check.
- **Example**: `/artifact delete 0710a743-e73f-465a-a66a-a197434f07cc`
- **Example (multiple)**: `/artifact delete 0710a743-... ac2dee07-... 6e901075-...`

### `/artifact delete-all [confirm]`
- **What it does**: Permanently deletes every artifact currently in the index. A bare
  `/artifact delete-all` performs no deletion — it only reports the current total and asks you
  to resend with the literal word `confirm`. Only `/artifact delete-all confirm` actually
  deletes anything.
- **When to use**: Rarely, and deliberately hard to trigger by accident — e.g. clearing out a
  test deployment's artifacts before going live, or reclaiming disk space wholesale rather than
  one id at a time.
- **Type**: Manual, destructive. **Admin-only**, same gate as `/artifact delete`. The
  confirmation requirement is enforced by `CommandParser`/`ApplicationService`, not just UI
  text — an unconfirmed request never reaches the storage layer at all.
- **Example**: `/artifact delete-all` (shows the count and asks for confirmation)
- **Example**: `/artifact delete-all confirm` (actually deletes everything)

### `/artifact rebuild-index`
- **What it does**: Rebuilds the in-memory artifact index from whatever's actually on disk.
  Normally unnecessary — this already happens automatically on every startup.
- **When to use**: If the index and the filesystem ever appear to disagree (e.g. after manually
  editing the artifacts directory, which isn't a supported workflow but this recovers from it).
- **Type**: Manual, maintenance. **Admin-only**, same gate as `/artifact delete`.
- **Example**: `/artifact rebuild-index`

---

## Anything else

Any command not listed above (including a typo of one of these) gets a specific reply —
`Sorry, I don't recognize the command "<name>".` — and nothing runs. A recognized command missing
a required argument (e.g. `/implement` with no description) gets a specific, purpose-built error
message instead of running with empty input.

No command in this file was inferred or assumed — each one is taken directly from
`src/telegram/CommandParser.ts`'s command table as it exists in the codebase today.
