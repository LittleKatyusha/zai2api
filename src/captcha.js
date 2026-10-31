// src/captcha.js — Aliyun Captcha V3 verification logic
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config');

const CAPTCHA_ACCESS_KEY = 'LTAI5tSEBwYMwVKAQGpxmvTd';
const CAPTCHA_SECRET_KEY = 'YSKfst7GaVkXwZYvVihJsKF9r89koz';
const CAPTCHA_SCENE_ID = 'didk33e0';
const CAPTCHA_MAX_RETRIES = 2;

const ARG_PERM_TABLE = [
  32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
  60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
  18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
  8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
];

const ARG_CONSTANT = '4xrihv8zb8tf1mfj';
const ENCRYPT_KEY = '3e627e1b4c63f913';

// URL encoding with safe table (matching Go's urlEncode)
function urlEncode(str, safe = '') {
  const safeChars = new Set(
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_.~' + safe
  );
  let out = '';
  const buf = Buffer.from(String(str), 'utf8');
  for (const b of buf) {
    const ch = String.fromCharCode(b);
    if (safeChars.has(ch)) {
      out += ch;
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function getTimestampUTC() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function generateAliyunSignature(params, secKey) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalParts = [];
  for (const k of sortedKeys) {
    canonicalParts.push(`${urlEncode(k, '')}=${urlEncode(params[k], '')}`);
  }
  const canonical = canonicalParts.join('&');
  const stringToSign = `POST&${urlEncode('/', '')}&${urlEncode(canonical, '')}`;
  const signingKey = secKey + '&';
  return crypto.createHmac('sha1', signingKey).update(stringToSign, 'utf8').digest('base64');
}

function buildQueryString(params) {
  const sortedKeys = Object.keys(params).sort();
  return sortedKeys
    .map((k) => `${urlEncode(k, '')}=${urlEncode(params[k], '')}`)
    .join('&');
}

function getProxyAgent() {
  const proxy = config.httpsProxy || config.httpProxy;
  if (!proxy) return undefined;
  if (proxy.startsWith('socks')) {
    return new SocksProxyAgent(proxy);
  }
  return new HttpsProxyAgent(proxy);
}

function captchaHttpPost(urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
      agent: getProxyAgent(),
      timeout: 30000,
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Captcha HTTP POST timed out'));
    });

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

async function initCaptcha() {
  const params = {
    AccessKeyId: CAPTCHA_ACCESS_KEY,
    Action: 'InitCaptchaV3',
    Format: 'JSON',
    Language: 'en',
    Mode: 'popup',
    SceneId: CAPTCHA_SCENE_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: getTimestampUTC(),
    UpLang: 'true',
    Version: '2023-03-05',
  };
  params.Signature = generateAliyunSignature(params, CAPTCHA_SECRET_KEY);
  const body = buildQueryString(params);
  const resp = await captchaHttpPost('https://no8xfe.captcha-open-southeast.aliyuncs.com/', body);
  const result = JSON.parse(resp);
  if (!result.CertifyId) {
    throw new Error('InitCaptchaV3 returned no CertifyId: ' + resp);
  }
  return result.CertifyId;
}

function generateArg(certifyID) {
  // Decode URL-encoded string to raw bytes
  const o = Buffer.from(decodeURIComponent(certifyID), 'utf8');
  const r = [...ARG_PERM_TABLE];
  const n = ARG_CONSTANT;
  const rlen = 64;

  let i = 0;
  let j = 0;
  while (i < rlen) {
    j = (((i + j + r[i] + r[j]) >> 1) + n.charCodeAt(i % n.length)) & (rlen - 1);
    if (i !== j) {
      const tmp = r[i];
      r[i] = r[j];
      r[j] = tmp;
    }
    i++;
  }

  const t = Buffer.alloc(o.length);
  let e = 0;
  let a = 0;
  for (let idx = 0; idx < o.length; idx++) {
    a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1);
    if (e !== a) {
      const tmp = r[e];
      r[e] = r[a];
      r[a] = tmp;
    }
    let m = o[idx];
    m = m + e + r[e] - a - r[a];
    m = m ^ (r[e] + r[a]);
    m = m ^ r[(r[e] + r[a]) & (rlen - 1)];
    m = m & 255;
    t[idx] = m;
    e = (e + 1) & (rlen - 1);
  }

  return t.toString('base64');
}

