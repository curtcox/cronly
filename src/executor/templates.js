import { assert } from '../utils/errors.js';
const TOKEN = /\{\{\s*([a-z]+)\.([a-zA-Z0-9_-]+)\s*\}\}/g;
const BUILTINS = { run: ['id', 'scheduled_at', 'trigger'], job: ['name'], account: ['id'] };
/** Extract substitutions and reject malformed template syntax. */
export function references(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const refs = [...text.matchAll(TOKEN)].map(([, type, name]) => ({ type, name }));
  assert(!text.replace(TOKEN, '').includes('{{'), 'invalid_template', 'Invalid template syntax');
  return refs;
}
/** Fail at save time for unknown variables, secrets or built-ins. */
export function validateTemplates(action, config) {
  for (const { type, name } of references([action.url, action.headers, action.body])) {
    assert(type === 'input' || (type === 'var' && Object.hasOwn(config.variables, name)) || (type === 'secret' && Object.hasOwn(config.secrets, name)) || BUILTINS[type]?.includes(name), 'unknown_template', `Unknown template: ${type}.${name}`);
  }
}
/** Render values as text only; templates never evaluate code. */
export function render(value, context) {
  return String(value || '').replace(TOKEN, (_, type, name) => {
    assert(Object.hasOwn(context[type] || {}, name), 'missing_input', `Missing template value: ${type}.${name}`);
    return String(context[type][name]);
  });
}
