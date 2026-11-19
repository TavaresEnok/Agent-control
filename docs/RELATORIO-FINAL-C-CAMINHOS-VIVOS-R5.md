# Relatório R5 — privacidade em caminhos de rotas

Base do worktree: `35da9db4`. A correção conserva as alterações parciais já presentes neste worktree.

- A detecção existente de `BASE64_SECRET` precede as exceções de caminho e identificador: sequências coincidentes são redigidas mesmo em parâmetros, grupos, prefixos de interceptação e diretórios anteriores a `app`.
- A exceção para rotas longas exige folha reconhecida e valida todos os componentes delimitados após `app`, inclusive os curtos. O caminho relativo pode conter diretórios de pacote antes de `app`. Os nomes longos exigem forma descritiva, com sufixo de versão numérico opcional; texto livre não recebe essa exceção.
- A prova integrada usa `runVerificationModule`, com repositório e resultados de ferramentas sintéticos, e verifica a publicação em mapa, cobertura e achados. Inclui rota dinâmica descritiva, pacote de monorepo e versão V2, além de controles de conteúdo opaco e delimitadores desbalanceados.
- Não houve mudança em esquemas, coleta ou estrutura de relatórios. As heurísticas são conservadoras: uma sequência descritiva que coincida com `BASE64_SECRET` também é redigida.

Verificação local:

- `npx tsc --noEmit --skipLibCheck`: aprovado.
- `node --import tsx --test --test-concurrency=1 tests/module-arquitetura.test.ts`: 28 aprovados, 4 ignorados, nenhuma falha, com TypeScript 5.9.3 do cache local instalado temporariamente fora do worktree. O link de dependências preexistente foi restaurado. Os testes ignorados dependem de hadolint ou binários do módulo indisponíveis.
- A primeira execução encontrou seis falhas porque o link preexistente de dependências estava quebrado e o TypeScript 7 da raiz não fornece a API esperada pelo coletor; a execução com a versão fixada resolveu essas falhas.
- Não foram executados suíte completa, laboratório ou instalação viva.
