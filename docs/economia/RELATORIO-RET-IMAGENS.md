# Retenção de imagens candidatas de módulo

## O que mudou
Antes, `runPersonalArtifactRetention` só relatava "imagens: não implementado, preservadas" e nunca removia nada, porque não havia como provar pins de outras instalações no mesmo daemon. Agora a retenção remove imagens candidatas registradas pelo produto, com todas as barreiras abaixo. Em dúvida, preserva e relata.

Elegível apenas a imagem que:
- foi registrada pelo produto (`--registrar-imagem`; é o que prova ser do Agent Control, nenhuma imagem é escolhida por nome, prefixo ou idade) e cujo id e daemon conferem com o registro;
- não é digest fixado (`deploy/modules/*/digest.txt` do produto e de todos os projetos da instalação, bootstrap nativo, execuções de verificação);
- não é imagem aposentada ainda referenciada (`execution.retiredImages`, `planning.retiredImageIds`), com motivo próprio no relatório;
- não é usada por nenhum contêiner, rodando ou parado, por duas vias independentes (`ancestor` e imagem de origem de cada contêiner existente);
- tem pelo menos 24 h de registro (antes eram 2 h);
- o projeto dono não desligou a opção `economy.imageRetention` (padrão ligado).

Modo `retention.automatic`: `off` não chama a retenção; `preview` só relata (registro e Docker intactos, tamanho nominal listado); `apply` julga de novo com pins e contêineres frescos, remove por id com `docker image rm <id>` (mesmo comando de `docker rmi`, sem `--force`, sem prune), confere que a imagem sumiu, retira o registro e informa o tamanho nominal. Registro de imagem que já não existe no Docker é retirado em `apply`. O próprio Docker ainda recusa imagem com filhos ou várias tags.

## Arquivos
- `src/personal-artifact-retention.ts`: `IMAGE_MIN_AGE_MS`=24 h, `protectedDigests` separa pins e aposentadas, `proveImage` com dupla checagem de contêineres e tamanho, laço de remoção e novo resumo.
- `src/installation.ts`: `economy.imageRetention` (padrão `true`).
- Testes: `tests/personal-artifact-retention.test.ts` (5 testes de imagem reescritos/novos, docker falso com contêiner oculto e tamanho), `tests/personal-artifact-commands.test.ts`, `tests/installation.test.ts`.

## Números (fixtures, docker falso)
- Antes: 1 imagem candidata de 2,5 GB nominais, 3 dias, sem pin: 0 removidas, 2,500 GB "não liberados".
- Depois: a mesma imagem aparece como elegível na prévia (2,500 GB) e é removida em `apply` (1 chamada `image rm <id>`, 2,500 GB nominais); outras 9 imagens da fixture de proteção (pin de digest.txt de produto e projeto, bootstrap, aposentada de planejamento, aposentada de execução, execução de verificação, contêiner por ancestor, contêiner oculto, 23 h) ficaram intactas, 0 remoções.
- Tamanho nominal pode compartilhar camadas; o espaço realmente liberado pode ser menor. Não foi medido contra o Docker real (proibido nesta ordem).

## Testes
`npx tsc --noEmit` sem erros. `node --import tsx --test` em personal-artifact-retention, personal-artifact-commands, personal-artifact-producers, personal-maintenance, installation, retention-plan e native-job-work-retention: 78 testes, 0 falhas.

## Limites conhecidos
- Só imagens registradas (`--registrar-imagem`) entram; nada registra automaticamente as imagens que os módulos constroem, então o ganho depende de o fluxo de build registrar a candidata.
- Pins de outras instalações no mesmo daemon que não estejam em `digest.txt`, no bootstrap desta instalação ou em execuções do banco não são visíveis; a proteção contra isso é o contêiner, a idade de 24 h, o registro próprio e a recusa do Docker sem `--force`. A retenção das imagens aposentadas em `personal:maintenance` (`retiredPlan`) não foi alterada.
- Nada foi aplicado na instalação viva nem executado contra o Docker real.
