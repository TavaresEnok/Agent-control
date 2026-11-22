// Prova do login dentro da imagem pelo caminho do produto: senha certa grava o estado, senha errada recusa.
// Uso: node --import tsx tests/fixtures/design-trust/prova-login.ts <url> <login.json> <ca.pem> <imagem>
import {stat} from 'node:fs/promises';
import {readDesignLoginFile} from '../../../src/design-command.ts';
import {writeDesignLoginState} from '../../../src/design-browser.ts';
import {readDesignTrustCa, stageDesignTrustCa} from '../../../src/design-trust.ts';
import {designScratchRoot, removeDesignScratch} from '../../../src/design-containers.ts';

const [url, loginFile, caFile, image] = process.argv.slice(2);
if (!url || !loginFile || !caFile || !image) throw new Error('uso');
const opened = await readDesignLoginFile(loginFile);
const trust = await stageDesignTrustCa(await readDesignTrustCa(caFile));
try {
  const state = await writeDesignLoginState(url, opened.login, image, trust.path);
  // O estado é do uid da imagem, em 0600: o host só confere que ele existe.
  const info = await stat(state);
  console.log('senha certa: estado gravado,', info.size, 'bytes, modo', (info.mode & 0o777).toString(8));
  const scratch = await designScratchRoot(state);
  if (scratch !== undefined) await removeDesignScratch(scratch);
  try {
    await writeDesignLoginState(url, {...opened.login, password: `${opened.login.password}-errada`}, image, trust.path);
    console.log('senha errada: ESTADO GRAVADO (falha da prova)');
  } catch (error) {
    console.log('senha errada: recusada', error instanceof Error ? error.message : String(error));
  }
} finally {
  opened.wipe();
  await trust.dispose();
}
