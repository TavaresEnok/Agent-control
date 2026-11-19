# C9 — Conformidade (LGPD e licenças)

O coletor usa ScanCode Toolkit 32.5.0 para identificar licenças por arquivo e metadados de pacote. Nos lockfiles npm v2/v3, inventaria licenças declaradas e sinaliza para revisão dependências proprietárias ou de copyleft forte em projetos com licença permissiva conhecida. Reconhece alternativas em expressões SPDX, como `MIT OR GPL-3.0-only`. [Documentação do ScanCode](https://scancode-toolkit.readthedocs.io/en/stable/reference/scancode-cli/index.html)

O ORT 97.2.0 importa até 500 declarações npm em documentos SPDX gerados pelo coletor. Somente o leitor `SpdxDocumentFile` fica habilitado. Os documentos usam identificadores sintéticos, valores de licença reconhecidos e relações de inventário. O ORT recebe esse diretório temporário sem arquivos, configurações, scripts ou URLs de dependências do projeto. A cobertura informa quantas declarações o ORT processou por lockfile. [Distribuição do ORT](https://github.com/oss-review-toolkit/ort/releases/tag/97.2.0) · [Analisador SPDX do ORT](https://oss-review-toolkit.org/ort/docs/tools/analyzer)

O Presidio Analyzer 2.2.366 mede CPF, e-mail, telefone e nomes de pessoa com modelos português e inglês empacotados. O reconhecedor de CPF confere os dois dígitos verificadores e descarta sequências repetidas. A análise estática indica campos e chamadas de rede, log ou armazenamento na mesma linha. As evidências mostram o tipo e o local da ocorrência, com supressão do valor e do trecho analisado. [Documentação do Presidio](https://microsoft.github.io/presidio/analyzer/)

## Provas executadas

- Sete testes focados passaram. Conferem os locks, os dígitos do CPF, a supressão dos valores, a triagem de licenças e a normalização do JSON. Também simulam as respostas de ScanCode e ORT e exercitam a falha de entrada.
- A política SPDX também foi executada com o wheel fixado de `license-expression` e com os dois lockfiles sintéticos. A licença forte gerou o alerta no defeito plantado. O controle gerou o inventário MIT sem aquele alerta.
- O `tsc` focado nos dois testes e `sh -n` do entrypoint passaram. O `npx tsc --noEmit --skipLibCheck` padrão encontrou os artefatos `upstream/cezar/packages/cezar/dist` ausentes no worktree. A checagem completa passou com um `tsconfig` temporário que consultou os artefatos já presentes no checkout principal por `rootDirs`.
- Foram conferidos os metadados dos 119 wheels do PyPI para Python 3.13 e linux/amd64, os hashes dos dois modelos spaCy baixados e do pacote Debian `libgomp1`, e os digests linux/amd64 das imagens-base. O Dockerfile verifica o SHA-256 publicado do arquivo ORT durante o build.
- O laboratório com a imagem pelo digest ficou para a integração pelo gerente.

## Build e laboratório da integração

Na raiz do repositório, o gerente constrói a imagem usando somente o contexto do módulo e registra o ID local imutável.

```sh
docker build --platform linux/amd64 -t ac-module-conformidade:c9 deploy/modules/conformidade
docker image inspect --format '{{.Id}}' ac-module-conformidade:c9 > deploy/modules/conformidade/digest.txt
AC_MODULE_LAB=1 node --import tsx --test tests/module-conformidade-lab.test.ts
```

O laboratório roda o ENTRYPOINT como UID/GID 65532, com rede desligada, raiz e `/repo` somente leitura e `/tmp` gravável. Em `com-defeito`, exige que ScanCode encontre GPL no arquivo, que a política npm sinalize revisão, que o ORT classifique a declaração como copyleft forte e que Presidio e a análise estática encontrem o CPF sintético e seu uso em log. Em `limpo`, exige cobertura bem-sucedida, inventário de MIT e ausência dessas ocorrências. Nas duas entradas, o teste confere que o CPF sintético não aparece na saída.

## Limites

O ORT mede a interpretação das declarações que recebe. A resolução de dependências, o download de componentes e a avaliação de toda a cadeia de distribuição ficam fora desse recorte. Dependências sem licença explícita no lockfile permanecem desconhecidas. Os alertas de compatibilidade indicam situações para revisão e dependem de informações sobre distribuição e vínculo.

A análise de privacidade é estática. Os sinais de saída dependem da proximidade sintática, e fluxos entre arquivos, payloads produzidos em execução e destinos indiretos exigem outras provas. O recorte lê até 1.500 arquivos regulares e 64 MiB no total, com limite de 4 MiB por arquivo. Presidio examina as extensões de texto elegíveis e UTF-8 até 128 KiB por arquivo. Links, arquivos excluídos pela política do snapshot e arquivos fora dos limites são registrados na cobertura. O esgotamento do limite de saída é registrado como falha com a contagem omitida. A avaliação de conformidade jurídica depende de revisão humana.
