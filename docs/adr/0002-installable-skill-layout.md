# Install self-loop as a skill

Status: accepted

Self-loop is distributed as an installable skill with `SKILL.md` at the skill
root. A target repository keeps only configuration, memory, and ignored
`.loop/` output; it does not need a project-local `loop/` directory.

This was chosen over copying the loop implementation into every project because
it gives one upgrade path and prevents product repositories from owning
scheduler code. The cost is that scripts must locate themselves from
`SKILL.md`, installation layouts must be verified, and version drift must be
managed explicitly.
