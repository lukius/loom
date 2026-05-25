# Subagent-driven feature execution

How we run a written implementation plan to completion. Reusable across features. The plan itself lists the tasks and steps; this document describes the **process** that turns those tasks into committed code.

## Why subagent-driven

The orchestrator (this session) is too valuable to spend on routine implementation: it holds the design context, the conversation history, and the user relationship. Routine implementation work is delegated to short-lived subagents so the orchestrator can stay focused on review, integration, and decision-making.

Subagents start fresh per task — they don't see prior conversation. They get a self-contained briefing pointing at the plan, the task they own, and any cross-task context they need. They return a short report + diff for the orchestrator to inspect.

## Roles & models

Each role is a distinct subagent kind, dispatched via the `Agent` tool with a specific `model`. "Effort" is an intended thinking budget; in practice we pass it through whatever the agent harness supports (today: model name only; effort baked into the model variant).

| Role | Model | Effort (intent) | Job |
|---|---|---|---|
| **Developer** | `sonnet` (Sonnet 4.6) | xhigh | Read the task from the plan. Execute its steps verbatim (TDD red → green → refactor → commit). Return a report: what got committed, test/lint output, any deviations. |
| **Reviewer** | `opus` (Opus 4.7) | xhigh | Audit the developer's commit(s) against the plan's task spec AND the design spec. Focus areas: code quality, spec consistency, performance, functional correctness. Approve or reject with specific, citable findings. |
| **Final reviewer** | `opus` (Opus 4.7) | max | Once every per-task review has been approved, audit the **entire branch** end-to-end. Catches cross-task issues that per-task review can miss (subtle inconsistencies between tasks, abstractions that diverged, missing coverage, integration gaps). One pass, deep. |
| **QA** | `opus` (Opus 4.7) | xhigh | After final review approves, runs functional QA. Walks the user journeys / acceptance criteria from the spec, checks that the running system matches the spec's promises. Returns a QA report with any defects. |

The orchestrator (this session) does NOT review code itself — it dispatches reviewers, reads their reports, and decides what to do.

## The per-task loop

```
┌────────────────────────────────────────────────────────────┐
│ For each task in the plan (in order):                      │
│                                                            │
│   1. Orchestrator dispatches Developer subagent            │
│      → executes Task N's steps, commits, reports back      │
│                                                            │
│   2. Orchestrator dispatches Reviewer subagent             │
│      → audits the Task N commits, returns approve / reject │
│                                                            │
│   3. If reject:                                            │
│        Orchestrator dispatches Developer subagent again    │
│        with the reviewer's feedback                        │
│        → developer addresses findings, reports back        │
│        Loop back to step 2 (review the fix)                │
│                                                            │
│   4. If approve: move to Task N+1                          │
└────────────────────────────────────────────────────────────┘

After every task is approved:

   5. Orchestrator dispatches Final reviewer (one pass, whole branch)
      → returns approve / list of issues

   6. If issues:
        Orchestrator drives fixes via more Developer + Reviewer cycles
        Re-run step 5 until clean

   7. Orchestrator dispatches QA subagent
      → runs functional QA, returns report

   8. If defects:
        Orchestrator drives fixes; loop to step 7

   9. Orchestrator reports completion to the user
```

## Briefing template — Developer

When dispatching a developer subagent, the prompt MUST include:

- Path to the plan file.
- Which **task number** to execute (e.g. "Task 5").
- The full task instructions — DO NOT just tell them to find the task; quote the whole task block into the prompt so the subagent doesn't have to scan the plan for it.
- Reminder that steps are TDD-shaped: write failing test, confirm it fails for the expected reason, implement minimum, run, commit. Don't skip the red step.
- The worktree path (or instruction "you're already in the worktree").
- Reminder of project conventions: `<type>(scope): <imperative>` commits; no co-author trailer; pytest + ruff after each step; `pytest` via `/home/lukius/repo/netrouting/.venv/bin/pytest`.
- Required output: list of commits (SHAs + messages), pytest tail, ruff status, any deviations from the plan and why.

If the developer is being re-dispatched to address review feedback, the prompt MUST also include:

- The reviewer's full findings.
- The commits from the previous developer pass (SHAs).
- Instruction to fix and commit *amending the relevant commit* (or stacking a fixup commit, depending on the policy of this project).

## Briefing template — Reviewer

When dispatching a reviewer subagent, the prompt MUST include:

- Path to the plan file.
- Path to the design spec.
- Which **task number** to review.
- The list of commit SHAs the developer reported (so the reviewer can `git show`/`git diff` them).
- Explicit review focus areas, in priority order:
  1. **Functional correctness** — does the code do what the task spec says it does?
  2. **Spec consistency** — do the new types / signatures match what the design spec promises?
  3. **Code quality** — readability, idiom, DRY/YAGNI, project conventions (CLAUDE.md), no over-engineering.
  4. **Performance** — any obvious O(n²) or hot-path allocations that the spec didn't sanction.
