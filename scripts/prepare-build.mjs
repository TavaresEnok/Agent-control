import { symlinkSync, existsSync } from 'node:fs';
for (const name of ['upstream','db','scripts']) {
  const target = 'dist/' + name;
  if (!existsSync(target)) symlinkSync('../' + name, target, 'dir');
}
