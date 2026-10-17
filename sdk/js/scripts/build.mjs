// Builds the package and the copies la2l-server serves.
//
//   dist/                      tsc: the JavaScript and the type definitions npm gets; a bundler
//                              that imports la2l and la2l/button gets the SDK once
//   dist/button.min.js         esbuild: the Send to Live button with the SDK, as one minified file,
//                              for a page without a build step (jsDelivr)
//   server/public/vendor/      esbuild: la2l.js (the SDK), la2l-button.js (= button.min.js) and
//                              la2l-receiver.js (the test receiver of the page), committed, so the
//                              server's Docker image needs no npm
//   docs/*.md, README.md,      the version and the integrity hash of dist/button.min.js in every
//   examples/*/                jsDelivr address
//
//   npm run build           build everything
//   npm run check:vendor    only check that the committed copies are what a fresh build makes (CI)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(HERE, '..', '..', 'server', 'public', 'vendor');
const { version } = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));

const banner = (what) =>
  [
    `// la2l ${version}: ${what}.`,
    '// SPDX-License-Identifier: Apache-2.0. https://github.com/lloydstellar/Lloyds-app2live',
    '// Built from sdk/js with "npm run build". Do not edit: CI compares it with a fresh build.',
  ].join('\n');

async function bundle(entry, options) {
  const result = await esbuild.build(
    Object.assign(
      {
        entryPoints: [path.join(HERE, 'src', entry)],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2020',
        external: ['node:*'],
        legalComments: 'none',
        charset: 'utf8',
        write: false,
      },
      options
    )
  );
  return result.outputFiles[0].text;
}

// Every file the build makes besides tsc's, by its place.
async function outputs() {
  const button = await bundle('button.ts', { platform: 'browser', minify: true, banner: { js: banner('the Send to Live button, for a browser') } });
  return {
    [path.join(HERE, 'dist', 'button.min.js')]: button,
    [path.join(VENDOR, 'la2l-button.js')]: button,
    [path.join(VENDOR, 'la2l.js')]: await bundle('index.ts', { banner: { js: banner('for the browser, as la2l-server serves it at /la2l/vendor/la2l.js') } }),
    [path.join(VENDOR, 'la2l-receiver.js')]: await bundle('receiver.ts', { banner: { js: banner('the test receiver of the page /la2l/receiver') } }),
  };
}

// The docs and the examples carry the version and the integrity hash of dist/button.min.js.
const integrity = (text) => 'sha384-' + crypto.createHash('sha384').update(text).digest('base64');
function docsWithIntegrity(hash) {
  const md = (dir) => fs.readdirSync(dir).filter((f) => /\.(md|html)$/.test(f)).map((f) => path.join(dir, f));
  const examples = path.join(HERE, '..', '..', 'examples');
  const files = [path.join(HERE, 'README.md'), ...md(path.join(HERE, 'docs')), ...fs.readdirSync(examples).flatMap((d) => md(path.join(examples, d)))];
  const out = {};
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    out[file] = text
      .replace(/la2l@\d+\.\d+\.\d+(-[\w.]+)?\/dist\/button\.min\.js/g, `la2l@${version}/dist/button.min.js`)
      .replace(/(la2l@[\d.]+\/dist\/button\.min\.js"\s+integrity=")sha384-[A-Za-z0-9+/=]*(")/g, `$1${hash}$2`);
  }
  return out;
}

const check = process.argv.includes('--check');
if (!check) {
  const tsc = spawnSync(process.execPath, [path.join(HERE, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(HERE, 'tsconfig.json')], { stdio: 'inherit' });
  if (tsc.status !== 0) process.exit(tsc.status || 1);
}
const made = await outputs();
Object.assign(made, docsWithIntegrity(integrity(made[path.join(HERE, 'dist', 'button.min.js')])));
if (check) {
  const stale = Object.entries(made)
    .filter(([file]) => !file.startsWith(path.join(HERE, 'dist')))
    .filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
    .map(([file]) => path.relative(path.join(HERE, '..', '..'), file));
  if (stale.length) {
    console.error(`Not what sdk/js builds: ${stale.join(', ')}. Run "npm run build" in sdk/js and commit them.`);
    process.exit(1);
  }
  console.log('The vendor files and the docs are up to date.');
} else {
  for (const [file, text] of Object.entries(made)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
  fs.chmodSync(path.join(HERE, 'dist', 'cli', 'main.js'), 0o755);
  console.log(`Built la2l ${version}: dist/, server/public/vendor/ (la2l.js, la2l-button.js, la2l-receiver.js), and the docs.`);
}
