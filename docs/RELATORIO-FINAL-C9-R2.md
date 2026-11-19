# C9-R2 — inicialização do ScanCode

## Diagnóstico

O build do gerente instalou `scancode-toolkit 32.5.0`, `plugincode 32.0.0` e `pluggy 1.7.0`; `pip check` passou, mas o comando real ScanCode falhou ao registrar `pre_scan`. O `plugincode` decora a classe `PreScanPlugin` como especificação de hook. O `pluggy 1.7.0` restringe a descoberta a funções e métodos, deixando de reconhecer essa classe. Os metadados de `plugincode` declaram apenas `pluggy >= 0.12.0`, portanto não impedem essa combinação incompatível.

Em ambiente isolado Python 3.12, com os wheels reais, a importação de `plugincode.pre_scan` reproduziu o mesmo `ValueError` com `pluggy 1.7.0`. Substituindo apenas esse pacote por `pluggy 1.6.0`, as importações dos estágios `pre_scan`, `scan`, `post_scan`, `output` e `output_filter` passaram. Essa prova isola a incompatibilidade, mas não substitui a execução do ScanCode completo no Python 3.13 da imagem.

## Alterações

- Fixado `pluggy 1.6.0` no `requirements.lock`, com SHA-256 do wheel `e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746`; atualizado o hash do lock em `tools.lock.json`. O Dockerfile instala com `--require-hashes` e mantém a execução real do ScanCode no prewarm.
- Acrescentado um teste focado para proteger o par de versões e os hashes; o teste existente também confere o hash do lock e as opções de instalação da imagem.
- A prova de licenças e dados artificiais no laboratório e `digest.txt` não foram alterados.

## Verificação

- `node --import tsx --test tests/module-conformidade.test.ts`: 8 testes passaram.
- `npx tsc --noEmit --skipLibCheck`: falhou neste worktree; faltam módulos gerados em `upstream/cezar/packages/cezar/dist`, com erros adicionais de tipos no código e testes que dependem deles. Nenhuma alteração de TypeScript do escopo foi indicada no resultado.
- Não foram executados build de imagem, laboratório ou suíte completa, conforme a ordem. O gerente deve refazer o build e o laboratório para validar o comando real e a detecção no ambiente Python 3.13 da imagem.
