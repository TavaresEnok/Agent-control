import https from 'node:https'; import {readFileSync} from 'node:fs'; import {createRequire} from 'node:module';
import {prepareTrust} from '/opt/design-tools/trust.mjs';
const require = createRequire('/opt/design-tools/package.json');
const {chromium} = require('playwright');
const ca = readFileSync('/trust/ca.pem', 'utf8');
const leaf = readFileSync('/ca/folha.pem', 'utf8');
const key = readFileSync('/ca/falso.key'); const own = readFileSync('/ca/falso.crt', 'utf8');
// Servidores falsos: certificado próprio com a CA pública, ou com o certificado final público, anexado como intermediário.
const serve = (port, cert) => new Promise(ok => { const s = https.createServer({key, cert}, (q, r) => r.end('<title>falso</title>')); s.listen(port, '127.0.0.1', () => ok(s)); });
const withCa = await serve(8443, own + ca);
const withLeaf = await serve(8444, own + leaf);
const visit = async url => { const b = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']}); const p = await b.newPage(); try { const r = await p.goto(url, {timeout: 15000}); return `${r.status()} ${await p.title()}`; } catch (e) { return String(e.message).split('\n')[0].replace(/ at .*/, ''); } finally { await b.close(); } };
console.log('sem CA, homologação:', await visit('https://chatisp-homolog.local/entrar'));
await prepareTrust('https://chatisp-homolog.local');
console.log('com CA, homologação:', await visit('https://chatisp-homolog.local/entrar'));
console.log('com CA, mesmo servidor com outro nome:', await visit('https://ac-chatisp-homolog-caddy/entrar'));
console.log('com CA, falso com a CA anexada:', await visit('https://localhost:8443/'));
console.log('com CA, falso com o certificado final anexado:', await visit('https://localhost:8444/'));
withCa.close(); withLeaf.close();
