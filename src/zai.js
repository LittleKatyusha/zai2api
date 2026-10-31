// src/zai.js — Z.AI session, HMAC-SHA256 signature, and SSE streaming
const crypto = require('crypto');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config');
const { computeCaptchaParam } = require('./captcha');
const { ReasoningSplitter, splitReasoningInline } = require('./tools');

const BASE_URL = 'https://chat.z.ai';
const SALT_KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const DEFAULT_FE_VERSION = 'prod-fe-1.0.185';

const KNOWN_MODELS = ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'];
const DEFAULT_MODEL = 'glm-5.3-flash';

const MODEL_ALIASES = {
  'glm-5.3': 'glm-5.3',
  'glm-5.3-flash': 'x-preview-l',
  'glm-5.3-flashx': 'x-preview-l',
  'glm-5.2': 'glm-5.2',
  'glm-4.7': 'x-preview-l',
  'glm-5.1': 'glm-5.3',
  'glm-5': 'glm-5.3',
  'glm-5-turbo': 'x-preview-l',
  'glm-5v-turbo': 'x-preview-l',
  'x-preview-l': 'x-preview-l',
};

const ALWAYS_THINK_MODELS = {
  'x-preview-l': true,
  'glm-5.3': true,
};

function normalizeModel(m, hasZaiToken = true) {
  const model = (m || '').toLowerCase().trim();
  if (!model) return DEFAULT_MODEL;
  let resolved = MODEL_ALIASES[model] || model;
  if (!hasZaiToken) {
    if (resolved === 'glm-5.3' || resolved === 'glm-5.2') {
      console.log(`[Model] Guest mode: remapping ${model} -> glm-5.3-flash (x-preview-l)`);
      return 'x-preview-l';
    }
  }
  return resolved;
}

function jwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

function getProxyAgent() {
  const proxy = config.httpsProxy || config.httpProxy;
  if (!proxy) return undefined;
  if (proxy.startsWith('socks')) {
    return new SocksProxyAgent(proxy);
  }
  return new HttpsProxyAgent(proxy);
}

class ZaiSession {
  constructor() {
    this.token = '';
    this.userID = '';
    this.userName = 'Guest';
    this.chatID = crypto.randomUUID();
    this.feVersion = DEFAULT_FE_VERSION;
    this.features = {
      webSearch: false,
      autoWebSearch: false,
      thinking: false,
      imageGen: false,
      previewMode: false,
      persistHistory: false,
    };
    this.initialized = false;
    this.initializing = false;
  }

  generateSignature(prompt, token, userID) {
    const timestamp = Date.now().toString();
    const requestID = crypto.randomUUID();
    const bucket = Math.floor(Date.now() / 300000).toString();

    const wKey = crypto.createHmac('sha256', SALT_KEY).update(bucket, 'utf8').digest('hex');

    const sorted = [
      ['requestId', requestID],
      ['timestamp', timestamp],
      ['user_id', userID],
    ];
    const sp = sorted.map(([k, v]) => `${k},${v}`).join(',');
    const promptB64 = Buffer.from((prompt || '').trim(), 'utf8').toString('base64');
    const dataToSign = `${sp}|${promptB64}|${timestamp}`;

    return crypto.createHmac('sha256', wKey).update(dataToSign, 'utf8').digest('hex');
  }

  async scrapeConfig() {
    try {
      const resp = await fetch(BASE_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const html = await resp.text();
      const match = html.match(/prod-fe-\d+\.\d+\.\d+/);
      if (match) {
        this.feVersion = match[0];
        console.log(`[Config] Scraped fe_version: ${this.feVersion}`);
      }
    } catch (err) {
      console.log(`[Config] Scrape error: ${err.message}, using default feVersion`);
    }
  }

  async initialize(zaiToken) {
    if (this.initializing) {
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!this.initializing) return;
      }
      throw new Error('Session initialization timeout');
    }

