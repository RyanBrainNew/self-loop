# Context Packet and Result Envelope are first-class

Status: accepted

The Router assembles project and Ticket facts once into a Context Packet and
projects them for Router and Worker roles. Every execution result uses one
Result Envelope with human-readable text, a fixed state, error metadata, and
artifact references.

This was chosen over each stage assembling its own prompt and report because
those local shapes drift: a Worker can claim success while the artifact is
missing, and the same failure can be reported differently in a comment, a
report, and a log. The cost is keeping the schemas versioned and validating
them at every boundary.
