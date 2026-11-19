import {moduleExamCall, scanModuleExamSource} from './module-exam-syntax.ts';

export type SourceAnchor = {column: number; expression: string};
type Tokens = NonNullable<ReturnType<typeof scanModuleExamSource>>;

export function sourceLine(source: string, line: number) {
  return source.split('\n')[line - 1]?.trim() ?? '';
}

function anchorOnLine(source: string, line: number, start: number, end: number): SourceAnchor | null {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const rawLine = source.split('\n')[line - 1] ?? '';
  const text = rawLine.trim();
  const expression = source.slice(start, end);
  const column = start - lineStart - (rawLine.length - rawLine.trimStart().length) + 1;
  return column > 0 && expression && !/[\r\n]/u.test(expression) && text.slice(column - 1, column - 1 + expression.length) === expression
    ? {column, expression} : null;
}

/** Use the complete source when the subset accepts it. A complete lexical prefix
 * is enough for a local observation if later syntax is outside that subset. */
function scriptLine(source: string, line: number, complete = false) {
  if (!/\S/u.test(sourceLine(source, line))) return null;
  const tokens = scanModuleExamSource(complete ? source : source.split('\n').slice(0, line).join('\n'));
  if (!tokens) return null;
  return {tokens, anchor: (start: number, end: number) => {
    const first = tokens[start];
    const last = tokens[end];
    return first?.line === line && last?.line === line ? anchorOnLine(source, line, first.start, last.end) : null;
  }};
}

export function functionAnchor(source: string, line: number, exported: boolean) {
  const script = scriptLine(source, line);
  if (!script) return null;
  const {tokens, anchor} = script;
  const start = tokens.findIndex(token => token.line === line);
  if (start < 0) return null;
  let depth = 0;
  for (const token of tokens.slice(0, start)) {
    if (token.text === '{') depth++;
    if (token.text === '}') depth--;
  }
  if (depth !== 0) return null;
  let index = start;
  if (tokens[index]?.text === 'export') index++;
  else if (exported) return null;
  if (tokens[index]?.text === 'async') index++;
  const name = tokens[index + 1];
  const args = moduleExamCall(tokens, index + 2);
  if (tokens[index]?.text !== 'function' || name?.kind !== 'word' || !args) return null;
  const after = tokens.slice(args.close + 1).map(token => token.text).join(' ');
  if (!/^(?:\{|: [\w$.[\] |&]+ \{)(?: |$)/u.test(after)) return null;
  const located = anchor(start, args.close);
  return located && {anchor: located, name: name.text, offset: tokens[start]!.start};
}

export function singleScriptCallAnchor(source: string, line: number,
  findOpen: (tokens: Tokens, index: number) => number | null) {
  const tokens = scanModuleExamSource(source);
  if (!tokens) return null;
  const candidates = tokens.flatMap((token, index) => {
    if (token.line !== line) return [];
    const open = findOpen(tokens, index);
    const call = open === null ? null : moduleExamCall(tokens, open);
    if (open === null || !call || call.close <= open + 1) return [];
    const close = tokens[call.close]!;
    const endOfLine = source.indexOf('\n', token.start);
    const lineEnd = endOfLine < 0 ? source.length : endOfLine;
    const end = token.start + source.slice(token.start, Math.min(lineEnd, close.end)).trimEnd().length;
    const anchor = anchorOnLine(source, line, token.start, end);
    return anchor ? [{anchor, expression: source.slice(token.start, close.end), lastLine: close.line}] : [];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export function singleScriptAnchor(source: string, line: number,
  findEnd: (tokens: Tokens, index: number) => number | null, complete = false): SourceAnchor | null {
  const script = scriptLine(source, line, complete);
  if (!script) return null;
  const {tokens, anchor} = script;
  const matches = tokens.flatMap((token, index) => {
    if (token.line !== line) return [];
    const end = findEnd(tokens, index);
    const found = end === null ? null : anchor(index, end);
    return found ? [found] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

type JsonMember = {path: string[]; line: number; start: number; keyEnd: number; valueEnd: number};

/** Name and offset must come from the same JSON member. Reject duplicate keys
 * so a printed declaration cannot disagree with the value JSON.parse sees. */
export function jsonMembers(source: string) {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  const scanned = scanModuleExamSource(source);
  if (!scanned) return null;
  const tokens = scanned;
  const members: JsonMember[] = [];
  let at = 0;
  function walk(path: string[]): boolean {
    if (path.length > 40) return false;
    const start = tokens[at]?.text;
    if (start === '{' || start === '[') {
      const close = start === '{' ? '}' : ']';
      const seen = new Set<string>();
      let index = 0;
      at++;
      while (tokens[at]?.text !== close) {
        const key = tokens[at];
        if (!key) return false;
        const name: string = start === '{' ? JSON.parse(key.text) : String(index++);
        if (seen.has(name)) return false;
        seen.add(name);
        if (start === '{') at += 2;
        const next = [...path, name];
        if (!walk(next)) return false;
        if (start === '{') members.push({path: next, line: key.line, start: key.start,
          keyEnd: key.end, valueEnd: tokens[at - 1]!.end});
        if (tokens[at]?.text === ',') at++;
      }
      at++;
    } else {
      while (at < tokens.length && ![',', '}', ']'].includes(tokens[at]!.text)) at++;
    }
    return true;
  }
  return walk([]) && at === tokens.length
    ? {value, members, anchor: (member: JsonMember, keyOnly = false) =>
      anchorOnLine(source, member.line, member.start, keyOnly ? member.keyEnd : member.valueEnd)}
    : null;
}

/** Conservative PostgreSQL subset. Comments and string contents cannot supply
 * keywords. Dollar quotes, backslash escapes and nested comments are omitted. */
export function sqlStatement(source: string, line: number) {
  const lex = /(?<trivia>\s+|--[^\n]*|\/\*(?:(?!\/\*|\*\/)[\s\S])*\*\/)|(?<text>'(?:[^'\\]|'')*'|"(?:[^"\\]|"")*"|[A-Za-z_][\w]*|\d+|[().,:;=+*<>!%/-])/gy;
  const statements: {tokens: string[]; start: number; end: number}[] = [];
  let tokens: string[] = [];
  let start = 0;
  let end = 0;
  for (let offset = 0; offset < source.length;) {
    lex.lastIndex = offset;
    const token = lex.exec(source);
    if (!token || token[0] === '/' && source[offset + 1] === '*') return null;
    offset = lex.lastIndex;
    if (token.groups!.trivia) continue;
    if (!tokens.length) start = token.index;
    tokens.push(token[0]);
    end = offset;
    if (token[0] === ';') {
      statements.push({tokens, start, end});
      tokens = [];
    }
  }
  if (tokens.length) statements.push({tokens, start, end});
  const matches = statements.filter(statement => source.slice(0, statement.start).split('\n').length === line);
  if (matches.length !== 1) return null;
  const statement = matches[0]!;
  return {tokens: statement.tokens, count: statements.length,
    lastLine: source.slice(0, statement.end).split('\n').length,
    anchor: (firstLineOnly = false) => {
      const lineEnd = source.indexOf('\n', statement.start);
      const end = firstLineOnly && lineEnd >= 0 ? Math.min(lineEnd, statement.end) : statement.end;
      const text = source.slice(statement.start, end).trimEnd();
      return anchorOnLine(source, line, statement.start, statement.start + text.length);
    }};
}