    this.initializing = true;
    try {
      if (zaiToken) {
        console.log('[Session] Using hardcoded ZAI_TOKEN, skipping guest init.');
        this.token = zaiToken;
        const payload = jwtPayload(zaiToken);
        if (payload) {
          if (payload.id) this.userID = payload.id;
          if (payload.email) this.userName = payload.email.split('@')[0];
          const uid = this.userID.length > 8 ? this.userID.slice(0, 8) : this.userID;
          console.log(`[Session] Token user: ${uid}... (${this.userName})`);
        }
        this.initialized = true;
        return;
      }

      console.log('[Session] Initializing Z.AI guest session...');
      await this.scrapeConfig();

      const headers = {
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        'Content-Type': 'application/json',
      };

      // Warm up guest endpoint
      try {
        await fetch(`${BASE_URL}/api/v1/auths/guest`, {
          method: 'POST',
          headers,
          body: '{}',
        });
      } catch (e) {}

      // Get session
      const authResp = await fetch(`${BASE_URL}/api/v1/auths/`, { headers });
      let token = '';
      if (authResp.ok) {
        const authData = await authResp.json();
        token = authData.token || '';
      }

      if (!token) {
        const retryResp = await fetch(`${BASE_URL}/api/v1/auths/guest`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        if (retryResp.ok) {
          const guestData = await retryResp.json();
          token = guestData.token || '';
        }
      }

      if (!token) {
        throw new Error('No guest token received from Z.AI');
      }

      this.token = token;
      const payload = jwtPayload(token);
      if (payload) {
        if (payload.id) this.userID = payload.id;
        if (payload.email) this.userName = payload.email.split('@')[0];
        const uid = this.userID.length > 8 ? this.userID.slice(0, 8) : this.userID;
        console.log(`[Session] Connected. UserID: ${uid}... (${this.userName})`);
      }
      this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  snapshot() {
    const uid = this.userID.length > 8 ? this.userID.slice(0, 8) + '...' : this.userID;
    return {
      token: this.token,
      userName: this.userName,
      userId: uid,
      feVersion: this.feVersion,
      features: this.features,
      initialized: this.initialized,
    };
  }
}

function newZAIRequestBody(opts, captchaParam, messages, prompt) {
  const features = {
    image_generation: opts.imageGen || false,
    web_search: opts.webSearch || false,
    auto_web_search: opts.webSearch || false,
    preview_mode: opts.previewMode || false,
    flags: [],
    enable_thinking: opts.thinking || false,
  };

  if (ALWAYS_THINK_MODELS[opts.model]) {
    features.enable_thinking = true;
    if (opts.effort) {
      features.reasoning_effort = opts.effort;
    } else if (opts.thinking) {
      features.reasoning_effort = 'high';
    } else {
      features.reasoning_effort = 'low';
    }
  }

  return {
    id: crypto.randomUUID(),
    model: opts.model,
    chat_id: opts.chatID,
    messages: messages,
    signature_prompt: prompt,
    stream: true,
    captcha_verify_param: captchaParam,
    features: features,
  };
}

class ConversationStore {
  constructor() {
    this.sessions = new Map();
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  getOrCreate(sessionID, fresh = false) {
    if (fresh || !this.sessions.has(sessionID)) {
      this.sessions.set(sessionID, {
        chatID: crypto.randomUUID(),
        messages: [],
        lastUsed: Date.now(),
      });
    }
    const s = this.sessions.get(sessionID);
    s.lastUsed = Date.now();
    return s;
  }

  count() {
    return this.sessions.size;
  }

  totalMessages() {
    let count = 0;
    for (const s of this.sessions.values()) {
      count += s.messages.length;
    }
    return count;
  }

  clear() {
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();
    const ttl = 30 * 60 * 1000;
    for (const [id, s] of this.sessions.entries()) {
      if (now - s.lastUsed > ttl) {
        this.sessions.delete(id);
      }
    }
  }
}

async function sendToZAI(server, prompt, opts, callbacks) {
  const { onChunk, onUsage, onReasoning } = callbacks;
  const { zaiSession, tokens, config: srvConfig } = server;

  if (!zaiSession.initialized) {
    await zaiSession.initialize(srvConfig.zaiToken);
  }

  for (let retry = 0; retry < 2; retry++) {
    try {
      return await doZAIRequest(server, prompt, opts, callbacks);
    } catch (err) {
      if (err.isUnauthorized && retry === 0) {
        console.log('[ZAI] 401 unauthorized, re-initializing session...');
        zaiSession.initialized = false;
        await zaiSession.initialize(srvConfig.zaiToken);
        continue;
      }
      throw err;
    }
  }
}

function doZAIRequest(server, prompt, opts, callbacks) {
  const { onChunk, onUsage, onReasoning } = callbacks;
  const { zaiSession, tokens, config: srvConfig } = server;

  return new Promise(async (resolve, reject) => {
    try {
      const captchaParam = await computeCaptchaParam(tokens);
      if (!captchaParam) {
        return reject(new Error('captcha verification failed — check tokens.sqlite'));
      }

      const signature = zaiSession.generateSignature(prompt, zaiSession.token, zaiSession.userID);

      const headers = {
        authorization: `Bearer ${zaiSession.token}`,
        'content-type': 'application/json',
        'x-fe-Version': zaiSession.feVersion,
        'x-region': 'overseas',
        'x-signature': signature,
      };

      let forwardedMessages = [];
      if (opts.clientMessages && opts.clientMessages.length > 0) {
        forwardedMessages = opts.clientMessages;
      } else {
        forwardedMessages = [...(opts.messages || [])];
        forwardedMessages.push({ role: 'user', content: prompt });
      }

      const reqBody = newZAIRequestBody(opts, captchaParam, forwardedMessages, prompt);
      const bodyStr = JSON.stringify(reqBody);

      if (srvConfig.logLevel === 'debug') {
        console.log('[DEBUG] Z.AI request body:', bodyStr);
      }

      const url = new URL(`${BASE_URL}/api/v2/chat/completions`);
      const options = {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        agent: getProxyAgent(),
        timeout: 90000,
      };

      const req = https.request(url, options, (res) => {
        if (srvConfig.logLevel === 'debug') {
          console.log(`[DEBUG] Z.AI response status: ${res.statusCode} ${res.statusMessage}`);
        }

        if (res.statusCode === 401) {
          const err = new Error('ZAI unauthorized');
          err.isUnauthorized = true;
          return reject(err);
        }

        if (res.statusCode !== 200) {
          let errData = '';
          res.on('data', (c) => (errData += c));
          res.on('end', () => {
            if (errData.includes('<html') || errData.includes('<!doctype')) {
              return reject(
                new Error(`Z.AI error ${res.statusCode}: blocked by Aliyun WAF (rate limit/security)`)
              );
            }
            const snippet = errData.length > 200 ? errData.slice(0, 200) + '...' : errData;
            return reject(new Error(`Z.AI error ${res.statusCode}: ${snippet}`));
          });
          return;
        }

        let buffer = '';
        const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let hasContent = false;
        const reasoningSplitter = new ReasoningSplitter();

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (srvConfig.logLevel === 'debug' && trimmed) {
              console.log('[DEBUG] Z.AI SSE line:', trimmed);
            }
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') {
              if (onUsage) onUsage(usage);
              return resolve();
            }

            try {
              const json = JSON.parse(dataStr);

              if (json.data && json.data.usage) {
                const u = json.data.usage;
                if (typeof u.prompt_tokens === 'number') usage.promptTokens = u.prompt_tokens;
                if (typeof u.completion_tokens === 'number') usage.completionTokens = u.completion_tokens;
                if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens;
              }

              // Check if Z.AI signals done
              if (json.data && json.data.phase === 'done') {
                if (onUsage) onUsage(usage);
                return resolve();
              }

              if (json.data && json.data.error && json.data.error.detail) {
                if (!hasContent) {
                  return reject(new Error(`Z.AI: ${json.data.error.detail}`));
                }
                // Post-generation persistence error on guest account — ignore since content is received
                continue;
              }
              if (json.error && json.error.detail) {
                if (!hasContent) {
                  return reject(new Error(`Z.AI: ${json.error.detail}`));
                }
                continue;
              }

              let delta = '';
              if (json.data) {
                if (json.data.delta_content) delta = json.data.delta_content;
                else if (json.data.edit_content) delta = json.data.edit_content;
              }
              if (!delta && json.choices && json.choices.length > 0 && json.choices[0].delta) {
                delta = json.choices[0].delta.content || '';
              }

              if (delta) {
                hasContent = true;
                const { content: sepContent, reasoning } = reasoningSplitter.process(delta);
                if (reasoning && onReasoning) {
                  onReasoning(reasoning);
                }
                if (sepContent && onChunk) {
                  onChunk(sepContent);
                }
              }
            } catch (e) {
              if (srvConfig.logLevel === 'debug') {
                console.log('[DEBUG] Failed to parse SSE line:', dataStr);
              }
            }
          }
        });

        res.on('end', () => {
          if (onUsage) onUsage(usage);
          resolve();
        });

        res.on('error', (err) => reject(err));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Z.AI request timed out'));
      });

      req.on('error', (err) => reject(new Error(`Z.AI connection error: ${err.message}`)));

      req.write(bodyStr);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  ZaiSession,
  ConversationStore,
  normalizeModel,
  newZAIRequestBody,
  sendToZAI,
  KNOWN_MODELS,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  ALWAYS_THINK_MODELS,
};
