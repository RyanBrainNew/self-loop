# Router is a deterministic control plane

Status: accepted

The Router owns Ticket state, claims, leases, gates, dispatch, retries, and
human handoffs. It never implements business changes and never merges. An LLM
may advise on triage, Task Cards, or semantic review, but it cannot grant
authority, invent candidates outside a whitelist, or override deterministic
gates.

This is preferred over a fully autonomous Router because the loop must be
auditable, testable, and safe to run from cron or CI. The cost is less
flexibility for ambiguous work; those cases should become `blocked` with one
concrete question rather than an improvised dispatch.
