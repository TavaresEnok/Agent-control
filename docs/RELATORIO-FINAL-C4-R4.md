# Módulo 4 de dependências · rodada R4

Base `90a2b8c4`, ordem `ORDEM-FINAL-C4-R4.md` e parecer de `5fe369f6`. As mudanças foram feitas no worktree `task/final-c4`.

## Correções e provas sintéticas

| Caso | Alteração e prova |
| --- | --- |
| Lock do workspace | O membro usa o lock da raiz aplicável, com precedência de `npm-shrinkwrap.json` quando ambos os arquivos npm existem. Um lock local com `foo@2` deixou de mascarar `foo@1` no lock do workspace. Achados de faixa e atualização apontam para a chave e a linha da instalação resolvida. Uma entrada numérica gerou falha de validade. A divergência por ausência permaneceu reservada a um pacote realmente ausente do mapa aplicável. [Formato e precedência dos locks npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) |
| npm-check-updates | Um resultado inválido invalida as atualizações emitidas para aquele manifesto. Foram exercitados valor objeto, nome não declarado, faixa inválida e versão sem confirmação no snapshot. Um manifesto vizinho manteve sua atualização válida. O ncu fixado em `23.1.1` também confirmou um alias npm com snapshot local. A cópia enviada ao ncu offline exclui referências Git e outras faixas não comparáveis que poderiam selecionar uma consulta externa. |
| ast-grep | A cobertura exige que o ast-grep relate regras aplicadas ao próprio arquivo e que a cópia passe pelo parser JS/TS fixado no módulo. O binário `0.51.3` confirmou cobertura em TSX, MJS, CJS, MTS e CTS. Duas fontes inválidas geraram falha, inclusive uma para a qual o ast-grep recuperou a sintaxe e devolveu um achado. A extensão maiúscula sem varredura confirmada ficou pendente. |
| Regra do codemod | Eventos NDJSON exigem caminho, linha, regra, severidade, mensagem e trecho. Um patch precisa declarar a reescrita e reproduzir exatamente a diferença entre a cópia original e a cópia processada. Eventos incompletos e textos de reescrita sem alteração falharam. Um patch sintético comprovado e as revisões do jscodeshift `17.4.0` continuaram disponíveis. |
| Inventário CycloneDX | O documento pode omitir `components`. Listas aninhadas são percorridas e registros inválidos são contabilizados. Um pacote npm escopado aninhado produziu o achado esperado mesmo com entradas inválidas no mesmo SBOM. [Referência JSON do CycloneDX 1.6](https://cyclonedx.org/docs/1.6/json/) |
| Metadados de registro | A comparação exige uma versão semver própria do snapshot. O teste de SBOM contabilizou duas entradas em `sem_metadados`, uma delas presente com versão inválida. O dado inválido gerou falha com contador próprio. |
| Limites | Locks e SBOMs individuais têm teto de 20 MiB. A leitura sequencial de SBOMs tem tetos agregados de 64 MiB e 20 mil componentes. Os relatórios jscodeshift têm tetos de 2 MiB por arquivo, 16 MiB agregados e 5 mil achados. Os testes ultrapassaram os tetos individuais e agregados e confirmaram que as provas já obtidas continuam disponíveis. Arquivos esperados que desapareceram geraram falha. |
| Prazo do jscodeshift | O prazo de cada processo é de até 120 s, com orçamento de 10 min para a etapa. Um processo filho que iniciou e ficou pendurado foi interrompido por prazo reduzido de teste. Seu diagnóstico registra o tempo e o tipo de prazo. Uma saída com código 7 gerou diagnóstico de execução e um arquivo restante ficou pendente quando se esgotou o prazo total. |

## Verificação

- Node `22.23.4`. `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-dependencias.test.ts` passou com 19 testes sintéticos.
- `node --check` passou no coletor e no codemod. `git diff --check` passou.
- A comparação com `90a2b8c4` confirmou digest, locks das ferramentas e Dockerfile sem diferenças.

## Pendências

A validação de integração com imagem, laboratório, suíte completa e instalação viva fica fora desta rodada. A análise continua limitada aos locks npm, aos campos CycloneDX usados para identificar pacotes e às versões verificáveis no snapshot local. A cobertura do ast-grep também depende da sintaxe aceita pelo parser fixado. Reescritas com trechos ambíguos na mesma linha exigem revisão.
