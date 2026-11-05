# R6 — retomada e integração

Retomada solicitada pelo usuário. Base `35635ebb`, branch `continuation/cursor-20261104`. HEAD e alterações locais foram conferidos antes de editar. `AGENTS.md`, `.codex/` e `test.txt` preexistentes permanecem preservados. Principal Sol 6.1 confirmado; nenhuma ferramenta permite mudar seu esforço. Cinco chamadas nativas Terra 6.1/Médio foram aceitas e `list_agents` confirmou a equipe; nenhum Paseo foi utilizado.

| Agente efetivamente iniciado | Worktree / branch | Responsabilidade |
| --- | --- | --- |
| `/root/r6_runtime` | `/tmp/ac-r6-runtime`, `r6/20261105/runtime` | T30, bootstrap e comandos explícitos de laboratório |
| `/root/r6_security` | `/tmp/ac-r6-security`, `r6/20261105/security`; integração `security-current` | RNF08, gate Git e composição do fluxo |
| `/root/r6_mobile` | `/tmp/ac-r6-mobile`, `r6/20261105/mobile` | Grafo, cartões e projeção real T35 |
| `/root/r6_audit` | `/tmp/ac-r6-audit`, `r6/20261105/audit` | Matriz111 e percurso RF03 |
| `/root/r6_review` | `/tmp/ac-r6-review`, `r6/20261105/review` | Revisão independente, sem autoria de código |

Os agentes R5 não estavam vivos nesta retomada. As referências Git sobreviveram; worktrees antigas de `/tmp` estavam ausentes. Dependências temporárias não são evidência durável: Node22 glibc foi novamente disponibilizado em `/tmp/node-v22.23.3-linux-x64`. Não se usou o Node musl copiado para `/tmp/ac-r6-node22`, incompatível com este host.

## Integrado nesta retomada

- `5e512853`: gateway autenticado de grafos, rotas exatas antes de selecionar runtime. Teste focal anterior1/1 e typecheck versionados; revisão independente `fce6a4ce` delimita que não constitui jornada browser/server-main integral.
- `dafed963` até `28a333e7`: alterações móveis R5 restantes, ACK perdido/reload com mesma intenção, catálogo legado e identidade do descritor, T22 e negativos091. `4fa83c65`/`a72116d0`/`686ecab0`: hooks nativos T22. Não houve nova execução das provas verdes anteriores.
- `1f4336a1` até `cd415eb0`: todos os pareceres R5 e auditoria111, incluindo logs independentes T30 exatos `20906934`. Foram cherry-picked somente commits documentais; não se fez merge global de branch antiga.
- T30: sequência explícita de20 commits de `dc7d0874` até `56dd3800`, integrada de `51370b3b` a `d47b8e87`. Bootstrap `102414b9` → `e9a1b514`, revisão `230fa5b3`. No conflito de supervisor foram preservados tanto `assertModelAllowed` quanto `requireRecoveryInventory` antes de efeitos. A revisão confirmou essa composição. Catálogo deve ser provisionado antes dos efeitos e do backup; custódia externa continua precondição, sem promessa contra rollback arbitrário pelo administrador do host.
- Matriz `5336e143` → `a7af4a98`:111 registros JSON/CSV equivalentes;22 aceites delimitados, incluindo T21 por log e revisão versionados. Demais critérios continuam individualizados. Não é100%.
- RNF08 `c8643b73` → `6dccfbbe`: snapshots cifrados, registro dos segredos conhecidos, redação de saída/log, gate dos objetos Git antes de registrar artefato e retirada do writer após recusa. Prova física negativa nova1/1: credencial sintética colocada realmente no objeto Git, zero artefatos, target intacto, acesso retirado; logs negativos de setup preservados. Revisor confirmou preservação T30/T22, sem promover a RNF08 integral.

## Trabalho em andamento

`r6_runtime`: CLI opt-in `6e07eee6` ainda em revisão e teste integrado; backup exposto é explicitamente de laboratório, sem migração operacional. `r6_security`: composição do worker CLI determinístico real com os mesmos estado/conversa/artefato/vault/export. `r6_mobile`: cartões `24644ec7` e idade da recepção da projeção `a7fe548e`, ainda requerem revisão e jornada física real durante suspensão/reconexão/correção. `r6_audit`: duas intenções na mesma conversa, com contas/modelos/imagens compatíveis diferentes, sem fingir suporte a outro provedor. Principal: conversor tipado do intercâmbio offline histórico, recusando versões desconhecidas; não leitor de banco Paseo operacional.

Os slots físicos são coordenados para evitar colisões e OOM; preparação, leitura e testes leves permanecem paralelos. Serviços preexistentes não são laboratório. O PG R5 descrito anteriormente não deve ser presumido vivo; qualquer recurso novo precisa de identificação/label e limpeza própria. Sem contas reais, APIs pagas, deploy, migração operacional ou alteração do Paseo.

Esta é continuidade ativa, não encerramento da missão. Não confundir componente testado com requisito aceito, nem lacuna de integração executável com dependência externa.
