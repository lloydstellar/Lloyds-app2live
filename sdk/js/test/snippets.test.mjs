// The TypeScript examples in the docs, on the developer pages, in the paste text and in the skill
// type-check against this package, with React's types: an AI tool copies them as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.join(HERE, '..');
const REPO = path.join(PACKAGE, '..', '..');
const TSC = path.join(PACKAGE, 'node_modules', 'typescript', 'bin', 'tsc');

const markdown = [
  ...fs.readdirSync(path.join(PACKAGE, 'docs')).map((f) => path.join(PACKAGE, 'docs', f)),
  ...fs.readdirSync(path.join(REPO, 'docs', 'developers')).map((f) => path.join(REPO, 'docs', 'developers', f)),
  ...fs.readdirSync(path.join(REPO, 'skills'), { recursive: true }).map((f) => path.join(REPO, 'skills', f)),
].filter((f) => f.endsWith('.md'));

const snippets = markdown.flatMap((file) =>
  [...fs.readFileSync(file, 'utf8').matchAll(/```tsx\n([\s\S]*?)```/g)].map((m, i) => ({ name: `${path.relative(REPO, file)} #${i + 1}`, code: m[1] })),
);

test('there are TypeScript examples to check', () => {
  assert.ok(snippets.length >= 4, `${snippets.length} found`);
});

for (const snippet of snippets) {
  test(`${snippet.name} type-checks`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-tsx-'));
    try {
      fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
      fs.symlinkSync(PACKAGE, path.join(dir, 'node_modules', 'la2l'), 'dir');
      for (const types of ['react', 'csstype']) {
        const from = fs.existsSync(path.join(PACKAGE, 'node_modules', '@types', types)) ? path.join(PACKAGE, 'node_modules', '@types', types) : path.join(PACKAGE, 'node_modules', types);
        fs.symlinkSync(from, path.join(dir, 'node_modules', types === 'react' ? '@types/react' : 'csstype'), 'dir');
      }
      fs.writeFileSync(path.join(dir, 'snippet.tsx'), snippet.code);
      const options = { jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2022', strict: true, noEmit: true, skipLibCheck: true, lib: ['dom', 'es2022'], types: [] };
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: options, files: ['snippet.tsx'] }));
      const { code, out } = await new Promise((resolve) => execFile(process.execPath, [TSC, '-p', dir], (error, out) => resolve({ code: error ? error.code : 0, out })));
      assert.equal(code, 0, out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