- Reminder of project guardrails (read-only): backend ↔ SPA decoupling, conventional commits, ruff clean, no debug prints, no commented-out code.
- Required output structure:
  - **Decision**: APPROVED or REJECTED.
  - If REJECTED: numbered list of findings. Each finding: file + line, what's wrong, what the fix should be. Findings must be specific enough that the developer can act without further interpretation.
  - If APPROVED: one paragraph summarising what was reviewed and any nits-not-blocking the developer should know about.

Reviewer subagents do not commit. They read commits and write a report.

## Briefing template — Final reviewer

When dispatching the final reviewer:

- Path to the plan file.
- Path to the design spec.
- Branch name (`git log main..HEAD` is the diff to audit).
- Explicit focus areas, in priority order:
  1. **Cross-task consistency** — abstractions that drifted between Phase 1 and Phase 5, naming inconsistencies, leftover migration scaffolding, dead-code branches.
  2. **Spec coverage** — is every spec requirement actually delivered? Walk each section of the design spec, point at the commits that implemented it.
  3. **Integration health** — modules interact correctly across the four protocol phases + UI surface; events fire in the right order; lock-ordering is sane.
  4. **What got cut** — were there features promised in the spec but quietly dropped during implementation? Or features added that weren't in the spec?
- Required output: APPROVED or REJECTED + numbered findings as above. Findings here typically span multiple files; the reviewer should be explicit about which task to amend or whether a new follow-up task is required.

## Briefing template — QA

When dispatching the QA subagent:

- Path to the design spec.
- Branch name (the work to test).
- Explicit list of QA scenarios drawn from the spec's user-facing surfaces — for each:
  1. The acceptance criterion (what the spec promises the user can do).
  2. The steps to verify it (start the system, click X, observe Y).
  3. The expected outcome.
- Reminder: QA verifies functionality, not code. They start the system and use it. They confirm or refute the spec's promises with evidence (screenshots / logs / specific assertions).
- Required output: per-scenario PASS / FAIL with evidence. A summary section noting any cross-cutting issues (performance, UX gaps, etc.).

QA subagents may execute the test suite, start the server, run E2E. They do not commit fixes.

## Orchestrator responsibilities

The orchestrator owns the **outer loop** and is the only one that:

- Maintains the task pointer (which task we're on, which iteration of review).
- Synthesises reviewer reports into developer briefings.
- Decides when to ship.
- Talks to the user.
- Calls out scope creep, blocking issues, or plan flaws that no subagent can resolve.

The orchestrator does NOT:

- Read commit diffs to second-guess reviewers (reviewers are the authority on their report).
- Write code (the developer subagent does that).
- Skip review iterations (every reject → fix → re-review cycle goes through the same path).
- Try to merge developer + reviewer roles into one subagent (separation of concerns is the point).

## Decision rules

- **A rejection always triggers a developer redo, never an "explain and move on".** The plan is committed to the bit (the rejected commit gets fixed in place), not to the schedule.
- **A reviewer "approve with nits" is approved.** Nits get logged for the final review pass, not blocked at the per-task gate.
- **The final reviewer can require new tasks.** If a gap surfaces that wasn't in the plan, the orchestrator adds the task and runs another developer + reviewer cycle on it.
- **QA failures that block the spec's promises are P0.** QA failures that surface non-spec polish issues are P1 and logged as follow-ups.

## When to deviate

If a developer subagent finds the plan itself is wrong (a step is impossible, two steps contradict, a test that's supposed to fail actually passes for the wrong reason), it MUST stop and report — not attempt to fix the plan unilaterally. The orchestrator decides whether to:

- Patch the plan and re-dispatch the developer.
- Take the question to the user.

Same rule for reviewers: if the plan is wrong, surface it; don't approve a deviation that the plan didn't sanction.

## Tooling notes

- Subagent invocations use the `Agent` tool with the appropriate `subagent_type` (or fallback to general-purpose with explicit `model: 'sonnet'|'opus'`).
- Parallel dispatch (multiple developers on independent tasks at once) is permitted only when the tasks share no files. Otherwise serialise to avoid merge conflicts.
- The orchestrator may use `run_in_background` for long-running QA or build runs and continue with other work; it does NOT poll, it waits for the completion notification.
- Each subagent operates in the **same worktree** as the orchestrator. Commits land on the branch directly.

## Glossary

- **Plan** — the implementation document for the feature. The source of task instructions. Path is feature- and toolchain-specific.
- **Spec / design** — the design document the plan was written from. The source of requirements. Path is feature- and toolchain-specific.
- **Task** — one numbered unit in the plan. Owns one or more commits.
- **Cycle** — one developer-then-reviewer pair on a single task. A task may need multiple cycles.
- **Phase** — a group of related tasks in the plan (e.g. "Phase 2 — Hello + Neighbor states").
