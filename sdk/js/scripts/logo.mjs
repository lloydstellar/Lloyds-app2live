// Writes src/logo.ts: the LA2L logo of the Send to Live button as a data address, so the button
// is one file. assets/logo-48.png was made from src/ui/la2l-logo-big.png at 48 x 48 pixels.
//   node scripts/logo.mjs
import fs from 'node:fs';
const png = fs.readFileSync(new URL('../assets/logo-48.png', import.meta.url));
const text = `// Made by scripts/logo.mjs from assets/logo-48.png. Do not edit.\nexport const LOGO: string = 'data:image/png;base64,${png.toString('base64')}';\n`;
fs.writeFileSync(new URL('../src/logo.ts', import.meta.url), text);
console.log(`src/logo.ts: ${text.length} characters`);
