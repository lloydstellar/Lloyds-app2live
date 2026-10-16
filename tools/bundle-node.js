'use strict';
// Bundles the Node entry point with every module it loads via require('./...') into one file.
// Reason: Freeze in Max only packs the script that [node.script] names, not the modules it loads.
// A device that works on your computer (where the modules sit next to it) would fail on any other.
// Usage: node tools/bundle-node.js <entry.js> <output.js>

const fs = require('fs');
const path = require('path');

function bundle(entry) {
  const dir = path.dirname(path.resolve(entry));
  const modules = new Map();
  const add = (name) => {
    if (modules.has(name)) return;
    const src = fs.readFileSync(path.join(dir, name + '.js'), 'utf8');
    modules.set(name, src);
    for (const m of src.matchAll(/require\(\s*'\.\/([\w-]+)'\s*\)/g)) add(m[1]);
  };
  const entryName = path.basename(entry, '.js');
  add(entryName);

  let code = `'use strict';\n// BUNDLED by tools/bundle-node.js. Do not edit: change src/node and build again.\n`;
  code += `const __la2l = { defs: {}, cache: {} };\n`;
  code += `function __la2lRequire(name) {\n  if (!name.startsWith('./')) return require(name);\n  const key = name.slice(2);\n  if (__la2l.cache[key]) return __la2l.cache[key].exports;\n  const module = { exports: {} };\n  __la2l.cache[key] = module;\n  __la2l.defs[key](module, module.exports, __la2lRequire);\n  return module.exports;\n}\n`;
  for (const [name, src] of modules) {
    code += `\n__la2l.defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${src}\n};\n`;
  }
  code += `\n__la2lRequire('./${entryName}');\n`;
  return { code, modules: [...modules.keys()] };
}

if (require.main === module) {
  const [entry, out] = process.argv.slice(2);
  if (!entry || !out) {
    console.error('Usage: node tools/bundle-node.js <entry.js> <output.js>');
    process.exit(1);
  }
  const { code, modules } = bundle(entry);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.log(`Bundled ${modules.join(', ')} -> ${out} (${code.length} bytes)`);
}

module.exports = { bundle };
