# F0/G0 — lote4: acesso Rails e transporte OpenSSH

2026-10-31. **G0 PENDENTE; F1 não iniciada.** Consolidação documental na worktree
`/home/enok/srv_projetos/worktrees/14v3rrig/task-b15c348c94b6-g0-lote4-status`,
HEAD inicial `c78bd74`, árvore inicialmente limpa. Sem execução de serviços,
produto copiado à origem, contas reais, segredos existentes, API paga, migração,
deploy/push/merge/commit ou administração de host pelo executor.

## Procedência e fronteiras por fase

Lotes1–3 DONE com revisões independentes PASS conforme controlador; correção
BUNDLE_FROZEN da costura recebeu nova revisão PASS. E4 e E7 implementados e
revisados conforme controlador em sessões independentes. Recibos de implementação
ainda com revisão pending são snapshots pré-parecer; não são prova física ou
parecer atual. Identificadores de parecer/sessão não fornecidos não são inventados.
Esta consolidação ainda exige sua própria revisão independente antes de integrar.

| Frente | Implementação/revisão | Execução física e limite |
|---|---|---|
| Costura lote3 | `1cfa37ae20d029d9b18c0d7c03674e5b82b0ed89`, candidato HOST `17f79b6122ab666fb6c68cd9c5f72e57026c4355`; revisão PASS conforme controlador | **PASS pela gerência**, recibos incorporados em `1f6e51a`, EV-19. PG+relay+Temporal reais; workflow inerte, ledger vazio, reserva ocupada, sem runtime cleanup/modelos periféricos reais ou E3/T28 global |
| Mobile bytes | EV-17, revisão conforme controlador | Quatro checks de componentes parciais; seis arquivos/7.858.710 bytes versionados, hashes reconferidos. Transporte sintético, sem shell autenticado, E5 aberto |
| E4/T36 | `879164b576ff0a12ba81cb0526a9b354564f9042`, merge `c78bd74`, revisão conforme controlador; EV-20 | **NOT RUN/PENDENTE HOST**. Seis checks Python administrativos com Docker simulado PASS; Ruby/build/cookies/MCP/boot/matriz pendentes. Bypass direto não fechado |
| E7 SSH | `75ebeaed9ec84c5b358cdc96bc36fd5ccf0e83be`, merge `00068d8`, revisão conforme controlador; EV-21 | **NOT RUN/PENDENTE HOST**. Python/bash/gramática não substituem Ruby/OpenSSH, bundle/SHA/job/teste reais. Testes Rails e queda forçada de canal continuam NOT RUN |

[Recibo HOST integrado](artifacts/integrated/host-lote3-receipt.json): exit0,
boot 4 testes/16 assertions/0skip, relay exit86 após start/antes ack; lease
saudável sem novo envio, envelhecimento explícito SQL, AlreadyStarted real com
mesmo runID e uma execução, cancel/cleanup PASS. Nesta consolidação somente
conferência offline: 21 hashes do run, seis móveis e verifier PASS. Não repetir
Temporal5/SQL9/costura/browser verdes por rotina. FAIL inicial, aborto
administrativo por ownership, SQL/history e EVs anteriores ficam preservados.

## Próximo menor gate concreto, sem contas reais

Após revisão independente desta consolidação, a gerência executa o **build E4**
e seus testes dirigidos de Cookies/CookieStore e oráculo MCP; só então roda a
matriz com dois IDs de imagem imutáveis. Na worktree candidata revisada que o
controlador indicar, comandos exatos de [F0-ACESSO-REAL](F0-ACESSO-REAL.md):

```sh
python3 tools/f0/access/host.py build
docker image inspect --format '{{.Id}}' f0-access-candidate
python3 tools/f0/access/host.py run --image sha256:ID_DE_64_HEXA_DO_BUILD --gateway sha256:ID_DE_64_HEXA_DO_TRAEFIK_LOCAL
```

IDs são obtidos do build e da imagem Traefik local compatível com
`addAuthCookiesToResponse`; não são tags nem valores fictícios de recibo. Runtime
isolado, sem portas publicadas/contas/serviços externos; PG descartável com
identidade verificada antes do schema, sem migração ou banco existente.
Reter report, manifesto, gateway efetivo, topologia, controles HTTP/WS/MCP/SQL
sanitizados, resultado e cleanup antes de remover somente recursos próprios.

