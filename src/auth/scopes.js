// Ported from hashbin's scope/access model; cronly has a smaller authority surface.
export const PUBLIC = 'public';
export const SESSION = 'session';
export const USER_SCOPES = Object.freeze(['read', 'run', 'change', 'prose', 'secrets:write']);
/** Parse and deduplicate only known scopes, as in hashbin. */
export function parseScopes(input) {
  if (!Array.isArray(input) || input.some(scope => !USER_SCOPES.includes(scope))) return null;
  return [...new Set(input)];
}
/** Check route access; absent declarations always deny access. */
export function canAccess(auth, access) {
  if (access === PUBLIC) return true;
  if (!auth) return false;
  if (Array.isArray(access)) return access.some(scope => canAccess(auth, scope));
  if (access === SESSION) return auth.session === true;
  return Boolean(access && (auth.session || auth.scopes?.includes(access)));
}
