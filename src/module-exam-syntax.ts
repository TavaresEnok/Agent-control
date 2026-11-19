type Token = {kind: 'word' | 'number' | 'literal' | 'punctuation'; text: string; start: number; end: number; line: number};

export const isModuleExamScript = (file: string) => /\.(?:[mc]?[jt]s)$/i.test(file);

// A small JS/TS lexical subset. Stop at ambiguous slash, JSX and interpolated
// templates rather than looking for declarations inside their contents.
export function scanModuleExamSource(code: string): Token[] | null {
  if (/\r(?!\n)|[\u2028\u2029]/u.test(code)) return null;
  const tokenPattern = /(?<trivia>\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<literal>"(?:[^"\\\r\n]|\\(?:\r?\n|[^\r\n]))*"|'(?:[^'\\\r\n]|\\(?:\r?\n|[^\r\n]))*'|`(?:[^`\\$]|\$(?!\{)|\\[\s\S])*`)|(?<word>[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)|(?<number>\d+)|(?<punctuation>=>|[{}()[\].,;:=?!&|%*+>~^@#…-])/uy;
  const tokens: Token[] = [];
  let start = code.startsWith('#!') ? (code.indexOf('\n') + 1 || code.length) : 0;
  let line = start && start < code.length ? 2 : 1;
  while (start < code.length) {
    tokenPattern.lastIndex = start;
    const match = tokenPattern.exec(code);
    if (!match) return null;
    const end = tokenPattern.lastIndex;
    const {trivia, literal, word, number} = match.groups!;
    if (!trivia) tokens.push({kind: literal ? 'literal' : word ? 'word' : number ? 'number' : 'punctuation',
      text: match[0], start, end, line});
    for (let index = start; index < end; index++) if (code[index] === '\n') line++;
    start = end;
  }
  return tokens;
}

export function isDirectIdentifier(tokens: Token[], index: number): boolean {
  return tokens[index]?.kind === 'word' && !['.', '#', 'new'].includes(tokens[index - 1]?.text ?? '');
}

const closes = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const closing = new Set(closes.values());

/** Depth before each token, including within arguments and callback bodies. */
export function moduleExamDepths(tokens: Token[]): number[] | null {
  const stack: string[] = [];
  const depths: number[] = [];
  for (const {text} of tokens) {
    depths.push(stack.length);
    const close = closes.get(text);
    if (close) stack.push(close);
    else if (closing.has(text) && stack.pop() !== text) return null;
  }
  return stack.length ? null : depths;
}

/** The matching close and the top-level argument separators for one call. */
export function moduleExamCall(tokens: Token[], open: number) {
  if (tokens[open]?.text !== '(') return null;
  const stack = [')'];
  const commas: number[] = [];
  for (let i = open + 1; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return {close: i, commas};
    } else if (closing.has(text)) {
      return null;
    } else if (text === ',' && stack.length === 1) {
      commas.push(i);
    } else {
      const close = closes.get(text);
      if (close) stack.push(close);
    }
  }
  return null;
}
