// test/models.test.js — Model normalization and parameter testing
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeModel,
  newZAIRequestBody,
  KNOWN_MODELS,
} = require('../src/zai');

test('normalizeModel mappings', () => {
  const cases = {
    '': 'glm-5.3-flash',
    'glm-5.3': 'glm-5.3',
    'GLM-5.3': 'glm-5.3',
    'glm-5.3-flash': 'x-preview-l',
    'GLM-5.3-FLASH': 'x-preview-l',
    'glm-5.2': 'glm-5.2',
    'glm-4.7': 'x-preview-l',
    'glm-5v-turbo': 'x-preview-l',
    'glm-5.1': 'glm-5.3',
    'x-preview-l': 'x-preview-l',
    'some-unknown-name': 'some-unknown-name',
  };

  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeModel(input), expected, `Failed for input: ${input}`);
  }
});

test('KNOWN_MODELS list', () => {
  assert.deepEqual(KNOWN_MODELS, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
});

test('newZAIRequestBody - always-think models', () => {
  // thinking=false -> remap to reasoning_effort=low
  const body1 = newZAIRequestBody(
    { model: 'x-preview-l', chatID: 'c', thinking: false },
    'cap',
    [],
    'prompt'
  );
  assert.ok(body1.id, 'missing top-level id');
  assert.equal(body1.features.enable_thinking, true, 'always-think must have enable_thinking=true');
  assert.equal(body1.features.reasoning_effort, 'low', 'thinking=false -> reasoning_effort=low');

  // thinking=true -> reasoning_effort=high
  const body2 = newZAIRequestBody(
    { model: 'glm-5.3', chatID: 'c', thinking: true },
    'cap',
    [],
    'prompt'
  );
  assert.equal(body2.features.enable_thinking, true);
  assert.equal(body2.features.reasoning_effort, 'high');

  // deepThink=true -> effort=max
  const body3 = newZAIRequestBody(
    { model: 'glm-5.3', chatID: 'c', thinking: true, effort: 'max' },
    'cap',
    [],
    'prompt'
  );
  assert.equal(body3.features.reasoning_effort, 'max');
});

test('newZAIRequestBody - think capable models (glm-5.2)', () => {
  const body = newZAIRequestBody(
    { model: 'glm-5.2', chatID: 'c', thinking: false },
    'cap',
    [],
    'prompt'
  );
  assert.equal(body.features.enable_thinking, false);
  assert.equal(body.features.reasoning_effort, undefined);
});
