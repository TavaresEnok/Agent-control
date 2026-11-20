# Prontidão R8 — validade do wrapper e identidade do comando

O analisador continua estático: não executa scripts examinados, não resolve chamadas de função nem expande arrays. A análise do `timeout` preserva a posição do executável quando valores reconhecidos do wrapper são incertos, sem procurar comandos nos argumentos do executável conhecido. Assim, nomes impressos por `printf` não geram evidência nem cobertura parcial de backup, alerta ou disco. Com executável operacional conhecido e wrapper incerto, apenas o requisito correspondente fica parcial.

O literal `--signal=` é inválido. O sinal numérico 143 e durações exponenciais, hexadecimais e outros formatos reconhecidos são aceitos; codificações numéricas de sinal fora dos intervalos comprovados e formatos numéricos de duração não reconhecidos permanecem incertos. Não se alteraram limites globais.

Na bancada, `timeout (GNU coreutils) 9.4` aceitou `--signal=143`, `1e1s`, `1e-2s`, `.1s`, `0x1s`, `0x1p2s`, `+1s` e `1.s`; rejeitou sinal vazio, `BOGUS`, `65` e `160`. A decisão conservadora para outros valores numéricos não presume que todas as versões ou plataformas tenham a mesma conversão. As sondas executaram apenas `true` com o utilitário local, sem executar código do projeto.

A fixture sintética de função HTTP monta localmente um array com `-sS`, `-X`, destino variável, `-H` e `-d` opcional, passado inteiro ao `curl`. Como o destino e os chamadores não são resolvidos, `alertas-logs` fica `failed`, com aviso específico por arquivo: não se conclui que há ou falta alerta ou rotação a partir dessa função. Backup e disco permanecem com cobertura `ok`, sem associação à função. Isso não prova comportamento de nenhuma instalação.

Os testes sintéticos cobrem sinais e durações, sinal vazio, incerteza por pilar, `printf` com e sem comando composto, controles existentes de opções e destinos de `curl` e `logrotate`, validação da publicação e nota consolidada quando há falha de cobertura. O teste da nota usa deliberadamente uma lista vazia de achados revisados para isolar a contribuição da cobertura; não atribui confirmação aos achados do coletor.

Verificações: `npx tsc --noEmit --skipLibCheck` e os três testes selecionados de `tests/module-prontidao.test.ts` passaram. Não foram executadas suíte completa, laboratório, instalação viva, serviços ou credenciais reais. A prova física e uma revisão externa não fazem parte desta alteração.
