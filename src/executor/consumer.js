import { boundLog } from './logs.js';
import { rpc } from '../utils/rpc.js';
import { decryptSecret } from './secrets.js';
import { executeHttp } from './http.js';
/** Claim a prepaid run once; queue redelivery may retry reporting but never the external call. */
export async function consume(message, env, ctx) {
  const { account, name, id } = message.body;
  let execution;
  try { execution = await rpc(env.ACCOUNTS, account, 'claim-run', { id }); }
  catch (error) { if (error.code === 'expired_run') { message.ack(); return; } throw error; }
  if (execution.duplicate) { message.ack(); return; }
  let result;
  try {
    if (env.SAFETY && (await rpc(env.SAFETY, 'global', 'status')).brake) {
      await rpc(env.JOBS, `${account}:${name}`, 'result', { id, result: { status: 'failure', error: 'Paused by cost safety brake', charge_microdollars: 0 } }); message.ack(); return;
    }
    const secrets = {};
    for (const [name, record] of Object.entries(execution.secrets)) secrets[name] = await decryptSecret(env, account, name, record);
    const context = { var: execution.vars, secret: secrets, input: execution.input, run: { id, scheduled_at: execution.scheduled_at, trigger: execution.trigger }, job: { name }, account: { id: account } };
    if (env.COST_SAFETY_HARD_STOP === 'true') throw new Error('brake');
    if (execution.action.type === 'javascript') {
      const { executeJavaScript } = await import('./javascript.js'); result = await executeJavaScript(execution, context, env, ctx, secrets);
    } else result = await executeHttp(execution, context, env, secrets);
  } catch { result = { status: 'failure', error: 'Action failed or exceeded its limits' }; }
  // Store the outcome before acknowledging. On reporting failure, the hold still bounds cost.
  await rpc(env.JOBS, `${account}:${name}`, 'result', { id, result: boundLog(result) });
  message.ack();
}
