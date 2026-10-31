// src/worker.js — Native background supervisor for automatic token replenishment
const { collectTokens } = require('./collector');

class TokenWorker {
  constructor(tokenStore, config) {
    this.tokenStore = tokenStore;
    this.config = config;
    this.isCollecting = false;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    const count = this.tokenStore ? this.tokenStore.count() : 0;
    console.log(`[Worker] Initial token count: ${count} (target: ${this.config.tokenTarget})`);

    // If below low water, trigger collection in background immediately
    if (count < this.config.tokenLowWater) {
      console.log('[Worker] Tokens below low water mark, initiating initial background collection...');
      this.triggerBatch('Initial');
    }

    // Start background replenishment loop
    this.scheduleNextCheck(60000);
  }

  scheduleNextCheck(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.checkAndReplenish(), delayMs);
    this.timer.unref();
  }

  async checkAndReplenish() {
    if (!this.running) return;
    const count = this.tokenStore ? this.tokenStore.count() : 0;

    let nextIntervalMs = 600000; // 10 minutes when full

    if (count < this.config.tokenTarget || count < this.config.tokenLowWater) {
      console.log(`[Worker] Token pool (${count}) < target (${this.config.tokenTarget}), triggering batch...`);
      await this.triggerBatch('Auto-Replenish');
      nextIntervalMs = 60000; // 1 minute when still under target
    }

    this.scheduleNextCheck(nextIntervalMs);
  }

  async triggerBatch(label = 'Manual') {
    if (this.isCollecting) {
      console.log(`[Worker] ⚠️ ${label}: Collection already in progress, skipping.`);
      return;
    }

    this.isCollecting = true;
    try {
      console.log(`[Worker] 🚀 ${label}: Collecting batch of ${this.config.tokenBatch} tokens...`);
      await collectTokens({
        count: this.config.tokenBatch,
        dbPath: this.config.dbPath,
        proxy: this.config.httpsProxy || this.config.httpProxy,
      });
      const newCount = this.tokenStore ? this.tokenStore.count() : 0;
      console.log(`[Worker] ✅ ${label}: Token replenishment finished. Total tokens: ${newCount}`);
    } catch (err) {
      console.warn(`[Worker] ⚠️ ${label}: Collection failed: ${err.message}. Will retry on next cycle.`);
    } finally {
      this.isCollecting = false;
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = TokenWorker;
