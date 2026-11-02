# Autoridades nesta implementação

| Domínio | Autoridade | Implementação / condição |
|---|---|---|
| Transcript e transporte cifrado | Happier | Servidor/cliente/protocolo originais. Nenhum banco de conversa concorrente no Cezar. |
| Projetos, ACL, contextos, épocas, intenções e outbox | PostgreSQL | Schema versionado e transações `src/ledger.ts`; políticas completas/grants ainda I1/I3. |
| Próxima etapa de DAG e estado de run | RunManager/RunStore Cezar | `src/cezar.ts` admite definição fixa; não escolhe a próxima etapa. |
| Efeito físico | Executor sintético de bancada | Processo real e recibo real Git; supervisor de produto/recovery/SSH permanecem I5. |
| Artefato | Git | Commit/tree/base reais na worktree de fixture. Integrador final e helper antigo ainda não portados. |
| Regras de uso de contas | Não habilitadas | Nenhuma conta real, chamada de IA ou fallback pago. I3 é próxima etapa futura. |
| Administração visual | Cezar existente + contratos | Editor/grafo preservados; formulários e ingressos adicionais ainda não habilitados. |
| Acesso móvel | Happier Web existente | Build/browser e critérios específicos; app físico/lojas não presumidos. |

Stack: TypeScript/Node 22.23.3; Hono/Zod/pg no adaptador; Cezar React/Vite/React Flow/Dagre; Happier Expo/React Native/Web e persistência SQLite no modo light de laboratório; PostgreSQL 16 para ledger. Não foram instalados Temporal/Optio ou novo backend Rails.
