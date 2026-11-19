# GitHub Actions event adapter

This adapter is optional. It maps one GitHub event into one durable
`.loop/inbox.json` event and then calls `router tick`, so the Router wakes up
when an Issue or PR changes instead of waiting for the next cron slot.

The event is a wake-up and priority hint, not an authorization. The Router still
reads GitHub to decide whether an Issue is eligible.

## Use it

1. Install the `self-loop` skill where the workflow can check it out. The example
   workflow clones `RyanBrainNew/self-loop` into `.self-loop-skill`; pin a commit
   for production.
2. Copy `self-loop.yml` to `.github/workflows/self-loop.yml` in the target
   repository.
3. Make the configured `executor.command` available on the runner, or set
   `worktreeMode: "external"` and let another scheduler own the Worker.
4. Give the workflow a token with `contents`, `issues`, and `pull-requests`
   permissions. The default `GITHUB_TOKEN` is usually enough.

The workflow runs on `issues`, `pull_request`, `issue_comment`,
`workflow_dispatch`, and a 30-minute fallback schedule. The schedule is still
useful: it collects completed Result Envelopes and expires stale leases even if
an event was missed.

## Manual equivalent

Any scheduler, webhook, or terminal can post the same event:

```bash
node "$SKILL_DIR/scripts/run.mjs" router post --repo "$TARGET_REPO" \
  --type issue --action labeled --ticket 42 --file event.json
node "$SKILL_DIR/scripts/run.mjs" router tick --repo "$TARGET_REPO"
```
