# C9 — proteção de nomes opacos com separadores (R6)

A exceção para identificadores com sublinhados foi removida. A proteção volta a avaliar cada segmento completo do caminho, inclusive seus separadores, pelo mesmo limite de tamanho e entropia. As entradas excluídas são contabilizadas no escopo, sem publicar seus nomes.

A fixture sintética cobre um identificador descritivo abaixo do limite que continua selecionado e medido, um nome opaco dividido em grupos curtos, `account_subscription_preferences` com 32 caracteres e um nome descritivo mais longo. Os três últimos são excluídos. Essa é uma consequência conservadora: nomes descritivos que cruzam o mesmo limiar de um nome opaco também deixam de ser medidos, pois o sinal não permite distingui-los com segurança. A cobertura da fixture verifica a ausência do nome opaco e de seus fragmentos exclusivos na saída e preserva a medição e a publicação do arquivo elegível.

O comportamento de SPDX foi preservado: campos ausentes ou nulos não contam como supressões; a fixture mista mantém dois achados, três expressões rejeitadas e cobertura `ok` para o arquivo medido. O contador de exclusões do snapshot conta entradas, não expressões.

Verificação local com dados sintéticos:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-conformidade.test.ts`: 39 testes passaram. Uma execução anterior falhou por uma asserção da fixture que incluía fragmento compartilhado com o controle permitido; a asserção foi corrigida e o arquivo foi executado novamente.
- `git diff --check`: passou.

Não foram executados a suíte completa, laboratório, reconstrução de imagens ou testes na instalação viva.
