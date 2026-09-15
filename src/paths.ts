import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source lives in src/, compiled code in dist/src/. Assets and private runtime
// files have one location regardless of which entry point is used.
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = existsSync(join(moduleRoot, 'package.json'))
  ? moduleRoot
  : resolve(moduleRoot, '..');
