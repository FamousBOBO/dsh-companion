import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const parent=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Supports scripts checked into the suite and the original sibling ops layout.
export const suite=path.resolve(process.env.DSH_COMPANION_PRODUCTION_ROOT||(
  fs.existsSync(path.join(parent,'package.json'))?parent:path.join(parent,'dsh-production')
));
