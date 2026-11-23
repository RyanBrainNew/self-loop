# Orca adapter live evidence

Date: 2026-11-23

Command:

```text
npm run test:e2e:orca
```

The adapter probe uses the live Orca CLI and current Orca-managed worktree. It:

1. creates one **disabled** automation with a unique `self-loop-e2e-*` name;
2. lists automations and verifies the new id is present;
3. reads the automation back with `automations show`;
4. removes the temporary automation in a `finally` cleanup.

Observed result:

```json
{
  "ok": true,
  "adapter": "orca",
  "id": "ee58cb68-93e9-44d9-9728-535944f7b881",
  "name": "self-loop-e2e-1795447965232",
  "disabled": true,
  "note": "created, listed, read, and removed one disabled Orca automation; no agent was launched"
}
```

This validates the optional Orca scheduler adapter contract without starting an
agent, consuming model tokens, or modifying project files. A full Orca Worker
execution E2E still depends on the Orca agent runtime exposing a stable
one-shot completion contract.
