#!/usr/bin/env node
/**
 * Publish Exodus Card site (self-contained vendor + embed).
 */
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = 'exodus-card.surge.sh';

writeFileSync(`${__dir}/.surgeignore`, 'publish.mjs\n_bake.mjs\n_patch-check.mjs\nnode_modules\n');
writeFileSync(`${__dir}/CORS`, '*\n');

console.log('[exodus] site', SITE);
execSync(`npx --yes surge . ${SITE}`, { cwd: __dir, stdio: 'inherit', shell: true });
console.log('[exodus] live → https://' + SITE);
