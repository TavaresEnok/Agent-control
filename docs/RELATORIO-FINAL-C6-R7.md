# Módulo 6 · controles passivos e privacidade

A revisão foi feita em `task/final-c6-r2` a partir de `8851ca33`, com base nos quatro achados altos e nos cinco médios do parecer independente. O coletor e o adaptador HTTPS estão no commit desta ordem. A mudança da CLI comum está em [INTEGRACAO-FINAL-C6-R7.patch](INTEGRACAO-FINAL-C6-R7.patch).

| Item do parecer | Correção e prova sintética |
| --- | --- |
| 1 · privacidade dos achados | Compose, systemd, dotenv, chaves privadas, Gitleaks e Trivy emitem regra, arquivo, linha e texto fixo. As provas cobrem valores fictícios com espaços, aspas, escapes, listas, mapas e blocos YAML. A saída serializada foi inspecionada para detectar fragmentos dos valores. Mensagens de parsing e diagnósticos brutos dos binários ficam fora da saída do coletor. |
| 2 · reinício e healthcheck | A auditoria avalia a condição da política de reinício do Compose e reconhece `disable: true` e `test: [NONE]`. O teste contrasta configurações desabilitadas com declarações ativas em bloco e em linha. A leitura de systemd considera a última diretiva `Restart` em `[Service]`. |
| 3 · backup e restauração | A presença das rotinas depende de comandos em contextos operacionais reconhecidos, como scripts de shell, `package.json`, cron e `ExecStart`. Um teste mantém os achados na presença de README, comentários, `echo` e heredoc. Em seguida acrescenta rotinas em uma unidade e em um script e verifica a remoção dos achados de ausência. |
| 4 · escopo de Gitleaks | A varredura de arquivos usa as regras internas da versão fixada. Quando há política de exclusão na raiz ou metadados Git, examina uma cópia privada sem metadados Git e sem seguir links. A cobertura declara o histórico Git fora do escopo do snapshot. A prova confirma configuração, isolamento, caminho relativo e execução com o binário real. |
| 5 · limites e cobertura | A coleta identifica omissões por profundidade, tamanho, leitura e cota de arquivos. A cobertura estática passa a `failed` quando a leitura é parcial por falha ou limite. Todos os arquivos analisados com verificações aplicadas recebem linha de cobertura. Após 200 omissões individuais, a saída agrega o restante. A prova ultrapassa 4.000 arquivos e dez níveis. |
| 6 · Nginx | O teste confirma que TLS 1.2 e 1.3 passam, TLS 1.1 gera achado e somente um redirecionamento no nível do mesmo bloco `server` cobre a escuta HTTP. Comentários e redirecionamentos em outro bloco ou em uma `location` não contam para essa regra. |
| 7 · medição HTTPS | HSTS exige um `max-age` completo, válido, único e suficiente. Proteção contra enquadramento exige `DENY`, `SAMEORIGIN` ou uma diretiva `frame-ancestors` aplicável. As evidências descrevem as condições sem copiar os valores de cabeçalho. A medição mantém o teto de 16 origens, registra origens autorizadas excedentes como `skipped` e permite selecioná-las individualmente. |
| 8 · estrutura dos relatórios | Os adaptadores validam os formatos e rejeitam relatórios vazios ou estruturas incompatíveis, inclusive com código de saída zero. Os controles cobrem o formato vazio legítimo do Trivy e o `null` legítimo do Gitleaks. A prova verifica `failed` e a ausência de conteúdo bruto nas mensagens. |
| 9 · locação durante a sondagem | O patch inicia a renovação antes das requisições e conecta interrupção e perda da locação ao cancelamento da sondagem. A prova HTTPS em loopback confirma o fechamento da requisição em curso e que a próxima origem não é visitada. A mesma prova verifica GET na raiz, limite do corpo, ausência de cookies ou autorização, redirecionamento não seguido e falha de transporte por resposta interrompida. |

A análise do Compose é estática. Referências YAML que exigem resolução de aliases são registradas como cobertura incompleta. A presença de um comando de backup ou restauração comprova uma declaração estática. A execução e o resultado operacional dessas rotinas dependem de prova própria. [Política de reinício do Compose](https://docs.docker.com/reference/compose-file/deploy/#restart_policy) · [Healthcheck do Compose](https://docs.docker.com/reference/compose-file/services/#healthcheck) · [Sintaxe do systemd](https://www.freedesktop.org/software/systemd/man/256/systemd.syntax.html)

O isolamento de Gitleaks considera o carregamento de exclusões da raiz na versão 8.30.1. O adaptador do Trivy aceita a omissão de `Results` com um envelope válido, conforme o formato da versão fixada. [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/root.go) · [Trivy 0.76.2](https://github.com/aquasecurity/trivy/blob/v0.76.2/pkg/types/report.go)

## Provas executadas

- `npx tsc --noEmit --skipLibCheck` passou com o patch da CLI aplicado para verificação e no estado entregue.
- Node 22.23.4 passou nos 18 testes focados de `module-prontidao.test.ts` e `prontidao-target.test.ts`. Passou também o caso isolado de argumentos, origens e montagem da CLI em `prontidao-cli.test.ts`, sem banco.
- O coletor rodou diretamente sobre cópias descartáveis com Gitleaks 8.30.1, Hadolint 2.15.1 e Trivy 0.76.2. O diretório vazio e o controle limpo tiveram zero achados. A fixture defeituosa teve 25 achados, sendo 20 da auditoria estática, um do Gitleaks, dois do Hadolint e dois do Trivy. Os binários aplicáveis tiveram cobertura `ok`. A saída serializada passou na verificação de ausência de fragmentos dos valores fictícios.
- `git apply --check docs/INTEGRACAO-FINAL-C6-R7.patch` passou. O arquivo `src/personal-module-cli.ts` permanece fora do commit.

## Integração pendente

Aplicar o patch na CLI comum e confirmar, no fluxo integrado, a renovação da locação durante as requisições. A construção e fixação da imagem, o laboratório e a CLI real ficam com o gerente da integração.
