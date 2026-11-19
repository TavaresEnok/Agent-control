# Conformidade R4 — correções e evidências

Base de trabalho: `5a9fcd9491d41854abbb36ce09381bb99eb05c57`. A alteração agrega entradas excluídas do snapshot em uma única linha e conserva a contagem no resumo; o limite de linhas por arquivo continua reservando espaço para resumos e cobertura das ferramentas. Achados continuam condicionados à cobertura `ok` da ferramenta para o arquivo, ou à cobertura global explícita. O aviso de saída informa também achados acima de 999.

A triagem de texto e nomes verifica entropia sem exceções baseadas na forma de identificador ou caminho. A expressão suprimida pelo ScanCode é contada em cobertura `skipped`, sem incluir seus fragmentos; a medição do arquivo continua registrada. O limite e as heurísticas podem excluir nomes legítimos de alta entropia; isso é conservador, não uma identificação definitiva de segredo.

`id_generator.py` continua protegido como qualquer basename iniciado por `id_`, conforme `isSecretClassBasename` do host, com controles positivo e negativo. A publicação do módulo aceita `password-reset.ts` nas funções `assertModuleRepoRelativePath` e `validateModuleCollectorPublication`; o fluxo separado de reverificação aplica proteção adicional a esse nome. O coletor mantém sua exclusão conservadora, sem relaxar controles.

Verificações locais com dados sintéticos:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-conformidade.test.ts`: 38 testes passaram; após acrescentar controles ao último teste, ele foi executado novamente isoladamente e passou.
- O cenário novo cria 4.999 exclusões `.env.*`, arquivo elegível e nomes protegidos/opacos; verifica medição preservada, supressão isolada de LicenseRef, cobertura global, falha parcial e contagem de achados omitidos acima de 999. Os testes existentes exercitam o consumidor com saída injetada e Ledger simulado.

Não foram executados suíte completa, laboratório, imagem, transporte físico do coletor ou instalação viva. A identificação exata do modelo desta sessão não é fornecida ao executor; o trailer solicitado consta no commit e não constitui verificação independente dessa identidade.
