import {digest} from './contracts.ts';
import {redactText, redactUnknownSecrets, secretPreview} from './verify-redact.ts';
import {type RawFinding, type VerifySeverity} from './verify-types.ts';

type Draft = {
  rule: string;
  cwe: string | null;
  file: string | null;
  line: number | null;
  severity: VerifySeverity;
  snippet: string;
  secrets?: readonly string[];
  /** Identidade do pacote (ecossistema, nome e versão). Entra na impressão digital para que duas versões do mesmo pacote no mesmo arquivo não se fundam. */
  pkg?: string;
};

function packageIdentity(ecosystem: string | null, name: string | null, version: string | null): string | undefined {
  if (!name) return undefined;
  return [ecosystem ?? '', name, version ?? ''].join('\u0000');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rawSecret(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length < 4) return null;
  return value;
}

function lineOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000_000) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0 && parsed <= 10_000_000) return parsed;
  }
  return null;
}

function mapSeverity(value: unknown): VerifySeverity {
  if (typeof value !== 'string' || value.trim() === '') return 'media';
  const level = value.trim().toLowerCase();
  if (level === 'error' || level === 'high' || level === 'critical') return 'alta';
  if (level === 'warning' || level === 'medium' || level === 'moderate') return 'media';
  if (level === 'note' || level === 'low') return 'baixa';
  if (level === 'none' || level === 'info' || level === 'informational' || level === 'information') return 'informativa';
  return 'media';
}

