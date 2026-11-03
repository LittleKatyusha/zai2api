// src/config.js — Environment variable loader and configuration
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const rawAuthToken = process.env.AUTH_TOKEN !== undefined ? process.env.AUTH_TOKEN.trim() : 'd3vin';
const authDisabled =
  process.env.AUTH_ENABLED === 'false' ||
  rawAuthToken === '' ||
  rawAuthToken.toLowerCase() === 'none' ||
  rawAuthToken.toLowerCase() === 'false';

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8088', 10),
  authEnabled: !authDisabled,
  authToken: rawAuthToken || 'd3vin',
  zaiToken: (process.env.ZAI_TOKEN || '').trim(),
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || 'tokens.sqlite'),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  timeout: parseInt(process.env.TIMEOUT || '300000', 10),
  tokenBatch: parseInt(process.env.TOKEN_BATCH || '150', 10),
  tokenTarget: parseInt(process.env.TOKEN_TARGET || '750', 10),
  tokenLowWater: parseInt(process.env.TOKEN_LOWWATER || '50', 10),
  httpProxy: process.env.http_proxy || process.env.HTTP_PROXY || '',
  httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY || '',
};

module.exports = config;
