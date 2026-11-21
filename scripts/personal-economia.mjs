import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// npm runs scripts from the package root; INIT_CWD keeps the folder where the user typed the command.
const root = resolve(import.meta.dirname, '..');
const from = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2).map(a => (a.startsWith('--') ? a : resolve(from, a)));
const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/personal-economia-cli.ts', ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
