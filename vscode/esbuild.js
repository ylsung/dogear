// Build: copy the shared Dogear files (single source of truth lives in
// ../extension) into media/, then bundle the extension host code.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CHROME = path.join(ROOT, '..', 'extension');
const MEDIA = path.join(ROOT, 'media');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyShared() {
  copy(path.join(CHROME, 'theme.js'), path.join(MEDIA, 'theme.js'));
  for (const f of fs.readdirSync(path.join(CHROME, 'prompts'))) {
    copy(path.join(CHROME, 'prompts', f), path.join(MEDIA, 'prompts', f));
  }
  for (const f of fs.readdirSync(path.join(CHROME, 'fonts'))) {
    copy(path.join(CHROME, 'fonts', f), path.join(MEDIA, 'fonts', f));
  }
  copy(path.join(CHROME, 'icons', 'icon128.png'), path.join(MEDIA, 'icon128.png'));
}

async function main() {
  copyShared();
  const ctx = await esbuild.context({
    entryPoints: [path.join(ROOT, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(ROOT, 'dist', 'extension.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
  });
  if (process.argv.includes('--watch')) {
    await ctx.watch();
    console.log('watching…');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('built dist/extension.js');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
