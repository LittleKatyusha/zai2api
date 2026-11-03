// src/index.js — Express HTTP server & OpenAI-compatible routes
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const TokenStore = require('./db');
const {
  ZaiSession,
  ConversationStore,
  normalizeModel,
  sendToZAI,
  KNOWN_MODELS,
  DEFAULT_MODEL,
} = require('./zai');
const {
  convertToolMessages,
  parseToolCalls,
  stripFraming,
  stripReasoning,
  stripReasoningTags,
  flushReasoningFree,
  stripToolContent,
} = require('./tools');
const { renderDashboard } = require('./dashboard');
const TokenWorker = require('./worker');

function generateID() {
  return crypto.randomBytes(16).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil((text.length + 3) / 4);
}

function messagesToPrompt(messages) {
  let sb = '';
  for (const raw of messages) {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg) continue;
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    sb += content + '\n\n';
  }
  return sb.trim();
}

function formatOpenAIError(msg, errType = 'api_error') {
  return {
    error: {
      message: msg,
      type: errType,
      code: null,
      param: null,
    },
  };
}

function newChunk(content, model, requestID, finishReason = null) {
  return {
    id: 'chatcmpl-' + requestID,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason,
      },
    ],
  };
}

function newChunkReasoning(reasoning, model, requestID) {
  return {
    id: 'chatcmpl-' + requestID,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { reasoning_content: reasoning },
        finish_reason: null,
      },
    ],
  };
}

function newCompletion(content, prompt, model, requestID, usage = null) {
  const pt = estimateTokens(prompt);
  const ct = estimateTokens(content);
  const finalUsage =
    usage && usage.totalTokens > 0
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        }
      : {
          prompt_tokens: pt,
          completion_tokens: ct,
          total_tokens: pt + ct,
        };

  return {
    id: 'chatcmpl-' + requestID,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: finalUsage,
  };
}

