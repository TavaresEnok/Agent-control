# Compatibilidade de caminhos na arquitetura

## Diagnóstico

Uma fixture sintética reproduziu `VERIFY_PATH_FORBIDDEN` no parser de publicação em dois casos independentes. O Knip informou um achado em uma rota Git com parênteses e colchetes, caracteres ausentes da lista de permissões do parser. O JSCPD simulado informou um achado em um arquivo de configuração exemplo, que a cópia do coletor deixava passar embora o parser recusasse a classe do nome.

O parser valida `findings[].file` e `coverage[].files` como caminhos relativos. A execução ainda exige que esses caminhos resolvam para arquivos regulares do commit arquivado, sem seguir symlinks. As linhas de cobertura que dependiam exclusivamente de `detail` podiam perder a identidade do arquivo durante o saneamento desse texto.

## Correção

- A lista de caracteres dos caminhos comuns aceita `()[]`, inclusive para parâmetros de rota com colchetes duplos. Permanecem as recusas de segmentos proibidos, nomes de classe secreta, travessia, controles e caminhos absolutos. A regra de localização protegida da prontidão conserva a sua lista de caracteres anterior.
- A cópia de arquitetura exclui entradas de nomes reservados ou fora do contrato antes de disponibilizar arquivos às ferramentas. Os adaptadores usam o inventário da cópia para aceitar localizações e referências de achados. A cobertura indica as omissões em contagens, e diagnósticos de processo registram o status sem reproduzir a saída da ferramenta.
- As medições válidas carregam `files` estruturado. Os detalhes e as evidências continuam passando pelo saneamento do parser. Os rótulos de contagem de tokens do JSCPD permanecem legíveis após esse saneamento.
- O exame da arquitetura também agrega as entradas indisponíveis do inventário. A fixture percorreu `git archive`, coletor, parser, inventário do exame e gravador de relatórios. Confirmou a preservação das medições e dos achados válidos, a ausência dos caminhos omitidos nos artefatos e o saneamento de um valor fictício em evidência.

## Verificação e alcance

- `env -u AC_TEST_DATABASE_URL node --import tsx --test tests/module-arquitetura.test.ts tests/verification-modules.test.ts` passou com 26 testes, incluindo os binários fixados sobre a rota sintética. Dois testes foram pulados por ausência de Hadolint e pela desativação da integração com banco.
- `npx tsc --noEmit --skipLibCheck` passou.
- `git diff --check` passou.

A reprodução sintética identificou duas causas possíveis para o sintoma. A ocorrência original permanece sem atribuição a uma entrada específica. A instalação carrega o coletor da imagem fixada. A adoção da correção nesse ambiente depende da publicação de uma imagem que inclua este commit.
