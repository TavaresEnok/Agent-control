# Módulos de verificação

Criado em 16/11/2026. Um módulo examina um sistema inteiro, que pode estar em criação ou já em produção, e grava um relatório detalhado. Cada achado do relatório vira tarefa para o fluxo normal (gerente, programador, QA e revisor) corrigir.

A pesquisa de ferramentas foi feita em 16/11/2026 em páginas e repositórios do GitHub. Licenças e números de estrelas mudam com o tempo e devem ser conferidos de novo quando cada ferramenta for instalada.

## O limite, dito com clareza

Nenhum conjunto de ferramentas garante que um sistema não tem falha nem erro. Os testes provam apenas que o sistema não falhou nos casos tentados. Requisitos errados ou esquecidos passam por todos eles. O que os módulos garantem é outra coisa, e é verificável:

- cada arquivo e cada rota foram examinados, e há uma tabela de cobertura que mostra quem examinou o quê;
- cada achado tem prova (arquivo, linha, cenário e, quando possível, um teste que falha);
- cada correção só fecha com um teste que falhava antes e passa depois, mais uma nova verificação do mesmo ponto;
- a mesma verificação roda de novo depois (periodicamente e a cada mudança grande), para pegar o que voltou.

Isso reduz muito o risco. Não o zera. Produção real continua exigindo a revisão externa de `docs/REVISAO-SEGURANCA-EXTERNA.md`.

## Como todo módulo funciona

O esqueleto é o mesmo em todos os módulos. Ele é construído uma vez, junto com o módulo 1, e os outros módulos reaproveitam esse esqueleto com ferramentas e listas de verificação próprias.

```
pedido ──► 1 coleta ──► 2 mapa ──► 3 exame ponto a ponto ──► 4 confirmação ──► 5 relatório ──► 6 correção ──► 7 nova verificação
          (ferramentas)  (o que existe) (agentes por fatia)    (outro provedor)   (pasta .md)    (fluxo normal)   (fecha o achado)
```

1. **Coleta.** Ferramentas de linha de comando rodam num contêiner próprio, a "imagem de verificação". Elas não usam IA.
   - Cada ferramenta tem versão fixa e digest conferido. Em março de 2026, versões do Trivy e da action do KICS foram adulteradas; ferramenta de segurança também pode ser ataque.
   - O código fica montado só para leitura. O contêiner não tem login de conta de IA, não tem socket do Docker e roda sem rede.
   - As bases de vulnerabilidade são baixadas antes, num passo separado.
   - A saída é SARIF ou JSON. Tudo é normalizado num único `achados-brutos.json`.
2. **Mapa.** Um agente monta o mapa do sistema e grava em `mapa.md`. Por exemplo: rotas, telas, entradas externas, banco, filas, segredos, dependências e onde roda. Esse mapa também divide o sistema em fatias de tamanho que um agente consiga ler inteiro.
3. **Exame ponto a ponto.** Cada fatia vai para um agente examinador, com:
   - a lista de verificação do módulo;
   - o mapa;
   - os achados das ferramentas que caem naquela fatia.

   O examinador precisa marcar cada arquivo da fatia como lido. É isso que alimenta a tabela de cobertura: nenhum arquivo fica sem dono. Ele usa o papel `specialist`, que já existe no runtime e na capacidade, e não escreve no repositório.
4. **Confirmação.** Cada achado vai para um verificador de outro provedor. O verificador recebe o código e o achado, nunca a conclusão do examinador, e tenta derrubar o achado. Resultado: `confirmado`, `provável` ou `descartado`, com o motivo. Quando dá, ele também escreve um teste ou uma prova que mostra a falha. Assim o ruído das ferramentas não chega ao relatório.
5. **Relatório.** Fica em `<dataDirectory>/verificacoes/<projectId>/<data>-<módulo>/`, com permissão 0700. Não fica no repositório: um relatório de segurança é um mapa para quem ataca e não pode ir para o remoto por engano.

   | Arquivo | O que tem |
   |---|---|
   | `README.md` | resumo, nota geral, contagem por gravidade, o que não foi possível verificar |
   | `mapa.md` | o mapa do sistema |
   | `cobertura.md` | cada arquivo e rota, quem examinou, quais itens da lista foram aplicados |
   | `achados/ACH-001.md` … | um arquivo por achado, no formato abaixo |
   | `achados.json` | os mesmos achados para máquina (é o que vira tarefa) |
   | `bruto/` | saídas SARIF e JSON originais das ferramentas |

