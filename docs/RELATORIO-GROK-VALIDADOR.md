# Relatório — validador de segurança (módulo 1)

Ramo `task/validador-seguranca`. Nada foi enviado a outro remoto, nada foi mesclado e o histórico não foi reescrito. A instalação viva não foi tocada.

Uma suíte e um `npm run typecheck` cobriram a árvore integrada antes dos commits. O TypeScript vê `src/**` inteiro no disco, então repetir a suíte a cada commit, sem mudança de código entre eles, não mudaria o resultado. O typecheck terminou com código 0. A suíte oficial, com `env -u NO_COLOR -u FORCE_COLOR` e `umask 022`, terminou com código 0: **182 passaram, 0 falharam, 83 ficaram de fora** (cerca de 608 s). A primeira passagem, antes de existir o bundle do painel e o boundary do Happier, tinha falhado só em `runtime.test.ts` e `workflow-runtime-bootstrap.test.ts`. Os dois passaram na passagem verde.

## Por passo

**1.1 Imagem.** Commit `9e72bfee`. `deploy/Dockerfile.verify` fixa Debian trixie-slim pelo digest `sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2` (bookworm não executa o Checkov 3.4.5, que pede GLIBC_2.38). As oito ferramentas têm versão e SHA-256; o build roda `sha256sum -c`. Opengrep 2.0.0 e Checkov 3.4.5 não publicam checksum: o hash foi calculado do asset oficial. O exame pede `--network none`, usuário `65532:65532`, checkout e bases só para leitura, sem socket, com memória, CPU e pids. A base de vulnerabilidade é outro passo (`verify-db-fetch.sh`), com rede, e não entra na imagem. Teste de unidade `verify-image.test.ts`: ok, 0 s, dentro da suíte. Laboratório `verify-image.lab.test.ts`, fora da suíte: 1 passou, 0 falhou, cerca de 23 s, na imagem `sha256:5fba4f7e8e345f5fc3f177038fb08be4eb57e2f4a3804e4c1a57243145e24d85`.

**1.2 Normalizador.** Commit `94f20983`. SARIF e JSON viram achados com ferramenta, regra, CWE, arquivo, linha, gravidade e trecho curto. Segredo aparece só com 4 caracteres e SHA-256. `collectToolFindings` lê só os nomes conhecidos do diretório de saída. `verify-normalize.test.ts` e `verify-collect.test.ts`: ok, 0 s.

**1.3 Runtime.** Commit `d52c2ce9`. A intenção `security-verify-readonly-v1` existe para a capacidade reservar `specialist` e `reviewer`. O Cezar não despacha essa intenção. O tick do Happier pula. O revisor é de outro provedor e recebe o arquivo e o achado, não a conclusão do examinador. Não há caminho de escrita. A prova do fluxo é um worker de bancada, não o supervisor nativo. `verify-runtime.test.ts`: ok, 3 s. O catálogo de workflow está em `workflow-versioning.test.ts`: ok, 7 s.

**1.4 Lista.** Commit `2356e0c0`. 56 itens versionados: ASVS 5.0 capítulos V1–V17, OWASP Top 10:2025 A01–A10 e o CWE Top 25 de 2025, mais CWE-287 e CWE-798. A fatia tem no máximo 15 arquivos e não segue symlink para fora. `verify-checklist.test.ts` e `verify-slices.test.ts`: ok, 0 s.

**1.5 Relatório, API e painel.** Relatório em disco: commit `9b2580b2`. Diretório `0700`, arquivos `0600`, fora do git. `verify-report.test.ts`: ok, 1 s. Rotas e tela: commit `05692baf`, junto com o passo 1.6, porque o mesmo arquivo registra a lista e o pedido de correção e a mesma página mostra os dois. As rotas passam por `requireInstallationOwner` e só existem com painel pessoal. A tela `/verificacoes` entra no menu só quando `VITE_AGENT_CONTROL_MANAGED=1`. `verify-api.test.ts`: ok, 2 s. O typecheck do pacote web passou. O build `VITE_AGENT_CONTROL_MANAGED=1 npm run build:web` passou em 2,47 s e o bundle contém “Verificações”. Não há navegador nesta sessão: a tela não foi clicada.

