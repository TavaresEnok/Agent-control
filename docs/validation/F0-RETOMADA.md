# F0 — retomada delimitada após consolidação

Data: 2026-10-31. **G0 PENDENTE; F1 não iniciada.** Documento de encaminhamento,
sem nova implementação, execução de integração ou autorização de promoção.

## Fonte e precedência operacional

O pedido atual autoriza consolidação dos relatórios Temporal, Fronteiras e Mobile
e EV-01–07, somente nos cinco documentos contratados. Aixle Flow `e6ec5a28` é
candidato aprovado e dependências isoladas sem sudo estão autorizadas. A espera
por continuação em `PASEO-CONTINUACAO.md` descreve a transferência anterior; o
pedido explícito atual autoriza esta worktree de desenvolvimento, sem autorizar
concorrência na origem Zed. Não é necessário perguntar novamente por candidato
ou instalação local. Requisitos do Plano v1.1/Adendo não foram relaxados.

A política exclusiva registrada em PASEO-CONTINUACAO e nos relatórios é histórica:
gerente Codex antigo Sol Alto, programador/revisor Codex novo Sol Médio em sessões
independentes, sem fallback. A atualização administrativa de sessão
`paseo_runtime_policy version=3` **substitui expressamente** regras históricas de
modelos/esforços/contas/substituição. Para o despacho do controlador, ela define
gerente Sol Médio (Alto adaptativo), cadeia de programação Grok → Codex isolado
Sol Médio → conta antigravity2 habilitada (Gemini e Sonnet) → Sol Médio original
somente na exceção prevista; revisor principal Sonnet Alto, depois Codex, depois
Grok Alto nas condições da política. Astra permanece proibido. Não se deve
apresentar a exclusiva histórica como política global vigente nem a cadeia de
despacho como elegibilidade RF-55 da futura plataforma Aixle.

Este executor já delegado permanece no escopo Codex programador admitido,
sem criação de agentes, troca de conta/modelo ou fallback. Próxima revisão cabe
ao controlador em sessão independente, conforme política vigente, sem parecer
emitido pelo implementador. Exaustão requer recuperação confirmada; transporte
e autenticação não são quota. Nesta consolidação não houve qualquer desses
eventos. Nenhuma política da instalação ou configuração de modelos foi alterada.

Worktree: `/home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-consolidar`.
HEAD inicial `50d3387f21778dacd7f2e9c6147fbcaf650bbe99`; origem do clone em
`UPSTREAM.json`. Origem documental/Zed `/home/enok/Documentos/projetos/agent-control`
preservada e não acessada nesta entrega. `.paseo-context.md` não existe aqui.
Controlador ativo no fluxo por delegação e histórico integrado das três tarefas;
saúde do daemon não foi sondada. Não iniciar/reiniciar serviço por instrução
histórica. Outros projetos continuam pausados, inclusive NexoISP/Webchat.

## Evidência disponível para revisão

| Entrega | Commit e fonte | Limite obrigatório |
|---|---|---|
| Temporal | `73ec58ed14cf2a49e7774538c5d481212fbc577c`, [F0-TEMPORAL](F0-TEMPORAL.md), EV-08 | Sintaxe relatada; runtime/testes Ruby/SDK/servidor NOT RUN; sem admissão/relay/outbox SQL |
| Fronteiras | `744b19e81cc903e0e43b63e843184d6ee322cd93`, [relatório](F0-FRONTEIRAS-ELEGIBILIDADE.md), `tools/f0/boundary/evidence.json`, EV-09 | HOME vazou; namespace negado; guard standalone; T01/T36/T39 integrado NOT RUN |
| Mobile | `6878e8cf554e27aa23d265935de1c2b266dab817`, [F0-MOBILE](F0-MOBILE.md), EV-10 | Quatro checks parciais relatados em browser; HTTP/WS/dados sintéticos; sem persistência ou deduplicação |
| Baseline | EV-01–07 e ADR-001 | Ambiente e SSH/namespace históricos não homologam esta integração |

Relatórios completos e diffs foram consultados para consolidação, sem emitir
aprovação independente. O JSON de fronteira está versionado e foi lido. Mobile
`report.json`, `trace.zip` e capturas não foram transportados pelo Git e estão
ausentes aqui; hashes e horário exatos constam de EV-10/F0-MOBILE. O controlador
deve disponibilizar os bytes da worktree produtora para conferência pelo revisor.
Temporal não produziu históricos/resultados de servidor: não há artefatos a
promover. Revisor deve consultar artefatos completos se resumo insuficiente;
ausência de artefato não equivale a PASS. Não repetir verde por rotina.

## Próximo bloco mínimo: obter a primeira execução Temporal