6. **Correção.** No painel, o botão "Corrigir" transforma os achados escolhidos em pedidos normais. Cada achado (ou grupo de achados no mesmo arquivo) vira um pedido com:
   - os caminhos de escrita;
   - o teste de regressão exigido;
   - o critério de aceite.

   O gerente planeja, o programador corrige e escreve o teste, o QA roda e o revisor confere, como já acontece hoje.
7. **Nova verificação.** Depois da integração, o módulo roda de novo só para os pontos corrigidos. O achado fecha com prova (`fechado`) ou volta (`reaberto`).

Formato de um achado:

```markdown
# ACH-007: (exemplo) rota de pedidos aceita projeto de outro dono
- Gravidade: alta | média | baixa | informativa
- Situação: confirmado (verificador: <modelo, provedor>)
- Referência: OWASP ASVS 5.0 V8 (autorização), CWE-862
- Onde: src/rotas/pedidos.ts:120
- Cenário: quem tem sessão no projeto A envia POST /pedidos com o id do projeto B e cria um pedido em B
- Prova: teste tests/seguranca/ach-007.test.ts (falha hoje) ou passos em homologação
- Correção sugerida: ...
- Critério de aceite: o teste passa; a nova verificação não reabre
- Fontes: regra opengrep X, examinador da fatia 3
```

**Regras que valem para todos os módulos:**

- **Produção nunca recebe ataque nem carga.** Os testes ativos, como varredura dinâmica, agente de intrusão, fuzz de API, carga e caos, rodam só contra uma URL de homologação declarada no pedido. A rede fica limitada a essa URL. Contra produção, só o que é passivo.
- **O código examinado não é confiável.** Ele pode trazer texto que tenta manipular o agente (injeção de prompt). Por isso:
  - a confirmação por outro provedor é obrigatória;
  - nada do relatório é executado sem passar pelo fluxo normal.
- O módulo pode rodar por pedido, por timer periódico ou depois de cada integração grande, só nos arquivos mudados.

## Os módulos, em ordem

| # | Módulo | Valor | Por quê nesta ordem |
|---|---|---|---|
| 1 | Validador de segurança | alto | é o que mais custa errar; constrói o esqueleto comum |
| 2 | QA pesado | alto | prova o funcionamento e mede se os testes valem algo |
| 3 | Arquitetura e dívida técnica | alto, barato | ferramentas leves, achados viram tarefas claras |
| 4 | Dependências e atualizações | alto | mantém tudo atual; correções mecânicas, boas para agentes |
| 5 | Banco de dados | alto se usa Postgres | evita queda por migração e lentidão por índice faltando |
| 6 | Prontidão para produção | médio-alto | confere TLS, cabeçalhos, backup, restauração, alertas e logs do sistema publicado |
| 7 | Desempenho | médio | onde é lento e se piorou |
| 8 | Documentação viva | médio | mantém o contexto dos agentes certo, o que reduz erro deles |
| 9 | Conformidade (LGPD e licenças) | médio | importa se há dados de clientes ou se o software é vendido |
| 10 | Design e experiência de uso | alto para sistemas com telas | pedido do titular em 17/11/2026; construído em paralelo ao módulo 1 |

Acessibilidade básica (axe-core) roda no QA pesado; a avaliação completa de acessibilidade e design fica no módulo 10. Custo de nuvem fica de fora: os sistemas rodam em servidor próprio.

### 1. Validador de segurança

