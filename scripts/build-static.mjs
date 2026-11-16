import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

// Only public assets are exported. Keys, backend code, and local data stay out.
const output = new URL('../dist/', import.meta.url);
await mkdir(output, { recursive: true });
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
await writeFile(new URL('index.html', output), html.replace('name="wagle-runtime" content="auto"', 'name="wagle-runtime" content="demo"'));
for (const file of ['styles.css', 'app.js', 'community.js', 'favicon.svg']) {
  await copyFile(new URL(`../public/${file}`, import.meta.url), new URL(file, output));
}
await writeFile(new URL('.nojekyll', output), '');
console.log('Static demo exported to dist/ — works at a domain root or a nested path.');
