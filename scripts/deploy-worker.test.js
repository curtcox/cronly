import { it, expect } from 'vitest';
import { deploymentArgs } from './deploy-worker.mjs';

const release = { GITHUB_SHA: 'a'.repeat(40) };

it('preserves an emergency dashboard stop on routine deployments with an unset CI control', () => {
  for (const control of [undefined, '']) {
    const args = deploymentArgs({ ...release, COST_SAFETY_HARD_STOP: control });
    expect(args).toContain('--keep-vars');
    expect(args.some(value => value.startsWith('COST_SAFETY_HARD_STOP:'))).toBe(false);
    // Preserving operator controls must not preserve old public-launch approvals.
    expect(args).toContain('LAUNCH_APPROVED:false');
    expect(args).toContain('JS_LIVE_ACCEPTED:false');
    expect(args).toContain(`GIT_SHA:${release.GITHUB_SHA}`);
  }
});

it('allows the operator to explicitly enable or clear the emergency stop', () => {
  for (const control of ['true', 'false']) {
    const args = deploymentArgs({ ...release, COST_SAFETY_HARD_STOP: control });
    expect(args).toContain('--keep-vars');
    expect(args).toContain(`COST_SAFETY_HARD_STOP:${control}`);
  }
});

it('refuses malformed stop controls instead of silently clearing the stop', () => {
  for (const control of ['TRUE', '0', ' false', 'no', 'private-invalid-value']) {
    expect(() => deploymentArgs({ ...release, COST_SAFETY_HARD_STOP: control })).toThrow('COST_SAFETY_HARD_STOP must be true, false or unset.');
  }
});

it('requires an identifiable release before starting a deployment', () => {
  for (const sha of [undefined, '', 'main', 'a'.repeat(39)]) expect(() => deploymentArgs({ ...release, GITHUB_SHA: sha })).toThrow('A full deployment GITHUB_SHA is required.');
});