**1.6 Corrigir.** Mesmo commit `05692baf`. O botão manda só achados `confirmado` ou `reaberto` para um pedido normal do gerente, com caminhos de escrita, teste `tests/seguranca/<achado>.test.ts` e o critério de aceite. A reverificação devolve `fechado` ou `reaberto`. A rota HTTP `reverificar` não é registrada em produção: `createApi` não injeta `deps.recheck`, porque não há worker de modelo no pedido. A função `recheckFindings` existe e o teste cobre. `verify-remediate.test.ts`: ok, 4 s.

**1.7 Homologação.** Commit `dcad315f`. O plano só aceita `http` ou `https` em `127.0.0.1`, `localhost` ou `*.local`. Outro host ou porto é `VERIFY_TARGET_ESCAPE`. Ferramentas previstas: ZAP baseline, Schemathesis em `/openapi.json` da mesma origem e Nuclei com tags `cve,exposure,misconfig`. `verify-dynamic.test.ts`: ok, 0 s. Laboratório `verify-dynamic.lab.test.ts`: 1 passou, 0 falhou, cerca de 2 s. O processo na rede interna alcançou só o encaminhador da URL declarada. O outro porto, no gateway e em loopback, não respondeu. A rede foi removida. Shannon e Strix ficam desligados: a documentação pública deles não aceita os arquivos de assinatura que o Agent Control já guarda (Claude, Grok, Codex). O caminho padrão é chave de API paga, e comprar crédito é proibido.

**1.8 Régua e o próprio Agent Control.** Commit `93d4787b`. O laboratório planta injeção SQL, rota sem autorização, caminho com `..`, Dockerfile como root, dependência minimist 0.0.8 e um segredo criado só no git temporário do teste. Os falsos positivos plantados saem `descartado`. `verify-ruler.test.ts`: ok, 4 s. O exame do produto está em `docs/validation/verificacao-seguranca-agent-control.md`. Foi a imagem do passo 1.1, sem rede, sobre `src`, `db`, `deploy`, `scripts`, `adapters` e os manifestos. Sem `.git`, sem `upstream`, sem `tests`. 35 achados normalizados, 0 rejeitados, nenhum segredo inteiro. O único alto é erro de parse do Hadolint no heredoc de `deploy/Dockerfile.verify`, não um `USER root` confirmado. Nenhum achado foi marcado `confirmado` e nenhum pedido de correção foi aberto.

## O que ficou de fora

- Revisão por Claude, Grok ou Codex na árvore do produto. O fluxo está provado com worker de bancada. Chamar os modelos usaria o login de assinatura e a instalação viva.
- Download das bases de vulnerabilidade. OSV-Scanner saiu 127 por falta da base offline e o Grype saiu 1 com JSON vazio. Achado de dependência deste exame está incompleto. O entrypoint trata 127 como ferramenta ausente, então o contêiner do autoexame saiu 1 mesmo com as outras ferramentas em 0.
- Rota HTTP de reverificação, pelo motivo do passo 1.6.
- Shannon e Strix, pelo motivo do passo 1.7.
- Clique no painel. Não há ferramenta de navegador aqui. O substituto foi o typecheck, o build e o teste da API.

## Riscos

- Opengrep e Checkov estão fixados por hash calculado, não por arquivo publicado pelo projeto.
- O Hadolint não entende o heredoc de download dentro de `Dockerfile.verify` e emite um alto que não é falha confirmada.
- Sem a base offline, dependência vulnerável não aparece no exame de ferramentas.
- A tela nova só existe no build com `VITE_AGENT_CONTROL_MANAGED=1`. O gateway em execução não foi reiniciado e continua servindo o bundle anterior.
- O modo `locked` não ganhou estas rotas. Tudo novo exige ativação pessoal.

## Rodada 2