Aceite por percurso exige positivo e negação específica sem mutação, não erro
genérico. Shell anônimo pelo ttyd direto é **FAIL de bypass**; upgrade sem bytes
ou falha sem controle de saúde direto é **NOTRUN**, nunca PASS. IDE/files/preview
completos continuam NOTRUN e fazem o processo sair 1 mesmo com outras recusas
corretas. Preservar o resultado exato. O menor fechamento seguinte é separar
rede cliente/controle de terminais e provar recusa direta com controle de saúde;
exige outra correção revisada e contraprova, não aprovação por gateway apenas.

Em frente independente, a gerência prepara as duas imagens E7 e executa os
comandos de [F0-SSH-INTEGRADO](F0-SSH-INTEGRADO.md):

```sh
docker build --pull=false -f tools/f0/ssh/Dockerfile.central -t f0-ssh-central .
docker build --pull=false --build-arg BASE=ID_OU_DIGEST_DEBIAN_LOCAL -f tools/f0/ssh/Dockerfile.target -t f0-ssh-target .
docker image inspect --format '{{.Id}}' f0-ssh-central f0-ssh-target
python3 tools/f0/ssh/host-run.py sha256:ID_CENTRAL_DE_64_HEX sha256:ID_DESTINO_DE_64_HEX
```

Base Debian deve estar identificada por digest/ID local; reter builds e IDs.
Aceite: testes standalone, pin incorreto local e hostkey errada no OpenSSH real
sem escrita, conexão correta, repo inicialmente só no destino, bundle/digest e
SHA central/remoto iguais, job detached consultado sem relançar com um único
efeito, teste remoto exit0, marcador sintético central/SSH_AUTH_SOCK ausentes,
recibo e cleanup sem erros. Não prova credencial IA real nem queda forçada de
canal; não fechar E7 inteiro por inferência. Sem novo recibo, estado físico é
PENDENTE, mesmo após implementação/revisão PASS.

## Condições restantes do G0

| Gate | Evidência ainda necessária |
|---|---|
| E3 global | Todos os pontos de entrada sob autoridade única; runtime cleanup/liberação e modelos periféricos reais. Fatia EV-19 não prova esses itens |
| E4/T36 | Executar matriz, preservar FAIL/NOTRUN, corrigir bypass e contraprovar; percursos completos restantes e ausência MITM/CA/proxy no executor real |
| E5 | Perfil conta/modelo, criação/persistência de tarefa, reenvio com efeito único backend, reconexão e grafo/estado reais no shell autenticado; em etapa própria após fronteira segura |
| RF-55/T39 | Elegibilidade de titular/plano/CLI/transporte e guard nos lançamentos globais; hospedado/remoto requires_clarification, perfis vedados desativados e sem API paga |
| RF-46/T28 | Autoridade única de admissão/refresh com Paseos ativos ou contas explicitamente não sobrepostas autorizadas, antes da primeira chamada real; laboratório sem contas não prova T28 |
| E1/E2 | Só em etapa própria: CLI/assinatura elegíveis, duas identidades verificáveis, isolamento integrado Aixle com ataques negativos; namespace sintético não basta |
| E7 | Gate físico acima, registrar limites remanescentes sem alegar CoderPrepareRepo/MCP/SQL/IA autenticada ou recuperação de queda não exercitada |

E6/COMP continuam documentais, notas 3,40 Aixle/2,25 Kandev preservadas.
Plano1.1/Adendo/commits/recibos/EVs/pausas e origem Zed preservados; usuário
informou Zed encerrado. Outros projetos permanecem pausados. Política efetiva
exclusiva `agent-control` conforme contrato/EV-15: manager
`codex/gpt-6.1-sol high`, programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, sessões independentes, sem fallback;
aguardar recuperação confirmada da mesma conta. Sem inspeção de host ou
reabertura de pausas pelo executor. `git diff --check` valida esta entrega
documental; revisão independente e deliberação G0 são fases distintas.
