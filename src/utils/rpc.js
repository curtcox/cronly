import { ApiError } from './errors.js';
/** Invoke an internal DO operation through its private namespace binding. */
export async function rpc(namespace, id, op, args = {}) {
  const response = await namespace.get(namespace.idFromName(id)).fetch(new Request('https://internal/', {
    method: 'POST', body: JSON.stringify({ op, ...args })
  }));
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.code, data.error, data.details);
  return data;
}