function cweToken(value: unknown, bare: boolean): string | null {
  if (typeof value === 'number' && bare && Number.isInteger(value) && value >= 0 && value <= 99999) return `CWE-${value}`;
  if (typeof value === 'string') {
    const match = /CWE-(\d{1,5})(?!\d)/i.exec(value);
    if (match?.[1]) return `CWE-${match[1]}`;
    if (bare && /^\d{1,5}$/.test(value.trim())) return `CWE-${value.trim()}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = cweToken(item, bare);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    if ('cwe' in value) {
      const found = cweToken(value.cwe, true);
      if (found) return found;
    }
    const component = isRecord(value.toolComponent) ? text(value.toolComponent.name) : null;
    if (component && /cwe/i.test(component)) {
      const found = cweToken(value.id, true);
      if (found) return found;
    }
    if ('id' in value) return cweToken(value.id, false);
  }
  return null;
}

function cweFromProperties(properties: unknown): string | null {
  if (!isRecord(properties)) return null;
  for (const key of ['cwe', 'CWE', 'cweId', 'cweID', 'cwes', 'CweIDs', 'cwe_ids', 'cweIds']) {
    if (!(key in properties)) continue;
    const found = cweToken(properties[key], true);
    if (found) return found;
  }
  return cweToken(properties.tags, false);
}

function cweFromTaxon(value: unknown): string | null {
  return cweToken(value, false);
}

function ruleRecords(run: Record<string, unknown>): Record<string, unknown>[] {
  const tool = isRecord(run.tool) ? run.tool : null;
  const lists: unknown[] = [];
  if (tool && isRecord(tool.driver)) lists.push(...asArray(tool.driver.rules));
  if (tool) {
    for (const extension of asArray(tool.extensions)) {
      if (isRecord(extension)) lists.push(...asArray(extension.rules));
    }
  }
  return lists.filter(isRecord);
}

function ruleIdFromIndex(run: Record<string, unknown>, index: unknown): string | null {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  const rule = ruleRecords(run)[index];
  return rule ? text(rule.id) : null;
}

function cweFromRule(run: Record<string, unknown>, ruleId: string): string | null {
  for (const rule of ruleRecords(run)) {
    if (text(rule.id) !== ruleId) continue;
    const direct = cweFromProperties(rule.properties);
    if (direct) return direct;
    for (const relation of asArray(rule.relationships)) {
      if (!isRecord(relation)) continue;
      const found = cweFromTaxon(relation.target);
      if (found) return found;
    }
  }
  return null;
}

function cweFromResult(result: Record<string, unknown>, run: Record<string, unknown>): string | null {
  for (const taxon of asArray(result.taxa)) {
    const found = cweFromTaxon(taxon);
    if (found) return found;
  }
  const fromProperties = cweFromProperties(result.properties);
  if (fromProperties) return fromProperties;
  const ruleId = text(result.ruleId) ?? text(result.ruleID) ?? ruleIdFromIndex(run, result.ruleIndex);
  return ruleId ? cweFromRule(run, ruleId) : null;
}

function fileFromUri(uri: string): string | null {
  let value = uri.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = new URL(value).pathname; } catch { value = value.replace(/^file:\/\//i, ''); }
  }
  try { value = decodeURIComponent(value); } catch { return text(uri); }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finishSnippet(base: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter(secret => secret.length >= 4))];
  let snippet = redactUnknownSecrets(redactText(base, unique)).replace(/\s+/g, ' ').trim();
  const extras: string[] = [];
  for (const secret of unique) {
    const preview = secretPreview(secret);
    if (!snippet.includes(preview.sha256)) extras.push(`${preview.preview} (sha256:${preview.sha256})`);
  }
  const extra = extras.join(' ');
  if (!extra) return snippet.slice(0, 180);
  const room = 180 - extra.length - (snippet ? 1 : 0);
  const head = room > 0 ? snippet.slice(0, room) : '';
  return (head ? `${head} ${extra}` : extra).slice(0, 180);
}

/** The exam mounts the repo at /repository. Other absolute paths stay as the tool wrote them. */
function examPath(file: string): string | null {
  const cleaned = file.replaceAll('\\', '/').trim();
  if (!cleaned) return null;
  let value = cleaned;
  if (value === '/repository' || value === '/repository/') return null;
  const prefixed = value.startsWith('/repository/');
  if (prefixed) value = value.slice('/repository/'.length);
  if (value.split('/').includes('..')) return null;
  if (prefixed) {
    const relativePath = value.split('/').filter(part => part.length > 0 && part !== '.').join('/');
    return relativePath.length > 0 ? relativePath.slice(0, 400) : null;
  }
  return text(file)?.slice(0, 400) ?? null;
}

function materialize(tool: string, draft: Draft): RawFinding | null {
  const file = draft.file ? examPath(draft.file) : null;
  if (!file) return null;
  const name = tool.slice(0, 40);
  const rule = (text(draft.rule) ?? 'sem-regra').slice(0, 200);
  const cwe = draft.cwe && /^CWE-\d{1,5}$/.test(draft.cwe) ? draft.cwe : null;
  return {
    tool: name,
    rule,
    cwe,
    file,
    line: draft.line,
    severity: draft.severity,
    snippet: finishSnippet(draft.snippet, draft.secrets ?? []),
    fingerprint: digest(draft.pkg === undefined
      ? {tool: name, rule, file, line: draft.line, cwe}
      : {tool: name, rule, file, line: draft.line, cwe, package: draft.pkg}),
  };
}

function parseGitleaks(body: unknown): Draft[] {
  const rows = Array.isArray(body) ? body : isRecord(body) ? asArray(body.findings ?? body.Findings) : [];
  const drafts: Draft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const secret = rawSecret(row.Secret) ?? rawSecret(row.secret);
    drafts.push({
      rule: text(row.RuleID) ?? text(row.RuleId) ?? text(row.ruleId) ?? text(row.ruleID) ?? 'sem-regra',
      cwe: cweToken(row.CWE ?? row.cwe, true),
      file: text(row.File) ?? text(row.file),
      line: lineOf(row.StartLine ?? row.startLine ?? row.Line ?? row.line),
      severity: mapSeverity(row.Severity ?? row.severity ?? row.Level ?? row.level),
      snippet: text(row.Description) ?? text(row.description) ?? text(row.Message) ?? text(row.message) ?? text(row.RuleID) ?? 'segredo',
      secrets: secret ? [secret] : [],
    });
  }
  return drafts;
}

function parseOsv(body: unknown): Draft[] {
  if (!isRecord(body)) return [];
  const drafts: Draft[] = [];
  for (const result of asArray(body.results)) {
    if (!isRecord(result)) continue;
    const source = isRecord(result.source) ? result.source : {};
    const file = text(source.path);
    for (const pkg of asArray(result.packages)) {
      if (!isRecord(pkg)) continue;
      const info = isRecord(pkg.package) ? pkg.package : {};
      const name = text(info.name) ?? 'pacote';
      const version = text(info.version);
      const label = version ? `${name}@${version}` : name;
      const pkgId = packageIdentity(text(info.ecosystem), text(info.name) ?? 'pacote', version);
      const seen = new Set<string>();
      for (const vuln of asArray(pkg.vulnerabilities)) {
        if (!isRecord(vuln)) continue;
        const id = text(vuln.id) ?? 'sem-regra';
        seen.add(id);
        const specific = isRecord(vuln.database_specific) ? vuln.database_specific : {};
        const ecosystem = isRecord(vuln.ecosystem_specific) ? vuln.ecosystem_specific : {};
        drafts.push({
          rule: id,
          cwe: cweToken(specific.cwe_ids ?? specific.cweIds ?? specific.cwe ?? vuln.cwe, true),
          file,
          line: null,
          severity: mapSeverity(specific.severity ?? ecosystem.severity ?? (typeof vuln.severity === 'string' ? vuln.severity : null)),
          snippet: [label, id, text(vuln.summary)].filter(Boolean).join(' '),
          pkg: pkgId,
        });
      }
      for (const group of asArray(pkg.groups)) {
        if (!isRecord(group)) continue;
        const id = asArray(group.ids).map(text).find((item): item is string => !!item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        drafts.push({
          rule: id,
          cwe: cweToken(group.cwe ?? group.cwes, true),
          file,
          line: null,
          severity: mapSeverity(group.max_severity ?? group.maxSeverity ?? group.severity),
          snippet: `${label} ${id}`,
          pkg: pkgId,
        });
      }
    }
  }
  return drafts;
}

function readVuln(row: Record<string, unknown>, parentFile: string | null, parentType: unknown = null): Draft {
  const nested = isRecord(row.vulnerability) ? row.vulnerability : null;
  const artifact = isRecord(row.artifact) ? row.artifact : null;
  const location = artifact ? asArray(artifact.locations).find(isRecord) : undefined;
  const id = text(row.VulnerabilityID) ?? text(row.vulnerabilityID) ?? (nested ? text(nested.id) ?? text(nested.VulnerabilityID) : null) ?? 'sem-regra';
  const name = text(row.ArtifactName) ?? text(row.PkgName) ?? text(row.pkgName) ?? (artifact ? text(artifact.name) : null);
  const detail = text(row.Title) ?? text(row.title) ?? text(row.Description) ?? text(row.description) ?? (nested ? text(nested.description) ?? text(nested.summary) : null);
  const pkgName = text(row.PkgName) ?? text(row.pkgName) ?? (artifact ? text(artifact.name) : null) ?? text(row.ArtifactName);
  const pkgVersion = text(row.InstalledVersion) ?? text(row.installedVersion) ?? (artifact ? text(artifact.version) : null);
  const pkgType = text(row.Type) ?? text(row.type) ?? (artifact ? text(artifact.type) : null) ?? text(parentType);
  return {
    pkg: packageIdentity(pkgType, pkgName, pkgVersion),
    rule: id,
    cwe: cweToken(row.CweIDs ?? row.cweIDs ?? row.CWE ?? row.cwe ?? row.cwes, true) ?? (nested ? cweToken(nested.cwes ?? nested.CweIDs ?? nested.cwe, true) : null),
    file: text(row.Target) ?? text(row.target) ?? (location ? text(location.path) : null) ?? parentFile,
    line: lineOf(row.StartLine ?? row.startLine ?? row.line ?? row.Line),
    severity: mapSeverity(row.Severity ?? row.severity ?? nested?.severity ?? nested?.Severity),
    snippet: [name, id, detail].filter(Boolean).join(' '),
  };
}

function hasVulnId(row: Record<string, unknown>): boolean {
  return !!(text(row.VulnerabilityID) || text(row.vulnerabilityID) || isRecord(row.vulnerability));
}

function parseVulnReport(body: unknown): Draft[] {
  if (!isRecord(body)) return [];
  const drafts: Draft[] = [];
  for (const match of asArray(body.matches)) {
    if (isRecord(match)) drafts.push(readVuln(match, null));
  }
  for (const result of asArray(body.Results ?? body.results)) {
    if (!isRecord(result)) continue;
    const parent = text(result.Target) ?? text(result.target);
    const vulns = asArray(result.Vulnerabilities ?? result.vulnerabilities).filter(isRecord);
    if (vulns.length > 0) {
      for (const vuln of vulns) drafts.push(readVuln(vuln, parent, result.Type ?? result.type));
      continue;
    }
    if (hasVulnId(result)) drafts.push(readVuln(result, parent, null));
  }
  return drafts;
}

function parseSemgrep(body: unknown): Draft[] {
  const rows = Array.isArray(body) ? body : isRecord(body) ? asArray(body.results) : [];
  const drafts: Draft[] = [];
  for (const result of rows) {
    if (!isRecord(result)) continue;
    const extra = isRecord(result.extra) ? result.extra : {};
    const start = isRecord(result.start) ? result.start : {};
    drafts.push({
      rule: text(result.check_id) ?? text(result.checkId) ?? 'sem-regra',
      cwe: cweToken(isRecord(extra.metadata) ? extra.metadata.cwe ?? extra.metadata.CWE ?? extra.metadata.cwe_ids : null, true),
      file: text(result.path),
      line: lineOf(start.line ?? result.line),
      severity: mapSeverity(extra.severity ?? result.severity),
      snippet: [text(extra.message), text(extra.lines)].filter(Boolean).join(' ') || 'achado',
    });
  }
  return drafts;
}

function parseHadolint(body: unknown): Draft[] {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.issues) ? body.issues : isRecord(body) ? [body] : [];
  const drafts: Draft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (!text(row.code) && !text(row.file) && !text(row.message) && !text(row.level)) continue;
    drafts.push({
      rule: text(row.code) ?? text(row.rule) ?? 'sem-regra',
      cwe: cweToken(row.cwe ?? row.CWE, true),
      file: text(row.file),
      line: lineOf(row.line),
      severity: mapSeverity(row.level ?? row.severity),
      snippet: text(row.message) ?? text(row.code) ?? 'achado',
    });
  }
  return drafts;
}

function parseCheckov(body: unknown): Draft[] {
  const reports = Array.isArray(body) ? body : [body];
  const drafts: Draft[] = [];
  for (const report of reports) {
    if (!isRecord(report)) continue;
    const results = isRecord(report.results) ? report.results : report;
    for (const check of asArray(results.failed_checks)) {
      if (!isRecord(check)) continue;
      const range = Array.isArray(check.file_line_range) ? check.file_line_range[0] : null;
      drafts.push({
        rule: text(check.check_id) ?? 'sem-regra',
        cwe: cweToken(check.cwe ?? check.CWE, true),
        file: text(check.file_path) ?? text(check.file_abs_path) ?? text(check.filePath),
        line: lineOf(range),
        severity: mapSeverity(check.severity ?? check.Severity),
        snippet: text(check.check_name) ?? text(check.check_id) ?? 'falha',
      });
    }
  }
  return drafts;
}

function sarifMessage(result: Record<string, unknown>): string | null {
  if (typeof result.message === 'string') return text(result.message);
  if (!isRecord(result.message)) return null;
  return text(result.message.text) ?? text(result.message.markdown);
}

function firstLocation(result: Record<string, unknown>): {file: string | null; line: number | null; snippet: string | null} {
  for (const location of asArray(result.locations)) {
    if (!isRecord(location) || !isRecord(location.physicalLocation)) continue;
    const physical = location.physicalLocation;
    const artifact = isRecord(physical.artifactLocation) ? physical.artifactLocation : null;
    const uri = artifact ? text(artifact.uri) : null;
    if (!uri) continue;
    const region = isRecord(physical.region) ? physical.region : null;
    const snippet = region && isRecord(region.snippet) ? text(region.snippet.text) : null;
    return {file: fileFromUri(uri), line: region ? lineOf(region.startLine) : null, snippet};
  }
  return {file: null, line: null, snippet: null};
}

function parseSarif(body: unknown): Draft[] {
  if (!isRecord(body)) return [];
  const drafts: Draft[] = [];
  for (const run of asArray(body.runs)) {
    if (!isRecord(run)) continue;
    for (const result of asArray(run.results)) {
      if (!isRecord(result)) continue;
      const located = firstLocation(result);
      drafts.push({
        rule: text(result.ruleId) ?? text(result.ruleID) ?? ruleIdFromIndex(run, result.ruleIndex) ?? 'sem-regra',
        cwe: cweFromResult(result, run),
        file: located.file,
        line: located.line,
        severity: mapSeverity(result.level),
        snippet: [sarifMessage(result), located.snippet].filter(Boolean).join(' ') || 'achado',
      });
    }
  }
  return drafts;
}

function parseJsonTool(tool: string, body: unknown): Draft[] {
  const name = tool.toLowerCase();
  if (name.includes('gitleaks')) return parseGitleaks(body);
  if (name.includes('osv')) return parseOsv(body);
  if (name.includes('hadolint')) return parseHadolint(body);
  if (name.includes('checkov')) return parseCheckov(body);
  if (name.includes('opengrep') || name.includes('semgrep')) return parseSemgrep(body);
  if (name.includes('grype') || name.includes('trivy') || name.includes('syft')) return parseVulnReport(body);
  return [];
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body) as unknown; } catch { return null; }
}

export function normalizeToolOutput(parts: readonly {tool: string; format: 'sarif' | 'json'; body: unknown}[]): {findings: RawFinding[]; rejected: number} {
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const part of parts) {
    const tool = (typeof part.tool === 'string' && part.tool.trim()) ? part.tool.trim().slice(0, 40) : 'ferramenta';
    const body = parseBody(part.body);
    const drafts = part.format === 'sarif' ? parseSarif(body) : parseJsonTool(tool, body);
    for (const draft of drafts) {
      const finding = materialize(tool, draft);
      if (!finding) {
        rejected += 1;
        continue;
      }
      if (seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      findings.push(finding);
    }
  }
  return {findings, rejected};
}
