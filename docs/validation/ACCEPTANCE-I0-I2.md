# Critérios fixados para a primeira entrega

Base normativa: docs/normative/DIRETRIZ_MESTRE_V1.md; não substitui RF/RNF/T completos.

- C01: manifesto consolidado íntegro, snapshots/patches fixados e instalação nova; typecheck integral Cezar e adaptador sem bypass.
- C02: dois contextos no mesmo projeto com sessões Happier distintas e transcript cifrado sem mistura.
- C03: uma instância por contexto; takeover com mesmo perfil incrementa epoch; comandos novos e efeitos antigos recusados; checkpoint e pausa preservados.
- C04: mensagem comum com identidade nativa gera comando Zod sem marcadores; 12 retries concorrentes geram uma intenção/run/operação.
- C05: PG/outbox precedem despacho; Cezar RunManager/RunStore reais executam processo sintético e produzem commit Git em cópia de laboratório.
- C06: retorno do estado real ao transcript Happier e consulta do mesmo run pelo cockpit; nenhum composer/endpoint paralelo aceita mutação.
- C07: principal estranho, viewer com escrita, sessão trocada, payload trocado, época antiga, política divergente e caminhos API/WS/MCP legados são recusados.
- C08: reenvio após perda de ack retorna IDs anteriores; recibo/operação incerta nunca autoriza segundo processo cego.

Estes critérios aceitam somente o escopo sintético local executado. Não aprovam GI1/GI2 completos, dispositivos nativos, modelos reais, sandbox de produção, política de contas, revisão independente ou migração.