Entrega um relatório com todas as falhas encontradas, cada uma confirmada e com prova, mais a cobertura que mostra que nada ficou sem exame.

| Fase | Ferramentas (código aberto) | Observação |
|---|---|---|
| Segredos, inclusive no histórico do git | gitleaks (MIT); TruffleHog `--only-verified` (AGPL-3.0) | TruffleHog verifica a credencial chamando o provedor; ligar só com autorização |
| Dependências e SBOM | OSV-Scanner (Apache-2.0); Syft e Grype (Apache-2.0); `npm audit`, `pip-audit` | SBOM CycloneDX guardado no relatório |
| Código (SAST) | Opengrep (LGPL-2.1, regras comunitárias); CodeQL se o repositório for público ou houver licença | Semgrep CE só com regras próprias: as regras oficiais têm licença restritiva desde 12/2024 |
| Dockerfile, IaC e imagens | Hadolint (GPL-3.0); Trivy config e Checkov (Apache-2.0) | Trivy por digest conferido, por causa do ataque de 03/2026 |
| Dinâmico, só em homologação | OWASP ZAP (baseline passivo; ativo só em homologação); Nuclei com tags escolhidas; Schemathesis | ffuf e sqlmap só sob pedido explícito |
| Agentes de intrusão, só em homologação | Shannon (AGPL-3.0, caixa branca, SARIF, aceita Claude e Grok); Strix (Apache-2.0, modo sem tela) | Estrelas aproximadas: Shannon 52 mil, Strix 76 mil (a conferir) |
| Exame ponto a ponto por IA | Lista própria baseada em OWASP ASVS 5.0, OWASP Top 10:2025, CWE Top 25 2025 e OWASP LLM Top 10 (sistemas com IA) | Inspirado nas skills da Trail of Bits (análise de variantes, verificação de correção) |

Ficam de fora: CAI (arquivado em 08/2026), HexStrike AI (servidor sem autenticação), PentestGPT (feito para uso humano), PentAGI (pesado; talvez depois) e DefectDojo (um JSON normalizado basta por enquanto). O `/security-review` e a action `claude-code-security-review` olham só o diff. Servem para a nova verificação depois da correção, não para o exame inteiro.

Primeiro alvo: o próprio Agent Control. O resultado serve de pré-revisão para a revisão externa.

### 2. QA pesado

