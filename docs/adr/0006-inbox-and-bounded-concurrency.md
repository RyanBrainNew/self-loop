# Inbox events wake the Router; concurrency stays bounded

Status: accepted

The Router reads a durable `.loop/inbox.json` before each tick. Schedulers,
webhooks, and people append typed events; `tick` drains them, applies completed
Result Envelopes, and then evaluates Tickets. An event is a wake-up and a
priority hint, not an authorization: GitHub remains the source of issue truth,
and every deterministic gate still runs.

This is preferred over a second issue database because stale webhook payloads
must never invent candidates or bypass labels, claims, acceptance criteria, or
verification. The cost is one extra file and a pruning policy
(`router.inboxLimit`).

The same tick admits up to `router.maxConcurrent` Tickets. `dispatchMode:
"wait"` preserves inline execution; `"background"` detaches the executor and
collects its Result Envelope on a later tick. Concurrency is bounded on purpose:
the Router never silently exceeds the configured capacity, and `blocked` or
`awaiting_review` Tickets do not consume a Worker slot.
