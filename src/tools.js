// src/tools.js — Tool calling adapter for models without native function calling
const jsonToolRegex = /```json\s*(\{[\s\S]*?\})\s*```/g;
const toolTagRegex = /<<TOOL>>\s*(\{[\s\S]*?\})\s*<<\/TOOL>>/g;

// Thinking-mode reasoning blocks (<details type="reasoning">...</details>)
const reasoningBlockRegex = /<details[^>]*type=["']reasoning["'][^>]*>[\s\S]*?<\/details>/;
const reasoningBlockRegexG = /<details[^>]*type=["']reasoning["'][^>]*>[\s\S]*?<\/details>/g;
const reasoningOpenTagRegex = /<details[^>]*type=["']reasoning["'][^>]*>/;
const reasoningOpenTagRegexG = /<details[^>]*type=["']reasoning["'][^>]*>/g;

function buildToolsSystemPrompt(tools) {
  let sb = 'You are an AI assistant with access to the following functions.\n';
  sb += 'Available functions:\n';
  sb += buildCompactToolList(tools);
  sb += 'To call a function, respond with exactly one JSON object: {"name": "function_name", "arguments": {...}}\n';
  sb += "Only output the JSON object when the user's request maps to one of the functions above.\n";
  sb += 'If the input does NOT map to any function — e.g. it is a greeting or a plain question — do NOT output JSON. Respond to the input normally, as a helpful assistant, using the conversation context.\n\n';
  return sb;
}

function buildCompactToolList(tools) {
  if (!Array.isArray(tools)) return '';
  let sb = '';
  for (const raw of tools) {
    const tool = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!tool || !tool.function || !tool.function.name) continue;
    sb += `- ${tool.function.name}`;
    if (tool.function.parameters) {
      const sig = extractParamSignature(tool.function.parameters);
      if (sig) {
        sb += `(${sig})`;
      }
    }
    if (tool.function.description) {
      let desc = tool.function.description;
      if (desc.length > 80) {
        desc = desc.slice(0, 80) + '...';
      }
      sb += ` — ${desc}`;
    }
    sb += '\n';
  }
  return sb;
}

function extractParamSignature(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties) return '';
  const props = schema.properties;
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
  const parts = [];

  for (const [name, v] of Object.entries(props)) {
    let typeName = 'any';
    if (v && typeof v === 'object' && v.type) {
      switch (v.type) {
        case 'string':
          typeName = 'str';
          break;
        case 'integer':
          typeName = 'int';
          break;
        case 'boolean':
          typeName = 'bool';
          break;
        case 'array':
          typeName = 'arr';
          break;
        case 'object':
          typeName = 'obj';
          break;
      }
    }
    if (requiredSet.has(name)) {
      parts.push(`${name}: ${typeName}`);
    } else {
      parts.push(`${name}?: ${typeName}`);
    }
  }
  return parts.join(', ');
}

function repairUnescapedQuotes(s) {
  let out = '';
  let inStr = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out += c;
      if (c === '"') {
        inStr = true;
      }
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\r' || s[j] === '\n')) {
        j++;
      }
      if (j < s.length && (s[j] === ',' || s[j] === ']' || s[j] === '}' || s[j] === ':')) {
        out += c; // Genuine closing quote
        inStr = false;
        continue;
      }
      // Unescaped quote inside string
      out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}

function buildSchemaMap(tools) {
  const m = {};
  if (!Array.isArray(tools)) return m;
  for (const raw of tools) {
    const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (t && t.function && t.function.name) {
      m[t.function.name] = t.function.parameters || {};
    }
  }
  return m;
}

function parseDirectJSON(content) {
  const stripped = content.trim();
  let direct;
  try {
    direct = JSON.parse(stripped);
  } catch (e) {
    return null;
  }

  if (direct && typeof direct === 'object') {
    let name = direct.name;
    let args = direct.arguments;

    if (!name && direct.action) {
      name = direct.action;
    }

    if (name && typeof name === 'string') {
      if (name === '__done__') {
        let result = typeof args === 'object' && args ? args.result : undefined;
        if (result && typeof result === 'string') {
          let resultStr = result.trim();
          resultStr = resultStr.replace(/^```json\n/, '').replace(/^```\n/, '').replace(/\n```$/, '').trim();
          try {
            const nested = JSON.parse(resultStr);
            if (nested && nested.name && nested.name !== '__done__') {
              const nestedArgs = typeof nested.arguments === 'object' ? JSON.stringify(nested.arguments) : String(nested.arguments || '{}');
              return [{
                id: 'call_1',
                type: 'function',
                function: { name: nested.name, arguments: nestedArgs },
              }];
            }
          } catch (e) {}
        }
        return null;
      }

      const argsStr = typeof args === 'object' ? JSON.stringify(args) : (typeof args === 'string' ? args : '{}');
      return [{
        id: 'call_1',
        type: 'function',
        function: { name, arguments: argsStr },
      }];
    }
  }
  return null;
}

function parseEmbeddedJSON(content) {
  const first = content.indexOf('{');
  if (first < 0) return null;
  const last = content.lastIndexOf('}');
  if (last <= first) return null;

  const extracted = content.slice(first, last + 1);
  if (extracted === content.trim()) return null;

  const direct = parseDirectJSON(extracted);
  if (direct && direct.length > 0) return direct;

  const repaired = repairUnescapedQuotes(extracted);
  if (repaired !== extracted) {
    const repDirect = parseDirectJSON(repaired);
    if (repDirect && repDirect.length > 0) return repDirect;
  }
  return null;
}

function parseJSONToolCalls(content) {
  const matches = [...content.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)];
  if (matches.length === 0) return null;

  const calls = [];
  for (let i = 0; i < matches.length; i++) {
    try {
      const parsed = JSON.parse(matches[i][1]);
      if (parsed && parsed.name) {
        calls.push({
          id: `call_${i + 1}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'object' ? JSON.stringify(parsed.arguments) : (parsed.arguments || '{}'),
          },
        });
      }
    } catch (e) {}
  }
  return calls.length > 0 ? calls : null;
}

