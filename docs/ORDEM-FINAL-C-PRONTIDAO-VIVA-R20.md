# Unifica os operadores de redirecionamento e limita a recuperação de comandos malformados

Feche os três defeitos médios específicos da R19. Use uma lista única e ordenada dos operadores de redirecionamento do shell para léxico e recuperação (inclua <> e >|), preserve operandos, quebras de linha e fronteiras verificáveis. Use separadores lexicais ASCII do shell e não a classe Unicode de espaços. Para substituições em shell malformado, evite adivinhar a gramática: aceite um subconjunto simples delimitado, suficiente para os controles positivos existentes; se o interior exigir interpretar estrutura composta (case, heredoc e demais sintaxes fora desse subconjunto), pare conservadoramente antes da substituição, sem expor conteúdo interno. Considere manter apenas os tokens/segmentos exteriores cuja interpretação seja inequívoca e documente positivamente o contrato dessa recuperação e o da retenção no doc do módulo ou no coletor. Não implemente interpretação geral nem novas capacidades do produto. Teste os controles positivos e negativos dos três casos pelo auditor.

**Parecer sobre `eb32fde0..54a38c06` — o diff corrige os quatro mecanismos apontados em R18, mas eu não aprovaria o fechamento.** O recuperador ainda pode perder evidência de um comando externo ou atribuir evidência ao pilar errado ao sair prematuramente de uma substituição.

### Defeitos

- **Média — redirecionamentos válidos interrompem a recuperação.** No corpo de `sh -c` `df -P / <>/dev/null; echo "`, o recuperador separa `<>` em dois operadores. `emit()` rejeita `<` porque o próximo token é `>`, e o `df` fica fora da medição. Em `df -P / >|/dev/null; echo "`, o scanner trata `|` como separador e tenta emitir um fragmento terminado em `>` sem operando. Nos dois casos, `disco-memoria` perde a parcialidade esperada. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2406)

- **Média — o parêntese de um padrão `case` expõe comandos internos de `$()`.** No corpo de `sh -c` `echo $(case x in y) :; df -P /;; esac); echo "`, `substitutionEnd()` toma o `)` de `y)` pelo fim da substituição. O recuperador passa a tratar `df -P /` como segmento externo e pode marcar `disco-memoria` como `failed`. O `df` está dentro de uma substituição que deveria ser opaca, em um ramo que o seletor `x` nem alcança. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2380)

- **Média — o início de palavra ainda diverge da gramática do shell.** Em `echo "$(printf '%s' x #)"; df -P /; echo "`, há um espaço não separável, U+00A0, entre `x` e `#`. Ele faz parte da palavra no shell, mas `\s` ativa `wordStart`. O scanner interpreta `#` como comentário até o fim da entrada e perde o `df` externo. O controle com espaço ASCII escapado corrige R18 e deixa esse caso descoberto. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2394)

### R18 e cobertura da ordem

| Cenário | Resultado da leitura estática |
|---|---|
| `-path` ou `-ipath` com `-delete` | A expressão deixa de dar prova de retenção e aciona parcialidade de `backup-restauracao`. O controle só com `-print` mantém `ok`. |
| Dois filtros de nome incompatíveis | O segundo filtro invalida a prova. Os controles com um basename, um tipo e uma idade continuam positivos. |
| `df` como destino de `>&` | O destino é consumido como operando. Os controles negativos cobrem entrada e saída, inclusive com descritor, e verificam os três pilares. |
| `#` após espaço escapado dentro de `$()` | O `#` permanece na palavra, inclusive na variante aninhada. Os controles positivos cobrem `df`, `alertmanager`, `logrotate` e `npm run personal:backup`. O caso novo fecha o segmento de `df` com `;` e abre a aspa em `echo`. O exemplo original deixa a aspa no próprio segmento de `df`, cuja finalização ficou fora do trecho fornecido. |

A gramática implementada exige um `-mtime +N`, um `-delete` terminal, no máximo um `-name` ou `-iname` ASCII simples e um `-type`. Ela aceita conjunção implícita, `-a` e `-and`, além das opções `-depth`, `-xdev` e `-mount`. Rejeita `.` e `..` como padrões literais e nomes cujo comprimento mínimo excede 255 bytes. A parcialidade de uma expressão com `-path`, dois padrões ou uma ação adicional é uma restrição deliberada da prova estática, mesmo quando uma expressão específica funcionaria na instalação. Os defeitos acima decorrem de identificar incorretamente a fronteira de um comando. O diff fornecido acrescenta comentários e testes, mas não reúne a gramática em documentação. [Gramática no coletor](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2267) · [Controles R19](/home/app/projects/agent-control/tests/module-prontidao.test.ts:2887)

### Publicação e pilares

Os cenários alteram a medição do pilar. Na validação fornecida, `coverage.status`, os caminhos de `coverage.files` e os caminhos de `findings.file` passam por verificações próprias. A linha `failed` representa cobertura parcial. Uma recusa por caminho exige que um caminho submetido viole o contrato, com regras adicionais para achados em arquivo protegido. O diff não muda essas regras. O trecho do executor termina antes da agregação e da publicação, portanto não dá para confirmar ali o efeito final em `toolFailures` ou no estado publicado. [Validação da saída](/home/app/projects/agent-control/src/verification-modules.ts:620) · [Recepção da saída pelo executor](/home/app/projects/agent-control/src/verification-modules.ts:1959)

O sandbox impediu a leitura direta do checkout. A revisão se baseia no diff e nos trechos fornecidos. Os testes físicos ficam a cargo do gerente.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-PRONTIDAO-VIVA-R20.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>.
