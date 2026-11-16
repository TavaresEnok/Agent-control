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

Acessibilidade entra no QA pesado e não ganha módulo próprio. Custo de nuvem fica de fora: os sistemas rodam em servidor próprio.

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

Entrega o que está velho, o risco de cada atualização e as mudanças de código prontas. Ferramentas:

- npm-check-updates (Apache-2.0);
- ast-grep (MIT) e jscodeshift (MIT) para reescrever código;
- OpenRewrite (Apache-2.0) para Java;
- Renovate (AGPL-3.0) em modo local, opcional.

O SBOM do módulo 1 é reaproveitado. Cada atualização vira um pedido separado, com o QA do projeto como prova.

### 5. Banco de dados

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

Entrega uma lista de verificação do sistema publicado:

- TLS e cabeçalhos de segurança;
- backup e prova de restauração;
- alertas e rotação de logs;
- reinício automático;
- uso de disco e memória;
- segredos fora do código.

Tudo é passivo, então pode rodar contra produção. Reaproveita o vigia e o backup do modo pessoal como modelo. Ferramenta candidata: testssl.sh, que ainda não foi conferido nesta pesquisa.

### 7. Desempenho

Entrega as telas, rotas e consultas lentas e se pioraram desde a última vez. Ferramentas:

- Lighthouse CI (Apache-2.0);
- k6 com limites;
- `node --cpu-prof`;
- `pg_stat_statements`.

clinic.js e 0x ficam de fora: estão parados.

### 8. Documentação viva

Entrega a documentação e os diagramas gerados do código, mais a lista do que está desatualizado. Ferramentas: TypeDoc (Apache-2.0), dependency-cruiser e Mermaid. O revisor confere cada afirmação contra o código, porque texto escrito por IA pode inventar detalhes.

### 9. Conformidade (LGPD e licenças)

Entrega:

- as licenças das dependências e os conflitos entre elas;
- onde há dados pessoais e como saem do sistema.

Ferramentas:

- ScanCode Toolkit (Apache-2.0);
- ORT (Apache-2.0; pesado, precisa de cerca de 8 GB);
- Presidio (MIT), com regras próprias para CPF.

O suporte a CPF no Presidio não foi confirmado.

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
