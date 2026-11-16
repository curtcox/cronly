import { writeFile } from 'node:fs/promises';
import { API_ROUTES } from '../src/index.js';
import { openapi } from '../src/services/openapi.js';
await writeFile(new URL('../frontend/openapi.json', import.meta.url), JSON.stringify(openapi(API_ROUTES), null, 2) + '\n');
