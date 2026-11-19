# C3-R5 · Correções de arquitetura

Base `0496c480`. A ordem corrige os três casos da revisão de `ffbed51e`, sem alterar o digest da imagem.

- **Cópia privada:** arquivos regulares são abertos sem seguir link no arquivo final e copiados com modo privado gravável, sem modificar a origem. O limite de tamanho também é aplicado durante a leitura. A prova com os binários fixados executou o coletor como usuário sem privilégios sobre `tsconfig.json`, `tsconfig.base.json`, `package.json` e `pnpm-workspace.yaml` sintéticos em modo `0444`; confirmou a análise e preservou conteúdo e modo dos originais. A prova de cópia também verifica a exclusão de symlink.
- **Herança TypeScript:** os separadores dos `extends` locais são normalizados antes da resolução e na configuração saneada, com destinos limitados aos arquivos presentes no snapshot. A regressão cobre herança aninhada dentro da cópia, referência para fora, pacote externo e symlink; o dependency-cruiser fixado também resolveu um alias herdado por uma referência com barra invertida.
- **Knip:** os padrões gerados ignoram diretórios de testes e fixtures em qualquer nível. O parser aplica o mesmo conjunto de candidatos aos achados de código e às métricas por arquivo; dependências de manifestos continuam registradas, exceto em diretórios ignorados. As provas sintéticas cobrem arquivos incluídos e excluídos, contagem de problemas por arquivo e achados de manifesto; a prova com o Knip fixado cobre diretórios aninhados e arquivos `.mts` e `.cts` elegíveis.

## Validação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-arquitetura.test.ts`: 16 testes passaram e um foi pulado por ausência de `hadolint`; nenhum falhou. Os binários fixados foram instalados no worktree com `npm ci --omit=dev --no-audit --no-fund` e usados com entradas sintéticas.
- Não foram executados suíte completa ou laboratório, nem reconstruída imagem; a prova da imagem e eventual atualização do digest cabem à integração.
