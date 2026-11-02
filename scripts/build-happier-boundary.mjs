import { build } from '../upstream/cezar/node_modules/esbuild/lib/main.js';
await build({entryPoints:['adapters/happier-entry.ts'],outfile:'upstream/happier/node_modules/.agent-control-boundary.mjs',bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'upstream/happier/apps/cli/tsconfig.json',sourcemap:true});
