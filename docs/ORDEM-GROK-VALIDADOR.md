# Ordem para o Grok — módulo 1, validador de segurança

Escrita pelo gerente (Claude) em 16/11/2026. Execução sem tela, `grok-4.7`, esforço **alto**, até **8 subagentes simultâneos**.

Leia antes de tudo: `AGENTS.md`, `docs/MODULOS-DE-VERIFICACAO.md` (o desenho; a seção "Plano do módulo 1" é o que você entrega), `docs/USO-PESSOAL.md` e `docs/REVISAO-SEGURANCA-EXTERNA.md`.

Você está no worktree `/home/app/projects/agent-control-validador`, ramo `task/validador-seguranca`. Trabalhe só aqui.

## O que entregar

Os passos 1.1 a 1.8 do plano do módulo 1. Em resumo:

1. **Imagem de verificação** (`deploy/Dockerfile.verify`): gitleaks, OSV-Scanner, Syft, Grype, Opengrep, Hadolint, Trivy e Checkov, cada um com versão fixa e checksum ou digest conferido no build (lembre o ataque ao Trivy de 03/2026: nada de `latest`). Bases de vulnerabilidade baixadas num passo separado e montadas só para leitura. O exame roda com `--network none`, checkout só leitura, sem login de conta, sem socket do Docker, usuário sem root, limites de memória, CPU e pids.
2. **Normalizador**: SARIF e JSON das ferramentas para um `achados-brutos.json` único (ferramenta, regra, CWE, arquivo, linha, gravidade, trecho curto sem segredo). Segredo encontrado nunca aparece inteiro em relatório nem em log: só os 4 primeiros caracteres e o hash.
3. **Pedido de verificação no runtime**, somente leitura: mapa do sistema e exame por fatias com o papel `specialist`, confirmação de cada achado por um `reviewer` de **outro provedor** que recebe o código e o achado, nunca a conclusão do examinador. Use o caminho pessoal dos workers que já existe (Claude, Grok, Codex) e a capacidade (`src/capacity.ts`). Nenhuma escrita no repositório examinado. Tabela de cobertura: cada arquivo do repositório com quem examinou e quais itens da lista foram aplicados.
4. **Lista de verificação** baseada no OWASP ASVS 5.0, OWASP Top 10:2025 e CWE Top 25, em arquivo versionado, aplicada por fatia.
5. **Relatório** em `<dataDirectory>/verificacoes/<projectId>/<AAAAMMDD-HHMMSS>-seguranca/` (0700, arquivos 0600) com `README.md`, `mapa.md`, `cobertura.md`, `achados/ACH-NNN.md`, `achados.json` e `bruto/`, no formato do documento. Rotas na API, atrás de `requireInstallationOwner`, e uma tela no painel (`upstream/cezar/packages/web`) para listar verificações e abrir os achados.
6. **Botão "Corrigir"**: os achados escolhidos viram pedidos normais ao gerente, com caminhos de escrita, teste de regressão exigido e critério de aceite. Depois da integração, nova verificação só dos pontos corrigidos: `fechado` ou `reaberto`.
7. **Homologação**: ZAP baseline, Schemathesis e Nuclei com tags escolhidas, numa rede Docker que só alcança a URL de homologação declarada no pedido. Teste que prova que outro host não é alcançado. Shannon e Strix: integre como adaptadores opcionais **só se** funcionarem com os logins de assinatura já existentes nas contas, sem chave de API paga. É proibido comprar crédito. Se não funcionarem assim, deixe desligado e explique no relatório final.
8. **Régua**: crie `tests/fixtures/verify-lab/`, um pequeno app com falhas plantadas (injeção SQL, segredo no histórico do git, rota sem autorização, dependência vulnerável, caminho com `..`, Dockerfile como root) e falsos positivos plantados. Teste que mede: cada falha plantada aparece `confirmado`, cada falso positivo aparece `descartado`. Depois rode o validador no próprio Agent Control e grave o resultado (sem segredos) em `docs/validation/verificacao-seguranca-agent-control.md`.

## Como trabalhar com os subagentes

- Divida o trabalho em partes independentes, por exemplo: imagem e ferramentas; normalizador; runtime e capacidade; lista e relatório; API e painel; homologação; régua. Até 8 ao mesmo tempo.
- Dois subagentes nunca editam o mesmo arquivo. Você, o principal, integra, resolve conflitos e roda a suíte inteira.
- Não duplique investigação: o primeiro subagente que mapear o runtime (como um pedido vira jobs, como o papel `specialist` é reservado, como o worker pessoal roda) escreve um resumo em `.grok-notas/runtime.md` para os outros lerem. Apague `.grok-notas/` antes do último commit.

## Regras

- Modo `locked` não muda. Tudo novo vale só para `activation:"personal"`.
- Não toque na instalação viva: `/home/app/.agent-control/`, o gateway `agent-control-gateway-ispagent`, o banco `ac_ispagent` e o contêiner `ac-personal-pg`, exceto bancos descartáveis criados e apagados pelos testes. Não reinicie serviços.
- Varredura ativa só contra alvos locais criados pelos testes. Nenhum host externo.
- Nada de `git push`, merge em outro ramo, `--force` ou reescrita de histórico. Não mexa em `docs/PROMPT-GROK-*.md` nem em `docs/PROXIMA-ORDEM.md`.
- Um commit por passo concluído, com testes. Identidade: `git -c user.name="Enok Tavares" -c user.email="migration@localhost" commit`, terminando a mensagem com `Co-Authored-By: Grok 4.7 <noreply@x.ai>`.
- Antes de cada commit: `npm run typecheck` e `umask 022 && npm test` (o banco de teste está em `AC_TEST_DATABASE_URL`, já definido no ambiente). Os testes que precisam de Docker real entram na lista de laboratório de `scripts/test-ci.mjs` e são rodados à parte; diga quais rodou e o resultado.
- Se um passo travar, não invente nem finja: registre o bloqueio e siga para o próximo passo independente.

## Ao terminar

Escreva `docs/RELATORIO-GROK-VALIDADOR.md`:

- o que foi feito em cada passo, com o commit;
- os testes e o resultado real (números);
- o que ficou de fora e por quê;
- os riscos que você vê.

Faça o commit dele. O gerente revisa tudo depois.
