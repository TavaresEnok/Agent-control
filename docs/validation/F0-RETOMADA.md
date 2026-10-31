# F0 — retomada delimitada após consolidação

Data: 2026-10-31. **G0 PENDENTE; F1 não iniciada.** Documento de encaminhamento,
sem nova implementação, execução de integração ou autorização de promoção.

## Fonte e precedência operacional

O pedido da consolidação anterior autorizava os relatórios Temporal, Fronteiras e
Mobile e EV-01–07, somente nos cinco documentos então contratados. A atualização
atual é documental e restrita a F0-FRONTEIRAS-ELEGIBILIDADE, F0-RETOMADA e
F0-POLITICA-EVIDENCIA, na worktree
`/home/enok/srv_projetos/worktrees/14v3rrig/task-a9c3be73bab4-g0-policy-host-evidence`.
Aixle Flow `e6ec5a28` é
candidato aprovado e dependências isoladas sem sudo estão autorizadas. A espera
por continuação em `PASEO-CONTINUACAO.md` descreve a transferência anterior; o
pedido explícito atual autoriza esta worktree de desenvolvimento, sem autorizar
concorrência na origem Zed. Não é necessário perguntar novamente por candidato
ou instalação local. Requisitos do Plano v1.1/Adendo não foram relaxados.

A política exclusiva é **efetiva para este projeto**, não apenas histórica.
Conforme o contrato atual fornecido pelo controlador, `model-limits.json` contém
a regra `project_role_policies` id `agent-control` para as raízes
`/home/enok/Documentos/projetos/agent-control` e
`/home/enok/srv_projetos/workspace/agent-control`: gerente Codex antigo
`codex/gpt-6.1-sol` **high**; programador e revisor Codex novo
`codex-programmer/gpt-6.1-sol` **medium**, em sessões independentes;
`automatic_fallback: false`;
`quota_behavior: wait_for_same_account_positive_evidence`.
A política global geral tem cadeia própria, mas **não substitui a regra exclusiva
do projeto**. Corrige-se aqui a afirmação anterior em sentido contrário. A fonte
desta confirmação é o contrato, sem leitura ou alteração da configuração externa;
ver [F0-POLITICA-EVIDENCIA](F0-POLITICA-EVIDENCIA.md). Política de despacho não
comprova elegibilidade RF-55 da futura plataforma Aixle.

Este executor já delegado permanece no escopo Codex programador admitido,
sem criação de agentes, troca de conta/modelo ou fallback. Próxima revisão cabe
ao controlador em sessão independente, conforme política vigente, sem parecer
emitido pelo implementador. Exaustão requer recuperação confirmada; transporte
e autenticação não são quota. Nesta consolidação não houve qualquer desses
eventos. Nenhuma política da instalação ou configuração de modelos foi alterada.

Worktree da consolidação anterior: `/home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-consolidar`.
HEAD inicial `50d3387f21778dacd7f2e9c6147fbcaf650bbe99`; origem do clone em
`UPSTREAM.json`. Origem documental/Zed `/home/enok/Documentos/projetos/agent-control`
preservada e não acessada nesta entrega. `.paseo-context.md` não existe aqui.
O usuário informou que **Zed terminou e o controlador foi ativado**. O contrato
registra lote 1 `e59f2072f8f4` **DONE**, quatro entregas com revisões PASS;
Temporal exigiu correções R1/R2 e nova revisão PASS. Esses registros não demonstram
saúde atual do daemon, que não foi sondada. Não iniciar/reiniciar serviço por instrução
histórica. Outros projetos continuam pausados, inclusive NexoISP/Webchat.

## Evidência disponível para revisão

A tabela abaixo preserva o estado da consolidação anterior (EV-08–10), não o
estado mais recente do laboratório. Atualização do lote 2 pelo contrato: gerente
preparou Ruby 4.0.9, gems e CLI 1.9.1 em Docker isolado; sintaxe de 11 arquivos,
unitários e preflight PASS. O ensaio real iniciou workflow, mas **falhou no recibo
`run_id` nil com Temporal SDK 1.10**, antes de concluir o cenário. Isso não é PASS
de runtime e não foi executado por este trabalhador. A correção do recibo e a
prova SQL dos contratos existentes de admissão/relay pertencem às outras fatias
do lote 2; esta entrega apenas reconcilia documentação. EV-01–11 e recibos
anteriores permanecem preservados, sem modificar evidências consolidadas.

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
Naquela consolidação, Temporal não havia produzido históricos/resultados de
servidor; o ensaio posterior com falha não deve ser apagado por essa descrição
histórica. O recibo HOST posterior está versionado e foi conferido nesta tarefa:
namespace sintético bloqueou cinco ataques em ambas as direções; detalhes e hash
em [F0-POLITICA-EVIDENCIA](F0-POLITICA-EVIDENCIA.md). Revisor deve consultar artefatos completos se resumo insuficiente;
ausência de artefato não equivale a PASS. Não repetir verde por rotina.

## Roteiro anterior: obter a primeira execução Temporal

**Roteiro histórico de encaminhamento.** A preparação isolada e a primeira
tentativa real já ocorreram na gerência, com a falha de recibo descrita acima.
Não repetir instalação, preflight ou checks verdes por esta documentação.
O próximo passo Temporal é corrigir o recibo SDK 1.10 e submeter a execução física
corrigida ao gerente; provas SQL permanecem exigidas. Os comandos abaixo ficam
como registro, sem execução nesta tarefa e sem nova necessidade administrativa.

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
| Namespace T24 | Recibo HOST da gerência já prova o probe sintético bidirecional; integrar a fronteira nos executores Aixle e exercitar os mesmos ataques antes de login | Não repetir o probe aqui; T24 integrado continua pendente. Não alterar sysctl/privilegiar produção por tentativa |
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
