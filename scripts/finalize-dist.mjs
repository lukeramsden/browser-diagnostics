// Moves the Vite-emitted HTML to dist/ui.html and, for the test build,
// adds the test-only host permission (see docs/platform-notes.md).
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] === 'test' ? 'test' : 'prod';
const out = mode === 'test' ? 'dist-test' : 'dist';

const emittedHtml = join(out, 'src/ui/index.html');
if (existsSync(emittedHtml)) {
  let html = readFileSync(emittedHtml, 'utf8');
  // Paths were emitted relative to src/ui/; ui.html sits at the root.
  html = html.replaceAll('../../', './');
  writeFileSync(join(out, 'ui.html'), html);
  rmSync(join(out, 'src'), { recursive: true, force: true });
}

const manifestPath = join(out, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (mode === 'test') {
  manifest.name += ' (TEST BUILD)';
  // Playwright cannot perform the user gesture that grants activeTab, so the
  // test build is given host access to the local fixture server only.
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
} else if (manifest.host_permissions) {
  throw new Error('production manifest must not have host_permissions');
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`finalized ${out}/ (${mode})`);
