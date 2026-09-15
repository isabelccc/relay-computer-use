import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CapabilitySchema } from '../src/schema.js';
writeFileSync(
  'docs/capability.schema.json',
  JSON.stringify(z.toJSONSchema(CapabilitySchema), null, 2),
);
