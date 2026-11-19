# C7 R5 — desempenho

## Entrega

- O orquestrador grava e sincroniza a intenção de cada criação Docker antes de enviar o comando. A limpeza exige o nome esperado e a etiqueta de propriedade registrada. Contêineres são usados e removidos pelo ID conferido. O volume é removido pelo nome após conferência da etiqueta. A trava de diretório via `/usr/bin/flock` impede que outro processo reconcilie uma execução ativa ou que dois reconciliadores processem o mesmo registro ao mesmo tempo.
- Uma criação sem resposta confirmada permanece registrada mesmo após inspeções que indiquem ausência. Se o recurso aparecer depois do prazo ou da saída do orquestrador, outra passagem pode removê-lo. O cancelamento impede a partida de novos contêineres. A limpeza imediata continua com limite por comando e preserva a intenção que ainda precisa de reconciliação.
- Falhas de volume, preparação, partida e permanência do backend ficam explícitas na cobertura. O observador estático coleta sem o canal do backend quando a preparação falha. Se uma limpeza permanecer pendente no fallback, o relatório conserva os resultados estáticos e registra a pendência em `limpeza-docker`.
- O recorte estático seleciona as declarações servíveis em ordem antes das páginas descobertas, dentro do limite de oito rotas. A cobertura nomeia declarações indisponíveis, rotas fora da seleção e rotas sem relatório completo de cada ferramenta. Um achado k6 aponta para a linha da declaração no JSON ou para o primeiro conteúdo do documento estático servido. A evidência descreve essa origem e a métrica HTTP. Quando falta uma localização verificável, a cobertura ainda registra a medição e o excesso de limite.
- O campo legado `baselineFile` e o arquivo padrão `desempenho.baseline.json` representam orçamentos do projeto. Seus pares produzem regras `DESEMPENHO-ORCAMENTO-*`. As regras `DESEMPENHO-REGRESSAO-*` só usam dados trazidos pela base de uma medição anterior independente. Exigem o mesmo digest e a mesma versão da ferramenta, além de pares compatíveis de rota, modo HTTP, arquivo, formato de tela ou instrução SQL, conforme a série. A comparação histórica usa o limiar padrão de 25% e os deltas absolutos de 10 ms para p95, 100 ms para LCP e 5 ms para a média SQL. O orçamento compara as métricas diretamente com os valores declarados.
- O código-fonte da imagem declara o protocolo 5. Permanecem os limites do módulo, a cópia do snapshot somente para leitura, o volume local limitado e os contêineres com `--network none`.

## Contrato para integração

Em `src/verification-modules.ts`, na função `runVerificationModule`, inserir a ramificação real de `desempenho` depois dos caminhos injetáveis `collectorOutput` e `runCollector`, imediatamente antes da chamada genérica a `runModuleCollectorContainer`. Nessa ramificação, o snapshot oficial, o digest fixado, os limites e o sinal do heartbeat já estão disponíveis.

```ts
const recoveryDirectory = join(await requireDataDirectory(input.dataDirectory), 'performance-docker');
const directory = dirname(moduleDigestPath('desempenho', input.rootDir));
const {runPerformanceModule} = await import(pathToFileURL(join(directory, 'orchestrator.mjs')).href);

const {coverage, findings, measurement} = await runPerformanceModule({
  snapshotPath: snapshot,
  imageDigest: image,
  signal: input.signal,
  timeoutMs,
  maxStdoutBytes,
  recoveryDirectory,
  previousMeasurement, // undefined ou {examId, measurement} de um exame anterior elegível
});
collectorData = validateModuleCollectorObject({coverage, findings}, 'desempenho');
```

O envelope `measurement` retornado contém as séries medidas, versões, modo HTTP e digest. Persistir junto de um exame publicado sob a autoridade da base, em armazenamento privado fora do repositório. Na consulta seguinte, selecionar somente um exame anterior concluído do mesmo projeto e de ambiente comparável. O identificador vem do exame persistido. A validação compartilhada recebe só `coverage` e `findings`. Na ausência desse histórico, a comparação registra cobertura omitida.

No caminho de recuperação da base, chamar `reconcilePerformanceResources({recoveryDirectory, signal})` após o retorno de `recoverModuleContainers` em `runVerificationModule` e `reconcileModuleReports`, fora da transação do ledger e com o mesmo caminho absoluto e a mesma conta de serviço usados pelo orquestrador. A manutenção do runtime deve chamar a mesma função na inicialização e periodicamente, inclusive quando não houver novos exames. Cada chamada faz uma passagem e retorna contagens de registros `cleaned`, `pending`, `active` e `invalid`. A base pode encerrar a passagem via sinal e repetir depois. O caminho padrão, quando omitido em ambos os chamadores, fica em `~/.local/state/agent-control/performance-docker`.

Um registro de criação cuja conclusão permaneça indeterminada fica pendente sem expiração baseada em tempo ou em inspeções de ausência. A trava serializa os processos do módulo que usam o mesmo registro. A CLI Docker identifica volumes pelo nome e a inspeção da etiqueta e a remoção são chamadas distintas. Operações administrativas diretas no mesmo nome não participam dessa trava.

## Provas e pendências

- Verificações locais com Node 24.22.1. `npx tsc --noEmit --skipLibCheck`, `node --check` nos JavaScript alterados e `git diff --check`.
- 35 testes focados aprovados com fixtures sintéticas em `tests/module-desempenho.test.ts`, `tests/module-desempenho-collector.test.mjs` e `tests/module-desempenho-orchestrator.test.mjs`. As provas cobrem volume e contêiner tardios, retomada em outro processo após prazo e três inspeções, concorrência, cancelamento, propriedade divergente, fallback estático, prioridade e omissões de rotas, saída parcial das ferramentas, origem de achados k6 e referências de medição.
- A base ainda precisa ligar a ramificação, agendar a reconciliação e persistir a medição independente. O digest disponível pertence à imagem anterior. A prova futura com a imagem R5 precisa conferir o fluxo real das ferramentas e atualizar as asserções legadas do laboratório que esperam `server.mjs` como origem do achado k6 ou `isolamento-http` omitido no fallback. Laboratório, suíte completa, imagens construídas, instalação viva e logins reais ficaram fora desta rodada.
