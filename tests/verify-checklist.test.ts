import assert from 'node:assert/strict';
import test from 'node:test';
import {loadSecurityChecklist, parseSecurityChecklist} from '../src/verify-checklist.ts';

const chapters = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16', 'V17'];
const owasp = [
  ['OWASPT10-2025-01', 'Broken Access Control'],
  ['OWASPT10-2025-02', 'Security Misconfiguration'],
  ['OWASPT10-2025-03', 'Software Supply Chain Failures'],
  ['OWASPT10-2025-04', 'Cryptographic Failures'],
  ['OWASPT10-2025-05', 'Injection'],
  ['OWASPT10-2025-06', 'Insecure Design'],
  ['OWASPT10-2025-07', 'Authentication Failures'],
  ['OWASPT10-2025-08', 'Software or Data Integrity Failures'],
  ['OWASPT10-2025-09', 'Security Logging and Alerting Failures'],
  ['OWASPT10-2025-10', 'Mishandling of Exceptional Conditions'],
] as const;
const cwes = ['CWE-79', 'CWE-89', 'CWE-352', 'CWE-862', 'CWE-787', 'CWE-22', 'CWE-416', 'CWE-125', 'CWE-78', 'CWE-94', 'CWE-120', 'CWE-434', 'CWE-476', 'CWE-121', 'CWE-502', 'CWE-122', 'CWE-863', 'CWE-20', 'CWE-284', 'CWE-200', 'CWE-306', 'CWE-918', 'CWE-77', 'CWE-639', 'CWE-770', 'CWE-287', 'CWE-798'];

test('lista versionada cobre ASVS 5.0, Top 10:2025 e CWE Top 25', () => {
  const items = loadSecurityChecklist();
  const ids = items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(items.length, 56);
  assert.deepEqual([...new Set(items.map(item => item.source))].sort(), ['ASVS-5.0', 'CWE-TOP-25', 'OWASP-2025']);
  for (const chapter of chapters) {
    assert.ok(items.some(item => item.source === 'ASVS-5.0' && item.title.includes(`ASVS 5.0 ${chapter} `)), chapter);
  }
  for (const [id, name] of owasp) {
    const item = items.find(entry => entry.id === id);
    assert.ok(item, id);
    assert.equal(item.source, 'OWASP-2025');
    assert.ok(item.title.includes('2025') && item.title.includes(name), item.title);
  }
  for (const id of cwes) {
    const item = items.find(entry => entry.id === id);
    assert.ok(item, id);
    assert.equal(item.source, 'CWE-TOP-25');
  }
  for (const appliesTo of ['code', 'route', 'config', 'dependency', 'secret', 'dockerfile', 'any']) {
    assert.ok(items.some(item => item.appliesTo === appliesTo), appliesTo);
  }
  assert.ok(items.some(item => item.id === 'ASVS5-V8-AUTORIZACAO' && item.appliesTo === 'route'));
});

test('recusa id duplicado e item fora do esquema', () => {
  const [first] = loadSecurityChecklist();
  assert.ok(first);
  assert.throws(() => parseSecurityChecklist([first, {...first}]), new RegExp(`CHECKLIST_ID_DUPLICADO:${first.id}`));
  assert.throws(() => parseSecurityChecklist([{...first, extra: true}]));
  assert.throws(() => parseSecurityChecklist([{...first, id: 'minusculo'}]));
});
