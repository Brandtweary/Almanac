import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerCopyText, collectAnswerSources, answerIdentity, isAnswerMessage } from '../src/answer-sources.js';
import { EvidenceLedger } from '../src/corpus-tools.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const generation = 'a'.repeat(64), revision = 'b'.repeat(64), extraction = 'c'.repeat(64);
const handle = (offset: string) => `p:${generation}:${offset.repeat(64)}`;
const evidence = (document_id: string, title: string, offset: string, collection?: string) => ({
 passage_id: handle(offset), document_id, source_revision: revision, extraction_revision: extraction, title,
 ...(collection ? { collection } : {}), edition: 'v1', section: [], excerpt: 'Passage text', complete: true,
 previous: null, next: null, flags: [], page: { index: 0, label: '1', coordinates: null, anchor: null },
 source: { url: `/v1/corpus/source/${encodeURIComponent(handle(offset))}`, sha256: revision, media_type: 'text/html', origin: 'fixture' },
});
const user = (content = 'Question') => ({ role: 'user', content, timestamp: 1 }) as unknown as AgentMessage;
const answer = (text: string, timestamp = 5) => ({
 role: 'assistant', content: [{ type: 'text', text }], timestamp, stopReason: 'stop',
 api: 'openai-completions', provider: 'fixture', model: 'fixture',
}) as unknown as AssistantMessage;
const call = (id: string, name = 'corpus_read') => ({
 role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }], timestamp: 2, stopReason: 'toolUse',
 api: 'openai-completions', provider: 'fixture', model: 'fixture',
}) as unknown as AssistantMessage;
const result = (id: string, rows: unknown[], name = 'corpus_read') => ({
 role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: 'evidence' }],
 details: name === 'corpus_read' ? { passages: rows } : { hits: rows }, timestamp: 3, isError: false,
}) as unknown as AgentMessage;

const manual = evidence('manual', 'Manual', 'd', 'Field Guides'), second = evidence('atlas', 'Atlas', 'e');
const copy = (messages: AgentMessage[], message: AssistantMessage) => {
 const ledger = new EvidenceLedger();
 ledger.restore(messages);
 return answerCopyText(message, collectAnswerSources(messages).get(answerIdentity(message)), ledger, 'http://127.0.0.1:8790');
};
const sourceUrl = (offset: string) => `http://127.0.0.1:8790/v1/corpus/source/${encodeURIComponent(handle(offset))}`;

test('copied answers carry resolvable citations and the footer the transcript shows', () => {
 const cited = answer(`Grounded claim [Manual](corpus:${handle('d')}).`);
 const turn = [user(), call('read'), result('read', [manual, second]), cited];
 assert.equal(copy(turn, cited), [
  `Grounded claim [Manual](${sourceUrl('d')}).`, '',
  'Sources — cited in this answer:',
  `- Field Guides — Manual — ${sourceUrl('d')}`,
 ].join('\n'));

 // Retrieval the answer never cited stays labelled as retrieval, never as support.
 const uncited = answer('Ungrounded claim.');
 assert.equal(copy([user(), call('read'), result('read', [manual]), uncited], uncited), [
  'Ungrounded claim.', '',
  'Consulted — retrieved while researching; not cited in the answer:',
  `- Field Guides — Manual — ${sourceUrl('d')}`,
 ].join('\n'));

 // A handle the library never returned loses its target and is labelled, as the transcript labels it.
 const invented = answer(`Invented [Ghost](corpus:${handle('9')}).`);
 const inventedCopy = copy([user(), call('read'), result('read', [manual]), invented], invented);
 assert.match(inventedCopy, /^Invented Ghost \[unverified source\]\.$/m);
 assert.match(inventedCopy, /^Consulted — /m);

 // A passage read in an earlier turn still resolves; the footer heading follows the citation.
 const later = answer(`Later turn [Atlas](corpus:${handle('e')}).`, 9);
 const across = [user(), call('read'), result('read', [manual, second]), answer('First.'), user('Follow-up'), later];
 assert.equal(copy(across, later), [
  `Later turn [Atlas](${sourceUrl('e')}).`, '',
  'Sources — cited in this answer:',
  `- Atlas — ${sourceUrl('e')}`,
 ].join('\n'));
});

test('copying leaves non-corpus text alone and omits an absent footer', () => {
 const ledger = new EvidenceLedger();
 ledger.restore([result('read', [manual])]);
 const plain = answer('  Ordinary [docs](https://example.invalid/page) and `code`.  ');
 assert.equal(answerCopyText(plain, undefined, ledger, 'http://127.0.0.1:8790'),
  'Ordinary [docs](https://example.invalid/page) and `code`.');
 assert.equal(answerCopyText(plain, { kind: 'cited', sources: [] }, ledger, 'http://127.0.0.1:8790'),
  'Ordinary [docs](https://example.invalid/page) and `code`.');

 // Quoted syntax is not a citation, so it is not rewritten.
 const quoted = answer(`Cite like this:\n\n\`\`\`\n[Manual](corpus:${handle('d')})\n\`\`\``);
 assert.match(answerCopyText(quoted, undefined, ledger, 'http://127.0.0.1:8790'), /\(corpus:p:/);

 // Multiple text parts join, and a tool-only turn is not an answer at all.
 const multipart = { ...answer('First part.'), content: [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }] } as unknown as AssistantMessage;
 assert.equal(answerCopyText(multipart, undefined, ledger), 'First part.\nSecond part.');
 assert.equal(isAnswerMessage(call('read')), false);
 assert.equal(isAnswerMessage(answer('   ')), false);
 assert.equal(isAnswerMessage(answer('Text.')), true);
});
