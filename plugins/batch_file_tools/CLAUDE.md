# Tool preference
Always use `batch_read` and `batch_edit` instead of the built-in Read, Edit, Write and Update tools.

# Workflow
Before reading or editing load both `batch_read` and `batch_edit` tools, then plan which files you need and in what order. Bundle related reads into one `batch_read` call and related edits into one `batch_edit` call — fewer round-trips means less context noise and more room for the actual task.
