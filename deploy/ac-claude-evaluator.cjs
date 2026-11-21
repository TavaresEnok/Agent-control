#!/usr/bin/env node
const {spawn} = require('node:child_process');
const real = "/usr/local/bin/claude";
const args = [...["--setting-sources","user","--strict-mcp-config","--settings","{\"disableAllHooks\":true}"], ...process.argv.slice(2)];
const child = spawn(real, args, {stdio: 'inherit', env: process.env});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code == null ? 1 : code);
});
child.on('error', () => process.exit(127));
