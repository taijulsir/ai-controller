# Release Process

> This describes the process actually used to reach v1.0.0 and how to repeat it for future
> releases — it is a manual checklist, not an automated pipeline. There is no CI/CD configured
> in this repository (no `.github/workflows` or equivalent) as of this writing.

## Versioning and tagging convention

This repository has used two tag conventions so far, both still valid to continue:
- `phase-<N>-complete` (and sub-phases like `phase-9.1-complete`) — one per development phase,
  tracking incremental feature work. 21 such tags exist, from `phase-5-complete` through
  `phase-15-complete`.
- `vX.Y.Z` — semantic-version release tags. `v1.0.0` is the first and, as of this writing,
  only one, tagged on the commit that closed out the pre-release audit's blocking findings.

Phase tags are for internal development milestones; `vX.Y.Z` tags are for actual releases and
are the ones that should ever be pushed to `origin` and published.

## Pre-release verification checklist

Every step below was run, in this order, before tagging `v1.0.0`. Repeat all of them before
tagging any future release:

1. **Confirm the working tree is clean and contains only intended changes**:
   ```bash
   git status
   git diff --stat
   ```
   No untracked files, no unrelated modifications. If the release includes a specific,
   reviewed set of fixes, confirm the diff touches exactly those files and nothing else.

2. **Build**:
   ```bash
   npm run build
   ```
   Must complete with no errors.

3. **Type-check**:
   ```bash
   npx tsc --noEmit
   ```
   Must report zero errors. Remember this does **not** cover `scripts/*.ts` — see
   [DEVELOPMENT.md](./DEVELOPMENT.md#type-checking).

4. **Run every verification script**:
   ```bash
   for f in scripts/verify-*.ts; do
     echo "=== $f ==="
     npx tsx "$f" || echo "FAILED: $f"
   done
   ```
   All scripts must exit 0. Additionally, since a few scripts (e.g.
   `verify-telegram-live-integration.ts`) only log `FAIL` lines without throwing, grep each
   script's output for `FAIL` explicitly rather than trusting exit code alone:
   ```bash
   grep -c '^FAIL' <captured-output>   # should be 0 for every script
   ```

5. **Check for debug leftovers in the diff being released** — no `TODO`/`FIXME`, no stray
   `console.log`/`debugger` statements, no `.only(`/`.skip(` calls introduced beyond what
   already exists in the codebase intentionally.

6. **Confirm any known release blockers are actually resolved** — cross-check against your own
   audit/issue tracking; this repository doesn't have one built in (see
   [CONFIGURATION.md](./CONFIGURATION.md) and [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md#known-gaps-and-dormant-capabilities)
   for currently-known, accepted gaps that are *not* release blockers by design, as distinct
   from genuine defects that should be).

## Tagging and publishing

Only after every step above passes:

```bash
git add <intended files only>
git commit -m "..."
git tag -a vX.Y.Z -m "AI Controller vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Then publish release notes (e.g. via `gh release create vX.Y.Z --notes-file <notes>` if using
GitHub, or your platform's equivalent) summarizing what changed since the previous `vX.Y.Z`
tag — see [CHANGELOG.md](./CHANGELOG.md) for the format used so far.

**Do not** push a tag, push to a shared branch, or publish a release without explicit
confirmation from whoever owns the release decision — these are visible, hard-to-reverse
actions affecting shared state.

## What this process does not cover yet

- No automated CI gate blocks a broken build/typecheck/verify-suite from being merged — the
  checklist above is currently run by hand.
- No automated end-to-end test exercises the live Telegram approval flow or the live
  autonomous execution flow against a real bot — both require manual verification; a reusable
  manual test plan for exactly this is a separate deliverable (not yet part of this file).
- No smoke test runs against a genuinely fresh clone as part of this checklist today — doing
  so by hand (fresh clone → `npm install` → build → typecheck → verify suite) is good practice
  before a release but is not currently scripted.

See [DEPLOYMENT.md](./DEPLOYMENT.md#whats-not-included-yet) for the corresponding gaps on the
operational side.
