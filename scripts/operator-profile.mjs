import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const fields = {
  'operator.legal_name': '[LEGAL ENTITY NAME]',
  'operator.postal_address': '[POSTAL ADDRESS]',
  'operator.governing_jurisdiction': '[JURISDICTION]',
  'operator.dispute_venue': '[VENUE]',
  'app.support_email': '[SUPPORT EMAIL]',
  'app.privacy_email': '[PRIVACY EMAIL]'
};
const pages = {
  'terms.html': Object.keys(fields).filter(field => field !== 'app.privacy_email'),
  'privacy.html': ['operator.legal_name', 'operator.postal_address', 'app.privacy_email']
};
const root = new URL('../', import.meta.url);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys, label) {
  assert(plainObject(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), `Invalid ${label} fields`);
}
function publicValue(value, label, email = false) {
  assert(value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(value)), `Invalid ${label}`);
  if (email && value !== null) assert(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value), `Invalid ${label}`);
}
/** Validate an offline snapshot; unknown public facts and provenance stay explicit. */
export function validateProfile(snapshot) {
  exactKeys(snapshot, ['source', 'profile'], 'snapshot');
  exactKeys(snapshot.source, ['repository', 'revision'], 'source');
  const { repository, revision } = snapshot.source;
  assert((repository === null && revision === null) || (typeof repository === 'string' && /^https:\/\/[^\s?#]+$/.test(repository) && /^[a-f0-9]{40}$/.test(revision)), 'Source must be unknown or an HTTPS repository pinned to a full commit');
  exactKeys(snapshot.profile, ['schema_version', 'operator', 'apps'], 'profile');
  const { schema_version, operator, apps } = snapshot.profile;
  assert(schema_version === 1, 'Unsupported operator profile version');
  exactKeys(operator, ['legal_name', 'postal_address', 'governing_jurisdiction', 'dispute_venue'], 'operator');
  for (const [key, value] of Object.entries(operator)) publicValue(value, key);
  assert(plainObject(apps) && Object.hasOwn(apps, 'cronly.org'), 'Missing cronly.org contacts');
  for (const [domain, contacts] of Object.entries(apps)) {
    assert(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain), 'Invalid app domain');
    exactKeys(contacts, ['support_email', 'privacy_email'], `${domain} contacts`);
    for (const [key, value] of Object.entries(contacts)) publicValue(value, `${domain} ${key}`, true);
  }
  return Object.fromEntries(Object.keys(fields).map(field => {
    const [kind, key] = field.split('.');
    return [field, kind === 'operator' ? operator[key] : apps['cronly.org'][key]];
  }));
}
/** Escape all public facts before inserting them into static legal HTML. */
export function renderProfile(html, snapshot, page) {
  const values = validateProfile(snapshot);
  assert(Object.hasOwn(pages, page), 'Unknown legal page');
  const seen = new Set();
  const rendered = html.replace(/<span data-operator-field="([^"]+)">[\s\S]*?<\/span>/g, (_match, field) => {
    assert(pages[page].includes(field), `Unexpected ${field} on ${page}`);
    seen.add(field);
    const value = values[field] ?? fields[field];
    const escaped = value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    return `<span data-operator-field="${field}">${escaped}</span>`;
  });
  for (const field of pages[page]) assert(seen.has(field), `Missing ${field} marker on ${page}`);
  return rendered;
}
/** List missing cronly facts without treating another app's contacts as required. */
export function missingProfileFields(snapshot) {
  const values = validateProfile(snapshot);
  return [...(!snapshot.source.repository ? ['source.repository', 'source.revision'] : []), ...Object.keys(values).filter(field => values[field] === null)];
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length <= 1 && args.every(arg => ['--check', '--require-complete'].includes(arg)), 'Usage: node scripts/operator-profile.mjs [--check|--require-complete]');
  const snapshot = JSON.parse(await readFile(new URL('docs/operator/profile.json', root), 'utf8'));
  const updates = [];
  for (const page of Object.keys(pages)) {
    const path = new URL(`frontend/${page}`, root); const html = await readFile(path, 'utf8');
    const rendered = renderProfile(html, snapshot, page);
    if (args.length) assert(rendered === html, `${page} operator fields drifted; run npm run legal:generate`);
    else updates.push([path, rendered]);
  }
  const missing = missingProfileFields(snapshot);
  if (args[0] === '--require-complete') assert(!missing.length, `Operator profile is incomplete: ${missing.join(', ')}`);
  for (const [path, rendered] of updates) await writeFile(path, rendered);
  console.log(`Operator profile ${args.length ? 'checked' : 'rendered'}; ${missing.length} unresolved fields. Legal approval and effective dates remain separate.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
