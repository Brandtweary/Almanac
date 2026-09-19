# Browser runtime

The browser loads its model, role budgets and readiness from `/v1/profile`, sends every completion through the local gateway with exact template/tokenizer admission, and keeps personal memory optional while corpus search/read and immutable source citations remain available; migration deletes known legacy credential slots without reading their values or replacing saved conversations and memory.

Reference and conversation-history tool cards keep raw arguments/results collapsed behind the existing inspector; source coverage and failures remain visible in their compact status.

Researched answers include a sources footer reconstructed from original conversation history after reload or compaction. It lists the answer's own citations, resolved against the evidence the corpus returned in that conversation; an answer that cites nothing resolvable instead shows its retrieval for that user turn under a separate label that does not claim support. Each entry is named by the document's title, prefixed with the collection the corpus records for it when that is not already part of the title. Links open the retained source in a new tab or download it, and do not certify the answer's claims.

Queue status and cancellation use transient request handles, context compaction preserves an explicit source ledger and marks omitted evidence for rereading, and personal-memory failure pauses its durable queue with a visible retry control while reference chat remains usable.

Automatic compaction runs before new input and within long research turns, preserving the current request and complete tool-call/result groups under the profile's measured budgets. Full citation metadata remains stored for validation while its model-facing representation is a fixed notice; summaries retain source handles and document identities, and original evidence remains available through history and corpus reads.

Original completed conversation messages are saved independently of compacted model context, with stable record handles accessible through the current-conversation `conversation_history` search/read tool; personal-memory consent does not control ordinary chat retention. Chats can export/import complete conversation files, legacy archives explicitly mark unavailable earlier history, deletion removes both context and originals, and storage conflicts or quota failures are visible rather than permitting destructive compaction.

Model-facing history obeys the personal-memory filter when consent is off, hiding memory-tool results and redacting memory-tool calls while preserving the original archive for export. Background memory jobs bind to immutable raw-record ranges and verify their digest before inspection or publication.

Personal recall rotates independently on accepted user input and completed tool results, with fresh whole definitions admitted against the complete model-request budget; corpus evidence remains separate. Successful HTTP admission records exact recall receipts in the raw archive for background audit, while old receipt and recall blocks are excluded from active model history; see [rotating recall](rotating-recall.md).
