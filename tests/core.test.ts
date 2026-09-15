import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CapabilitySchema, validateInputs } from '../src/schema.js';
import { assertCapability } from '../src/engine.js';
import { Policy } from '../src/policy.js';
import { target } from '../src/surface.js';
const load = () =>
  CapabilitySchema.parse(
    JSON.parse(readFileSync('capabilities/member-savings-inquiry.json', 'utf8')),
  );
const policy = new Policy('http://127.0.0.1:4317');
test('policy rejects origin, route, credential, fragment and query bypasses', () => {
  for (const u of [
    'https://example.com/bank',
    'http://localhost:4317/bank',
    'http://127.0.0.1:4317/api/runs',
    'http://x:y@127.0.0.1:4317/bank',
    'http://127.0.0.1:4317/bank?token=secret',
    'http://127.0.0.1:4317/bank#secret',
    'http://127.0.0.1:4317/bank/../api/runs',
    'javascript:alert(1)',
  ])
    assert.equal(policy.permitsUrl(u), false, u);
  assert.equal(policy.permitsUrl('http://127.0.0.1:4317/bank'), true);
});
test('risky actions are blocked for both actors, including tampered locators', () => {
  for (const actor of ['automation', 'human'] as const)
    assert.throws(
      () => policy.assertAction({ kind: 'click', target: target('Transfer funds') }, actor),
      /IRREVERSIBLE/,
    );
  assert.throws(
    () => policy.assertAction({ kind: 'click', target: target('Search', 'label') }, 'automation'),
    /BLOCKED/,
  );
  assert.throws(
    () => policy.assertAction({ kind: 'click', target: target('Restore session') }, 'automation'),
    /BLOCKED/,
  );
  assert.doesNotThrow(() =>
    policy.assertAction({ kind: 'click', target: target('Restore session') }, 'human'),
  );
});
test('artifact rejects unknown keys, unsupported version and undefined input references', () => {
  const c = load();
  assert.equal(CapabilitySchema.safeParse({ ...c, secret: 'token' }).success, false);
  assert.equal(CapabilitySchema.safeParse({ ...c, schemaVersion: '2.0' }).success, false);
  const copy = structuredClone(c);
  const first = copy.steps[0];
  assert.ok(first);
  first.action = { kind: 'fill', target: target('Member ID', 'label'), input: 'undefinedInput' };
  assert.equal(CapabilitySchema.safeParse(copy).success, false);
});
test('contract validation rejects ambiguous identifiers, disconnected steps and wrong output semantics', () => {
  const c = load();
  assert.doesNotThrow(() => assertCapability(c, policy));
  const duplicate = structuredClone(c);
  duplicate.outputs.push({ ...duplicate.outputs[0]! });
  assert.equal(CapabilitySchema.safeParse(duplicate).success, false);
  const disconnected = structuredClone(c);
  disconnected.steps[1]!.before.heading = 'Member accounts';
  assert.throws(() => assertCapability(disconnected, policy), /DISCONTINUOUS/);
  const wrong = structuredClone(c);
  wrong.outputs[0]!.type = 'string';
  assert.throws(() => assertCapability(wrong, policy), /OUTPUT/);
});
test('input validation rejects malformed, missing, extra and non-string parameters', () => {
  const c = load();
  for (const params of [
    {},
    { memberId: 10001 },
    { memberId: '1' },
    { memberId: '<script>' },
    { memberId: '10001', token: 'secret' },
  ])
    assert.throws(() => validateInputs(c, params), /INVALID_INPUT/);
  assert.equal(validateInputs(c, { memberId: '10002' }).memberId, '10002');
});
