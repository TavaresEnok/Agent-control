/**
 * Claude CLI flags that keep repository and account configuration from running beside the credentials.
 * Proven against Claude Code 2.1.329 in `-p` mode (tests/claude-hardening.test.ts, lab case):
 * project hooks and the project `.mcp.json` run by default, and a hook in the account `settings.json` runs too.
 * `--setting-sources user` drops project settings, `--strict-mcp-config` drops project MCP servers and
 * `--settings {"disableAllHooks":true}` turns off hooks from every source, the account included.
 */
export const CLAUDE_HOOKS_OFF_SETTINGS = '{"disableAllHooks":true}';

/** Evaluators read nothing from the project; the programmer keeps project settings, so CLAUDE.md still loads. */
export type ClaudeHardeningMode = 'evaluator' | 'programmer';

export function hardenedClaudeArgs(mode: ClaudeHardeningMode): string[] {
  const common = ['--strict-mcp-config', '--settings', CLAUDE_HOOKS_OFF_SETTINGS];
  return mode === 'evaluator' ? ['--setting-sources', 'user', ...common] : common;
}

/** Wrappers shipped in the execution and planning images. `/tmp` is noexec there, so they cannot be written at run time. */
export const HARDENED_CLAUDE_BIN: Record<ClaudeHardeningMode, string> = {
  evaluator: '/usr/local/bin/ac-claude-evaluator',
  programmer: '/usr/local/bin/ac-claude-programmer',
};

export function hardenedClaudeMode(role: string): ClaudeHardeningMode {
  return role === 'programmer' ? 'programmer' : 'evaluator';
}

/** CommonJS wrapper. It keeps the environment (CLAUDE_CONFIG_DIR stays) and only prepends the flags. */
export function hardenedClaudeWrapperSource(mode: ClaudeHardeningMode, realBin = '/usr/local/bin/claude', nodeShebang = '/usr/bin/env node'): string {
  return `#!${nodeShebang}
const {spawn} = require('node:child_process');
const real = ${JSON.stringify(realBin)};
const args = [...${JSON.stringify(hardenedClaudeArgs(mode))}, ...process.argv.slice(2)];
const child = spawn(real, args, {stdio: 'inherit', env: process.env});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code == null ? 1 : code);
});
child.on('error', () => process.exit(127));
`;
}
