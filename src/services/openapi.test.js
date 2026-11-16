import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { API_ROUTES } from '../index.js';
import { openapi } from './openapi.js';
it('keeps the published OpenAPI synchronized with every declared route', () => {
  const generated = openapi(API_ROUTES);
  expect(JSON.parse(readFileSync(new URL('../../frontend/openapi.json', import.meta.url), 'utf8'))).toEqual(generated);
  for (const route of API_ROUTES.filter(r => r.path !== '/mcp')) expect(generated.paths[route.path.replace(/:([a-z_]+)/g, '{$1}')][route.method.toLowerCase()]['x-access']).toBe(route.access);
});
