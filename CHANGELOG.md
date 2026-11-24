# Changelog

## 0.6.0

- Added Playwright + axe browser E2E for every primary console route,
  theme persistence, project switching, audit filtering, and the glossary.
- Added the browser E2E CI job and fixed CSP font preconnect, focusable code
  blocks, and WCAG contrast issues found by axe.
- Added a live Orca adapter probe that creates, lists, reads, and removes a
  disabled automation without launching an agent.
- Added a manual `workflow_dispatch` live executor workflow for Codex/Claude
  evidence collection.
- Added the first hosted-control-plane contract: tenant/project RBAC,
  trusted-proxy identity parsing, PostgreSQL schema, idempotency constraints,
  indexes, and RLS policies.
- Added dependency-free OIDC discovery, PKCE, authorization-code exchange, and
  RS256/ES256 ID Token verification against JWKS.

## 0.5.0

- Added cron + timezone schedules, edit/delete/history APIs and UI for automations.
- Added remote Worker version/rotation/revocation and corrected multi-Ticket
  remote concurrency accounting.
- Added the Observability page with queue, state, connector, worker, and alert
  summaries, plus filtered and paginated console audit queries.
- Added GitHub PR review-comment commands (`/loop`, `@self-loop`) that create
  deduplicated follow-up Tasks with PR/comment links.
- Fixed connector task acceptance criteria being ignored by the Task Card.
- Added Prometheus alert rules, systemd tick/backup examples, an operations
  runbook, and tag-driven GitHub Release packaging.

## 0.4.0

- Added a multi-project local console with project switching and a persistent registry.
- Added Slack Events API / `/loop` ingress, thread-aware Outbox, and Jira incremental polling.
- Added durable Outbox delivery for GitHub, Jira, Slack, and generic webhooks.
- Added optional SQLite storage, migration/export, and a two-process Ticket write test.
- Added real Codex executor E2E evidence and a Codex/Claude harness.
- Added scheduled automations, remote Worker registration/claim/complete, and `/metrics`.
- Added backup/restore and release checks.
- Added Graphite, Ocean, Plum, and Paper themes plus bilingual UI annotations and a glossary.

## 0.3.0

- Added project-mode console, local write token, project registry, and audit.

## 0.2.0

- Added Router state, Inbox, Tickets, Attempts, Verifier, and Outbox.

## 0.1.0

- Initial installable self-loop skill.
