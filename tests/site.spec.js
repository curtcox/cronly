import { test, expect, login } from './helpers.js';

test('serves every public page at its linked URL without redirects', async ({ request }) => {
  for (const path of ['/', '/index.html', '/app.html', '/pricing.html', '/docs/', '/docs/index.html', '/docs/agents.html', '/terms.html', '/privacy.html']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain('text/html');
  }
});
test('allows the blob workers required by Clerk without relaxing script policy', async ({ page }) => {
  await page.goto('/app.html');
  expect(await page.evaluate(() => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob(['postMessage("ready")'], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Worker did not start')); }, 2000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
  }))).toBe('ready');
});
test('public site uses the logo and the workspace stays usable on mobile', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Small actions. Right on time.' })).toBeVisible();
  await expect(page.locator('header img')).toHaveAttribute('src', '/logo.jpeg');
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await expect(page.locator('#account-strip')).toContainText('Balance $0.00');
  await expect(page.locator('#workspace-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
