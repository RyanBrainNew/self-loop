# Verify independently before human review

Status: accepted

Every Ticket that reaches delivery must pass an independent Verifier. The
Verifier checks out the pull request head in a clean worktree, runs the required
gates, and records objective evidence; it never edits code and never trusts a
Worker's self-report.

This was chosen over accepting Worker test output because a coding agent can
misread, skip, or fabricate verification. The cost is extra execution time and
the need for a reliable way to discover the project's gates. The first version
uses a clean worktree and a separate process, not a container or sandbox; that
stronger isolation can be added later.
