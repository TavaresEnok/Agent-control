# Regras do Agent Control

Só regras vigentes. Regra nova do titular substitui a antiga no mesmo lugar, sem empilhar seção nem histórico. Ordens, relatórios e progresso de rodadas encerradas ficam fora do repositório, em `/home/app/arquivo-agent-control/`, e no histórico do git. O teste `tests/agents-rules.test.ts` confere este arquivo.

## Papéis (valem para qualquer projeto)

- **Gerente:** uma sessão só. Escreve as ordens, distribui o trabalho e junta os ramos. Roda a suíte completa (`node scripts/test-ci.mjs`) e as provas Docker localmente, aplica na instalação viva com backup e mantém o progresso do projeto. Não cria outros gerentes.
- **Trabalhadores:** escrevem código, cada um no seu worktree, com itens que não tocam os mesmos arquivos. Por padrão, um trabalhador por vez, com esforço `medium`. Mais trabalhadores ou esforço `high` só a pedido do titular.
- **Revisor:** só leitura. Recebe a ordem e o diff, nunca a conclusão do autor, e roda só os testes do diff. No máximo 2 rodadas de revisão por item. Depois disso, o gerente julga e registra o que sobrar como ressalva.
- **Examinador dos módulos:** sempre pelo caminho do produto (`personal:verify`, `personal:design`).
  - Esforço `high` nos módulos 1 (segurança), 5 (banco) e 9 (LGPD e licenças); `medium` nos demais.
  - Achado alto ganha segunda opinião do Opus 5.5 `medium`, em outra sessão.
  - Design (módulo 10): Opus 5.5, com `economy.designEffort` por projeto (padrão `high`). O modo `criar` usa `high`.

## Modelos

- Use só modelos com cota, do mais barato ao mais caro. Erro de cota (429, limite de uso, 402) passa para o próximo da fila.
- A fila padrão é Claude Code no login dedicado da conta Max (`CLAUDE_CONFIG_DIR=/home/app/.claude-trabalhadores/enok`):
  - correções comuns: Sonnet 5.5 `high`;
  - correções graves (segurança, banco, arquitetura): Opus 5.5 `medium`.
- Os modelos do Antigravity (`agy`) entram antes do Claude quando a conta tiver cota. O Codex fica desligado até o titular reativar. O Grok foi retirado e não volta para a fila.
- **Front-end:** qualquer `web/`, `upstream/cezar/packages/web` e telas são escritos só por Claude Opus 5.5 ou Fable 5.2.
  - Antes de integrar um ramo, confira `git diff --name-only` nessas pastas.
  - Front-end escrito por outro modelo é desfeito e refeito.
- Não troque de modelo em silêncio.
- Os logins dos trabalhadores ficam só em `/home/app/.claude-trabalhadores/<conta>` e em `HOME=/home/app/.agy-<conta>`. Nunca use as contas da instalação viva.
- O trailer do commit segue o modelo que escreveu, por exemplo `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Execução sem loops nem esperas cegas

- **Espera:** use `npm run personal:status -- <instalação> <exame> --esperar`, ou espere pelo PID gravado no andamento do exame. Nunca use laços com `pgrep -f`, que casam com o próprio laço.
- **Logs:** leia só o fim (`tail -n 40`).
- **Progresso real:** confira os jobs longos pelos códigos de falha. Sem progresso em 30 minutos, pare e investigue. O disjuntor do produto para o exame depois de 3 falhas iguais de infraestrutura.
- **Queda do Docker:** depois dela, confira `ac-provider-egress`, `ac-personal-pg` e `ac-design-registry`. Todos têm `restart unless-stopped`.
- **Mudança mínima:** reaproveite o que o projeto e a biblioteca padrão já oferecem. Não acrescente dependência nem abstração que a tarefa não peça, e não retire validação, segurança nem teste.
- **Projeto encerrado não é reaberto.** Se uma aprovação for ambígua sobre o projeto, pergunte ou aplique ao projeto atual.

## Cota

- Registre o erro de cota na hora, no progresso do projeto, com a palavra `COTA`.
- Nunca compre créditos. Se todos os modelos estiverem sem cota, espere e tente de novo a cada 15 minutos, adiantando o que não depende disso.
- Prioridade da conta Max: examinador, depois gerente, depois revisor, depois trabalhadores.

## Disco

- **Orçamento:** o Agent Control sem projetos usa no máximo `storage.budgetGB` (20 GB). Isso inclui:
  - repositório e worktrees;
  - dados da instalação e temporários;
  - backups;
  - imagens e volumes Docker do AC;
  - logins dos trabalhadores.
- **Medição:** `npm run personal:espaco -- <instalação>`. Acima do orçamento, novos exames e trabalhadores são recusados (`PERSONAL_SPACE_BUDGET_EXCEEDED`).
- **Disco inteiro:** alerta a partir de 90% e bloqueio a partir de 95%.
- **Retenção:** é automática (`retention.automatic`), por timer próprio, e remove:
  - pastas de job terminadas;
  - worktrees integrados e parados (o ramo fica);
  - temporários `/tmp/ac-*` antigos;
  - imagens sem pin nem uso;
  - contêineres e volumes rotulados do AC;
  - versões antigas das bases de vulnerabilidade;
  - backups além dos 3 mais recentes.
- **Imagens:** só saem por ID, depois de conferir os pins (`deploy/modules/*/digest.txt`, `deploy/design-image-digest.txt` e `nativeBootstrap`). Volume sem rótulo do AC nunca é removido.
- **Imagem candidata:** registre logo depois do build, com `personal:maintenance -- <instalação> --registrar-imagem --projeto <id> --modulo <módulo> --imagem <sha256:id>`.
- **Projeto encerrado:** retire com `npm run personal:project -- --remover <instalação> <id> --apagar-dados --sim`. O repositório do projeto nunca é apagado.

## Instalação viva

- Faça backup antes de qualquer mudança (`personal:backup`, que já roda o restore-check).
- **Atualização:** `npm run personal:update -- <instalação>`. Ela aplica as migrações (`initialize`) antes de reiniciar o gateway. Com migração pendente, o gateway sai com o código 78 e não reinicia em ciclo.
- **Painel:** construa só com `npm run personal:painel`. Faça primeiro numa pasta temporária, confira as páginas e guarde a cópia do `dist` anterior fora do repositório.

## Git

- Nada de push sem o sim do titular. Servidores de origem e instalações publicadas de projetos externos não são alterados.
- Commits locais usam a identidade local configurada pelo titular (e-mail `migration@localhost`).
- Testes não escrevem em arquivos versionados. A guarda de `scripts/test-ci.mjs` falha se a suíte sujar o repositório ou deixar temporários.

## Autonomia

- Decida as dúvidas com um padrão razoável e informe o que decidiu.
- Um plano aprovado vai até a aplicação na instalação viva, na mesma execução.
- Pare só para o que exige o titular: sudo, créditos ou credencial real.

## Documentação viva

- Raiz e `docs/`: `README.md`, `docs/USO-PESSOAL.md`, `docs/MODULOS-DE-VERIFICACAO.md`, `docs/RETENCAO-ARTEFATOS.md`, `docs/REVISAO-SEGURANCA-EXTERNA.md` e `docs/ESTADO.md`.
- Subpastas de `docs/`: `normative/`, `operations/`, `architecture/`, `contracts/`, `economia/` e `validation/`.
- **Projeto em andamento:** o progresso fica em `docs/projetos/<projeto>/PROGRESSO.md`. Ao encerrar o projeto, ele vai para o arquivo histórico.
