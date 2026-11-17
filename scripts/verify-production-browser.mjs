import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.CRONLY_ORIGIN || 'https://cronly.org');
assert(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'CRONLY_ORIGIN must be an HTTPS origin.');
const output = process.env.CRONLY_BROWSER_OUTPUT_DIR || '/tmp/cronly-production-browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(30000);
let stage = 'home page';
try {
  const home = await page.goto(origin.href, { waitUntil: 'domcontentloaded' });
  assert(home?.status() === 200, 'Home page did not return HTTP 200.');
  await page.getByRole('heading', { name: 'Small actions. Right on time.', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'home.png'), fullPage: true });

  stage = 'workspace sign-in';
  const workspace = await page.goto(new URL('/app.html', origin).href, { waitUntil: 'domcontentloaded' });
  assert(workspace?.status() === 200, 'Workspace did not return HTTP 200.');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // A fresh browser has no account/session. Opening this form neither sends an
  // email nor submits credentials, creates an account or performs billed work.
  await page.locator('input[name="identifier"], input[autocomplete="email"]').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /google/i }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(output, 'sign-in.png'), fullPage: true });
  console.log('Production browser verification passed: home, workspace and Clerk email/Google sign-in form. No sign-in or paid operation was performed.');
} catch {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`Production browser verification failed at ${stage}. Inspect the signed-out screenshots.`);
  process.exitCode = 1;
} finally { await browser.close(); }
