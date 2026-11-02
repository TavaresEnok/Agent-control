# Distribuição de fontes — sem implantação

O pacote-fonte contém um snapshot de **um commit Git**, incluindo cada checkout upstream uma única vez. Não é imagem de produção, backup operacional, exportação de contas ou instalação pronta. Dependências, builds, dados de runtime e credenciais não acompanham os fontes.

Antes de empacotar, finalize a implementação/revisão, atualize `upstream/CHANGES.json` e a proveniência com os scripts existentes e faça commit local. Não há push/publicação neste procedimento. O empacotador lê objetos Git, não os arquivos vivos: alterações ainda não commitadas não entram no pacote.

Validação sem gerar arquivo grande:

```bash
python3 scripts/package-source.py --commit HEAD --check
```

Pacote determinístico, destino **fora do repositório** e ainda inexistente:

```bash
python3 scripts/package-source.py --commit COMMIT_COMPLETO --output /tmp/agent-control-COMMIT_COMPLETO.tar.gz
```

O comando retorna SHA-256 do arquivo. O tar.gz contém `agent-control/SOURCE-REVISION.txt` e `SOURCE-MANIFEST.json` com caminho, modo, tamanho e SHA-256 de cada arquivo. UID/GID, ordem, data e cabeçalho gzip são normalizados. Duas execuções com o mesmo commit/ambiente Python geram o mesmo arquivo; mudanças de zlib/Python podem mudar a compressão sem mudar os hashes dos fontes.

## Recusas e limites

Exige locks root/Cezar/Happier, versões upstream fixadas e proveniência de todos os fontes próprios/patches modificados. Proveniência velha ou incompleta recusa a entrega. Caminhos privados/dependências rastreados (`.state`, `.git`, `node_modules`, `.env` que não seja exemplo) recusam o pacote em vez de esconder o erro; `dist`, caches Python e metadados de compilação são excluídos. Symlinks absolutos ou que escapem do snapshot são recusados. Não sobrescreve destino existente.

Há detecção limitada de chaves privadas e formatos de tokens nos fontes próprios e arquivos upstream modificados. Fixtures públicas upstream inalteradas mantêm sua proveniência. Isso não equivale a DLP universal: revisão humana/secret scanning permanecem necessários antes de publicar. Nenhuma credencial de `.state` é lida ou precisa existir para empacotar.

## Uso após extração

1. Extraia em diretório novo e isolado, nunca sobre instalação operacional.
2. Confira `SOURCE-REVISION.txt` e os hashes de `SOURCE-MANIFEST.json` antes de executar scripts.
3. Leia `AGENTS.md`, `docs/STATUS.md`, os documentos normativos e `docs/operations/LAB.md`.
4. Instale os locks e use somente a bancada autorizada. A configuração `administration-only` é uma fatia de produto; não autoriza inferência, contas reais ou migração.
5. Builds/types/testes e evidências do commit são distintos da integridade do arquivo. O empacotador não declara nenhum gate completo.

A prova pequena do empacotador usa repositório temporário com dados sintéticos; não gera outra cópia gigante dos upstreams.
