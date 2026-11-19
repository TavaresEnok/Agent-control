# C8 R10 — Associação de arquivos e linhas nos diagnósticos

O coletor de documentação resolve os avisos de símbolo sem documentação do TypeDoc 0.28.20 pelo caminho emitido. Ele usa o nome do pacote e o caminho relativo ao manifesto mais próximo na cópia analisada. O formato `<unknown>/` carrega o caminho absoluto quando o TypeDoc não encontra um pacote. Se dois arquivos geram o mesmo caminho de diagnóstico, o aviso fica sem atribuição, mesmo que apenas um arquivo apareça na reflexão. Uma origem única sem declaração confirmada é registrada com a linha da declaração indeterminada.

A busca por `@param` e links ignora trechos de código inline, inclusive os que atravessam linhas. Duas tags compatíveis na mesma linha contam como uma localização. Se as tags compatíveis aparecem em linhas diferentes, o achado usa a linha da declaração e informa que a linha da tag é indeterminada.

O coletor usa os formatos de mensagem do TypeDoc 0.28.20 e do Mermaid 12.3.0. O aviso TypeDoc com sugestão exige a frase completa e a sugestão correspondente ao alvo. O Mermaid preserva a rejeição do bloco e indica que a linha do erro é indeterminada quando a mensagem ou a versão não permite localizar o erro. O catálogo JSON do TypeDoc continua disponível quando a interpretação das mensagens é desativada.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos com Node 22.23.4.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa' tests/module-documentacao.test.ts` passou em 26 testes com fixtures sintéticas e as ferramentas fixadas. O filtro excluiu o teste do entrypoint, e o teste de laboratório ficou desativado.
- `git diff --check` concluiu sem apontamentos.

O digest `sha256:9b45c131679e7651ffdd982d9ab731fcaf18c06fa830d1c52e7a4d6b78fd0666` foi preservado para a homologação do gerente. A verificação ficou restrita ao worktree `final-c8` e ao arquivo de testes do coletor.
