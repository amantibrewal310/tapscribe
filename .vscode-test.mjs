import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS caps unix socket paths at 103 chars; a user-data-dir inside the
// repo can blow past that, so the test instance gets a short temp dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'tapscribe-test-'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: ['--user-data-dir', userDataDir],
});
