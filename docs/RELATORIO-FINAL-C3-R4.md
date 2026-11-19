# C3-R4 · Arquitetura e dívida técnica

Base `c1536db0`. Correções da revisão estática de `6f17bdfa` no coletor, nas fixtures e nas provas do módulo 3.

| Área | Correção e evidência |
| --- | --- |
| Cópia | Uma falha fatal retorna JSON com `snapshot: failed`, o caminho relativo e o código do erro. Uma regressão executou o coletor como usuário sem privilégio com um arquivo de modo `000` em uma raiz acessível e recebeu `EACCES` no JSON. O cenário de raiz ilegível continua com a rejeição anterior. |
| Omissões e limites | O snapshot registra o motivo das omissões conhecidas, inclusive diretórios excluídos, links, entradas ilegíveis e arquivos acima de 2 MiB. A cópia limita-se a 10 mil arquivos e identifica a primeira entrada restante quando atinge o teto. Cada ferramenta informa quantas linhas por arquivo foram exibidas e quantas foram medidas. Uma regressão com 501 arquivos verificou o corte declarado de 500 linhas para as quatro ferramentas e registrou um arquivo acima do limite. A lista de omissões conhecidas tem o mesmo teto de detalhe e sinaliza seu próprio corte. |
| Knip 6.46.1 | O adaptador usa os módulos da distribuição fixada para obter os nós analisados e as entradas confirmadas pelo Knip e usa o JSON da ferramenta para os arquivos não alcançados. O coletor registra quantos candidatos ficaram sem medição comprovada. A fixture contém um `.mts` e um `.cts` não alcançados, ambos confirmados com binários reais. O adaptador usa a configuração gerada, desativa as chaves reais do registro de plugins e remove diretivas de carregamento dos manifestos na cópia antes da análise do Knip. |
| dependency-cruiser 18.8.0 | O sanitizador preserva herança local com e sem a extensão `.json` na cadeia de configurações copiadas. Um teste com a ferramenta real resolveu um alias herdado e produziu a violação domínio → infraestrutura. Um teste simulado verificou que um JSON válido acompanhado de saída não zero mantém `failed`. |
| Ciclos e localização | Uma aresta circular produz um achado de ciclo e conserva as violações de camada próprias. A posição vem do literal da importação no AST quando disponível. A regressão inclui o mesmo especificador em comentário, string e importação multilinha. |
| jscpd 5.4.3 | O binário decide quais formatos do snapshot consegue medir. As contagens vêm dos relatórios de duplicação e complexidade, com `skipped` quando ambos registram zero arquivos. A regressão com um projeto apenas SQL confirmou a medição. As duas execuções usam o mesmo limite de 2 MiB por arquivo. |
| Complexidade AST | Getters, setters e inicializadores de parâmetros entram na medição por função. Funções aninhadas continuam com contagem própria. |
| Entrypoint e laboratório | O entrypoint força `AC_REPO_DIR=/repo` após validar o volume. O comando Docker do laboratório usa `--pull=never`. As provas do laboratório conservam o controle limpo e os defeitos anteriores, com asserções adicionais para `.mts`, `.cts`, ciclo por aresta e linha do import. |

## Validação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-arquitetura.test.ts` executou 16 casos com entradas sintéticas, 15 aprovados e um pulado por ausência de `hadolint`. As provas com binários reais usaram as versões do lockfile em uma instalação local ao worktree.
- `package-lock.json` e `tools.lock.json` constam na árvore da base. O progresso do gerente registra o laboratório anterior e o digest fixado em `c1536db0`. O build da rodada, a prova em contêiner e a atualização do digest ficam com o gerente.
