// Contract-only tests: no real model, TCP service or REA invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET, PROMPT, makeRequest, mockOutput, validateOutput, validateSelection } from './n09-contract.mjs';
const packet = { id: 'packet-1', source: 'packet', text: 'Explicit mock packet evidence: bytes 01 02 03.' };
const binary = { id: 'binary-1', source: 'binary', text: 'Explicit mock binary evidence: example function record.' };
const request = condition => makeRequest({ condition, packet, binary: condition === 'B' ? binary : null });

test('A receives packet evidence only; no binary evidence is serialized', () => {
  const a = request('A');
  assert.deepEqual(JSON.parse(a.messages[1].content).evidence, [packet]);
  assert.equal(JSON.stringify(a).includes(binary.text), false);
});
test('B receives the exact same packet text and additional binary evidence', () => {
  const a = request('A'), b = request('B');
  assert.deepEqual(JSON.parse(a.messages[1].content).evidence[0], JSON.parse(b.messages[1].content).evidence[0]);
  assert.deepEqual(JSON.parse(b.messages[1].content).evidence, [packet, binary]);
});
test('A and B have identical system prompts and declared model allowances', () => {
  const a = request('A'), b = request('B');
  assert.equal(a.messages[0].content, PROMPT);
  assert.equal(a.messages[0].content, b.messages[0].content);
  assert.deepEqual(a.budget, b.budget);
  assert.equal(a.budget.server_queries, 0);
});
test('budget copies cannot mutate the shared definition or another run', () => {
  const a = request('A');
  a.budget.model_calls = 999;
  assert.equal(BUDGET.model_calls, 2);
  assert.equal(request('B').budget.model_calls, 2);
});
test('A rejects an operator binary selection', () => {
  assert.throws(() => validateSelection({ condition: 'A', binaryPath: '/not-allowed' }), { code: 'A_BINARY_FORBIDDEN' });
});
test('B requires a binary selection', () => {
  assert.throws(() => validateSelection({ condition: 'B' }), { code: 'B_BINARY_REQUIRED' });
});
for (const [name, options, code] of [
  ['condition', { condition: 'C' }, 'INVALID_CONDITION'],
  ['execution', { condition: 'A', execution: 'live' }, 'INVALID_EXECUTION'],
  ['experiment', { condition: 'A', experiment: 'pretend-score' }, 'INVALID_EXPERIMENT'],
]) test('invalid ' + name + ' is rejected', () => assert.throws(() => validateSelection(options), { code }));
test('evidence must have the expected source, text and a unique ID', () => {
  assert.throws(() => makeRequest({ condition: 'A', packet: { ...packet, source: 'binary' } }), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => makeRequest({ condition: 'A', packet: { ...packet, text: '' } }), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => makeRequest({ condition: 'B', packet, binary: { ...binary, id: packet.id } }), { code: 'INVALID_EVIDENCE' });
});
for (const condition of ['A', 'B']) test(condition + ' mock output validates but contains no recovered specification', () => {
  const r = request(condition), output = mockOutput(r);
  assert.deepEqual(output.spec, {});
  assert.match(output.unknowns[0], /MOCK ONLY/);
  assert.equal(validateOutput(output, r)[0].exact_match, true);
});
test('an observation cannot cite binary evidence in A', () => {
  const r = request('A'), output = mockOutput(r);
  output.observations = [{ claim: 'Unsupported fixture', evidence_id: binary.id, quote: binary.text }];
  assert.throws(() => validateOutput(output, r), { code: 'QUOTE_MISMATCH' });
});
test('a fabricated quote fails even with a valid evidence ID', () => {
  const r = request('B'), output = mockOutput(r);
  output.observations[0].quote = 'This quote was never supplied in the evidence.';
  assert.throws(() => validateOutput(output, r), { code: 'QUOTE_MISMATCH' });
});
test('a matching quote in the wrong source does not pass', () => {
  const r = request('B'), output = mockOutput(r);
  output.observations[0].evidence_id = binary.id;
  assert.throws(() => validateOutput(output, r), { code: 'QUOTE_MISMATCH' });
});
test('missing or malformed output fields are rejected', () => {
  const r = request('A');
  for (const output of [null, { spec: [], observations: [], unknowns: [] },
    { spec: {}, observations: [], unknowns: [42] }])
    assert.throws(() => validateOutput(output, r), { code: 'OUTPUT_SCHEMA' });
  const output = mockOutput(r);
  output.observations[0].quote = 'short';
  assert.throws(() => validateOutput(output, r), { code: 'OUTPUT_SCHEMA' });
});
test('exact quotation offsets remain character offsets with non-ASCII evidence', () => {
  const p = { ...packet, text: '네트워크 패킷 근거입니다. 확인해야 할 실제 문장입니다.' };
  const r = makeRequest({ condition: 'A', packet: p });
  const quote = p.text.slice(5);
  const checks = validateOutput({ spec: {}, observations: [{ claim: 'Quote location only',
    evidence_id: p.id, quote }], unknowns: [] }, r);
  assert.equal(checks[0].quote_start_character, 5);
  assert.equal(checks[0].semantic_review, 'pending');
});
