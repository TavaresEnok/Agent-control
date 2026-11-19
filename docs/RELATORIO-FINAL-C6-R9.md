# Prontidão C6 R9

A rodada partiu de `74133e4d` no ramo `task/final-c6-r2` e preservou as correções da R8. A revisão de configuração usou arquivos locais e dados sintéticos.

## Correções

- O Nginx avalia listeners HTTP também em portas não padrão. A classificação usa a declaração do listener e sinaliza portas que podem compartilhar a configuração TLS de outro servidor. O parser respeita a ordem entre `break`, `return`, `if` e `rewrite`. Uma condição ou reescrita anterior ao retorno deixa o redirecionamento indeterminado. Caddy e Nginx reconhecem o status 303 em redirecionamentos HTTPS.
- O Nginx aplica a herança de `add_header` e considera o status literal da resposta. Uma rota que retorna 404 expõe a falta de cabeçalhos declarados sem `always`. Quando a proteção depende do status ou de uma página de erro que altera o contexto, a cobertura registra a incerteza. O Caddy considera que uma exclusão adiada pode remover um cabeçalho definido de imediato. Os dois parsers registram HSTS com duração insuficiente, incluindo `max-age=0`, em sites HTTPS.
- O Compose interpreta os separadores de chaves YAML em mapas de fluxo. Preserva os espaços e as quebras de linha relevantes nas opções literais de logs e usa o nome declarado do driver. Drivers externos, configuração do host e logs desativados aparecem na cobertura. O relatório evita publicar valores de configuração.
- A leitura de scripts distingue os corpos de here-docs de comandos, incluindo redirecionamentos adjacentes, delimitadores com aspas ou continuação de linha, vários delimitadores e endentação por tabulação de `<<-`. O Restic só fornece evidência estática de restauração com snapshot e destino, e de retenção com snapshot ou política reconhecível. A checagem do catálogo, a rotina de restauração e a retenção aparecem com rótulos próprios no relatório.
- A cópia preparatória do Gitleaks roda em um processo filho com prazo de 5 segundos, imposto pelo coletor com `SIGKILL`. Exceder o prazo ou as cotas registra falha de cobertura e impede a varredura da cópia parcial. O coletor aceita somente códigos de falha conhecidos do processo de cópia e mantém caminhos e conteúdo copiado fora das mensagens do processo.

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.4 e npm em modo offline.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 29 testes e subtestes em Node 22.23.4. Os binários de análise foram simulados. O teste de prazo chegou a uma chamada de abertura de arquivo substituída por um bloqueio síncrono no filho, observou `ETIMEDOUT` e `SIGKILL` após cerca de 5 segundos e confirmou zero chamadas ao scanner.
- `node --check` passou nos dois arquivos `.mjs` alterados. `git diff --check` passou. A validação ficou restrita a esses comandos e ao teste dirigido, sem tráfego de rede.

## Pendências de integração

- No ramo revisado, `src/personal-module-cli.ts` ainda chama a sondagem antes de iniciar `keepPersonalVerifyLease`. Cabe à integração conectar a perda do lease ao `AbortSignal` da sondagem e validar o cancelamento no fluxo do CLI.
- O Dockerfile vigente já lista `header-facts.mjs` na cópia para o coletor. A presença desse arquivo no pacote efetivo do adaptador e a imagem do coletor com seu digest dependem de verificação na integração.
- O teste de prazo cobre um bloqueio síncrono interrompível por sinal. A espera por I/O ininterruptível no kernel pode adiar a finalização do filho. Os parsers são estáticos e sinalizam sintaxe e contexto que exigem confirmação adicional. A comprovação de restauração, entrega de alertas e disponibilidade requer evidência operacional.
