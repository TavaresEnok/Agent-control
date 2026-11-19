# C7-CPU — coleta de amostras por função

## Entrega e integração

`deploy/modules/desempenho/cpu-metrics.mjs` exporta `collectCpuMetrics({snapshotRoot, file, functionName, thresholdMs = 80})`. `file` é relativo ao snapshot; `functionName` identifica uma única declaração de função de topo. O chamador deve fornecer snapshot estável, sob controle do observador, e limitar a concorrência das coletas. A API não substitui nem altera o coletor existente: cabe ao gerente integrá-la e guardar o resultado no armazenamento do observador.

O retorno medido contém `status: 'measured'`, `coverage: 'partial'`, nome e posição de origem, `sampleCount`, `selfSamples`, `selfMs`, `lineTicks`, `thresholdMs`, `hotspot` e o perfil V8 bruto `profile`. `line` é a linha da declaração; `lineTicks` contém os ticks por linha fornecidos pelo V8, quando disponíveis. As amostras são associadas apenas ao arquivo virtual escolhido pelo observador, ao nome e à linha da função extraída; o caminho apresentado vem do snapshot validado. `selfMs` soma os intervalos de amostras próprias do perfil: é estimativa amostral, sujeita a resolução, escalonamento e interrupções, não um cronômetro exato de CPU. Ausência de amostras não demonstra ausência de custo em outras entradas ou caminhos.

Em seleção inválida, sintaxe não suportada, erro de execução, timeout ou perfil inválido, retorna `status: 'partial'`, `coverage: 'partial'` e `detail`; não gera achado negativo. Mesmo uma medição bem-sucedida cobre somente uma chamada sem argumentos da função isolada. Imports, requisições, dependências, funções auxiliares, funções aninhadas, parâmetros, objetos com métodos, acessos a propriedades e chamadas arbitrárias não são cobertos. São aceitos cálculos com variáveis locais, controle de fluxo restrito, literais numéricos/booleanos, objetos de dados simples e a chamada controlada `performance.now()`. O resto do arquivo é analisado sintaticamente, mas não executado.

O parser próprio é Acorn 8.15.0, fixado por `deploy/modules/desempenho/cpu-parser/package.json` e `package-lock.json`. Para integrar à imagem, copiar `cpu-metrics.mjs`, `cpu-parser/package.json` e `cpu-parser/package-lock.json`, executar `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` no diretório `cpu-parser` e manter `cpu-parser/node_modules/acorn/` ao lado relativo esperado. Proteger esses arquivos e o snapshot contra escrita pelo alvo. Não copiar `node_modules` do worktree como fonte de dependências; instalar pelo lock e sua integridade. Nenhuma mudança na imagem ou no `collector.mjs` foi feita nesta entrega.

O observador inicia um processo Node com heap limitado a 64 MiB, ambiente mínimo e canais padrão descartados; o código selecionado roda em contexto VM com geração dinâmica de código desativada e timeout de 600 ms. Há timeout externo de 3 s para o processo. O código admitido não tem acesso a processo, rede, arquivos, protocolo IPC ou profiler, não pode enviar resultados nem escrever evidência; o inspector e seu perfil pertencem ao observador. Não é um sandbox genérico para JavaScript arbitrário: a segurança depende da lista restrita de sintaxe, do snapshot estável, da proteção dos arquivos do coletor e do isolamento operacional pelo integrador. Não existe serviço ou acesso de rede no fluxo da coleta.

## Provas locais sintéticas

Executado com Node v22.23.4, sem Docker, em `tests/module-desempenho-cpu.test.mjs`:

1. **Defeito:** `defective.js:2`, `computeHeavyReport`, calculando até o prazo sintético de 220 ms: 188 amostras próprias, 202,4 ms estimados, limiar 80 ms ultrapassado. O teste verifica ainda ticks na linha 7 do cálculo.
2. **Controle:** `clean.js:2`, `computeCachedReport`: 0 amostras próprias e 0,0 ms estimados nesta chamada, sem ultrapassar o mesmo limiar. A resolução amostral não permite concluir que a função custe literalmente zero.

Os valores variam conforme o agendamento local. Os testes também verificam rejeição de acesso ao processo e IPC, importação dinâmica, propriedades computadas, construção dinâmica, diretiva de origem, definições ambíguas, links fora do snapshot e travessia de diretórios; um laço infinito termina como cobertura parcial pelo timeout. Um `throw` fora da função confirma que o arquivo inteiro não é executado.

Validação adicional: `npx tsc --noEmit --skipLibCheck` passou; o teste específico também passou no Node v24.22.1. Suíte completa, laboratório, reconstrução da imagem e instalação viva não foram executados. A integração efetiva na imagem e a execução no ambiente de produção continuam por validar pelo gerente.
