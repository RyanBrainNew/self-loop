# Policy, Labels, Claims, and Exit Codes

## Policies

| Policy | Behavior |
| --- | --- |
| `ready-for-agent` (default) | Only issues with `ready-for-agent` |
| `label:<name>` | Only issues with the named label |
| `do` | Follow the advisory triage verdict `do` |
| `off` | Report only; never select work |

The policy is supplied by the caller. The repository does not decide whether a
run should act.

## Labels

Only the five roles are recognized:

`needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix`

`needs-info`, `ready-for-human`, and `wontfix` always block, even under `do`.
`needs-triage` also blocks until classified. Do not add new labels for claims or
progress.

## Deduplication and claims

1. An open PR whose body contains `Closes #N`, `Fixes #N`, or `Resolves #N`
   blocks issue `N`.
2. A branch matching `loop/<N>-...` or `self-loop/<N>-...` also blocks `N`.
3. An issue assigned to someone else is skipped.
4. The current bot may reclaim only after its claim is older than
   `claimTtlMinutes` (default 180) and there is still no PR.
5. Claiming assigns the issue to the resolved GitHub login. If the login is
   unknown or assignment fails, `select` exits `2` rather than running unclaimed.

## Selection

Candidates are sorted oldest-first by creation time. Selection is deterministic
for a given issue set and policy.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Configuration, token, network, or claim failure |
| `3` | No eligible issue |

`select --no-claim` is a dry run for debugging. It still writes `work.json`, but
the issue is not assigned.
