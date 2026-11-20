# Prontidão viva — R10

Base do trabalho: `d006ab757e22950d6d9da1b2009c4a1a8732421e`; titular informado: `43f1c664`.

Os três cenários de R9 foram tratados no analisador passivo de `timeout`:

- O terminador explícito `--` fixa a posição da duração e do executável, mesmo quando a duração é dinâmica. Sem o terminador, a ambiguidade de uma possível opção dinâmica permanece.
- Uma fração com vírgula que corresponderia a uma duração válida com ponto fica indeterminada quanto ao locale. A incerteza se limita ao requisito do executável na posição identificada, tanto para a duração principal como para `--kill-after` e `-k`. Sufixos inválidos continuam rejeitados.
- Sinais numéricos 32 e 33 normalizados são aceitos, acompanhando a imagem GNU coreutils 9.7 informada. As tabelas usam expectativas fixas, sem consultar o `timeout` do host. A aceitação de 32, 33, 143, 160 e 271, a rejeição de `30S` e `30ss` e a aceitação de `0x1P2s` na imagem foram fornecidas na ordem; a imagem não foi executada nesta rodada.

Validação em fixtures locais sintéticas:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts`: 49 testes passaram. Uma primeira execução detectou a expectativa R6 antiga para sinal 32, corrigida antes da execução final.
- `git diff --check`: passou.

Não foram executados a suíte completa, laboratório, reconstrução de imagem ou testes na instalação viva. A análise estática continua dependente da gramática existente; a validade da fração com vírgula depende do locale real e não foi afirmada como universal.
