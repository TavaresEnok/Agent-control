# C5 — Confirmação do sinal antes do replay

O teste `tests/completed-node-recovery.test.ts` aguarda o evento `close` e exige que o processo filho tenha terminado com código `null` e sinal `SIGKILL` antes de consultar o estado persistido e iniciar o replay.

O prazo monotônico de 30 s para o marcador usa um `AbortSignal` compartilhado pela leitura (`readFile`) e pela pausa entre consultas. Uma saída antecipada cancela a espera e informa o ponto, o código, o sinal e o trecho final da saída capturada. Um erro do processo filho também cancela a espera e preserva a causa.

## Cenários e asserções

| Pontos de interrupção | Resultado exigido após a retomada |
| --- | --- |
| `qa`, `review`, `judge`, `qa-before-start`, `qa-wait-capacity`, `integrate-registered` | Grafo retomado com uma chamada de CAS na recuperação. |
| `integrate`, `integrate-after-cas` | Grafo retomado sem repetir o CAS. |
| `integrate-before-cas` | Grafo em espera, integração `uncertain`, referência protegida no commit base e zero chamadas de CAS. |

Em todos os pontos, a retomada respeita a pausa e conserva as operações de estágio registradas. Nos oito casos que avançam, o teste preserva as identidades de operação e de sessão, exige cinco estágios concluídos, cinco concessões e uma intenção de integração. A referência protegida deve coincidir com o commit do recibo, e `main` deve permanecer no commit base.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 24.22.1.
- `node --import tsx --test --test-reporter=tap tests/completed-node-recovery.test.ts` passou nos nove pontos em 64,3 s, com zero falhas, cancelamentos ou pulos. A execução usou dados sintéticos e a imagem local `postgres:16-alpine` em um contêiner descartável com porta dinâmica em loopback. O contêiner foi removido ao final.
- `git diff --cached --check` passou.
