// test/tools.test.js — Tool-calling, quote repair, framing, and reasoning tests
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  repairUnescapedQuotes,
  parseToolCalls,
  convertToolMessages,
  stripFraming,
  stripReasoning,
  flushReasoningFree,
  splitReasoningInline,
  stripReasoningTags,
} = require('../src/tools');

test('repairUnescapedQuotes', () => {
  const cases = [
    { in: '{"a":"x"}', want: '{"a":"x"}' },
    { in: '{"a":"say "hi" now"}', want: '{"a":"say \\"hi\\" now"}' },
    { in: '{"a":"--body "## text""}', want: '{"a":"--body \\"## text\\""}' },
    { in: '{"a":"done","b":1}', want: '{"a":"done","b":1}' },
  ];

  for (const c of cases) {
    const got = repairUnescapedQuotes(c.in);
    assert.equal(got, c.want, `repairUnescapedQuotes failed for: ${c.in}`);
    assert.doesNotThrow(() => JSON.parse(got), `Repaired string is not valid JSON: ${got}`);
  }
});

test('parseEmbeddedJSON with unescaped quotes', () => {
  const content =
    '已推送。现在去 issue 回复：\n' +
    '{"name":"terminal","arguments":{"command":"cd /root/zai2api && gh issue comment 1 --repo pingmike2/zai2api --body "## 已修复""}}';

  const tools = [
    {
      type: 'function',
      function: {
        name: 'terminal',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
      },
    },
  ];

  const calls = parseToolCalls(content, tools);
  assert.equal(calls.length, 1, 'Should extract exactly 1 tool call');
  assert.equal(calls[0].function.name, 'terminal');

  const args = JSON.parse(calls[0].function.arguments);
  assert.ok(args.command.includes('--body'), `Command argument missing --body: ${args.command}`);
});

test('convertToolMessages keeps system context', () => {
  const sys = { role: 'system', content: 'You are Hermes Agent, built by Nous Research.' };
  const user = { role: 'user', content: '你好' };
  const tools = [
    {
      type: 'function',
      function: {
        name: 'terminal',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  const out = convertToolMessages([sys, user], tools);
  let sysFound = false;
  let userFound = false;

  for (const m of out) {
    if (m.role === 'system' && m.content.includes('Hermes Agent')) {
      sysFound = true;
    }
    if (m.role === 'user' && m.content.includes('User request: 你好')) {
      userFound = true;
    }
  }

  assert.ok(sysFound, 'System message must be preserved');
  assert.ok(userFound, 'User message must have framed user request');
});

test('stripFraming', () => {
  const cases = [
    { in: 'Available functions:\n- terminal\n\nHello there', want: 'Hello there' },
    { in: 'You are an AI assistant with access to functions.\nUser request: hi', want: 'hi' },
    { in: 'plain answer', want: 'plain answer' },
  ];

  for (const c of cases) {
    assert.equal(stripFraming(c.in).trim(), c.want);
  }
});

test('stripReasoning', () => {
  const input =
    '<details type="reasoning" done="false">\n> The user said "Hi" - this is a greeting.\n</details>\nHello! How can I help you today? 😊';
  const want = 'Hello! How can I help you today? 😊';
  assert.equal(stripReasoning(input), want);
});

test('flushReasoningFree', () => {
  const buf = { text: '' };

  // Partial opening tag — must hold
  buf.text = '<details type="reasoning" done="false">\n> The user';
  let res = flushReasoningFree(buf);
  assert.equal(res.text, '');
  assert.equal(res.hold, true);

  // Reasoning body continues — still hold
  buf.text += ' said "Hi" - greeting.\n';
  res = flushReasoningFree(buf);
  assert.equal(res.text, '');
  assert.equal(res.hold, true);

  // Block closes — reasoning stripped, answer emitted
  buf.text += '</details>\nHello!';
  res = flushReasoningFree(buf);
  assert.equal(res.hold, false);
  assert.equal(res.text, 'Hello!');

  // Plain text without reasoning
  buf.text = 'plain';
  res = flushReasoningFree(buf);
  assert.equal(res.hold, false);
  assert.equal(res.text, 'plain');
});

test('splitReasoningInline', () => {
  // Whole block
  let res = splitReasoningInline('<details type="reasoning" done="false">\n> think\n</details>');
  assert.equal(res.content, '');
  assert.ok(res.reasoning.includes('think'));

  // Block + trailing answer
  res = splitReasoningInline('<details type="reasoning">\n> think\n</details>\nAnswer here');
  assert.ok(res.reasoning.includes('think'));
  assert.ok(res.content.includes('Answer here'));

  // Plain content
  res = splitReasoningInline('just text');
  assert.equal(res.content, 'just text');
  assert.equal(res.reasoning, '');
});

test('ReasoningSplitter across multiple streaming chunks', () => {
  const { ReasoningSplitter } = require('../src/tools');
  const splitter = new ReasoningSplitter();

  const chunk1 = '<details type="reasoning" done="false">\n> ';
  const chunk2 = 'asks why I cannot see files. Answer normally, no tool call needed... Actually maybe I could ask where the project ';
  const chunk3 = '\n</details>\nGood question — here is the situation:';

  const r1 = splitter.process(chunk1);
  assert.equal(r1.content, '');

  const r2 = splitter.process(chunk2);
  assert.equal(r2.content, '', 'Reasoning body must NEVER leak into content');
  assert.ok(r2.reasoning.includes('asks why I cannot see files'));

  const r3 = splitter.process(chunk3);
  assert.equal(r3.content, '\nGood question — here is the situation:');
});
