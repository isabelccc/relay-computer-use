import { writeFileSync } from 'node:fs';
import { CapabilitySchema } from '../src/schema.js';
import { inquiryInputs } from '../src/engine.js';
import { target } from '../src/surface.js';
const cp = (heading: string) => ({ frame: 'Core workspace', heading });
const transitions = [
  ['Search', 'Member search', 'Search results'],
  ['Open member', 'Search results', 'Member overview'],
  ['View accounts', 'Member overview', 'Member accounts'],
  ['Open savings', 'Member accounts', 'Savings account'],
];
const c = CapabilitySchema.parse({
  schemaVersion: '1.0',
  id: 'member-savings-inquiry',
  version: '1.0.0',
  description:
    'Read a member’s current savings balance and account status through the core banking UI.',
  application: { vendor: 'northstar-core', version: '2026.1', entryPath: '/bank' },
  inputs: inquiryInputs,
  outputs: [
    {
      name: 'availableBalance',
      type: 'money',
      target: target('Available balance', 'label'),
      sensitive: true,
      description: 'Savings balance in USD minor units.',
    },
    {
      name: 'accountStatus',
      type: 'string',
      target: target('Account status', 'label'),
      sensitive: true,
      description: 'Current account status.',
    },
  ],
  steps: [
    {
      id: 'step-1',
      action: { kind: 'fill', target: target('Member ID', 'label'), input: 'memberId' },
      before: cp('Member search'),
      after: cp('Member search'),
      timeoutMs: 2500,
    },
    ...transitions.map(([name, before, after], i) => ({
      id: `step-${i + 2}`,
      action: { kind: 'click', target: target(name ?? '') },
      before: cp(before ?? ''),
      after: cp(after ?? ''),
      timeoutMs: 2500,
    })),
  ],
  success: cp('Savings account'),
  policyId: 'northstar-read-only-v1',
  provenance: {
    kind: 'hand-authored-example',
    provider: 'none',
    model: 'none',
    runId: 'example',
    createdAt: '2026-09-15T00:00:00.000Z',
  },
});
writeFileSync('capabilities/member-savings-inquiry.json', JSON.stringify(c, null, 2));
