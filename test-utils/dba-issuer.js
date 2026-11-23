import { issuerSigner, jwksFor, signCredential, signAccessToken, signStatusList } from '../src/vendor/devicebasedauth/issuer.js';
import { createProof } from '../src/vendor/devicebasedauth/credential.js';
import { generateKeyPair, exportPublicJwk, jwkThumbprint, signJws, b64u } from '../src/vendor/devicebasedauth/jose.js';
import { ReplayCacheDO } from '../src/vendor/devicebasedauth/replay-do.js';
import { DbaRevocationsDO } from '../src/durable-objects/dba-revocations-do.js';
import { forgetPushedDbaRevocations } from '../src/auth/dba.js';
import { namespace } from './storage.js';
import { setBit } from '../src/vendor/devicebasedauth/status-list.js';

let issuers = 0;
const id = prefix => `${prefix}${b64u(crypto.getRandomValues(new Uint8Array(12))).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, 'x')}`;

/**
 * A fake devicebasedauth.org for tests: a generated P-256 issuer key signs credentials, access
 * tokens, status lists, OIDC ID tokens and webhook events with the vendored issuer code, and
 * `fetch` serves JWKS, the status list, the cronly.org catalog (`catalog`), OIDC discovery, the
 * token endpoint and online `/api/v1/authorize` (answer with `online.answer`/`online.status`;
 * requests land in `online.calls`). Each instance has its own issuer URL so module-level
 * verifier caches never mix keys between tests.
 */
export async function fakeDbaIssuer() {
  const issuer = `https://dba-${++issuers}-${crypto.randomUUID().slice(0, 8)}.test`;
  const pair = await generateKeyPair(true);
  const issuerKey = { kid: 'test-1', jwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  const signer = await issuerSigner(issuerKey);
  const statusUri = `${issuer}/v1/lists/1`;
  let statusBytes = new Uint8Array(64); let nextIndex = 0;
  const codes = new Map(); const calls = []; const catalog = []; const online = { answer: { allow: true }, status: 200, calls: [] };
  forgetPushedDbaRevocations();

  const base = ({ acct, grants, aud = ['cronly.org'], lifetime = 3600 }) => {
    const now = Math.floor(Date.now() / 1000); const cid = id('crd_');
    return { iss: issuer, sub: id('dev_'), acct, aud, cid, jti: `${cid}.1`, iat: now, nbf: now, exp: now + lifetime, grants, status: { status_list: { idx: nextIndex++, uri: statusUri } }, ver: 1 };
  };

  return {
    issuer, calls, catalog, online,
    /** Sign a webhook event (spec/events.md at DBA) as the issuer. */
    signEvent(payload) {
      return signJws({ typ: 'dba-event+jwt', kid: signer.kid }, { iss: issuer, aud: 'cronly.org', iat: Math.floor(Date.now() / 1000), jti: `evt_${crypto.randomUUID()}`, ...payload }, signer.key);
    },
    /** A new device key and a credential for it. */
    async device({ acct, grants, aud, lifetime, device = { name: 'Test laptop', kind: 'cli', key_protection: 'software' } }) {
      const keys = await generateKeyPair(false); const publicJwk = await exportPublicJwk(keys.publicKey);
      const payload = { ...base({ acct, grants, aud, lifetime }), cnf: { jkt: await jwkThumbprint(publicJwk) }, device };
      const credential = await signCredential(payload, signer);
      return {
        credential, payload, publicJwk, privateKey: keys.privateKey,
        /** Authorization headers for one request (a fresh single-use proof each call). */
        async headers(method, url, overrides = {}) {
          return { Authorization: `DBA ${credential}`, DPoP: await createProof({ privateKey: overrides.privateKey || keys.privateKey, publicJwk: overrides.publicJwk || publicJwk, method: overrides.method || method, url: overrides.url || url, credential }) };
        }
      };
    },
    /** A short-lived bearer access token (no device key). */
    async accessToken({ acct, grants }) {
      const payload = base({ acct, grants, lifetime: 600 });
      return { token: await signAccessToken(payload, signer), payload };
    },
    revoke(payload) { statusBytes = setBit(statusBytes, payload.status.status_list.idx, 1); },
    /** Simulate the user approving the link at devicebasedauth.org; returns the redirect's code. */
    authorize(authorizationUrl, { acct }) {
      const query = new URL(authorizationUrl).searchParams; const code = id('code_');
      codes.set(code, { acct, nonce: query.get('nonce'), client_id: query.get('client_id'), redirect_uri: query.get('redirect_uri'), challenge: query.get('code_challenge') });
      return { code, state: query.get('state') };
    },
    async fetch(input, init = {}) {
      const url = String(input instanceof Request ? input.url : input); calls.push(url);
      if (url === `${issuer}/.well-known/jwks.json`) return Response.json(jwksFor([issuerKey]));
      if (url === statusUri) return new Response(await signStatusList({ uri: statusUri, bytes: statusBytes, issuer }, signer), { headers: { 'Content-Type': 'application/statuslist+jwt' } });
      if (url === `${issuer}/api/v1/audiences/cronly.org`) return Response.json({ name: 'cronly.org', namespace: 'cronly', catalog });
      if (url === `${issuer}/api/v1/authorize`) { online.calls.push({ ...JSON.parse(init.body), authorization: init.headers?.Authorization }); return Response.json(online.answer, { status: online.status }); }
      if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json` });
      if (url === `${issuer}/oauth/token`) {
        const form = new URLSearchParams(init.body); const grant = codes.get(form.get('code')); codes.delete(form.get('code'));
        const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier') || ''))));
        if (!grant || grant.client_id !== form.get('client_id') || grant.redirect_uri !== form.get('redirect_uri') || grant.challenge !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const idToken = await signJws({ typ: 'JWT', kid: signer.kid }, { iss: issuer, sub: grant.acct, acct: grant.acct, aud: grant.client_id, iat: now, exp: now + 300, nonce: grant.nonce }, signer.key);
        return Response.json({ id_token: idToken, token_type: 'Bearer', expires_in: 300 });
      }
      return new Response('not found', { status: 404 });
    }
  };
}

/**
 * The DBA Durable Objects for a test env: revocations, and the shared replay cache (whose
 * vendored client calls `stub.fetch(url, init)`, as Workers stubs allow).
 */
export function dbaObjects(env) {
  const replay = namespace(ReplayCacheDO, env); const get = replay.get.bind(replay);
  replay.get = id => { const object = get(id); return { fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) }; };
  return { DBA_REVOCATIONS: namespace(DbaRevocationsDO, env), DBA_REPLAY: replay };
}
