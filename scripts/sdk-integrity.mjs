import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const data = await readFile(new URL('../frontend/sdk/v1/cronly.js', import.meta.url));
const manifest = { version: '1.0.0', path: '/sdk/v1/cronly.js', integrity: `sha384-${createHash('sha384').update(data).digest('base64')}` };
await writeFile(new URL('../frontend/sdk/integrity.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
