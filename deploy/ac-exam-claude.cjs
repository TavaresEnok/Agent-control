#!/usr/bin/env node
const {spawn} = require('node:child_process');
const real = "/usr/local/bin/claude";
const incoming = process.argv.slice(2);
const args = ["--setting-sources","user","--strict-mcp-config","--settings","{\"disableAllHooks\":true}"];
for (let i = 0; i < incoming.length; i += 1) {
  if (incoming[i] === '--mcp-config') { i += 1; continue; }
  args.push(incoming[i]);
}
const env = {...process.env};
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL;
delete env.CLAUDE_CONFIG_DIR;
for (const key of Object.keys(env)) {
  if (key.startsWith('CLAUDE_CODE_USE_')) delete env[key];
}
const child = spawn(real, args, {stdio: 'inherit', env});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code == null ? 1 : code);
});
child.on('error', () => process.exit(127));
