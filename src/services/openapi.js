import { PUBLIC, SESSION, ACCOUNT_SESSION } from '../auth/scopes.js';
const integerMoney = { type: 'integer', minimum: 0, description: 'Integer micro-dollars (1 USD = 1,000,000).' };
const schemas = {
  Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' } } },
  Value: { type: 'object', required: ['value'], properties: { value: { type: 'string', maxLength: 8192 } } },
  Job: { type: 'object', required: ['action', 'cron'], properties: { action: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' }, cron: { type: ['string', 'null'] }, timezone: { type: 'string', default: 'UTC' }, overlap: { enum: ['skip', 'allow'] }, missed: { enum: ['skip', 'run_once'] }, enabled: { type: 'boolean' }, retries: { type: 'integer', minimum: 0, maximum: 3 }, budget: { type: 'object', properties: { day: integerMoney, month: integerMoney } } } },
  Action: { type: 'object', properties: { type: { enum: ['http', 'javascript'] }, url: { type: 'string' }, method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 }, follow_redirects: { type: 'boolean' }, source: { type: 'string', maxLength: 262144 }, cpu_ms: { type: 'integer', minimum: 10, maximum: 30000 }, subrequests: { type: 'integer', minimum: 0, maximum: 50 } } },
  Config: { type: 'object', properties: { variables: { type: 'object', additionalProperties: { type: 'string' } }, secrets: { type: 'object', description: 'Metadata only; set secret values with the write-only endpoint.' }, actions: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Action' } }, jobs: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Job' } } } },
  DbaLinkFinish: { type: 'object', required: ['code', 'state'], properties: { code: { type: 'string', maxLength: 2048, description: 'Authorization code from the devicebasedauth.org redirect.' }, state: { type: 'string', maxLength: 256 } }, additionalProperties: false },
  Response: { type: 'object', properties: { cost_microdollars: integerMoney, balance_microdollars: integerMoney, quote_microdollars: integerMoney } }
};
/** Generate the served and checked-in contract from the only dispatch table. */
export function openapi(routes) {
  const paths = {};
  for (const route of routes) {
    if (route.path === '/mcp') continue;
    const path = route.path.replace(/:([a-z_]+)/g, '{$1}');
    const operation = { operationId: `${route.method.toLowerCase()}_${route.path.replace(/[^a-z0-9]/gi, '_')}`, summary: route.handler, 'x-access': route.access,
      security: route.access === PUBLIC ? [] : route.access === ACCOUNT_SESSION ? [{ ClerkSession: [] }] : route.access === SESSION ? [{ ClerkSession: [] }, { DeviceCredential: [] }] : [{ ApiKey: [] }, { DeviceCredential: [] }, { ClerkSession: [] }],
      parameters: [...route.path.matchAll(/:([a-z_]+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      responses: { 200: { description: 'Successful result; money is integer micro-dollars.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } } } }, 400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 401: { description: 'Invalid credential' }, 403: { description: 'Insufficient scope' }, 402: { description: 'Insufficient balance or budget' }, 409: { description: 'Stale proposal, overlap or idempotency conflict' }, 429: { description: 'Rate limit exceeded' } } };
    if (['PUT', 'POST', 'DELETE'].includes(route.method) && route.path.startsWith('/api/')) operation.parameters.push({ name: 'dry_run', in: 'query', schema: { enum: ['1'] }, description: 'Validate and quote without applying or charging.' }, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 128 } });
    if (['PUT', 'POST'].includes(route.method)) {
      let schema = { type: 'object' };
      if (route.handler === 'definitions') schema = { $ref: `#/components/schemas/${route.kind === 'jobs' ? 'Job' : route.kind === 'actions' ? 'Action' : 'Value'}` };
      if (route.handler === 'config-write') schema = { $ref: '#/components/schemas/Config' };
      if (route.handler === 'dba-link-finish') schema = { $ref: '#/components/schemas/DbaLinkFinish' };
      operation.requestBody = { content: { 'application/json': { schema } } };
    }
    if (route.handler === 'quote') for (const name of ['op', 'job', 'resource']) operation.parameters.push({ name, in: 'query', schema: { type: 'string' } });
    if (['runs', 'costs', 'upcoming'].includes(route.handler)) for (const name of ['from', 'to', 'job', 'status', 'group', 'limit', 'format', 'before', 'cursor']) operation.parameters.push({ name, in: 'query', schema: { type: 'string' } });
    if (route.handler === 'runs') {
      operation.parameters.find(parameter => parameter.name === 'cursor').description = 'With job set, pass next_cursor to fetch older runs without skipping equal timestamps. Keep the same filters. NDJSON returns X-Next-Cursor.';
      operation.parameters.find(parameter => parameter.name === 'before').description = 'Legacy exclusive timestamp in milliseconds. Prefer cursor because retries can share a timestamp.';
    }
    (paths[path] ||= {})[route.method.toLowerCase()] = operation;
  }
  return { openapi: '3.1.0', info: { title: 'cronly API', version: '0.1.0', description: 'Prepaid cron actions. Quote first, apply separately. Session reads are free; API reads are metered.' }, servers: [{ url: 'https://cronly.org' }], paths,
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'ApiKey crk_…; scoped and optionally capped per UTC day.' }, ClerkSession: { type: 'http', scheme: 'bearer', bearerFormat: 'Clerk JWT' }, DeviceCredential: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'devicebasedauth.org device credential: `DBA <credential>` plus a `DPoP: <proof>` header signed by the device key, or a short-lived `Bearer <token>` whose JWS typ is dba-access+jwt. Granted actions cronly:<scope> become scopes; reads are metered like API keys; the grant\'s spend_usd_per_month is a UTC-month cap. The DBA account must be linked (POST /api/dba/link/start).' } }, schemas } };
}
