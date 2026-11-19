# self-loop

A repository-scoped delivery loop that turns eligible GitHub issues into
reviewed pull requests, verifies the result with objective evidence, and turns
retrospective findings into durable project memory.

## Language

**Self-loop**:
A repository-scoped system that selects eligible issues, coordinates one or
more implementation attempts within a concurrency limit, verifies each result,
and records lessons.
_Avoid_: loop, automation, bot

**Target repository**:
The repository a self-loop run operates on, resolved explicitly rather than
from the process working directory.
_Avoid_: workspace, project folder

**Skill root**:
The installed directory containing `SKILL.md` and the self-loop scripts.
_Avoid_: loop folder, install directory

**Issue**:
A GitHub issue that supplies the problem statement and policy signals for a
Ticket.
_Avoid_: task, request

**Ticket**:
A durable unit of authorized work with its own lifecycle, attempts, evidence,
and human handoffs.
_Avoid_: work item, job, task

**Attempt**:
One isolated execution of a Ticket by a Worker.
_Avoid_: run, session, job

**Claim**:
The act of reserving an Issue for the loop so another run does not select it.
_Avoid_: assignment, lock

**Lease**:
A time-bounded permission for one Attempt to hold a Ticket and continue
executing.
_Avoid_: claim, lock

**Policy**:
The caller-supplied rule that decides which Issues are eligible for work.
_Avoid_: mode, strategy

**Language**:
The project setting that controls the language of PR titles/bodies and
person-facing Router text. Machine values and verbatim logs stay unchanged.
_Avoid_: locale, translation mode

**Role label**:
One of the five GitHub labels that describes an Issue's human triage state.
_Avoid_: status label, queue label

**Router**:
The control plane that evaluates eligibility, claims work, assembles context,
dispatches Attempts, runs gates, and advances Ticket state. It does not write
business code.
_Avoid_: orchestrator, manager, chief agent

**Inbox**:
A durable, append-only event log that wakes the Router and hints at which Issue
to consider next. It never grants authority or bypasses a gate.
_Avoid_: queue, message bus, task tray

**Event**:
One typed inbox record, such as an Issue label change, a PR close, a completed
Result Envelope, or a manual recovery request.
_Avoid_: notification, webhook payload

**Dispatch mode**:
Whether the Router waits for an executor inline (`wait`) or detaches it and
collects the Result Envelope on a later tick (`background`).
_Avoid_: sync mode, async mode

**Concurrency**:
The number of Tickets the Router may keep in `queued`, `claimed`, `working`, or
`verifying` at once, set by `router.maxConcurrent`.
_Avoid_: parallelism, worker count

**Worker**:
The executor that implements exactly one atomic Task Card in an isolated
worktree and returns evidence.
_Avoid_: agent, executor, coder

**Verifier**:
An independent role that reproduces checks in a clean worktree and returns
`pass`, `fail`, or `human_review`. It never edits code or trusts a Worker's
self-report.
_Avoid_: reviewer, tester

**Reviewer**:
An optional semantic review role, separate from the Verifier, that assesses
diff and evidence. It cannot merge.
_Avoid_: verifier, approver

**Task Card**:
A bounded task contract containing goal, in-scope and out-of-scope paths,
acceptance criteria, required checks, risk, and rollback.
_Avoid_: plan, prompt, instructions

**Feature Map**:
A project-level shared view of architecture, interfaces, constraints, and
acceptance rules. In the first version it is represented by `AGENTS.md` and the
three memory files, not by a separate mandatory document.
_Avoid_: context file, memory dump

**Context Packet**:
A read-only set of project and Ticket facts assembled once and projected for a
specific role.
_Avoid_: prompt context, memory dump

**Result Envelope**:
The single structured result format returned by a Worker, Verifier, or
Reviewer.
_Avoid_: report, response, result message

**Artifact**:
An immutable evidence file referenced by path, such as a diff, test log, or
review record.
_Avoid_: output, log, attachment

**Gate**:
A deterministic check that must pass before a Ticket advances to the next
state.
_Avoid_: review, approval

**Memory**:
Durable project knowledge stored in the configured lessons, code-standards, and
decisions files.
_Avoid_: knowledge base, context, prompt

**Retro**:
An evidence-based review of completed work that produces lessons and proposed
gate changes.
_Avoid_: postmortem, summary

**Gardener**:
The retro outcome that turns a repeated lesson into a durable rule, lint check,
test, or CI gate.
_Avoid_: cleanup, refactor

**Human review**:
The stage in which a person decides whether a verified pull request should be
merged. Self-loop never merges.
_Avoid_: approval, merge gate