function parseTagToolCalls(content) {
  const matches = [...content.matchAll(/<<TOOL>>\s*(\{[\s\S]*?\})\s*<<\/TOOL>>/g)];
  if (matches.length === 0) return null;

  const calls = [];
  for (let i = 0; i < matches.length; i++) {
    try {
      const parsed = JSON.parse(matches[i][1]);
      if (parsed && parsed.name) {
        calls.push({
          id: `call_${i + 1}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'object' ? JSON.stringify(parsed.arguments) : (parsed.arguments || '{}'),
          },
        });
      }
    } catch (e) {}
  }
  return calls.length > 0 ? calls : null;
}

function parseMultilineJSON(content) {
  const lines = content.trim().split('\n');
  const calls = [];

  for (const line of lines) {
    let clean = line.trim();
    if (!clean) continue;
    while (clean.length > 0 && (clean.endsWith('}') || clean.endsWith('`'))) {
      try {
        const generic = JSON.parse(clean);
        if (generic && generic.name && generic.name !== '__done__') {
          let argsStr = '';
          if (generic.arguments) {
            argsStr = typeof generic.arguments === 'object' ? JSON.stringify(generic.arguments) : String(generic.arguments);
          }
          if (!argsStr) {
            const copy = { ...generic };
            delete copy.name;
            delete copy.type;
            argsStr = JSON.stringify(copy);
          }
          if (!argsStr || argsStr === 'null') argsStr = '{}';

          calls.push({
            type: 'function',
            function: { name: generic.name, arguments: argsStr },
          });
          break;
        }
      } catch (e) {}
      clean = clean.slice(0, -1);
    }
  }
  return calls.length > 0 ? calls : null;
}

function parseNaturalLanguage(content, tools) {
  const toolNames = new Set();
  if (Array.isArray(tools)) {
    for (const raw of tools) {
      const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (t && t.function && t.function.name) {
        toolNames.add(t.function.name);
      }
    }
  }

  const calls = [];
  let callIdx = 0;

  // Pattern 1: echo "content" > file
  const echoRegex = /echo\s+["']?(.*?)["']?\s*>\s*(\S+)/g;
  for (const m of content.matchAll(echoRegex)) {
    if (!toolNames.has('write_file') && !toolNames.has('write')) continue;
    const fileContent = m[1];
    const filePath = m[2].replace(/^[`"']+|[`"']+$/g, '');
    const toolName = toolNames.has('write_file') ? 'write_file' : 'write';
    callIdx++;
    calls.push({
      id: `call_${callIdx}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify({ path: filePath, content: fileContent }),
      },
    });
  }

  // Pattern 2 & 3: code blocks + file references
  const codeBlocks = [...content.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)\n```/g)];
  const fileRefs = [...content.matchAll(/(?:file|File)\s+(?:called|named)\s+["']?(.+?)["']?/g)];

  if (codeBlocks.length > 0 && fileRefs.length > 0 && (toolNames.has('write_file') || toolNames.has('write'))) {
    const toolName = toolNames.has('write_file') ? 'write_file' : 'write';
    const filePath = fileRefs[0][1].replace(/^['" .]+|['" .]+$/g, '');
    const fileContent = codeBlocks[0][1];
    callIdx++;
    calls.push({
      id: `call_${callIdx}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify({ path: filePath, content: fileContent }),
      },
    });
  }

  return calls.length > 0 ? calls : null;
}

function dedupCalls(calls) {
  if (!calls) return [];
  const seen = new Set();
  const result = [];
  for (const c of calls) {
    const key = `${c.function.name}:${c.function.arguments}`;
    if (!seen.has(key)) {
      seen.add(key);
      c.id = `call_${result.length + 1}`;
      result.push(c);
    }
  }
  return result;
}

function filterValidCalls(calls, schemas) {
  if (!calls) return [];
  const valid = [];
  for (const c of calls) {
    if (!schemas[c.function.name]) {
      continue;
    }
    try {
      JSON.parse(c.function.arguments);
    } catch (e) {
      continue;
    }
    valid.push(c);
  }
  return valid;
}

function parseToolCalls(content, tools) {
  const schemas = buildSchemaMap(tools);

  // Strategy 1: ```json code blocks
  let calls = filterValidCalls(dedupCalls(parseJSONToolCalls(content)), schemas);
  if (calls.length > 0) return calls;

  // Strategy 2: Direct JSON
  calls = filterValidCalls(dedupCalls(parseDirectJSON(content)), schemas);
  if (calls.length > 0) return calls;

  // Strategy 2b: Embedded JSON with quote repair
  calls = filterValidCalls(dedupCalls(parseEmbeddedJSON(content)), schemas);
  if (calls.length > 0) return calls;

  // Strategy 3: Multi-line JSON
  calls = filterValidCalls(dedupCalls(parseMultilineJSON(content)), schemas);
  if (calls.length > 0) return calls;

  // Strategy 4: <<TOOL>> tags
  calls = filterValidCalls(dedupCalls(parseTagToolCalls(content)), schemas);
  if (calls.length > 0) return calls;

  // Strategy 5: Natural language
  calls = filterValidCalls(dedupCalls(parseNaturalLanguage(content, tools)), schemas);
  if (calls.length > 0) return calls;

  return [];
}

function stripFraming(content) {
  const userIdx = content.lastIndexOf('User request:');
  if (userIdx >= 0) {
    const rest = content.slice(userIdx + 'User request:'.length).trim();
    if (rest) return rest;
  }
  const funcIdx = content.indexOf('Available functions:');
  if (funcIdx >= 0) {
    const end = content.indexOf('\n\n', funcIdx);
    if (end >= 0) {
      const after = content.slice(funcIdx + end).trim();
      if (after) return after;
    }
  }
  return content;
}

function stripReasoning(content) {
  return content.replace(reasoningBlockRegexG, '').trim();
}

function flushReasoningFree(bufRef) {
  let s = bufRef.text;
  while (true) {
    const match = s.match(reasoningOpenTagRegex);
    if (!match) {
      const out = s;
      bufRef.text = '';
      return { text: out, hold: false };
    }
    const openIdx = match.index;
    const afterOpen = s.slice(openIdx + match[0].length);
    const closeIdx = afterOpen.indexOf('</details>');
    if (closeIdx < 0) {
      // Still inside reasoning — hold
      bufRef.text = s;
      return { text: '', hold: true };
    }
    s = s.slice(0, openIdx) + afterOpen.slice(closeIdx + '</details>'.length);
    if (openIdx === 0) {
      s = s.replace(/^[\s\r\n]+/, '');
    }
  }
}

function stripReasoningTags(content) {
  let s = content;
  // Replace complete blocks keeping inner text
  s = s.replace(reasoningBlockRegexG, (match) => {
    let inner = match.replace(reasoningOpenTagRegexG, '').replace(/<\/details>/g, '');
    return inner;
  });
  // Strip orphan tags
  s = s.replace(reasoningOpenTagRegexG, '').replace(/<\/details>/g, '');
  // Strip leading "> " quote markers
  const lines = s.split('\n').map((l) => (l.startsWith('> ') ? l.slice(2) : l));
  return lines.join('\n');
}

class ReasoningSplitter {
  constructor() {
    this.inReasoning = false;
  }

  process(chunk) {
    let content = '';
    let reasoning = '';
    let s = chunk;

    while (s.length > 0) {
      if (!this.inReasoning) {
        const match = s.match(reasoningOpenTagRegex);
        if (!match) {
          content += s;
          break;
        }
        content += s.slice(0, match.index);
        this.inReasoning = true;
        s = s.slice(match.index + match[0].length);
      } else {
        const closeIdx = s.indexOf('</details>');
        if (closeIdx < 0) {
          reasoning += s;
          break;
        }
        reasoning += s.slice(0, closeIdx);
        this.inReasoning = false;
        s = s.slice(closeIdx + '</details>'.length);
      }
    }

    return {
      content,
      reasoning: reasoning.replace(/^> /gm, ''),
    };
  }
}

function splitReasoningInline(s) {
  const splitter = new ReasoningSplitter();
  return splitter.process(s);
}

function stripToolContent(content) {
  return content.replace(toolTagRegex, '').replace(jsonToolRegex, '').trim();
}

function convertToolMessages(messages, tools) {
  const framing = buildToolsSystemPrompt(tools);
  let lastUserIdx = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = typeof messages[i] === 'string' ? JSON.parse(messages[i]) : messages[i];
    if (m && m.role === 'user' && !m.tool_call_id) {
      lastUserIdx = i;
      break;
    }
  }

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg || typeof msg !== 'object') {
      result.push(raw);
      continue;
    }

    const role = msg.role;
    switch (role) {
      case 'system':
        result.push(raw);
        break;
      case 'tool': {
        const content = msg.content || '';
        const id = msg.tool_call_id || '';
        result.push({
          role: 'user',
          content: `[Tool result for ${id}]: ${content}`,
        });
        break;
      }
      case 'assistant': {
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          let callsText = '';
          for (const call of msg.tool_calls) {
            if (call && call.function) {
              const name = call.function.name || '';
              const args = typeof call.function.arguments === 'object' ? JSON.stringify(call.function.arguments) : String(call.function.arguments || '{}');
              callsText += `{"name":"${name}","arguments":${args}}\n`;
            }
          }
          const orig = msg.content || '';
          result.push({
            role: 'assistant',
            content: (orig + '\n' + callsText).trim(),
          });
        } else {
          result.push(raw);
        }
        break;
      }
      case 'user': {
        if (i === lastUserIdx) {
          const orig = msg.content || '';
          result.push({
            role: 'user',
            content: `${framing}User request: ${orig}`,
          });
        } else {
          result.push(raw);
        }
        break;
      }
      default:
        result.push(raw);
        break;
    }
  }

  if (lastUserIdx < 0) {
    result.unshift({ role: 'system', content: framing });
  }

  return result;
}

module.exports = {
  ReasoningSplitter,
  buildToolsSystemPrompt,
  buildCompactToolList,
  extractParamSignature,
  repairUnescapedQuotes,
  parseToolCalls,
  stripFraming,
  stripReasoning,
  flushReasoningFree,
  stripReasoningTags,
  splitReasoningInline,
  stripToolContent,
  convertToolMessages,
};
