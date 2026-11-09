# Fatia real de planejamento — 09/11/2026

O titular autorizou inferência real com os modelos mais básicos em esforço `low`. Bancada: [scripts/real-planning-slice.ts](../../scripts/real-planning-slice.ts).

## Resultado

Três execuções em PostgreSQL descartável, com `claude-haiku-5-5` em `low`, sem ferramentas. Pedido fixo: criar `CONTRIBUTING.md` e referenciá-lo no `README.md`.

| Execução | Estado | Chamadas ao modelo | Replay igual | Custo informado pela CLI |
|---|---|---|---|---|
| 1 | `published` | 1 | sim | US$ 0,00196 |
| 2 | `published` | 1 | sim | US$ 0,00193 |
| 3 | `published` | 1 | sim | US$ 0,00185 |

Nas três, o plano teve as tarefas `write-contributing` e `link-readme`, a segunda dependente da primeira. Ele passou por `SemanticPlanning`, `Capacity` e `ManagerPlans` do produto, com recibo Ed25519 verificado. O replay da mesma solicitação não gerou nova inferência.

## Limites

- A conta segue com `mode='synthetic'` no banco descartável, porque a migração 042 continua vigente. Isto não ativa `subscription_cli`.
- O executor roda a CLI no host, com o login existente, sem contêiner. O campo `containerId` do recibo guarda um digest da sessão, e o recibo é assinado por chave efêmera.
- Só o planejamento foi exercitado. Não houve programador, QA, revisão ou integração com modelo real.
- Três amostras de um único pedido não medem a qualidade dos planos.
- Sem revisão independente. Nenhum requisito muda de estado por causa desta prova.

## Reprodução

Exige `AC_TEST_DATABASE_URL` apontando para o banco `ac_implementation_test` em loopback, e `AC_REAL_INFERENCE_AUTHORIZED=1`. Execute com `node --import tsx scripts/real-planning-slice.ts`.

## Codex real sob as restrições do container — 09/11/2026

Com autorização do titular para copiar o login, a CLI Codex 0.166.0 rodou na imagem de planejamento com os limites do supervisor: raiz somente leitura, `cap_drop ALL`, `no-new-privileges`, sem repositório montado e rede `ac-native-provider`. Usou uma cópia do login em diretório `0700`, apagada ao final. O comando foi `codex exec` direto, não o worker assinado nem o `NativePlanningSupervisor`.

| Verificação | Resultado |
|---|---|
| Acesso direto à internet | bloqueado, sem resolução de nome |
| `example.com` pelo proxy | 403 |
| `chatgpt.com` pelo proxy | túnel aceito |
| Inferência com `gpt-5.6-luna` em `low` | recusada pelo provedor: limite de uso até 12/11/2026 |

A chamada chegou ao provedor, mas **não houve resposta do modelo**, portanto a inferência em container segue sem prova.

Para a ativação completa ainda faltam: liberar as travas da migração 042 e de `capacity.ts` por opt-in explícito, o pin de protocolo e uma avaliação RF-55 baseada em fonte oficial. Essa avaliação não pode ser registrada sem a fonte.
