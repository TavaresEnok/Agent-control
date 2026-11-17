# Ordem para o Grok — módulo 10, design e experiência de uso

Escrita pelo gerente (Claude) em 17/11/2026. Execução sem tela, `grok-4.7`, esforço **alto**, até **8 subagentes simultâneos**. Prioridade do titular: **rapidez**, sem perder prova.

Leia primeiro: `AGENTS.md`, `docs/MODULOS-DE-VERIFICACAO.md` (seções "Como todo módulo funciona" e "10. Design e experiência de uso").

Você está no worktree `/home/app/projects/agent-control-design`, ramo `task/modulo-design`. Trabalhe só aqui.

## Ao mesmo tempo, em outro worktree

Outro Grok está construindo o módulo 1 (validador de segurança) em `/home/app/projects/agent-control-validador`. Ele cria o esqueleto comum, ainda sem commit: `src/verify-types.ts`, `src/verify-report.ts`, `src/verify-runtime.ts`, `src/verify-remediate.ts`, `src/verify-api.ts`, `db/migrations/101_security_verification.sql` e a tela do painel.

- **Leia** esses arquivos (só leitura) para usar os mesmos formatos de achado, relatório, cobertura e correção.
- **Não os copie nem os edite.** Os dois ramos vão ser unidos depois pelo gerente.
- Faça o seu código em arquivos próprios `src/design-*.ts`, `deploy/Dockerfile.design`, `tests/design-*.test.ts`, `tests/fixtures/design-lab/`.
- Defina um ponto de encaixe pequeno e documentado (`src/design-module.ts`), com uma função que recebe o projeto e a URL e devolve achados no formato do módulo 1.
- Não crie migração com o número 101.

## O que entregar

1. **Imagem de design** (`deploy/Dockerfile.design`):
   - a partir da imagem oficial do Playwright, por digest;
   - com axe-core, pa11y, Lighthouse CI, `@projectwallace/css-analyzer` e Stylelint, com versões fixas e lockfile;
   - roda sem root e com limites;
   - a rede só alcança a URL de homologação declarada; reuse a ideia da rede restrita do módulo 1.
2. **Descoberta de telas:**
   - lê as rotas do código (React Router, Next, Vue, Flutter web quando houver);
   - navega a partir da URL inicial pelo Playwright;
   - aceita login de teste vindo do pedido, sem gravar a senha;
   - gera a lista de telas e a tabela de cobertura.
3. **Capturas:**
   - cada tela em 375, 768 e 1440 px, em tema claro e escuro quando existir;
   - estados forçados quando possível: vazio, carregando e erro;
   - página inteira, em PNG.
4. **Coleta automática por tela:**
   - axe-core (WCAG 2.2 AA) e pa11y;
   - navegação só por teclado: ordem do foco e foco visível;
   - inventário de cores, fontes, tamanhos, espaçamentos, raios e sombras a partir dos estilos computados e do css-analyzer;
   - Stylelint nos arquivos de estilo;
   - Lighthouse por tela.

   Tudo isso vai num `achados-brutos.json` no formato do módulo 1.
5. **Exame por IA, tela a tela.** Um examinador multimodal recebe as capturas, o código da tela e os dados coletados, e aplica a lista de verificação.
   - **A lista** vai em `src/design-checklist.ts`, versionada. Ela cobre:
     - heurísticas de Nielsen e leis de UX;
     - WCAG 2.2;
     - consistência com os tokens;
     - estados esquecidos;
     - textos da interface;
     - telas pequenas.
   - **Base da lista:** leia as skills `design-critique`, `accessibility-audit`, `design-elevation`, `ux-writing` e `frontend-design`. Elas estão em `/home/app/.agent-control/ispagent/accounts/*/plugins/` (só leitura: não copie credenciais nem outros arquivos dessa pasta).
   - **O caminho de execução** é o worker pessoal com papel `specialist`, e o verificador é de outro provedor, como no módulo 1. Cada achado traz:
     - a captura com a área marcada (desenhe o retângulo com o próprio Playwright ou com sharp);
     - a regra violada;
     - a correção com valores concretos.
6. **Relatório** em `<dataDirectory>/verificacoes/<projectId>/<AAAAMMDD-HHMMSS>-design/`, no formato do módulo 1, mais a pasta `capturas/`. As permissões são 0700 para as pastas e 0600 para os arquivos.
7. **Régua.** Crie `tests/fixtures/design-lab/`, um app pequeno com defeitos plantados:
   - contraste baixo;
   - botão sem rótulo;
   - foco invisível;
   - 9 tons de cinza diferentes;
   - espaçamento inconsistente;
   - estado vazio ausente;
   - layout quebrado em 375 px;
   - texto cortado.

   Ele também precisa de 2 telas corretas que não podem gerar achado alto. O teste mede: cada defeito plantado aparece; as telas corretas ficam limpas.
8. **Rodar de verdade** no painel do próprio Agent Control (`upstream/cezar/packages/web`), servido localmente a partir do build, e gravar o resumo em `docs/validation/verificacao-design-painel.md`. O resumo leva capturas sem dado pessoal e não leva segredos.

## Como trabalhar com os subagentes

- Divida já, por exemplo:
  - imagem;
  - descoberta e capturas;
  - acessibilidade e teclado;
  - inventário visual e Stylelint;
  - Lighthouse;
  - lista e examinador;
  - relatório e marcação de captura;
  - régua.
- Até 8 ao mesmo tempo. Dois subagentes nunca editam o mesmo arquivo.
- O principal integra e roda a suíte.
- Notas compartilhadas vão em `.grok-notas/`. Apague a pasta antes do último commit.

## Regras

- O modo `locked` não muda. Tudo vale só para `activation:"personal"`.
- Não toque na instalação viva: `/home/app/.agent-control/` (exceto ler as skills, como dito acima), o gateway, o banco `ac_ispagent` e o contêiner `ac-personal-pg`. Não reinicie serviços.
- Não mexa no worktree `agent-control-validador`, nem nos projetos em `/home/app/projects/` além deste worktree.
- Nada de push, merge, `--force` ou reescrita de histórico. É proibido comprar crédito ou usar chave de API paga.
- Faça um commit por passo concluído, com testes:
  - identidade: `git -c user.name="Enok Tavares" -c user.email="migration@localhost" commit`;
  - a mensagem termina com `Co-Authored-By: Grok 4.7 <noreply@x.ai>`.
- Antes de cada commit, rode `npm run typecheck` e `umask 022 && npm test`. O `AC_TEST_DATABASE_URL` já está no ambiente. Os testes com Docker ou navegador real entram na lista de laboratório de `scripts/test-ci.mjs` e rodam à parte. Diga quais rodou e com que resultado.
- Se travar, não finja. Registre e siga para o próximo passo independente.

## Ao terminar

Escreva `docs/RELATORIO-GROK-DESIGN.md` com:

- o que foi feito em cada passo e o commit;
- os testes e os números reais;
- o que ficou de fora;
- os riscos.

Faça o commit desse relatório.
