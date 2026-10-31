import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

export async function startHarness() {
  const dependencies = resolve(here, 'node_modules');
  const { dependencies: packages } = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(here, 'package.json')));
  const server = await createServer({
    configFile: false, envDir: false, root: here,
    cacheDir: resolve(here, '.runtime/vite'),
    resolve: {
      alias: [
        ...Object.keys(packages).map(name => ({ find: name, replacement: resolve(dependencies, name) })),
        { find: '@', replacement: resolve(root, 'app/frontend') },
        { find: 'shared', replacement: resolve(root, 'app/frontend/shared') },
        { find: 'types', replacement: resolve(root, 'app/frontend/types') },
      ],
      dedupe: ['react', 'react-dom'],
    },
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] },
      watch: { ignored: ['**/.runtime/**', '**/artifacts/**'] } },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}` };
}