[Prova do módulo 2 em homologação](#prova-do-módulo-2)

Entrega uma matriz que liga cada requisito e cada funcionalidade aos testes que a provam. Mostra também o que não tem teste e quão fortes são os testes que existem. Os testes novos entram como tarefas no fluxo normal, para passar por revisão.

| Fase | Ferramentas | O que prova |
|---|---|---|
| Testes existentes, rodados 3 vezes | runner do projeto, com cobertura de ramos (V8/istanbul, coverage.py, `go test -cover`) | o que passa, o que falha e o que oscila |
| Força dos testes | StrykerJS (Apache-2.0); mutmut (BSD-3-Clause) para Python; avito-tech/go-mutesting (MIT) para Go | mutante que sobrevive aponta teste fraco |
| Propriedades | fast-check (MIT); Hypothesis | regras valem para milhares de entradas geradas |
| Fuzz de entradas externas | Jazzer.js (Apache-2.0); fuzz nativo do Go; Atheris | parser e validador não quebram com lixo |
| Ponta a ponta e telas | Playwright (Apache-2.0), com os agentes planner/generator/healer e o Playwright MCP; `toHaveScreenshot`; axe-core | o sistema inteiro funciona pelo navegador, sem regressão visual e com acessibilidade básica |
| Contrato de API | Schemathesis (MIT); Pact (MIT) se houver dois serviços | a API cumpre o próprio OpenAPI e não dá erro 500 |
| Banco e migrações | Testcontainers; pgTAP; migração do zero e a partir de um dump antigo | o esquema e as consultas funcionam num banco real |
| Carga e falhas, só em homologação | k6 (AGPL-3.0); Toxiproxy (MIT) | aguenta a carga esperada e se recupera de rede ruim |

Cuidado: o healer do Playwright pode marcar como pulado um teste que achou um defeito real. Cada teste pulado vira achado.

Ficam de fora: Dredd (arquivado), Qodo Cover (sem manutenção), Chaos Mesh (exige Kubernetes) e OSS-Fuzz (serviço para projeto público).

### 3. Arquitetura e dívida técnica

[Prova do módulo 3 em homologação](#prova-do-módulo-3)

Entrega:

- código morto;
- duplicação;
- ciclos;
- violações de camada;
- arquivos complexos demais.

Ferramentas:

- knip (ISC);
- jscpd (MIT), que tem uma saída própria para IA;
- dependency-cruiser (MIT).

SonarQube fica de fora: é pesado demais para poucos sistemas.

### 4. Dependências e atualizações

[Prova do módulo 4 em homologação](#prova-do-módulo-4)

Entrega o que está velho, o risco de cada atualização e as mudanças de código prontas. Ferramentas:

- npm-check-updates (Apache-2.0);
- ast-grep (MIT) e jscodeshift (MIT) para reescrever código;
- OpenRewrite (Apache-2.0) para Java;
- Renovate (AGPL-3.0) em modo local, opcional.

O SBOM do módulo 1 é reaproveitado. Cada atualização vira um pedido separado, com o QA do projeto como prova.

### 5. Banco de dados

[Prova do módulo 5 em homologação](#prova-do-módulo-5)

Entrega:

- migrações perigosas;
- índices que faltam;
- consultas lentas;
- prova de que a migração roda do zero e sobre dados antigos.

Ferramentas:

- Squawk (Apache-2.0/MIT);
- Dexter (MIT, precisa de HypoPG);
- `pg_stat_statements` e `EXPLAIN`;
- a prova de restauração já existente.

### 6. Prontidão para produção

[Prova do módulo 6 em homologação](#prova-do-módulo-6)

Entrega uma lista de verificação do sistema publicado:

- TLS e cabeçalhos de segurança;
- backup e prova de restauração;
- alertas e rotação de logs;
- reinício automático;
- uso de disco e memória;
- segredos fora do código.

Tudo é passivo, então pode rodar contra produção. Reaproveita o vigia e o backup do modo pessoal como modelo. Ferramenta candidata: testssl.sh, que ainda não foi conferido nesta pesquisa.

### 7. Desempenho

[Prova do módulo 7 em homologação](#prova-do-módulo-7)

Entrega as telas, rotas e consultas lentas e se pioraram desde a última vez. Ferramentas:

- Lighthouse CI (Apache-2.0);
- k6 com limites;
- `node --cpu-prof`;
- `pg_stat_statements`.

clinic.js e 0x ficam de fora: estão parados.

### 8. Documentação viva

[Prova do módulo 8 em homologação](#prova-do-módulo-8)

Entrega a documentação e os diagramas gerados do código, mais a lista do que está desatualizado. Ferramentas: TypeDoc (Apache-2.0), dependency-cruiser e Mermaid. O revisor confere cada afirmação contra o código, porque texto escrito por IA pode inventar detalhes.

### 9. Conformidade (LGPD e licenças)

[Prova do módulo 9 em homologação](#prova-do-módulo-9)

Entrega:

- as licenças das dependências e os conflitos entre elas;
- onde há dados pessoais e como saem do sistema.

Ferramentas:

- ScanCode Toolkit (Apache-2.0);
- ORT (Apache-2.0; pesado, precisa de cerca de 8 GB);
- Presidio (MIT), com regras próprias para CPF.

A homologação deve conferir o reconhecedor de CPF com dados artificiais e validação dos dígitos.

### 10. Design e experiência de uso

Mede cada rota descoberta no código em 375, 768 e 1440 px, nos temas claro e escuro quando o projeto declara `prefers-color-scheme`, `data-theme` ou `color-scheme`. A imagem `ac-design` roda na rede `design-homologation`, com usuário 65532, raiz só de leitura e o digest gravado em `deploy/design-image-digest.txt`. O script da imagem é `deploy/design-tools/run-exam.mjs`. Ele não executa código do repositório. A tabela de cobertura lista ferramenta, versão, o que rodou, achados e falha. Ferramenta que quebra permanece na tabela com o código da falha.

Estados além do padrão vêm de `design.config.json` na raiz do repositório: vazio, carregando, erro e logado. Sem declaração, o relatório diz "não capturado". Rota com `:param` só abre com o exemplo concreto desse arquivo.

| Fase | Ferramentas | O que prova |
|---|---|---|
| Acessibilidade | axe-core 4.14.1 via `@axe-core/playwright` 4.14.0, tags wcag2a, wcag2aa, wcag21aa, wcag22aa e best-practice; pa11y 10.0.0 com runners axe e htmlcs | contraste, nome e alternativa das imagens, WCAG 2.2 AA |
| Qualidade percebida | Lighthouse 13.6.0, programático, mobile e desktop, categorias acessibilidade, boas práticas, desempenho e SEO | CLS acima de 0,25, LCP acima de 4 s e desempenho abaixo de 0,5 |
| CSS | Stylelint 18.0.0 com a config de `src/design-stylelint.ts`; `@projectwallace/css-analyzer` 9.9.9 no CSS do repositório e no CSS computado | regra proibida e o inventário de cores, tipos e sombras |
| Tokens | estilos computados viram `tokens.json` no formato W3C DTCG; comparação numérica com Material Design 3, IBM Carbon, Shopify Polaris, Apple HIG, GOV.UK e Radix Colors em `deploy/design-references/` | escala de tipo, cinzas com ΔE2000 abaixo de 3, contraste WCAG e APCA, alvo de toque |
| Crítica visual | nove eixos em português no próprio módulo: hierarquia, tipografia, cor, ritmo, grade, densidade, componentes, marca e polimento. O examinador nota de 0 a 10. Eixo abaixo de 7 vira achado. Um segundo Claude vê a captura e o código, sem as notas do primeiro. Divergência acima de 2 pontos fica "julgamento incerto" | tela genérica (gradiente roxo, cartões iguais) contra uma tela comum |
| Referência do titular | `--referencia` no exame e na criação, até 10 PNG ou JPG, copiados para o diretório privado do run em 0600 | o examinador vê a referência e a captura lado a lado |
| Regressão | pixelmatch 5.3.0, limiar padrão 0,1, só depois de `--aprovar-baseline` | telas mudadas, porcentagem de pixels e a imagem de diferença |
| Criação | `npm run personal:design -- criar`, modelo `claude-opus-5-5` e esforço `medium` forçados. As telas geradas passam pelo exame. Achado alto ou eixo visual abaixo de 8 volta ao modelo, até o número de rodadas | `tokens.json` e HTML/CSS em `<dataDirectory>/design-criacoes/<runId>/`, fora do repositório, mais a vitrine `index.html` |

O exame de leitura continua só com Claude. Achado `alta` sem medida estruturada desce para `media`, exceto inventário e teclado, que ficam informativos. O verificador confirma o achado cuja regra cabe na tela examinada. A senha de login não entra no relatório.

## Skills e catálogos conferidos

- `anthropics/skills`: `webapp-testing`, que traz o padrão Playwright e o `with_server.py`, e `skill-creator`, para empacotar cada módulo como skill. Não há skill de auditoria pronta.
- `anthropics/claude-plugins-official`: os nomes `security-guidance`, `code-review`, `pr-review-toolkit` e `code-modernization` são relevantes. O conteúdo de cada plugin ainda não foi lido e precisa ser revisado antes de entrar num contêiner.
- `trailofbits/skills`: análise estática, análise de variantes e verificação de correção. É a melhor fonte de método para o exame do módulo 1. A licença ainda não foi confirmada.
- Catálogos `awesome-claude-skills` (ComposioHQ e travisvn) e `awesome-claude-code`: pouca coisa útil para estes módulos. A conclusão é montar cada módulo sobre ferramentas de linha de comando e deixar o agente interpretar o resultado.

## Plano do módulo 1

| Passo | Entrega | Prova |
|---|---|---|
| 1.1 | Imagem de verificação com gitleaks, OSV-Scanner, Syft, Grype, Opengrep, Hadolint, Trivy e Checkov, por digest; bases baixadas num passo separado | a imagem roda sem rede contra um repositório de exemplo com falhas plantadas |
| 1.2 | Normalizador SARIF/JSON para `achados-brutos.json` (ferramenta, regra, CWE, arquivo, linha, gravidade) | teste com as saídas reais das ferramentas |
| 1.3 | Pedido de verificação no runtime: tipo de intenção somente leitura, papel `specialist` para mapa e exame, `reviewer` de outro provedor para confirmação, sem escrita no repositório | teste do fluxo completo com executor de bancada |
| 1.4 | Lista de verificação ASVS 5.0 adaptada, fatiamento e tabela de cobertura | nenhum arquivo do repositório de exemplo sem dono |
| 1.5 | Relatório em `<dataDirectory>/verificacoes/`, no formato acima, e tela no painel | as falhas plantadas aparecem confirmadas; os falsos positivos plantados aparecem descartados |
| 1.6 | Botão "Corrigir" (achado vira pedido) e nova verificação que fecha ou reabre | correção de uma falha plantada fecha o achado com teste |
| 1.7 | Homologação: ZAP baseline, Schemathesis, Nuclei e Shannon/Strix, limitados à URL declarada | rede do contêiner não alcança outro host |
| 1.8 | Rodar no próprio Agent Control e entregar o relatório | relatório real, achados altos corrigidos pelo fluxo normal |

O repositório de exemplo com falhas plantadas, como injeção, segredo no histórico, rota sem autorização e dependência vulnerável, é a régua do módulo. A taxa de acerto do validador é medida nele antes de usá-lo em sistema real.

## Provas da parte C em homologação

A prova conjunta em `6797c1a9` usou Git, PostgreSQL e imagens fixadas por digest nas oito CLIs. Os seis testes de ponta a ponta passaram. No exame em `bfab53bd`, as oito publicações persistiram achados com respostas sintéticas de provedores distintos. Os candidatos aguardam a conclusão das revisões para aplicação no gateway.

### Prova do módulo 2

**QA pesado.** Em homologação, a CLI `personal:qa` executou os testes Node três vezes, registrou os mutantes medidos pelo Stryker e analisou acessibilidade de HTML estático com axe. A imagem de `b1b254f3` passou no laboratório. A revisão de `211dc9aa` encontrou casos de asserção inalcançável e função impura contados como prova. Na rodada C2-R6, a imagem fixada em `b688989e` passou em 33 testes e um caso opcional ficou sem execução. Em `91a6c71a`, a CLI encontrou o defeito plantado e recusou a correção sem confirmação. A prova de idempotência usou uma medição sintética identificada no mesmo banco de teste. A rodada C2-R7, fixada em `6c4023fd`, passou em 35 testes, incluindo a prova de asserção e função no processo real. Na rodada C2-R8, a imagem de `b24d0335` passou em 35 testes, incluindo função não chamada em teste com o ID correto, função aguardada e declaração opcional de teste pulado. Na imagem `01038120`, os 35 testes de QA passaram com funções importadas por namespace, identificadores com cifrão e caminhos com codificação percentual. Na imagem poliglota de QA, três execuções detectaram o defeito aritmético em Python e Go; as mesmas quatro asserções passaram nas três execuções após corrigir apenas o código. A imagem de R10 fixada em `da2157cc` passou nos 43 testes do coletor e laboratório e repetiu a prova poliglota. A prova da CLI dessa revisão está em diagnóstico. Contraste visual e varreduras de entradas externas ficaram fora dessa execução.

Em `6b312c2d`, oito testes físicos passaram. O Chromium mediu o baixo contraste na linha plantada e a diferença visual em pixels. A mutação em Python e Go e as propriedades Hypothesis estão em integração.

### Prova do módulo 3

**Arquitetura e dívida técnica.** Em homologação, a CLI `personal:arquitetura` mediu código JavaScript e TypeScript com Knip, complexidade no AST, duplicação com jscpd e dependências com dependency-cruiser. O laboratório da imagem fixada em `303b1b36` passou após conferir a contagem por arquivo com caminhos equivalentes e o controle limpo. A imagem de C3-R7 em `88229a82` passou nas 18 provas habilitadas e na CLI com a conferência de travessia de diretório. A revisão de `7fb2f861` apontou omissões no destino e na interpretação de componentes. Em C3-R8, a imagem `43b3ef40` passou nas 18 provas habilitadas e nas seis da CLI. Um teste opcional do laboratório foi pulado. Em R9, `70a8c7cc` passou nas 19 provas habilitadas e a CLI no ramo incremental passou em seis testes. A imagem conserva a origem de caminhos relativos e identifica entradas sem cobertura mesmo quando chega ao limite de arquivos.

O coletor de `70a8c7cc` passou em 19 testes dirigidos, com um teste opcional pulado, e em seis testes da CLI. A revisão independente por modelo distinto registrou duas observações baixas sobre o limite de inventário e o teste da raiz relativa.

### Prova do módulo 4

**Dependências e atualizações.** Em homologação, `personal:dependencias` comparou versões com o registro de teste offline, identificou chamadas a migrar, exercitou o codemod em uma cópia e comparou inventários de dependências. Os 20 testes dirigidos, incluindo o laboratório da imagem fixada em `ec1122ff`, passaram. A rodada C4-R5, fixada em `ea172fa4`, passou nas 26 provas dirigidas e nas seis da CLI. O parecer de `8669f900` abriu C4-R6 para impedir propostas de downgrade e reforçar a validação de saídas de ferramentas. Na imagem `8da07644`, passaram os 28 testes de dependências e laboratório. A prova incluiu codemods, direção de versões e validação de documentos pelo esquema da versão CycloneDX declarada. Atualizações disponíveis dependem da data do inventário fornecido.

A rodada `db55280f` passou em 28 testes e seis da CLI. Os dez arquivos importados de CycloneDX tiveram os bytes comparados com a revisão original. A revisão independente por modelo distinto retornou três casos de comprovação inadequada de versão, na ordem C4-R7.

### Prova do módulo 5

**Banco de dados.** Em homologação, `personal:banco` usou PostgreSQL descartável para aplicar migrações, restaurar dados de teste e analisar consultas. A prova da imagem em `fbd1ed3f` teve nove testes aprovados. Um laboratório adicional excedeu o prazo de uma migração válida e verificou o SQLSTATE 57014 na cobertura. A imagem de C5-R4, fixada em `a3d02361`, passou nos dez testes de banco, incluindo falha no commit do lote, migração e restauração. A revisão independente de `5d494800` abriu C5-R5 para atribuição de falhas de transação e identificação de rejeições SQL. A imagem `e6b76eb4` passou nos onze testes de banco e pela CLI em `8bf6ed47`.

A imagem reconstruída em `31b447bc` conserva a correção de atribuição de migrações. A prova anterior da mesma fonte passou nos 12 testes com PostgreSQL, Dexter e Squawk. Os laboratórios combinados de banco, prontidão e documentação passaram nos 68 testes das imagens reconstruídas.

### Prova do módulo 6

**Prontidão para produção.** Em homologação, `personal:prontidao` registrou evidências locais de configuração, Gitleaks, Hadolint e Trivy em execução offline. O laboratório exerceu também a conversão de um achado em tarefa. A imagem fixada em `a2c2a68f` passou em 19 testes de prontidão e sondagem local. A revisão de `757eced2` identificou omissões na análise de Compose, dotenv e configuração por site, além de valores de cabeçalho que precisam ser removidos da evidência. O commit `01101716` guarda apenas as classes de proteção dos cabeçalhos e passou em 18 testes locais. A imagem `74133e4d` passou nas 29 provas dirigidas de prontidão e na CLI com HTTPS local. A confirmação independente é necessária antes de transformar um achado provável em tarefa.

O coletor passivo de `2cafe62b` passou nos 32 testes de homologação. A imagem reconstruída ficou em `256589e2`. Sem revisão independente, uma observação TLS permanece provável e a CLI recusa convertê-la em tarefa.

### Prova do módulo 7

**Desempenho.** Em homologação, a CLI pessoal mediu Lighthouse, k6, CPU e PostgreSQL no mesmo snapshot. A imagem de `f5f9a9ec` passou nos três laboratórios com defeito e controle, backend indisponível e projeto vazio. A imagem R5, fixada em `d7299a8f`, passou nos três laboratórios e em duas medições reais consecutivas pela CLI. A segunda medição em `1156ed12` apontou a primeira em armazenamento privado e no relatório. A prova de `db875596` conferiu a associação de amostras do V8 à função, ao arquivo e à linha. O PostgreSQL de teste registrou as contagens antes e depois do workload. O caso HTTP usou somente tráfego local entre contêineres isolados. A revisão independente de `9a7018c4` abriu C7-R5 para recuperação de recursos Docker, precedência das rotas, origem do baseline e continuidade da medição estática.

Na integração `e4680e65`, passaram os três laboratórios físicos de desempenho e 30 testes dirigidos do coletor e orquestrador. A CLI executou duas medições independentes e localizou a referência anterior, com seis testes aprovados. A rodada corrigiu a seleção quando há medições incomparáveis entre dois exames.

A revisão independente por modelo distinto de `e3527238` identificou falhas na resolução de recursos locais e na recuperação de reservas de contêiner. A correção está na ordem C7-R7.

### Prova do módulo 8

**Documentação viva.** Em homologação, `personal:documentacao` produziu `api.json` e `dependencias.mmd`, com verificação de conteúdo antes da publicação no relatório privado. Os 18 testes da imagem fixada em `da58dca6` passaram. A revisão de `9c2782fd` identificou problemas de atribuição de arestas, precedência de configuração TypeScript e leitura de JSDoc. A imagem de C8-R5 em `5c92b552` passou nos 20 testes dirigidos e nas seis provas da CLI de homologação. A revisão independente por modelo distinto, Sol 6.2 high sobre `fafc14d3`, encontrou duas atribuições que podiam produzir falsos positivos de dependência. A ordem C8-R6 cobre atribuições de ambiente, subgrafos e localização de provas.

A imagem de documentação fixada em `7e27197e` passou nos 21 testes com as ferramentas locais e nos seis testes da CLI na integração individual.

A implementação de `c1d36024` passou em 21 testes com ferramentas reais. A imagem reconstruída está em `6daae927`.

### Prova do módulo 9

**Conformidade (LGPD e licenças).** Em homologação, `personal:conformidade` analisou licenças e dados pessoais com ScanCode, ORT e Presidio em um projeto sintético. A imagem fixada em `6c3cddbf` passou nos nove testes, inclusive o laboratório que exige detectar o CPF artificial e a licença plantada e aprovar um controle limpo. Na rodada C9-R3 a imagem fixada em `381f577b` passou nos 16 testes e nas seis provas da CLI em `ffe86c74`. A revisão independente de `b433235e` apontou falhas de rastreamento de campos e de triagem entre licenças. Em `c0bb5637` a triagem manteve os pares nas seis permutações de classes e registrou o total omitido no limite. A imagem de C9-R4 fixada em `cb1c48ec` passou nos 20 testes e no laboratório com ScanCode, ORT e Presidio. A CLI passou nas seis provas na integração `3ede9a43`. A revisão desta versão está pendente.

A imagem fixada em `e1798884` passou nos 22 testes, incluindo detecção da licença e do identificador pessoal artificiais. A CLI entrou na prova conjunta em `6797c1a9`.