function aliHash(inputStr, saltStr) {
  const o = Buffer.from(inputStr, 'utf8');
  const r = Buffer.from(saltStr, 'utf8');
  const aLen = o.length;
  const m = r.length;
  const e = new Array(16);
  for (let idx = 0; idx < 16; idx++) {
    e[idx] = (idx << 4) + (idx % 16);
  }
  const f = 16;

  let i = 0;
  let j = 0;
  while (i < f) {
    j = (((i + j + e[i] + e[j]) >> 1) + r[i % m]) & (f - 1);
    const tmp = e[i];
    e[i] = e[j];
    e[j] = tmp;
    i++;
  }

  let idx = 0;
  let p = 0;
  let q = 0;
  while (idx < aLen) {
    q = ((p ^ q) + (e[p] ^ e[q])) & (f - 1);
    const tmp = e[p];
    e[p] = e[q];
    e[q] = tmp;
    let c = o[idx];
    c = (c + p + q) ^ e[p] ^ e[q];
    c = c & 255;
    e[p] = c;
    p = (p + 1) & (f - 1);
    idx++;
  }

  for (let step = 0; step < 2 * f; step++) {
    const pos = step % f;
    if (pos !== 0) {
      e[pos] ^= e[pos - 1];
    } else {
      e[0] ^= e[f - 1];
    }
  }

  const hexLower = '0123456789abcdef';
  let result = '';
  for (let bIdx = 0; bIdx < 16; bIdx++) {
    const b = e[bIdx];
    result += hexLower[(b >> 4) & 0x0f] + hexLower[b & 0x0f];
  }
  return result;
}

function encrypt(plaintextBuf) {
  const o = Buffer.isBuffer(plaintextBuf) ? plaintextBuf : Buffer.from(plaintextBuf);
  const n = ENCRYPT_KEY;
  const r = [...ARG_PERM_TABLE];
  const rlen = 64;

  let oKsa = 0;
  let tKsa = 0;
  while (oKsa < rlen) {
    tKsa = (((oKsa + tKsa + r[oKsa] + r[tKsa]) >> 1) + n.charCodeAt(oKsa % n.length)) & (rlen - 1);
    if (oKsa !== tKsa) {
      const tmp = r[oKsa];
      r[oKsa] = r[tKsa];
      r[tKsa] = tmp;
    }
    oKsa++;
  }

  const t = Buffer.alloc(o.length);
  let e = 0;
  let a = 0;
  for (let nPrga = 0; nPrga < o.length; nPrga++) {
    a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1);
    if (e !== a) {
      const tmp = r[e];
      r[e] = r[a];
      r[a] = tmp;
    }
    let m = o[nPrga];
    m = m + e + r[e] - a - r[a];
    m = m ^ (r[e] + r[a]);
    m = m ^ r[(r[e] + r[a]) & (rlen - 1)];
    m = m & 255;
    t[nPrga] = m;
    e = (e + 1) & (rlen - 1);
  }

  return t.toString('base64');
}

