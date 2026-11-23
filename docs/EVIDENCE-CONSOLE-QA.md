# Console QA evidence

Date: 2026-11-23

## Runtime

- Demo console: `http://127.0.0.1:4317` (`demo` mode, reset seed state)
- Project console: `http://127.0.0.1:4318` (`project` mode, two registered repos)
- Browser: Orca embedded browser
- Browser console errors: none on either console page

## Pages checked

| Page | Result |
| --- | --- |
| Overview | KPI cards, pipeline, worker pool, outbox health, and recent audit rendered |
| Observability | Queue health, ticket/delivery distributions, connector/worker health, alerts, `/metrics` link rendered in both demo and project mode |
| Inbox | Event filters and ticket links rendered |
| Tickets | Kanban and ticket detail rendered; blocked/review/done states visible |
| Outbox | Delivered/pending/failed/dead filters and replay controls rendered |
| Sources | GitHub, Jira, Slack, webhook, and scheduler health rendered |
| Workers | Local and remote worker cards, heartbeat, rotate/revoke controls rendered |
| Automations | Interval/Cron schedule controls, run history, edit/delete controls rendered |
| Policy | Runtime config, hard boundaries, local write protection, and filtered audit table rendered |
| Projects | Two registered repositories, current selection, live counts, and switch controls rendered |
| Glossary | English terms paired with Chinese explanations |

## Interaction checks

- Switched theme from Paper to Ocean and back; `data-theme` changed and persisted in localStorage.
- Filtered the Policy audit table by `delivery.sent`; the count changed from `73 / 73` to `12 / 73` while preserving the keyword in the input.
- Confirmed the project selector listed both registered repositories and the active project's `.loop/state.json` was shown on Observability.
- Confirmed `/api/state` and browser-visible content did not expose the write token.
- Confirmed cross-site writes and reads remain rejected by the existing tests.

## Automated coverage

```text
npm test
112 tests passed (Node 24 local, Node 20 compatible CI matrix)

npm run test:e2e:console
15 Playwright tests passed (Chromium, WCAG 2 A/AA axe scan)
```

The server suite covers the Observability summary, audit filters, GitHub review
comments, project-mode webhook routing, local auth, and the bilingual/themeable
shell. The core suite covers connector task acceptance, the Verifier
`commandPrefix`, automations, remote workers, durable Outbox, and SQLite
concurrency. The browser suite fills a two-project fixture, walks every primary
route, scans WCAG 2 A/AA violations with axe, verifies theme persistence, project
switching, audit filtering, and the bilingual glossary.
