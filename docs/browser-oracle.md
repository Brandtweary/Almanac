# Browser runtime

The browser loads its model, role budgets and readiness from `/v1/profile`, sends every completion through the local gateway with exact template/tokenizer admission, and keeps personal memory optional while corpus search/read and immutable source citations remain available; migration deletes known legacy credential slots without reading their values or replacing saved conversations and memory.

Queue status and cancellation use transient request handles, context compaction preserves an explicit source ledger and marks omitted evidence for rereading, and personal-memory failure pauses its durable queue with a visible retry control while reference chat remains usable.

Automatic compaction runs before new input and within long research turns, preserving the current request and complete tool-call/result groups under the profile's measured budgets. Full citation metadata remains stored for validation while its model-facing representation is a fixed notice; summaries retain source handles and document identities, and original evidence remains available through history and corpus reads.

Original completed conversation messages are saved independently of compacted model context, with stable record handles accessible through the current-conversation `conversation_history` search/read tool; personal-memory consent does not control ordinary chat retention. Chats can export/import complete conversation files, legacy archives explicitly mark unavailable earlier history, deletion removes both context and originals, and storage conflicts or quota failures are visible rather than permitting destructive compaction.

Model-facing history obeys the personal-memory filter when consent is off, hiding memory-tool results and redacting memory-tool calls while preserving the original archive for export. Background memory jobs bind to immutable raw-record ranges and verify their digest before inspection or publication.

Personal recall rotates independently on accepted user input and completed tool results, with fresh whole definitions admitted against the complete model-request budget; corpus evidence remains separate. Successful HTTP admission records exact recall receipts in the raw archive for background audit, while old receipt and recall blocks are excluded from active model history; see [rotating recall](rotating-recall.md).
