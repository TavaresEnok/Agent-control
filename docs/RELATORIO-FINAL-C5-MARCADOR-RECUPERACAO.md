# C5 — Espera pelo marcador de recuperação

Em duas execuções cumulativas sob carga, a espera pelo marcador expirou nos cenários `integrate`, `integrate-before-cas` e `integrate-registered`. O limite anterior era de 150 consultas separadas por 50 ms, cerca de 7,5 s de intervalos.

O teste agora usa um prazo monotônico de 30 s para esperar o marcador com `ready: true` e o nó esperado. Se o filho encerrar durante a espera, o teste falha no próximo ciclo de verificação e informa o nó, o código ou sinal de saída e o trecho final da saída capturada. Um erro do processo filho também encerra a espera, com a causa anexada.

O limite total por cenário passou de 30 s para 60 s para acomodar a espera, a preparação e a recuperação. Os prazos da recuperação pós-SIGKILL e as asserções de recibo, CAS, incerteza e replay foram preservados.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 22.23.4.
- `node --import tsx --test --test-reporter=tap tests/completed-node-recovery.test.ts` passou nos nove cenários em 66 s, com zero falhas e zero pulos. A execução usou a imagem local `postgres:16-alpine` em um contêiner descartável com porta dinâmica em loopback e dados sintéticos. O contêiner foi removido ao final.
- `git diff --check` passou.
