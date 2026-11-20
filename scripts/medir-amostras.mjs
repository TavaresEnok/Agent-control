import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { compactarSaida } from './compactar-saida.mjs';

const samples = [
  {
    id: '01-tsc',
    name: 'npx tsc --noEmit --skipLibCheck',
    file: 'docs/economia/amostras-saida/01-tsc.txt',
    hasError: true,
    errorKeywords: ['error TS', 'src/cezar.ts'],
    rtkCmd: 'cat docs/economia/amostras-saida/01-tsc.txt | rtk pipe -f tsc'
  },
  {
    id: '02-test-usage',
    name: 'node --import tsx --test tests/usage.test.ts (falha)',
    file: 'docs/economia/amostras-saida/02-test-usage.txt',
    hasError: true,
    errorKeywords: ['ERR_MODULE_NOT_FOUND', 'tests/usage.test.ts'],
    rtkCmd: 'rtk test node --import tsx --test tests/usage.test.ts 2>&1 || true'
  },
  {
    id: '02-test-passing',
    name: 'node --import tsx --test tests/auth-origins.test.ts (sucesso)',
    file: 'docs/economia/amostras-saida/02-test-passing.txt',
    hasError: false,
    errorKeywords: [],
    rtkCmd: 'rtk test node --import tsx --test tests/auth-origins.test.ts 2>&1 || true'
  },
  {
    id: '03-git-log',
    name: 'git log --stat -20',
    file: 'docs/economia/amostras-saida/03-git-log.txt',
    hasError: false,
    errorKeywords: [],
    rtkCmd: 'cat docs/economia/amostras-saida/03-git-log.txt | rtk pipe -f git-log'
  },
  {
    id: '04-git-diff',
    name: 'git diff HEAD~3 --stat',
    file: 'docs/economia/amostras-saida/04-git-diff.txt',
    hasError: false,
    errorKeywords: [],
    rtkCmd: 'cat docs/economia/amostras-saida/04-git-diff.txt | rtk pipe -f git-diff'
  },
  {
    id: '05-npm-ls',
    name: 'npm ls --depth=0',
    file: 'docs/economia/amostras-saida/05-npm-ls.txt',
    hasError: false,
    errorKeywords: [],
    rtkCmd: 'rtk deps 2>&1 || true'
  },
  {
    id: '06-docker-ps',
    name: 'docker ps -a',
    file: 'docs/economia/amostras-saida/06-docker-ps.txt',
    hasError: false,
    errorKeywords: [],
    rtkCmd: 'rtk docker ps -a 2>&1 || true'
  },
  {
    id: '07-astra-log',
    name: 'tail -n 300 astra.log',
    file: 'docs/economia/amostras-saida/07-astra-log.txt',
    hasError: true,
    errorKeywords: ['Error:', 'personal-artifact-retention.ts'],
    rtkCmd: 'cat docs/economia/amostras-saida/07-astra-log.txt | rtk pipe -f log'
  }
];

function tokenEst(chars) {
  return Math.ceil(chars / 4);
}

const results = [];

for (const s of samples) {
  const rawText = readFileSync(s.file, 'utf8');
  const rawChars = rawText.length;
  const rawTokens = tokenEst(rawChars);

  // RTK
  let rtkText = '';
  try {
    rtkText = execSync(s.rtkCmd, { shell: '/bin/bash', encoding: 'utf8' });
  } catch (err) {
    rtkText = err.stdout?.toString() ?? '';
  }
  const rtkChars = rtkText.length;
  const rtkTokens = tokenEst(rtkChars);
  const rtkRedPct = ((1 - rtkChars / rawChars) * 100).toFixed(1);

  // Filtro próprio
  const customText = compactarSaida(rawText, { maxLinhas: 50 });
  const customChars = customText.length;
  const customTokens = tokenEst(customChars);
  const customRedPct = ((1 - customChars / rawChars) * 100).toFixed(1);

  // Verificação de perda
  const rtkLossOk = s.hasError ? s.errorKeywords.every(k => rtkText.includes(k)) : true;
  const customLossOk = s.hasError ? s.errorKeywords.every(k => customText.includes(k)) : true;

  results.push({
    ...s,
    rawChars,
    rawTokens,
    rtkChars,
    rtkTokens,
    rtkRedPct,
    rtkLossOk,
    customChars,
    customTokens,
    customRedPct,
    customLossOk
  });
}

console.log(JSON.stringify(results, null, 2));
