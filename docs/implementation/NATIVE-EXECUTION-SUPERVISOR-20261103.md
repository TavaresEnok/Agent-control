# Supervisor nativo: implementação e limites

## Código entregue

`src/native-execution-supervisor.ts` implementa a preparação e o ciclo físico de um par de contêineres. A migração 051 registra identidade imutável de job, grant, conta, perfil, esforço por digest, época, sessão, origem, executor e chave. O supervisor não é um segundo scheduler.

Antes de preparar arquivos, exige contexto e época válidos, projeto/repositório corretos, grant admitido, quota fresca, conta/perfil habilitados, avaliação de elegibilidade fresca e identidade de HOME registrada. Contratos sintéticos não podem ser convertidos silenciosamente em execução nativa. A dependência de especialista que ainda não está implementada para o caminho nativo é recusada.

O journal antecede os efeitos. Redes, contêineres e nomes são específicos do job. A imagem de ferramentas tem somente o binário público, uma capability e o snapshot; não recebe conta, credenciais, diretório do controlador ou socket Docker. Avaliadores recebem `/work` somente leitura. A imagem do trabalhador espera pelo lançamento assinado; o supervisor inspeciona os dois contêineres em execução antes da publicação atômica desse lançamento. O estado de capacidade permanece incerto até a confirmação física.

A reconciliação consulta os mesmos nomes e IDs; não recria recursos nem repete um início incerto. Antes de liberar o grant, observa a saída do trabalhador, solicita a parada das ferramentas, confirma a saída de ambas e registra recibo Ed25519 vinculado a conta/perfil/época/input/resultado/estado físico. Resultado sem arquivo após saída malsucedida é falha; ausência após saída zero permanece incerta. Replay confere assinatura e recibo físico persistido.

O runtime Cezar pode receber os supervisores explicitamente. Seu ciclo existente observa jobs registrados e processa cancelamentos, inclusive com novo gerente e durante pausa. Não cria um temporizador concorrente nem inicia novos jobs por conta própria. O bootstrap administrativo não registra esse executor e não ativa contas.

## Evidências

- `native-supervisor-runtime-focused-20261103.log`: três testes focados, sem skips. PostgreSQL descartável e Cezar reais; Docker simulado para a transição de execução/cancelamento. Conta dormente foi recusada antes de qualquer acesso ao socket ou HOME. É prova da integração de observação/cancelamento, não do lançamento físico completo.
- `native-two-container-protocol-forwarded-20261103.log`: CLI oficial e exec-server em dois contêineres reais, rede privada, encaminhador do produto, autenticação por capability e recusa de chave incorreta. Nenhuma conta montada, login ou inferência. Metadados do protocolo apenas: não houve tarefa de programação.
- Os logs anteriores da mesma prova foram preservados. O acesso direto `ws://` entre contêineres foi recusado pelo CLI por exigir TLS ou destino loopback; a prova aprovada usa o encaminhador local já implementado. Não foi introduzida exceção de TLS no CLI.
- As duas imagens foram construídas offline. A imagem de ferramentas foi executada somente nessa prova. A imagem de trabalhador não recebeu uma conta real. O contêiner de ferramentas da prova foi encerrado e removido ao final.

## Pendências que impedem ativação e conclusão do produto

1. Implementar e ligar a receita nativa ao despacho Cezar; hoje receitas managed continuam `synthetic-only` e são corretamente recusadas pelo novo supervisor.
2. Conectar o resultado do modelo à finalização supervisionada do artefato Git, conferir escopo e identidade, converter QA/revisão reais em evidência e encaminhar somente o commit aprovado ao integrador existente. Um turno bem-sucedido não equivale a código aprovado.
3. Demonstrar o caminho inteiro de `start` do supervisor com dados sintéticos, incluindo criação de rede, montagem, barreira de lançamento, perdas de confirmação e deriva física. A prova de dois contêineres não executou esse método.
4. Homologar o proxy/rede de provedores, retenção e limpeza idempotente de redes/snapshots, intervalos de falha do supervisor, recursos adicionais de Docker, origem de mounts e janelas de alteração após inspeção. Falhas parciais conservam capacidade incerta e podem precisar de intervenção; não prometer recuperação automática universal.
5. Homologar provedores/assinaturas e fluxo móvel real sob autorização específica; manter revisão independente antes de promoção. Não houve migração nem alteração dos Paseos operacionais.

Não há declaração de gate completo ou produção pronta. Desativação: omitir o registro opcional de supervisores no bootstrap; preservar jobs incertos para reconciliação em vez de descartar seus registros. A migração 051 é aditiva e não deve ser revertida apagando evidências ou concessões.

A checagem final de tipos e o build do projeto passaram (`native-supervisor-final-types-20261103.log`, `native-supervisor-build-final-20261103.log`). A regressão final incluiu cancelamento nativo de planejamento e o novo supervisor, com duas provas aprovadas em banco descartável (`native-supervisor-final-integration-20261103.log`). Compilação não homologa comportamento não executado.
