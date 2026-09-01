/**
 * Bundles the pure modules under test to plain ESM, then runs the test files
 * in tests/. No test framework: these are node scripts that exit non-zero on
 * failure, which is all `npm test` and a CI step need.
 */
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, '.test-build');

const entries = {
  soraDetection: 'services/soraDetection.ts',
  sora: 'services/soraWatermarkService.ts',
  inpaint: 'services/inpaint.ts',
};

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: path.join(outdir, `${name}.mjs`),
    logLevel: 'error',
  });
}

const files = readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const file of files) {
  console.log(`\n─── ${file} ───`);
  const result = spawnSync(process.execPath, [path.join(root, 'tests', file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(failed === 0 ? `\n${files.length} test file(s) passed.` : `\n${failed} test file(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
