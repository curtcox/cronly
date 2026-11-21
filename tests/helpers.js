import { test as base, expect } from '@playwright/test';

export { expect };

// Keep each test's local ingress bucket independent, as separate visitors are in production.
// Running the whole suite through one localhost IP exhausts it. A per-worker counter (rather
// than the test's line number) keeps addresses unique across spec files.
let visitor = 0;
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    visitor += 1;
    await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `2001:db8::${(testInfo.workerIndex + 1).toString(16)}:${visitor.toString(16)}` });
    await use(context);
  }
});

/** Signs in to the local-mode workspace as a fresh account. */
export async function login(page) {
  await page.goto('/app.html'); await page.getByLabel('Local account name').fill(`browser-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Use local account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}

/** Applies the open review dialog and waits for the application to finish. */
export async function apply(page) { await expect(page.getByRole('dialog')).toBeVisible(); await page.locator('#review-apply').click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('body')).not.toHaveAttribute('data-applying', 'true'); }
