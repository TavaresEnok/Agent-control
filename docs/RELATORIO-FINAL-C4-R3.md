# C4-R3 — dependências

Base: `34cc3227`. Escopo: módulo de dependências, testes próprios e este relatório. O parecer de referência é `/tmp/ac-final-3aDgqp8I/parecer-c4-normal-ultra.txt`.

## Alterações

- Manifestos, locks e SBOMs inválidos produzem cobertura de falha por entrada; o processamento continua para os demais. PURLs npm malformadas não descartam outros componentes. Arquivos externos de SBOM presentes mas ilegíveis também são informados.
- A descoberta informa arquivos excedentes por quantidade ou tamanho e erros de leitura. As fontes têm teto agregado de 128 MiB antes das duas cópias; falhas individuais de cópia não interrompem a análise de manifestos e SBOM. A saída de correspondências do codemod tem teto por arquivo e informa perda de prova.
- O jscodeshift executa por arquivo com `--fail-on-error`, sem `--silent`. O ast-grep diferencia seus diagnósticos de erro do código de falha da ferramenta e exige JSON válido. TSX tem regras próprias; extensões sem regras aplicáveis são declaradas não medidas.
- O lock npm compartilhado é associado aos pacotes definidos em workspaces, com busca da dependência a partir do diretório do pacote e subindo até a raiz do lock. A comparação usa `semver` fixado; faixas ou versões não semver são marcadas para revisão. Locks reconhecidos cujo formato não é analisado recebem cobertura explícita. O casamento de padrões de workspace usa `minimatch` fixado.
- As regras e o codemod informam padrões ambíguos para revisão, sem apresentar reescritas prontas: bindings e tipos não demonstram equivalência por si só. Nenhum patch automático é oferecido nesta rodada.
- No SBOM só PURLs npm são comparadas com o registro npm. Componentes de origens e versões distintas não são deduplicados por nome. Metadados offline que não sejam versões semver não são contados como medições e não são entregues ao NCU.
- A atualização do registro tem prazo total, destrói a requisição ao expirar, limita o corpo, informa falhas e retorna saída não zero se houve fallback. As pré-validações do entrypoint imprimem JSON de cobertura em caso de erro.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-dependencias.test.ts`: 12 testes passaram. As entradas são sintéticas. Os testes exercitam os binários fixados de ast-grep e jscodeshift no host, além de processos simulados para falhas, timeout, limites e contrato do NCU; exigem a instalação das dependências do módulo.
- O lock do módulo passou em `verify-lock.mjs`; os locks do módulo e das duas fixtures já estavam presentes na base. Os novos pins de `semver` e `minimatch` estão incluídos nos dois locks do módulo.
- As asserções do teste de laboratório foram atualizadas para exigir revisão em vez de patches; esse teste não foi executado por exigir imagem.
- A execução usou Node 24 no host. O gerente deverá reconstruir a imagem Node 22 e executar os laboratórios e a integração com a CLI. A suíte completa, o laboratório, a imagem, a instalação viva e logins reais ficaram fora desta rodada. `digest.txt` não foi alterado.
