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
