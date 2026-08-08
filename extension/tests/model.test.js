const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../model.js');

test('normalizes a legacy text queue item', () => {
  const item = model.normalizeItem({
    id: 'q1',
    url: 'https://example.com',
    title: 'Example',
    anchor: { exact: 'selected', prefix: 'before', suffix: 'after', start: 10 },
    question: 'Why?',
    createdAt: 42,
  });
  assert.equal(item.selectedContext[0].source.url, 'https://example.com');
  assert.equal(item.selectedContext[0].locator.exact, 'selected');
  assert.deepEqual(item.message.parts, [{ type: 'text', text: 'Why?' }]);
});

test('coalesces adjacent text while preserving asset order', () => {
  assert.deepEqual(model.coalesceParts([
    { type: 'text', text: 'make it ' },
    { type: 'text', text: 'look like ' },
    { type: 'asset', assetId: 'a1', mediaType: 'image/png', label: 'reference.png' },
    { type: 'text', text: ' please' },
  ]), [
    { type: 'text', text: 'make it look like ' },
    { type: 'asset', assetId: 'a1', mediaType: 'image/png', label: 'reference.png' },
    { type: 'text', text: ' please' },
  ]);
});

test('collects unique assets from context and message', () => {
  const item = {
    id: 'q1',
    selectedContext: [{
      source: {},
      locator: { type: 'unanchored' },
      parts: [{ type: 'asset', assetId: 'context', mediaType: 'image/png' }],
    }],
    message: { role: 'user', parts: [
      { type: 'asset', assetId: 'reference', mediaType: 'image/png' },
      { type: 'asset', assetId: 'context', mediaType: 'image/png' },
    ] },
  };
  assert.deepEqual(model.assetIdsOf(item), ['context', 'reference']);
});

test('creates an unanchored whole-page request', () => {
  const item = model.createPageRequest({
    id: 'page-question',
    source: { url: 'https://example.com', title: 'Example' },
    messageParts: [model.textPart('Summarize this page.')],
    createdAt: 42,
  });
  assert.equal(item.selectedContext[0].locator.type, 'unanchored');
  assert.deepEqual(item.selectedContext[0].parts, []);
  assert.deepEqual(item.message.parts, [{ type: 'text', text: 'Summarize this page.' }]);
});
