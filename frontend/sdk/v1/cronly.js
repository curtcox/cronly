/* cronly browser trigger SDK v1.0.0. Immutable: release changes under a new version. */
(() => {
  'use strict';
  const script = document.currentScript;
  const origin = new URL(script.src).origin;
  /** Run a single job through its revocable trigger token; never accepts API keys. */
  async function trigger(token, input = {}, options = {}) {
    if (typeof token !== 'string' || !/^tk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Expected a trigger token');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.values(input).some(value => typeof value !== 'string')) throw new Error('Input fields must be strings');
    const response = await fetch(`${origin}/hook/${encodeURIComponent(token)}`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) }, body: JSON.stringify(input), signal: options.signal });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { code: result.code, status: response.status });
    return result;
  }
  globalThis.cronly = Object.freeze({ trigger });
})();
