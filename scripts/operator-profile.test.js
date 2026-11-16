import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { missingProfileFields, renderProfile, validateProfile } from './operator-profile.mjs';

const snapshot = JSON.parse(await readFile(new URL('../docs/operator/profile.json', import.meta.url), 'utf8'));
const terms = await readFile(new URL('../frontend/terms.html', import.meta.url), 'utf8');
const privacy = await readFile(new URL('../frontend/privacy.html', import.meta.url), 'utf8');

function completed() {
  const value = structuredClone(snapshot);
  value.source = { repository: 'https://example.com/operator-profile', revision: 'a'.repeat(40) };
  value.profile.operator = { legal_name: 'Example & Partners <LLC>', postal_address: '123 Example St', governing_jurisdiction: 'Example State', dispute_venue: 'Example County' };
  value.profile.apps['cronly.org'] = { support_email: 'support@example.com', privacy_email: 'privacy@example.com' };
  value.profile.apps['hashbin.org'] = { support_email: 'other-support@example.com', privacy_email: 'other-privacy@example.com' };
  return value;
}

it('keeps checked-in legal sections in sync with the offline placeholder snapshot', () => {
  expect(renderProfile(terms, snapshot, 'terms.html')).toBe(terms);
  expect(renderProfile(privacy, snapshot, 'privacy.html')).toBe(privacy);
  const check = () => execFileSync(process.execPath, [new URL('./operator-profile.mjs', import.meta.url).pathname, '--require-complete'], { stdio: 'pipe' });
  if (missingProfileFields(snapshot).length) expect(check).toThrow(/Operator profile is incomplete/);
  else expect(check).not.toThrow();
});

it('renders escaped common facts with cronly contacts and keeps policy approval separate', () => {
  const value = completed();
  const renderedTerms = renderProfile(terms, value, 'terms.html');
  const renderedPrivacy = renderProfile(privacy, value, 'privacy.html');
  expect(renderedTerms).toContain('Example &amp; Partners &lt;LLC&gt;');
  expect(renderedTerms).toContain('support@example.com');
  expect(renderedPrivacy).toContain('privacy@example.com');
  expect(renderedPrivacy).not.toContain('other-privacy@example.com');
  for (const page of [renderedTerms, renderedPrivacy]) {
    expect(page).toContain('DRAFT — not in effect.');
    expect(page).toContain('[OWNER APPROVAL DATE]');
    expect(page).toContain('[LEGAL REVIEW');
  }
  expect(missingProfileFields(value)).toEqual([]);
  expect(renderProfile(renderedTerms, value, 'terms.html')).toBe(renderedTerms);
  expect(renderProfile(renderedPrivacy, value, 'privacy.html')).toBe(renderedPrivacy);
  // Removing a previously known fact restores the visible draft placeholder.
  expect(renderProfile(renderedTerms, snapshot, 'terms.html')).toBe(terms);
});

it('fails closed on unknown schemas, unpinned sources, private fields and lost markers', () => {
  for (const mutate of [
    value => { value.profile.schema_version = 2; },
    value => { value.source.revision = 'main'; },
    value => { value.source.repository = null; },
    value => { value.profile.operator.ein = 'not-a-public-profile-field'; },
    value => { value.profile.apps['cronly.org'].legal_name = 'App override'; },
    value => { delete value.profile.apps['cronly.org']; },
    value => { value.profile.apps['cronly.org'].privacy_email = 'not an email'; },
    value => { value.profile.operator.legal_name = ' '; },
    value => { value.profile.operator.postal_address = 'address\u0000'; }
  ]) {
    const value = completed(); mutate(value);
    expect(() => validateProfile(value)).toThrow();
  }
  expect(() => renderProfile(terms.replace('data-operator-field="operator.legal_name"', 'data-operator-field="wrong"'), snapshot, 'terms.html')).toThrow(/Unexpected/);
  expect(() => renderProfile(terms.replace(/<span data-operator-field="operator.legal_name">.*?<\/span>/, ''), snapshot, 'terms.html')).toThrow(/Missing/);
});