1. Revisar independentemente documentação, harness e fronteiras do ensaio. Manter G0 pendente.
2. Gerente disponibiliza toolchain/headers no ambiente correto ou Ruby 4.0.9 pronto isolado. Os comandos de host abaixo foram devolvidos, **não executados** pelo trabalhador. A instalação isolada já está autorizada; necessidade de host é encaminhamento técnico, não nova pergunta genérica ao proprietário.
3. Executor autorizado na worktree de execução prepara Ruby 4.0.9/CLI 1.9.1/gems conforme receita com hashes em F0-TEMPORAL; resolve e valida lock isolado, executa preflight/testes essenciais e então harness uma vez. Não instalar serviço nem usar compose original.
4. Anexar manifest, cinco cenários, histórico real por workflow, worker log e results; na falha, preservar causa/saída e corrigir o mesmo bloco. NOT RUN se preflight falhar. Mesmo PASS não fecha E3 sem prova adicional pelo contrato real de admissão/relay/outbox.

Comandos administrativos para gerente, somente no host/ambiente de build
Debian/Ubuntu destinado à prova, sem operar outros projetos:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential pkg-config libssl-dev zlib1g-dev libyaml-dev libffi-dev
```

A receita original aponta à worktree `g0-temporal`; ao retomar no clone consolidado,
usar o caminho autorizado **desta tarefa** e manter todos os outputs abaixo dele:

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-consolidar
# Primeiro preparar .runtime/installed, .runtime/cli e gems pela receita F0-TEMPORAL.
export PATH="$PWD/tools/f0/temporal/.runtime/installed/bin:$PWD/tools/f0/temporal/.runtime/cli:$PATH"
runtime="$PWD/tools/f0/temporal/.runtime"
env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
  BUNDLE_GEMFILE="$PWD/tools/f0/temporal/Gemfile" BUNDLE_PATH="$runtime/bundle" \
  BUNDLE_APP_CONFIG="$runtime/bundle-config" bundle install
bash tools/f0/temporal/run.sh --preflight
for source in tools/f0/temporal/*.rb tools/f0/temporal/Gemfile test/f0/temporal/*.rb; do ruby -c "$source"; done
ruby test/f0/temporal/process_probe_test.rb
env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
  BUNDLE_GEMFILE="$PWD/tools/f0/temporal/Gemfile" BUNDLE_PATH="$runtime/bundle" \
  BUNDLE_APP_CONFIG="$runtime/bundle-config" bundle exec ruby test/f0/temporal/launch_evidence_test.rb
bash tools/f0/temporal/run.sh
```

Comandos são encaminhamento para execução futura, não realizados nesta entrega
somente documental. Cleanup por UUID e identificação exata no F0-TEMPORAL;
nunca `pkill`, prune ou limpeza global. Checks não executados continuam NOT RUN.

## Lacunas seguintes, sem iniciar F1

| Lacuna | Ação mínima executável / aceite | Natureza |
|---|---|---|
| Namespace T24 | Gerente fornece laboratório descartável sem credenciais; executar `unshare --user --map-root-user --mount --pid --fork --mount-proc --net /bin/true`, então `python3 tools/f0/boundary/isolation_probe.py` nesse laboratório | Permissão de ambiente; não é quota, login ou falta de autorização para instalação isolada. Não alterar sysctl/privilegiar produção por tentativa |
| E3 admissão/outbox/relay | Exercer serviços existentes da Aixle e inventariar entradas habilitadas UI/workflow/MCP/recovery; falhar entre intenção/processo/handle, confirmar ausência de segundo lançamento e cancel/reconciliação | Integração ainda ausente da prova; futuro PASS do harness não substitui SQL/leases |
| T36 / MITM / guard global | Projetar stack efêmera com portas/volumes/redes exclusivos e identidades sintéticas; testar sem cookie, viewer alheio, worker e sessão revogada via gateway e acesso direto UI/API/WS/terminal/MCP/preview; WS handshake e ação; negar antes de efeito e impedir worker de administrar central | Implementação/topologia e execução. Sem URL de laboratório, não há curl seguro contra instalação ativa; não inventar teste executado |
| E5 / T27 / T35 | No shell real isolado, criar perfil conta/modelo e tarefa, reenvio com chave estável e efeito persistido único; reconectar após transição real, conferir etapas/grafo e estado backend | Percurso integrado não executado; reaproveitar componentes. Persona e fixture não fecham perfil/tarefa |
| E1/E2 / RF-55/T28 | Definir modo/plano/titular/CLI/versão e origem confiável da avaliação; esclarecer Codex hospedado/remoto; provar fronteira antes de duas contas identificáveis e admissão/refresh comum ou contas autorizadas não sobrepostas | Elegibilidade e arranjo de contas em etapa própria. Este contrato não autoriza logins reais; controlador ativo não comprova T28 |
| E7 SSH | Disponibilizar destino de laboratório dedicado, fingerprint verificado fora de banda e transporte Aixle/OpenSSH; materializar repo só remoto, produzir artefato central e testar SHA no destino sem IA/credencial lá | Integração/destino ausentes. EV-07 permanece prova histórica loopback; não acessar NexoISP/produção |

Estas são fatias F0 ainda necessárias, não autorização para nova arquitetura,
dispatcher paralelo, F1, migração ou produto completo. O controle de capacidade,
CLI elegível e revisão independente são exigências técnicas/processuais; não
confundir com autorização genérica já concedida, transporte ou esgotamento.
Só deliberar G0 após todos os eliminatórios terem prova rastreável suficiente.
