# Planejamento semântico e fronteira nativa — 02–03/11/2026

## Estado e limites

Código implementado neste incremento; execução operacional não ativada. A entrada de instalação permanece `administration-only`, com transporte Happier opcional. Não foram utilizados logins, credenciais, contas, inferência ou APIs reais. Migração 042 continua impedindo a ativação de contas reais. Nenhum gate foi convertido em aprovado.

## Implementações

- `src/semantic-planning.ts`: serviço de geração de proposta, não scheduler. Registra chamada antes do efeito, reserva papel gerente por Capacity, fixa adaptador/chave/perfil e só consome saída com recibo Ed25519 e confirmação física do grant. Solicitação e texto gerado não são guardados como transcrição PG. A proposta tipada contém referências autorizadas.
- Migrações 048–050: journal semântico, vínculo imutável ao executor selecionado e journal do supervisor. Já aplicadas somente em bancos descartáveis de teste; seus bytes ficam congelados.
- A confirmação perdida retoma pela observação do mesmo executor, incluindo quando ele já saiu da cadeia ativa. Acrescentar adaptador não muda o digest de uma solicitação anterior. Provedores diferentes podem atender chamadas seguintes conforme Capacity.
- Proposta pronta fica retida durante pausa humana. Publicação e mudança de estado `published` são uma transação PG. A aprovação/execução continua separada.
- `diagnostics.ts`: fatos de admissão, resultado incerto, proposta pronta/rejeitada e job nativo incerto aparecem com evidência e próxima condição. Não faz recuperação, inferência, leitura de credenciais ou transcrição.
- `planning-api.ts`: geração e estado autenticados, vinculados ao projeto/contexto. Sem injeção explícita de executor a geração é recusada. O gateway de instalação não fornece essa injeção.
- Cezar Codex runner reaproveitado: esforço explícito no thread e no turno; modo de planejamento novo, sem ferramentas/MCP, com schema de saída; processo isolado não reutiliza daemon. Teto aceito: low/medium/high.
- Runner com ambiente de ferramentas remoto: `environment/add`, `environment/info`, confirmação `ready` e seleção explícita do mesmo ambiente no thread e nos turnos. `add` é lazy no CLI oficial; consultar apenas `status` não conecta. Nenhum fallback local é admitido. Só `wss` ou loopback são aceitos, sem segredos na URL e sem retomar thread local antiga. Essa configuração é privada do supervisor.
- `native-planning-worker.ts`: launch assinado, conta OAuth de assinatura identificada por digest, configuração customizada/API key recusadas, ambiente limpo, saída exclusiva privada. Não publica planos nem libera grants.
- `native-planning-supervisor.ts`: preparação Docker fixa e journal anterior ao efeito; imagem por SHA, usuário não root, limites, montagens e rede restritos. Observação não recria/starta job incerto. Liberação só com processo terminal observado, saída válida e recibo. Parada durante pausa/cancelamento e limpeza explícita do contêiner terminal estão disponíveis. Arquivos privados permanecem retidos para replay; não há limpeza de homes.
- Elegibilidade recente do modo/assinatura/adaptador e identidade nativa da conta são pré-condições adicionais. `accountSubjects` é configuração confiável do supervisor; a identidade do recurso deve ser `codex:<subjectDigest>`. Não foi feito enrollment de conta real.
- `AccountHomes.inspectGranted`: confere grant/ACL/época e identidade física do HOME de conta compartilhada com projeto autorizado, sem duplicar suas credenciais nem exportar caminhos.
- Turnos nativos falhos/incompletos, tool calls e compactação não aprovam uma resposta parcial, mesmo com JSON válido. Contagem observada pode acompanhar falha sanitizada sem incluir diagnóstico ou texto parcial.
- Tokens totais do CLI podem ser exibidos a partir de recibo físico correspondente. Não são saldo da assinatura, nem permitem inventar breakdown de entrada/saída/cache.

## Paralelismo

Planos novos podem declarar 1–10 tarefas desejadas por lote. Planos antigos sem o campo preservam o comportamento de quatro e seu digest. Dependências, caminhos sobrepostos e limites PG continuam reduzindo/admitindo o paralelismo efetivo. O editor nativo permite até dez ramos. Mudar paralelismo publica revisão nova da proposta mais recente, sem alterar run aceito.

O verificador anterior foi preservado byte a byte. `synthetic-verifier-wide.mjs` é uma versão separada para novas políticas. Broker e execução selecionam somente digest fixado na política; políticas antigas não são reinterpretadas como novas.

## Evidências e comandos delimitados

