import https from 'node:https'; import {readFileSync} from 'node:fs'; import {createRequire} from 'node:module';
import {trustFlags, spkiHash} from '/opt/design-tools/trust.mjs';
const require = createRequire('/opt/design-tools/package.json');
const {chromium} = require('playwright');
const ca = readFileSync('/trust/ca.pem', 'utf8');
// Servidor falso: certificado autoassinado qualquer, com a CA pública da homologação anexada como intermediário.
const fake = https.createServer({key: readFileSync('/ca/falso.key'), cert: readFileSync('/ca/falso.crt', 'utf8') + ca}, (q, r) => r.end('<title>falso</title>'));
await new Promise(ok => fake.listen(8443, '127.0.0.1', ok));
const flags = await trustFlags('https://chatisp-homolog.local');
const caFlag = [`--ignore-certificate-errors-spki-list=${spkiHash(ca)}`];
const visit = async (args, url) => { const b = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage', ...args]}); const p = await b.newPage(); try { const r = await p.goto(url, {timeout: 15000}); return `${r.status()} ${await p.title()}`; } catch (e) { return String(e.message).split('\n')[0].replace(/ at .*/, ''); } finally { await b.close(); } };
console.log('folha, homologação:', await visit(flags, 'https://chatisp-homolog.local/entrar'));
console.log('folha, servidor falso:', await visit(flags, 'https://localhost:8443/'));
console.log('sem flag, homologação:', await visit([], 'https://chatisp-homolog.local/entrar'));
console.log('hash da CA (versão reprovada), servidor falso:', await visit(caFlag, 'https://localhost:8443/'));
fake.close();