Os passos 2 e 3 saíram no mesmo commit `3e8fb87b`. A rota do exame, a rota de reverificação e o supervisor nativo passam pelos mesmos arquivos (`src/server-main.ts`, `src/api.ts`, `src/verify-native-launch.ts`, `tests/verify-api.test.ts`). Separar os commits obrigaria a deixar um dos dois sem a ligação que o outro precisa. O mesmo critério já tinha juntado os passos 1.5 e 1.6 no commit `05692baf`.

**2.1 Bases.** Commit `77de7ce9`. A manutenção semanal chama a busca das bases. O carimbo fica em `<dataDirectory>/verify-db/<AAAAMMDD-HHMMSS>/`, com `manifest.json` (data e SHA-256 de cada arquivo) e `current.json` no modo `0600`. O entrypoint grava 0 quando a ferramenta existe e não há achado, e 127 só quando o binário não está. `verify-db.test.ts`: ok. A busca real, na instalação descartável, publicou o carimbo `20261117-025058` em 2026-11-17T02:50:58.086Z, manifesto `136886764a4f9f58737beaf2ee565e7716aaa6addaa7cdda89d89df280945c59`, 659 arquivos, 7 096 044 630 bytes. A imagem usada é `sha256:3b677f6f20a5fc0cb29044a3939a2d172ba59724a5532e79255ae5bdaf0670cb`.

A primeira imagem não completou a busca: o Java DB do Trivy não cabe no tmpfs de 1 GB em `/tmp`, e `chmod` do ponto de montagem `/databases` é recusado para o usuário 65532. O ajuste que acompanhou a prova (ainda neste diff, commit da prova) manda o download para `/databases/tmp`, limita o `chmod` aos arquivos desse usuário e, se o host não consegue apagar um carimbo pela permissão, abre um contêiner root só para remover aquele carimbo. `verify-db.test.ts` cobre o script e a conservação do `current.json`.

**2.2 Exame real e 2.3 reverificação.** Commit `3e8fb87b`. O comando `npm run personal:verify` e `POST /api/v1/ac/personal/verificacoes` rodam ferramentas, mapa, exame `specialist`, confirmação por `reviewer` de outro provedor e relatório. O worker é o supervisor nativo que o modo pessoal já sobe. O Cezar não despacha `security-verify-readonly-v1`: a conversa não inicia este exame. A rota de reverificação usa o mesmo revisor nativo. O botão "Nova verificação" posta na rota e mostra a fase. A tela foi conferida com o vitest do pacote web (`upstream/cezar/packages/web`, 4 testes), não num navegador: esta sessão não tem browser. A imagem não tem ZAP, Nuclei nem Schemathesis. URL aceita gera a nota "Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis."

**2.4 Hadolint.** Commit `4b6c9988`. O heredoc de download saiu do Dockerfile e foi para scripts que o Hadolint lê. O checksum das ferramentas permanece. `verify-dockerfile.test.ts`: ok. O alto `DL1000` da rodada 1 deixa de ser o estado atual.

**2.5 Prova na régua.** Instalação descartável em `/tmp`, banco `ac_implementation_test_vordem2_15c1467ea51026de` no Postgres de teste, não o banco `ac_ispagent` e não a instalação viva. Três logins de assinatura foram copiados com `account-add --auth-file` para homes novas, modo `0600`. A régua é `tests/fixtures/verify-lab/` com histórico git próprio (commit `89135fd`). A primeira execução, antes da coerção do JSON, morreu com `VERIFY_CONFIRMATION_INVALID` depois de 4 chamadas e 111 608 ms: o modelo mandou severidade em inglês, checklist como objeto e `proof` como objeto. O código agora aceita esses formatos, reduz o caminho `/repository/` para relativo (e deixa `/main.tf` como está) e redige token desconhecido no texto do modelo. `verify-coerce.test.ts` e o teste novo de `verify-normalize.test.ts` cobrem isso. A locação do comando é renovada a cada 5 s, porque o ledger recusa mais de 60 s e uma chamada de modelo passa disso. `personal-verify-cli.test.ts` cobre a renovação.