function printBanner() {
  const cyan = '\x1b[36m';
  const yellow = '\x1b[33m';
  const magenta = '\x1b[35m';
  const green = '\x1b[32m';
  const reset = '\x1b[0m';

  console.log();
  console.log(cyan + '   ██████╗ ██╗     ███╗   ███╗    ███████╗ █████╗ ██╗    ██████╗  █████╗ ██████╗ ██╗' + reset);
  console.log(cyan + '  ██╔════╝ ██║     ████╗ ████║    ╚══███╔╝██╔══██╗██║    ╚════██╗██╔══██╗██╔══██╗██║' + reset);
  console.log(cyan + '  ██║  ███╗██║     ██╔████╔██║      ███╔╝ ███████║██║     █████╔╝███████║██████╔╝██║' + reset);
  console.log(cyan + '  ██║   ██║██║     ██║╚██╔╝██║     ███╔╝  ██╔══██║██║    ██╔═══╝ ██╔══██║██╔═══╝ ██║' + reset);
  console.log(cyan + '  ╚██████╔╝███████╗██║ ╚═╝ ██║    ███████╗██║  ██║██║    ███████╗██║  ██║██║     ██║' + reset);
  console.log(cyan + '   ╚═════╝ ╚══════╝╚═╝     ╚═╝    ╚══════╝╚═╝  ╚═╝╚═╝    ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝' + reset);
  console.log();
  console.log(yellow + '  📧 Ported to Node.js' + reset);
  console.log(green + '  🔗 GitHub:' + reset + ' https://github.com/D3-vin/GLM-ZAI-2API');
  console.log(cyan + '  📦 Version:' + reset + ' 1.0.0 (Node)');
  console.log();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // CORS middleware
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Session-Id, X-Fresh-Session'
    );
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Auth middleware
  const withAuth = (req, res, next) => {
    if (!config.authEnabled) return next();
    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (provided !== config.authToken) {
      return res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Invalid or missing authentication token. In your client app, set API Key to '${config.authToken}', or set AUTH_TOKEN= in .env to disable authentication.`,
        },
      });
    }
    next();
  };

  // Base /v1 route helper
  app.get(['/v1', '/v1/'], (req, res) => {
    res.json({
      status: 'ready',
      message: 'GLM-ZAI-2API OpenAI endpoint is active.',
      endpoints: {
        models: '/v1/models',
        chat: '/v1/chat/completions',
      },
      auth: {
        enabled: config.authEnabled,
        apiKey: config.authEnabled ? config.authToken : '(disabled)',
        hint: config.authEnabled
          ? `In your client app, set API Key to '${config.authToken}' (or set AUTH_TOKEN= in .env to disable)`
          : 'Authentication is disabled',
      },
    });
  });

  const tokens = new TokenStore(config.dbPath);
  const zaiSession = new ZaiSession();
  const conversations = new ConversationStore();
  const server = { config, tokens, zaiSession, conversations };

  // Dashboard & Public info
  app.get('/', (req, res) => {
    const host = req.headers.host || `localhost:${config.port}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboard(host, 'sk-zai-••••••••'));
  });

  app.get('/status', (req, res) => {
    const snap = zaiSession.snapshot();
    const accCount = tokens ? tokens.countAccountTokens() : 0;
    res.json({
      connected: snap.initialized || accCount > 0,
      userName: snap.userName,
      userId: snap.initialized ? snap.userId : '',
      feVersion: snap.feVersion,
      activeSessions: conversations.count(),
      features: snap.features,
      mode: 'direct',
      port: String(config.port),
      tokenCount: tokens.count(),
      accountTokenCount: accCount,
    });
  });

  app.get('/healthz', (req, res) => {
    const tokenCount = tokens.count();
    const accCount = tokens ? tokens.countAccountTokens() : 0;
    res.json({
      ok: true,
      healthy: zaiSession.initialized || accCount > 0,
      tokenCount: tokenCount,
      accountTokenCount: accCount,
      hasToken: tokenCount > 0,
      model: DEFAULT_MODEL,
      authEnabled: config.authEnabled,
    });
  });

  // Models
  app.get('/v1/models', withAuth, (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const data = KNOWN_MODELS.map((m) => ({
      id: m,
      object: 'model',
      created: now,
      owned_by: 'z-ai',
      display_name: m,
    }));
    res.json({ object: 'list', data });
  });

  app.get('/models', withAuth, (req, res) => {
    res.json({
      models: KNOWN_MODELS,
      currentModel: DEFAULT_MODEL,
    });
  });

  // Chat completions
  app.post('/v1/chat/completions', withAuth, async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res
        .status(400)
        .json(formatOpenAIError('messages is required and must be an array', 'invalid_request_error'));
    }

    const hasZaiToken = Boolean(config.zaiToken || (tokens && tokens.countAccountTokens() > 0));
    const model = normalizeModel(body.model, hasZaiToken);
    const sessionID = req.headers['x-session-id'] || 'default';
    const fresh = req.headers['x-fresh-session'] === 'true';
    const conv = conversations.getOrCreate(sessionID, fresh);
    const requestID = generateID();
    const prompt = messagesToPrompt(body.messages);
    const features = zaiSession.features;
    const stream = body.stream === true;

    // Tool calling path
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return handleChatWithTools(res, server, body, prompt, model, requestID, conv, features);
    }

    const opts = {
      model,
      webSearch: Boolean(body.webSearch ?? body.search ?? features.webSearch),
      thinking: Boolean(body.deepThink ?? features.thinking),
      imageGen: features.imageGen,
      previewMode: features.previewMode,
      chatID: conv.chatID,
      messages: conv.messages,
      clientMessages: body.messages,
    };
    if (body.deepThink) {
      opts.effort = 'max';
    }

    if (stream) {
      handleChatStream(res, server, prompt, model, requestID, opts, conv, features.persistHistory);
    } else {
      handleChatNonStream(res, server, prompt, model, requestID, opts, conv, features.persistHistory);
    }
  });

  async function handleChatWithTools(res, server, reqBody, prompt, model, requestID, conv, features) {
    const convertedMsgs = convertToolMessages(reqBody.messages, reqBody.tools);
    const convertedPrompt = messagesToPrompt(convertedMsgs);

    const hasZaiToken = Boolean(config.zaiToken || (tokens && tokens.countAccountTokens() > 0));
    const opts = {
      model: normalizeModel(reqBody.model, hasZaiToken),
      webSearch: Boolean(reqBody.webSearch ?? reqBody.search ?? features.webSearch),
      thinking: Boolean(reqBody.deepThink ?? features.thinking),
      imageGen: features.imageGen,
      previewMode: features.previewMode,
      chatID: conv.chatID,
      messages: conv.messages,
      clientMessages: convertedMsgs,
    };
    if (reqBody.deepThink) {
      opts.effort = 'max';
    }

    let fullContent = '';
    let zaiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      await sendToZAI(server, convertedPrompt, opts, {
        onChunk: (c) => (fullContent += c),
        onUsage: (u) => (zaiUsage = u),
        onReasoning: () => {},
      });
    } catch (err) {
      console.error('[Tools] Error:', err.message);
      const status = err.message.includes('401') ? 401 : 500;
      return res.status(status).json(formatOpenAIError(err.message));
    }

    const content = stripReasoning(fullContent);
    const toolCalls = parseToolCalls(content, reqBody.tools);

    if (toolCalls && toolCalls.length > 0) {
      const cleanContent = stripToolContent(content);
      const entries = toolCalls.map((c, i) => ({
        index: i,
        id: c.id,
        type: c.type,
        function: {
          name: c.function.name,
          arguments: c.function.arguments,
        },
      }));

      if (reqBody.stream === true) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Chunk 1
        const chunk1 = {
          id: 'chatcmpl-' + requestID,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: null, tool_calls: entries },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

        // Chunk 2
        const chunk2 = {
          id: 'chatcmpl-' + requestID,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      } else {
        return res.json({
          id: 'chatcmpl-' + requestID,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: cleanContent, tool_calls: entries },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: zaiUsage.promptTokens,
            completion_tokens: zaiUsage.completionTokens,
            total_tokens: zaiUsage.totalTokens,
          },
        });
      }
    }

    // No tool calls parsed — return clean text
    const cleanReply = stripFraming(content).trim();
    if (reqBody.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const chunkSize = 2000;
      for (let i = 0; i < cleanReply.length; i += chunkSize) {
        const slice = cleanReply.slice(i, i + chunkSize);
        res.write(`data: ${JSON.stringify(newChunk(slice, model, requestID, null))}\n\n`);
      }
      res.write(`data: ${JSON.stringify(newChunk('', model, requestID, 'stop'))}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      return res.json(newCompletion(cleanReply, prompt, model, requestID, zaiUsage));
    }
  }

  async function handleChatStream(res, server, prompt, model, requestID, opts, conv, persist) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify(newChunk('', model, requestID, null))}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(`data: ${JSON.stringify(newChunk('', model, requestID, null))}\n\n`);
    }, 5000);

    let fullContent = '';
    const pending = { text: '' };
    let zaiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      await sendToZAI(server, prompt, opts, {
        onChunk: (chunk) => {
          fullContent += chunk;
          pending.text += chunk;
          const { text: out, hold } = flushReasoningFree(pending);
          if (!hold && out) {
            res.write(`data: ${JSON.stringify(newChunk(out, model, requestID, null))}\n\n`);
          }
        },
        onUsage: (u) => (zaiUsage = u),
        onReasoning: (r) => {
          const clean = stripReasoningTags(r);
          if (clean) {
            res.write(`data: ${JSON.stringify(newChunkReasoning(clean, model, requestID))}\n\n`);
          }
        },
      });

      // Flush any leftover content held in pending
      if (pending.text) {
        const remaining = stripReasoning(pending.text).trim();
        if (remaining) {
          res.write(`data: ${JSON.stringify(newChunk(remaining, model, requestID, null))}\n\n`);
        }
      }
    } catch (err) {
      console.error('[Stream] Error:', err.message);
      res.write(
        `data: ${JSON.stringify(newChunk(`⚠️ Error: ${err.message}`, model, requestID, null))}\n\n`
      );
    } finally {
      clearInterval(keepAlive);
    }

    res.write(`data: ${JSON.stringify(newChunk('', model, requestID, 'stop'))}\n\n`);

    if (zaiUsage.totalTokens > 0) {
      const usageChunk = {
        id: 'chatcmpl-' + requestID,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [],
        usage: {
          prompt_tokens: zaiUsage.promptTokens,
          completion_tokens: zaiUsage.completionTokens,
          total_tokens: zaiUsage.totalTokens,
        },
      };
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();

    if (persist && fullContent) {
      conv.messages.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: fullContent }
      );
    }
  }

  async function handleChatNonStream(res, server, prompt, model, requestID, opts, conv, persist) {
    let fullContent = '';
    let zaiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      await sendToZAI(server, prompt, opts, {
        onChunk: (c) => (fullContent += c),
        onUsage: (u) => (zaiUsage = u),
        onReasoning: () => {},
      });
    } catch (err) {
      console.error('[API] Error:', err.message);
      const status = err.message.includes('401') ? 401 : 500;
      return res.status(status).json(formatOpenAIError(err.message));
    }

    const content = stripReasoning(fullContent);
    if (persist) {
      conv.messages.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content }
      );
    }

    res.json(newCompletion(content, prompt, model, requestID, zaiUsage));
  }

  // Legacy prompt & features
  app.post('/prompt', async (req, res) => {
    const { prompt, search, deepThink, webSearch } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const sessionID = req.headers['x-session-id'] || 'default';
    const fresh = req.headers['x-fresh-session'] === 'true';
    const conv = conversations.getOrCreate(sessionID, fresh);
    const features = zaiSession.features;

    const opts = {
      model: DEFAULT_MODEL,
      webSearch: Boolean(webSearch ?? search ?? features.webSearch),
      thinking: Boolean(deepThink ?? features.thinking),
      chatID: conv.chatID,
      messages: conv.messages,
    };
    if (deepThink) opts.effort = 'max';

    let fullContent = '';
    try {
      await sendToZAI(server, prompt, opts, {
        onChunk: (c) => (fullContent += c),
        onUsage: () => {},
        onReasoning: () => {},
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }

    if (features.persistHistory) {
      conv.messages.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: fullContent }
      );
    }

    res.json({ success: true, response: fullContent });
  });

  app.post('/features', (req, res) => {
    const f = zaiSession.features;
    const body = req.body || {};
    if (typeof body.webSearch === 'boolean') {
      f.webSearch = body.webSearch;
      f.autoWebSearch = body.webSearch;
    }
    if (typeof body.thinking === 'boolean') f.thinking = body.thinking;
    if (typeof body.imageGen === 'boolean') f.imageGen = body.imageGen;
    if (typeof body.previewMode === 'boolean') f.previewMode = body.previewMode;
    if (typeof body.persistHistory === 'boolean') f.persistHistory = body.persistHistory;

    res.json({ success: true, features: f });
  });

  // Admin routes
  app.get('/admin/stats', (req, res) => {
    res.json({
      mode: 'direct',
      totalClients: zaiSession.initialized ? 1 : 0,
      activeSessions: conversations.count(),
      stats: { totalRequests: Math.floor(conversations.totalMessages() / 2) },
    });
  });

  app.get('/admin/health', (req, res) => {
    if (!zaiSession.initialized) res.status(503);
    res.json({ healthy: zaiSession.initialized, mode: 'direct' });
  });

  app.get('/admin/clients', (req, res) => {
    const clients = zaiSession.initialized ? [{ id: 'session', status: 'idle' }] : [];
    res.json({ clients });
  });

  app.get('/admin/account-tokens', (req, res) => {
    const list = tokens ? tokens.getAccountTokens() : [];
    const masked = list.map((item) => ({
      id: item.id,
      email: item.email || 'unknown',
      maskedToken: item.token.length > 20 ? item.token.slice(0, 10) + '...' + item.token.slice(-10) : '***',
    }));
    res.json({ count: masked.length, tokens: masked });
  });

  app.post('/admin/account-tokens', (req, res) => {
    const body = req.body || {};
    const raw = body.tokens || body.token;
    if (!raw) return res.status(400).json({ error: 'No tokens provided' });
    const tokenList = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
        : [];
    const count = tokens ? tokens.insertAccountTokens(tokenList) : 0;
    res.json({ success: true, count, added: tokenList.length });
  });

  app.delete('/admin/account-tokens/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    if (tokens) tokens.removeAccountToken(id);
    res.json({ success: true, count: tokens ? tokens.countAccountTokens() : 0 });
  });

  app.post('/admin/session/clear', withAuth, (req, res) => {
    conversations.clear();
    console.log('[Session] All session histories cleared.');
    res.json({ success: true, message: 'All session histories cleared', activeSessions: 0 });
  });

  app.all('/admin/clients/*', withAuth, (req, res) => {
    conversations.clear();
    res.json({ success: true, message: 'History cleared' });
  });

  app.get('/inject.js', (req, res) => {
    res.json({ message: 'Direct mode' });
  });

  app.post('/stop', withAuth, (req, res) => {
    res.json({ success: true, message: 'Stop acknowledged' });
  });

  // Start background auto-replenishment worker
  const worker = new TokenWorker(tokens, config);
  worker.start();

  // Print startup banner
  printBanner();
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           GLM-ZAI-2API  (Node.js)                             ║
╠═══════════════════════════════════════════════════════════════╣
║  Mode:          DIRECT HTTP (no Docker required)              ║
║  Dashboard:     http://localhost:${config.port}                          ║
║  OpenAI API:    http://localhost:${config.port}/v1/chat/completions      ║
║  Token DB:      ${config.dbPath} (${tokens.count()} device, ${tokens.countAccountTokens()} account tokens)
║  Auth Token:    ${config.authToken}
╚═══════════════════════════════════════════════════════════════╝
`);

  // Start background session init
  zaiSession.initialize(config.zaiToken).catch((err) => {
    console.log(`[Startup] Session init deferred — will retry on request: ${err.message}`);
  });

  app.listen(config.port, config.host, () => {
    console.log(`[Server] Listening on http://${config.host}:${config.port}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
