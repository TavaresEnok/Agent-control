export type IntrusionAdapter = {
  name: 'shannon' | 'strix';
  enabled: false;
  reason: string;
};

const adapters: readonly IntrusionAdapter[] = [
  {
    name: 'shannon',
    enabled: false,
    reason: 'A documentação pública da Shannon (keygraph.io/docs/how-to/ai-providers, seção Subscriptions, consultada em 16/11/2026) diz que a versão atual não aceita a assinatura do Claude Code. Esse caminho ficou só na 1.9.0, com `claude setup-token` e CLAUDE_CODE_OAUTH_TOKEN, e não com o arquivo ~/.claude/.credentials.json que o Agent Control importa. Codex e Grok por assinatura exigem um login separado do Pi em ~/.pi/agent/auth.json (SHANNON_USE_PI_AUTH=1), não ~/.codex/auth.json nem ~/.grok/auth.json. O caminho padrão continua sendo chave de API (SHANNON_AI_API_KEY, ou ANTHROPIC_API_KEY, OPENAI_API_KEY e XAI_API_KEY). Não dá para afirmar que a Shannon reutiliza o login de assinatura já usado pelo Agent Control sem chave paga.',
  },
  {
    name: 'strix',
    enabled: false,
    reason: 'A documentação oficial da Strix (docs.strix.ai, Quick Start e LLM Providers, consultada em 16/11/2026) pede LLM_API_KEY para OpenAI e Anthropic. Não há página que aceite ~/.claude/.credentials.json, ~/.grok/auth.json ou ~/.codex/auth.json. O README no GitHub descreve `strix auth login chatgpt` como um login próprio da Strix, separado do arquivo do Codex, e não documenta a assinatura do Grok. O modo `strix cloud` é outra conta e pode cobrar crédito. Sem prova de que a Strix usa os três logins de assinatura do Agent Control sem chave paga, o adaptador fica desligado.',
  },
];

export function intrusionAdapters(): readonly IntrusionAdapter[] {
  return adapters;
}