Segunda execução da régua: `01aeb2ff-c772-4dee-9f1a-6f034c09982e`, diretório `20261117-031246-seguranca`, 19 chamadas, 440 522 ms. Examinador Claude `claude-sonnet-5-5`. Revisor Codex `gpt-6.1-sol`. 17 achados: 11 `confirmado`, 3 `provável`, 3 `descartado`. Nota de falha: reprovado por dois altos confirmados. As ferramentas saíram 0, inclusive o OSV-Scanner. Nenhuma delas extraiu o `package.json` sem lockfile, então o minimist 0.0.8 não veio de Grype, Trivy ou OSV. Veio do especialista e o revisor confirmou (`ACH-004`). O gitleaks não casou o token plantado (curto demais para a regra dele); o especialista viu o `git log` já redigido.

| Plantado | Resultado |
| --- | --- |
| `/admin` sem autorização | `confirmado` (`ACH-001`) |
| SQL concatenado | `confirmado` (`ACH-002`) |
| `path.join` com a entrada | `provável` (`ACH-003`). O revisor viu o escape e não viu leitura nem escrita nesse caminho. |
| `USER root` | `confirmado` (`ACH-005`, e de novo pelas ferramentas `ACH-011` e `ACH-012`) |
| minimist 0.0.8 | `confirmado` (`ACH-004`) |
| credencial no histórico | `provável` (`ACH-006`). O diff redigido estava no pedido; o revisor não tratou isso como prova de que o histórico segue acessível. |

Os falsos positivos de placeholder SQL e de comentário didático não viraram achado. `src/store.js` e `src/notes.js` estão na cobertura. `USER node` não foi marcado como root. O que foi confirmado em `Dockerfile.safe` é outro ponto: `USER node` sem UID numérico (`ACH-010` e `ACH-014`). Três achados do Checkov, com caminho absoluto `/Dockerfile`, foram `descartado` porque esse caminho não é arquivo do repositório. O relatório da régua não contém o token plantado.

**2.5 Prova no Agent Control.** Cópia descartável, commit `e7e412b`, só `src`, `db`, `deploy`, `scripts`, `adapters`, `package.json` e `package-lock.json`. Sem `upstream`, sem `tests`, sem `node_modules`, sem o histórico git do produto e sem arquivo de segredo. A primeira tentativa (12 s, 0 chamadas) parou porque a pasta estava em `0700`. Com a pasta em `0755`, a execução `8e34c460-22db-4c98-b3c2-e4f494305f88` fez 407 chamadas em 11 084 751 ms. 31 fatias, 455 arquivos, examinador Claude, revisor Codex em todos os 375 achados. 194 `confirmado`, 90 `provável`, 91 `descartado`. Oito altos confirmados, entre eles root na imagem pessoal, o socket Docker em TCP 2375 no compose pessoal, e avisos do OSV e do Trivy no lockfile. Grype (46) e Checkov (16) saíram `descartado`: o caminho absoluto não é arquivo do repositório. O OSV-Scanner saiu 1, com achado, não 127. O `DL1000` antigo não voltou. Detalhe em `docs/validation/verificacao-seguranca-agent-control.md`. Nenhum segredo inteiro foi para esse texto.

**2.6 Uso.** `docs/USO-PESSOAL.md` explica o comando, o botão, a nota de homologação não varrida, o fato de o Cezar não despachar o exame e como ler o relatório. A manutenção de domingo também atualiza as bases.

A suíte oficial antes deste commit de documentação, com `env -u NO_COLOR` e `umask 022`, terminou 0: **188 passaram, 0 falharam, 83 ficaram de fora**. O typecheck terminou 0. A suíte suja `docs/validation/evidence/runtime-result.json`; esse arquivo foi restaurado e não entra no commit. Os testes de laboratório `verify-image.lab.test.ts` e `verify-dynamic.lab.test.ts` continuam fora da suíte. A imagem da prova foi construída à parte e o exame real não entra nessa lista.