| Evidência | Resultado e alcance |
|---|---|
| `semantic-planning-http-final-20261102.log` | 3/3: PG descartável, HOME físico, compilação de oito tarefas e geração por executor sintético; ACK perdido, nova época, pausa, troca de registry/provedor, HTTP idempotente e recibo forjado. Nenhuma inferência. |
| `shared-account-home-grant-20261102.log` | 1/1: HOME único entre projetos e titulares de intenção distintos, viewer/época velha recusados e conta desabilitada sem liberar grant. Credenciais reais não lidas. |
| `native-planning-guard-first-20261102.log` | 1/1: mesmo grant forjado sobre conta real dormente é recusado antes de Docker/HOME. Não é prova positiva de CLI real. |
| `native-remote-offline-second-20261102.log` | CLI oficial 0.166.0, exec-server/app-server reais em contêiner `network_mode:none`, HOME vazio, metadados de conexão e chave inválida. Sem modelo, chamadas a provedor ou ferramentas sobre projeto real. |
| `native-remote-selection-scoped-final-20261103.log` | Mock de protocolo: esforço, planejamento restrito, ambiente remoto fixado e recusa de ambiente indisponível/substituído. |
| `native-planning-core-build-20261102.log`, `native-planning-build-second-20261102.log` | Compilação TS integrada nas versões desses logs. Alterações posteriores exigem a checagem final do incremento. |
| `native-planning-failure-usage-20261102.log` | 2/2, executor simulado: resposta parcial de turno falho/incompleto recusada, ferramentas recusadas e contador de falha preservado sem diagnóstico privado. |
| `native-planning-image-20261103.json` | Imagem de planejamento construída offline com manifesto, sem contas ou ativação. Artefato congelado com os ajustes de integridade de turno e telemetria. Alterações posteriores do worker exigem nova preparação/build. |
| `native-image-context-third-20261102.log` | Bundle produzido, não imagem executada. Script foi posteriormente corrigido para diretórios exclusivos por preparação e Dockerfile `.mjs`; não tratar este contexto antigo como receita final. |

Os primeiros negativos permanecem nos logs, incluindo `native-remote-offline-first`: o estado lazy foi descoberto e corrigido. Um teste de mock esperava exitCode em vez da rejeição de bootstrap; a asserção foi corrigida sem relaxar o runner.

### Impedimento real encontrado

Os canários nativos com permissões filesystem falharam por restrição de namespace/bubblewrap neste servidor. A alternativa Landlock também recusou a proteção de sockets. `codex-deny-read-first-20261102.log` e `codex-deny-read-landlock-20261102.log` não são aprovações. Não alteramos kernel, privilégios ou os serviços existentes para mascarar a falha.

A conexão oficial a exec-server em ambiente Docker separado é o caminho implementado para separar ferramentas de credenciais em programação futura. Ainda não há homologação da topologia em dois contêineres com TLS, chamadas de ferramentas e CLI autenticada. Não remover isolamento ou liberar execução local para contornar esse gate.

## Preparação reproduzível, sem ativação

`node scripts/prepare-native-planning-image.mjs /caminho/publico/codex SHA256` produz contexto privado com somente bundle, binário ELF público e manifesto. O script não autentica, não constrói imagem Docker nem inicia processo de IA. Uma imagem foi posteriormente construída explicitamente com `docker build --network=none`, em bancada; seu manifesto é evidência da versão congelada, não autorização de ativação. Caminhos públicos explícitos e hash obrigatório; nenhuma busca por credenciais. A imagem só poderá ser promovida após suas provas aplicáveis.

`deploy/compose.native-planning.yml` descreve exclusivamente proxy opt-in e redes; não foi iniciado. CONNECT é limitado a destinos oficiais de assinatura em 443, sem interceptar TLS. Não há publicações de portas nem contas montadas. O Dockerfile tem ignore próprio para que o contexto não contenha estado privado.

## Ainda necessário para o produto

1. Integrar o serviço ao gerente semântico contínuo e ao contexto canônico autorizado, com histórico selecionado, sem lançar receita sintética como se fosse programação real.
2. Homologar/admitir executores reais de programação, QA e revisão, seu isolamento de ferramentas/credenciais e suas imagens. O supervisor aqui é de planejamento; não se apresenta como executor de código completo.
3. Fechar ciclo autenticado de cota/esgotamento/recuperação com classificador comprovado e fallback, sem tratar erro genérico como saldo esgotado.
4. Provar cancelamento, parada, cleanup/replay e falhas de Docker do supervisor nativo. Tipos e prova negativa não substituem esses ensaios físicos.
5. Custódia/rotação, retenção privada, ingresso móvel nativo, restore operacional e demais aceites da matriz de 111 requisitos.

A independência de revisão e as autorizações para assinatura/piloto permanecem condições de promoção.

## Referências primárias

- [Permissões oficiais do Codex](https://learn.chatgpt.com/docs/permissions).
- [Configuração do CLI](https://learn.chatgpt.com/docs/config-file/config-reference).
- [Orientações de segurança e sandbox](https://learn.chatgpt.com/docs/enterprise/security-cookbook).
- Schema oficial gerado offline pelo CLI instalado: `codex app-server generate-json-schema --experimental`; evidência de versão/hash em `codex-protocol-effort-20261102.json`.

## Reversão

Nenhuma migração operacional foi feita. Desabilitar injeção opcional mantém o gateway administrativo anterior. Não remover tabelas/journals com efeitos incertos, reinterpretar seus IDs ou reaplicar migrações editadas. Executores antigos permanecem registrados como inativos para observar seus próprios jobs. Não remover HOME, output privado ou contêiner com processo ainda ativo.

Preparações antigas contendo somente binário público e bundle foram removidas após validação de seu próprio manifesto; contexto final e imagens foram preservados. `native-build-cache-cleanup-20261103.json` registra o alcance. Não houve limpeza de projetos, homes ou dados operacionais. O runner foi verificado no seu diretório nativo em `native-remote-selection-scoped-final-20261103.log` (3 casos); a execução anterior no diretório raiz encontrou duas cópias do mesmo teste e não conta como seis cenários independentes.

Checagem final das fontes e tipos web concluída em `delivery-types-20261103.log` e `delivery-web-types-20261103.log`. A verificação de tipos não homologa execução nem substitui os gates pendentes.
