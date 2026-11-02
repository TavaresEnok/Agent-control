# Empacotamento de fontes — 02/11/2026

Implementado `scripts/package-source.py` e instruções em `docs/operations/DISTRIBUTION.md`.

O comando exige um commit explícito e usa blobs Git, portanto não incorpora mudanças vivas, contas ou `.state`. Exige locks, snapshots upstream, proveniência exata dos fontes próprios e hashes de alterações upstream. Recusa caminhos privados rastreados, credenciais de alta confiança nos arquivos próprios/modificados, symlinks externos e saída dentro do repositório. Não sobrescreve um destino existente.

O arquivo tar.gz contém uma única cópia dos fontes selecionados, manifesto SHA-256 por entrada e identidade do commit; metadados são determinísticos. Leitura dos blobs durante o arquivo usa processo Git batch, evitando lançar um processo para cada arquivo upstream. Não inclui dependências, builds ou serviços reais. `--check` valida a seleção sem gerar um pacote grande.

O CI ganhou job isolado `source-distribution`, com uma prova pequena do empacotador e verificação da proveniência do commit. Nenhuma publicação ou instalação está incluída. A prova local `tests/package_source_test.py` passou em cerca de 0,2 s: dois pacotes iguais do mesmo commit, exclusão de dados vivos, hashes internos, recusa de sobrescrita, recusa de caminho privado comprometido e de chave privada em fonte comprometido. Evidência: `source-package-first-20261102.log`, exit 0.

Não gerei novo pacote completo de upstreams nesta frente. O commit final da integração ainda precisa atualizar proveniência e passar `--check`; hashes anteriores devem ser recusados quando desatualizados. O scanner é limitado, e fixtures upstream públicas inalteradas preservam sua origem. Não comprova ausência universal de segredos, build reprodutível integral, operação ou homologação de produção.

## Revisão do layout de build

A revisão independente do `scripts/prepare-build.mjs` corrigido verificou por leitura: `--before` remove somente symlinks que apontam exatamente para a fonte correspondente; recusa root/parents inesperadamente simbólicos; preserva arquivos/diretórios emitidos. O pós-build usa leaf links de runtime Cezar/Happier sem transformar novamente `dist/upstream` inteiro em link para as fontes. Isso mantém a emissão dos contratos TypeScript dentro de `dist` e permanece compatível com o pacote de fontes, que exclui `dist`.

Não repeti build nesta revisão. A comprovação dos quatro JS acidentais e os testes focados pertencem à frente que implementou a correção. Antes do commit/pacote final, a proveniência precisa incluir a versão final do script e excluir esses arquivos gerados da seleção Git.

O empacotador também passou a verificar explicitamente o SHA-256 dos dois patches históricos contra `upstream/PROVENANCE.json`; a fixture pequena continuou aprovada (`source-package-patch-provenance-20261102.log`).
