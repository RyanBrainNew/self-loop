# Changelog

## 0.7.0

- Added the first runnable hosted control-plane surface: OIDC login with PKCE,
  one-time login transactions, HttpOnly server-side sessions, logout, and
  `/api/me`.
- Added default-deny tenant/project routes with route-level RBAC and explicit
  tenant scoping for every hosted project read.
- Added PostgreSQL session, login-transaction, user, membership, project-role,
  project, and Ticket adapters, including `self_loop.tenant_id` and
  `self_loop.user_id` transaction variables, `FOR UPDATE SKIP LOCKED` claims,
  and optimistic version predicates.
- Added tenant-scoped hosted Ticket list/detail read routes with `ticket:read`
  authorization.
- Added the fail-fast `npm run serve:hosted` entry point, optional `pg`
  dependency, and hosted environment validation.
- Added hosted session, auth, HTTP, PostgreSQL, and startup configuration
  tests (19 passing).

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