async function verifyCaptcha(certifyId, dataValue, deviceToken) {
  const cvpJSON = JSON.stringify({
    certifyId: certifyId,
    data: dataValue,
    deviceToken: deviceToken,
    sceneId: CAPTCHA_SCENE_ID,
  });

  const params = {
    AccessKeyId: CAPTCHA_ACCESS_KEY,
    Action: 'VerifyCaptchaV3',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    Timestamp: getTimestampUTC(),
    Version: '2023-03-05',
    SceneId: CAPTCHA_SCENE_ID,
    CertifyId: certifyId,
    CaptchaVerifyParam: cvpJSON,
    SignatureNonce: crypto.randomUUID(),
  };
  params.Signature = generateAliyunSignature(params, CAPTCHA_SECRET_KEY);
  const body = buildQueryString(params);
  const resp = await captchaHttpPost(
    'https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/',
    body,
    { Referer: '' }
  );

  let respJSON;
  try {
    respJSON = JSON.parse(resp);
  } catch (e) {
    throw new Error('parse VerifyCaptchaV3 response: ' + resp);
  }

  if (respJSON.Success && respJSON.Result && respJSON.Result.VerifyResult) {
    const st = respJSON.Result.securityToken;
    const ci = respJSON.Result.certifyId;
    if (st && ci) {
      const finalPayload = JSON.stringify({
        certifyId: ci,
        isSign: true,
        sceneId: CAPTCHA_SCENE_ID,
        securityToken: st,
      });
      return Buffer.from(finalPayload, 'utf8').toString('base64');
    }
    captchaLog(`VerifyCaptchaV3 succeeded but token empty for deviceToken=${truncateToken(deviceToken)}`);
  } else if (respJSON.Success) {
    captchaLog(`deviceToken failed verification (VerifyResult=false): ${truncateToken(deviceToken)}`);
  } else {
    captchaLog(`VerifyCaptchaV3 unsuccessful for deviceToken=${truncateToken(deviceToken)}: ${resp}`);
  }
  return null;
}

async function tryComputeCaptcha(tokenStore, deviceToken) {
  const certifyId = await initCaptcha();
  const argValue = generateArg(certifyId);
  const ct = Date.now();

  const tr = {
    TrackList: {
      fi: '',
      ks: '',
      mc: '',
      mp: '',
      mu: '',
      startTime: ct,
      tc: '',
      te: '',
      tmv: '',
    },
    TrackStartTime: ct,
    VerifyTime: ct + 300,
    arg: argValue,
  };
  const jsonStr = JSON.stringify(tr);
  const h = aliHash(jsonStr, '0000');
  const combined = Buffer.from(h + jsonStr, 'utf8');
  const compressed = zlib.deflateSync(combined);
  const fb64 = compressed.toString('base64');
  const finalVal = encrypt(Buffer.from(fb64, 'utf8'));

  // Always remove consumed token immediately
  tokenStore.remove(deviceToken);

  return verifyCaptcha(certifyId, finalVal, deviceToken);
}

async function computeCaptchaParam(tokenStore) {
  if (!tokenStore) {
    captchaLog('No token store available — tokens.sqlite missing');
    return null;
  }

  for (let attempt = 0; attempt < CAPTCHA_MAX_RETRIES; attempt++) {
    const deviceToken = tokenStore.getNext();
    if (!deviceToken) {
      captchaLog(`No device tokens remaining (attempt ${attempt + 1}/${CAPTCHA_MAX_RETRIES})`);
      return null;
    }
    captchaLog(
      `Attempt ${attempt + 1}/${CAPTCHA_MAX_RETRIES} using deviceToken=${truncateToken(deviceToken)}`
    );

    try {
      const payload = await tryComputeCaptcha(tokenStore, deviceToken);
      if (payload) {
        return payload;
      }
      captchaLog(`deviceToken=${truncateToken(deviceToken)} produced empty payload, retrying`);
    } catch (err) {
      captchaLog(
        `Attempt ${attempt + 1} failed for deviceToken=${truncateToken(deviceToken)}: ${err.message}`
      );
    }
  }

  captchaLog(`All ${CAPTCHA_MAX_RETRIES} token retries exhausted`);
  return null;
}

function truncateToken(s) {
  if (!s || s.length <= 23) return s || '';
  return s.slice(0, 10) + '...' + s.slice(-10);
}

function captchaLog(msg) {
  if (config.logLevel === 'debug') {
    console.log(`[Captcha] ${msg}`);
  }
}

module.exports = {
  urlEncode,
  generateAliyunSignature,
  initCaptcha,
  generateArg,
  aliHash,
  encrypt,
  verifyCaptcha,
  computeCaptchaParam,
  truncateToken,
};