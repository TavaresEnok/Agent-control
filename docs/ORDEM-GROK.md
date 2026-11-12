# Ordem para o Grok — Fase 7, parte B: correções da revisão independente

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto** (segurança).

---

Você é o programador do Agent Control. Dois revisores independentes leram o código das Fases 1 a 6. Os achados estão em `docs/implementation/REVISAO-CLAUDE-20261112.md`. Nenhum é alto.

Corrija **todos os itens da tabela "Achados a corrigir"** (S1 a S5 e P1 a P7), com a correção indicada em cada linha. Pontos do gerente:

- **S1:** as opções valem para todo `ssh`, `ssh-keyscan` (onde couber), clone, fetch e push. Atualize o teste que compara as opções.
- **S2:** o teste é obrigatório: confirmar o mesmo host:porta com outro usuário e uma chave diferente tem que dar `HOST_KEY_CHANGED` e manter o `known_hosts` intacto.
- **P1:** a rota HTTP `POST /api/v1/ac/personal/accounts` deixa de aceitar `authFile`. O campo é recusado pelo schema estrito. A CLI `account-add` continua aceitando.
- **P2:**
  - o limite passa a ser **por IP**, no máximo 5 erros por minuto por IP;
  - o IP vem do primeiro valor de `x-forwarded-for`, que o Caddy da instalação põe, ou do endereço da conexão;
  - mantenha um teto global alto: 100 erros por minuto;
  - o teste: um IP bloqueado não bloqueia outro.
- **P3:** crie um helper que exige dono do **projeto principal** (`config.project.id`, já disponível em `personalPanel`) e use-o nas rotas que mexem na instalação inteira:
  - pastas e projetos (criar e arquivar);
  - SSH;
  - push;
  - contas.

  As rotas de conversa continuam por projeto.
- **P7:** `src/server-main.ts` pode ser editado agora, só no `pairCodeLogin`.

## Testes

Um teste para S2 e um para P2. Para os outros, atualize os testes existentes que mudarem. Rode só os arquivos ligados.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `upstream/cezar/packages/web/src/`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode o gateway, o ssh nem o Docker.

## Regras

- Sem push. O modo `locked` não muda.
- Commits pequenos: um para S1 a S5, um para P1 a P3 e um para P4 a P7. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e, para cada achado, onde ficou a correção (arquivo:linha).
- O resultado do typecheck e dos testes.
- O que não conferiu.
