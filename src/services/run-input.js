import { assert } from '../utils/errors.js';

/** Validate trigger input before dispatch, and again at the reservation boundary. */
export function validateRunInput(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length <= 32 && Object.entries(input).every(([key, value]) => /^[a-zA-Z0-9_-]{1,64}$/.test(key) && typeof value === 'string' && value.length <= 2048), 'invalid_input', 'Webhook input must be a small object of strings');
  return input;
}
