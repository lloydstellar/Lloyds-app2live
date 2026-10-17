// Builds the package: dist/ with tsc (the JavaScript and the type definitions npm gets), and the
// copy for the browser that la2l-server serves, server/public/vendor/la2l.js, with esbuild. That
// copy is committed, so the server's Docker image needs no npm.
//
//   npm run build           build both
//   npm run check:vendor    only check that the committed copy is what a fresh build makes (CI)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(HERE, '..', '..', 'server', 'public', 'vendor', 'la2l.js');
const { version } = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));

async function vendor() {
  const result = await esbuild.build({
    entryPoints: [path.join(HERE, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    external: ['node:*'],
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    banner: {
      js: [
        `// la2l ${version} for the browser, as la2l-server serves it at /la2l/vendor/la2l.js.`,
        '// SPDX-License-Identifier: Apache-2.0. https://github.com/lloydstellar/Lloyds-app2live',
        '// Built from sdk/js with "npm run build". Do not edit: CI compares it with a fresh build.',
      ].join('\n'),
    },
  });
  return result.outputFiles[0].text;
}

if (process.argv.includes('--check')) {
  const fresh = await vendor();
  const committed = fs.existsSync(VENDOR) ? fs.readFileSync(VENDOR, 'utf8') : '';
  if (fresh !== committed) {
    console.error('server/public/vendor/la2l.js is not what sdk/js builds. Run "npm run build" in sdk/js and commit it.');
    process.exit(1);
  }
  console.log('server/public/vendor/la2l.js is up to date.');
} else {
  const tsc = spawnSync(process.execPath, [path.join(HERE, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(HERE, 'tsconfig.json')], { stdio: 'inherit' });
  if (tsc.status !== 0) process.exit(tsc.status || 1);
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  fs.writeFileSync(VENDOR, await vendor());
  console.log(`Built dist/ and server/public/vendor/la2l.js (la2l ${version}).`);
}
