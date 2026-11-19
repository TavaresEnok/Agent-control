# C5 — Prazo independente da leitura do marcador

A espera pelo marcador em `tests/completed-node-recovery.test.ts` usa `Promise.race` entre a sondagem e uma promessa de interrupção. O prazo de 30 s, a saída prematura e o erro do controlador podem rejeitar a espera mesmo com `readFile` pendente. Os diagnósticos conservam o ponto de interrupção, o trecho final da saída capturada e, conforme o caso, o código e o sinal de saída ou a causa do erro.

Ao terminar a espera, o teste limpa o temporizador e retira os listeners de `exit` e `error`. O `AbortSignal` cancela a sondagem, e a corrida mantém uma reação à eventual rejeição tardia. Nos nove pontos de interrupção, o teste envia `SIGKILL` e exige que o evento `close` confirme o sinal antes de consultar o estado persistido e retomar o grafo.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 24.22.1.
- O controle determinístico mantém a leitura pendente até depois da rejeição da espera. Cobre prazo, saída e erro do filho. Verifica os diagnósticos, o cancelamento, a limpeza dos listeners e do temporizador, e uma rejeição tardia sem erro não observado.
- `node --import tsx --test --test-reporter=tap tests/completed-node-recovery.test.ts` passou nos três controles determinísticos e nos nove cenários com `SIGKILL`, em 61,4 s, com zero falhas, cancelamentos ou pulos. A execução usou dados sintéticos e a imagem local `postgres:16-alpine` em contêiner descartável com porta dinâmica em loopback. O contêiner foi removido ao final.
- `git diff --cached --check` passou.
