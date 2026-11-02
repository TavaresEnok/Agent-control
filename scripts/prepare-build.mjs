import { symlinkSync, existsSync } from 'node:fs';
for (const name of ['upstream','db','scripts','services']) {
  const target = 'dist/' + name;
  if (!existsSync(target)) symlinkSync('../' + name, target, 'dir');
}
