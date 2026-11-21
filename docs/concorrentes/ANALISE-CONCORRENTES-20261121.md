# Agent Control diante de 20 projetos públicos de agentes

Versão final de 21/11/2026, revisada depois da crítica. Base: `dados-sintese.json` (ranking, 105 ofertas válidas, 76 descartadas), as análises e verificações de cada repositório, `ac-score.json` e `ac-map.md`. O Agent Control foi lido no commit `6849d85d`.

## Resumo

**Onde o AC está.** Depois da crítica, o Agent Control (AC) fica em 11º lugar entre 21 projetos, com 4,9 de 10. Vai bem em orquestração (6, empatado com os melhores), porque, no fluxo de engenharia, o revisor nunca é do provedor que escreveu a mudança, e em verificação (6, só o ECC tem mais), porque o QA roda os testes num contêiner fixado. Perde por três motivos:
- é grande demais para um titular só (manutenção 2), e ninguém mais o usa (utilidade 2);
- tem segurança 4, com dois alertas altos na instalação viva: os contêineres de trabalho acessam a internet com os logins montados, e o gateway controla o Docker inteiro, com o Happier na internet;
- só 22 de 111 requisitos estão aceitos, e a documentação tem pelo menos cinco afirmações erradas ou velhas.

A nota do AC teve um avaliador só, e o Claude, que coordenou a análise, ajuda a desenvolver o AC.

**As 5 coisas que mais vale trazer.**
1. Limpar a configuração de agente da cópia que o revisor, o juiz e o QA por modelo leem, desligar os hooks da conta e provar em laboratório (A1, A2 e D11).
2. Quando o diff for cortado em 20 KB, mandar a lista completa dos arquivos mudados (A3).
3. Fazer o QA e o CI contarem os testes, sem dar "passou" com zero testes, testes pulados, `.only` ou testes apagados (D1, A4 e A11).
4. Impedir que o projeto examinado esconda achados do módulo 1 com as próprias supressões ou com `refs/replace` (A5 e A6).
5. Um protocolo para provar economia sem perda de qualidade, com repetições e comparação em pares, e uma medição melhor do cache e do gerente (B1, C1 e A9).

**Os 3 pontos fracos mais graves que a comparação revelou.**
1. Furo na revisão independente: fora dos exames, o revisor lê a configuração de agente escrita pelo programador, com a conta gravável. Nos exames, o examinador e o segundo revisor são ambos Claude e podem estar na mesma conta.
2. Prova mais fraca do que parece: o QA aprova pelo código de saída, o CI aceita testes todos pulados, o diff chega cortado sem aviso, e um resultado "limpo" não prova que a ferramenta funcionava.
3. As economias ligadas por padrão (mapa, lotes e disciplina do gerente) foram medidas por caracteres ou estimativa, sem o modelo real e sem medir a qualidade.

Antes de tudo isso, feche os dois alertas altos de segurança.

---

**Como ler.** A seção 1 compara as notas. A seção 2 lista o que vale trazer dos outros projetos. A seção 3 mostra o que parece útil mas não serve. A seção 4 junta os pontos fracos do AC. A seção 5 diz por onde começar. No fim, uma lista diz quais correções da crítica não foram aplicadas, e por quê.

**Termos usados.**
- *diff*: a lista de mudanças de um commit.
- *hook*: um comando que a ferramenta do agente executa sozinha em certos momentos, por exemplo ao abrir a sessão.
- *MCP*: um servidor de ferramentas extras que o agente carrega.
- *QA*: a etapa que roda os testes do projeto.
- *QA por modelo*: um modelo lê o diff e o fim do log dos testes e dá um parecer. É diferente do QA, que roda os testes.
- *revisor, juiz e especialista*: os papéis de avaliação. O revisor e o juiz julgam o trabalho do programador. O especialista é quem examina nos módulos.
- *CI*: a bateria automática de testes do próprio AC.
- *digest*: a impressão digital que identifica uma versão exata de uma imagem.
- *worktree*: uma cópia de trabalho de um ramo do Git.
- *merge-base*: o commit em que o ramo de trabalho saiu do ramo principal.
- *gateway*: o serviço central do AC, que recebe os pedidos e lança os contêineres.
- *trabalhadores*: no produto, os contêineres que executam as tarefas (workers). No processo de desenvolvimento, as CLIs (agy, Claude, Codex) que programam o próprio AC.
- *módulos 1 a 10*: os dez exames do AC: 1 segurança, 2 QA, 3 arquitetura, 4 dependências, 5 banco, 6 prontidão, 7 desempenho, 8 documentação, 9 LGPD e licenças, 10 design.
- *Cezar e Happier*: os dois projetos abertos sobre os quais o AC foi montado, copiados para a pasta `upstream/`. O Cezar roda os agentes. O Happier é o app e o servidor da conversa com o titular.
- *T1 a T6*: os experimentos de economia de tokens, numerados, em `docs/economia/`. O T7 é proposto neste relatório (B6).
- *fixture*: um projeto ou arquivo de teste montado de propósito.
- *canário*: um defeito ou segredo plantado para provar que a ferramenta o acha, ou que nada vaza.
- *lockfile*: o arquivo que fixa a versão exata de cada dependência.
- *TAP*: o formato de texto em que os testes informam quantos passaram, falharam ou foram pulados.
- *PID*: o número que o sistema dá a cada programa em execução. O número é reaproveitado depois que o programa termina.
- *SIGTERM e SIGKILL*: pedidos para um programa parar. O primeiro deixa o programa arrumar a casa. O segundo o mata na hora.
- *linha de comando e entrada padrão*: o texto passado na linha de comando aparece para qualquer usuário da máquina (comando `ps`). O texto passado pela entrada padrão, não.
- *cache de prompt*: o provedor guarda o começo repetido do pedido. Ler do cache é barato. Gravar nele é caro.
- *CAS com fencing*: só grava no Git se nada mudou desde a leitura, e um número de época impede que um processo antigo grave.
- *teste de McNemar*: compara duas versões nos mesmos casos, contando os casos em que só uma delas acertou.
- *recibo assinado*: um registro com assinatura digital que prova que um resultado não foi alterado depois.
- *restore-check*: restaura o backup numa cópia para provar que ele funciona.

---

## 1. Ranking crítico

Os pesos dos critérios somam 100:
- Eng (engenharia) 12;
- Test (testes e CI) 12;
- Seg (segurança) 14;
- Real (o que funciona contra o que o README promete) 12;
- Orq (orquestração multiagente e revisão independente) 10;
- Verif (verificação e prova de resultado) 12;
- Econ (economia de tokens) 8;
- Manut (manutenção e simplicidade) 8;
- Doc (documentação honesta) 6;
- Util (utilidade prática e adoção) 6.

Cada nota vai de 0 a 10. Os totais dos outros 20 projetos foram calculados por script e entram sem alteração. O do AC foi recalculado aqui com os mesmos pesos, depois de quatro correções de nota (veja "Como a nota foi dada", abaixo da lista), e arredondado para uma casa decimal. As estrelas do GitHub não entraram em nenhuma nota.

| Posição | Projeto | Tipo | Eng | Test | Seg | Real | Orq | Verif | Econ | Manut | Doc | Util | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | bmad-code-org/BMAD-METHOD | método | 7 | 6 | 5 | 7 | 5 | 5 | 6 | 5 | 7 | 7 | 5,92 |
| 2 | obra/superpowers | método | 6 | 4 | 5 | 7 | 6 | 4 | 7 | 6 | 8 | 8 | 5,82 |
| 3 | Fission-AI/OpenSpec | método | 8 | 8 | 6 | 7 | 2 | 4 | 3 | 5 | 7 | 7 | 5,76 |
| 4 | thedotmack/claude-mem | memória | 7 | 7 | 5 | 6 | 3 | 6 | 7 | 3 | 6 | 7 | 5,70 |
| 5 | github/spec-kit | kit completo | 7 | 8 | 6 | 6 | 4 | 4 | 2 | 4 | 7 | 8 | 5,62 |
| 6 | affaan-m/ECC | kit completo | 6 | 7 | 5 | 6 | 5 | 7 | 4 | 3 | 6 | 6 | 5,60 |
| 7 | Yeachan-Heo/oh-my-claudecode | kit completo | 7 | 7 | 4 | 5 | 6 | 5 | 5 | 3 | 5 | 7 | 5,40 |
| 8 | anthropics/skills | coleção de skills | 6 | 1 | 5 | 7 | 5 | 6 | 6 | 5 | 7 | 8 | 5,38 |
| 9 | shareAI-lab/learn-claude-code | curso | 6 | 7 | 3 | 7 | 5 | 3 | 5 | 5 | 7 | 6 | 5,26 |
| 10 | wshobson/agents | coleção de agentes | 6 | 6 | 4 | 6 | 3 | 4 | 5 | 6 | 7 | 6 | 5,16 |
| 11 | **Agent Control** | **produto pessoal** | 6 | 6 | 4 | 5 | 6 | 6 | 5 | 2 | 5 | 2 | **4,9** |
| 12 | gsd-build/get-shit-done | kit completo | 6 | 6 | 3 | 5 | 5 | 4 | 5 | 3 | 6 | 6 | 4,80 |
| 13 | alirezarezvani/claude-skills | coleção de skills | 5 | 4 | 4 | 5 | 3 | 6 | 5 | 4 | 6 | 6 | 4,70 |
| 14 | mattpocock/skills | coleção de skills | 4 | 2 | 4 | 6 | 4 | 4 | 4 | 7 | 7 | 7 | 4,60 |
| 15 | davila7/claude-code-templates | coleção de skills | 5 | 5 | 4 | 5 | 3 | 4 | 5 | 4 | 5 | 7 | 4,58 |
| 16 | eyaltoledano/claude-task-master | outro (tarefas) | 5 | 4 | 2 | 4 | 2 | 2 | 4 | 3 | 4 | 7 | 3,50 |
| 17 | ruvnet/ruflo | framework de orquestração | 4 | 5 | 3 | 2 | 3 | 4 | 3 | 2 | 3 | 6 | 3,46 |
| 18 | buildermethods/agent-os | método | 3 | 0 | 3 | 5 | 1 | 1 | 3 | 6 | 4 | 6 | 2,92 |
| 19 | multica-ai/andrej-karpathy-skills | método | 1 | 0 | 5 | 4 | 0 | 2 | 3 | 6 | 5 | 4 | 2,80 |
| 20 | disler/claude-code-hooks-mastery | curso | 3 | 1 | 2 | 3 | 3 | 2 | 2 | 4 | 4 | 5 | 2,68 |
| 21 | SuperClaude-Org/SuperClaude_Framework | coleção de skills | 3 | 3 | 2 | 2 | 2 | 2 | 2 | 3 | 2 | 6 | 2,56 |

**Por que cada um ficou onde ficou**

1. **BMAD-METHOD (5,92).** Fica em primeiro pelo equilíbrio. Tem uma camada Python determinística com cerca de 21 mil linhas e cerca de 1.235 testes, que usam git real, concorrência e Windows. Perde em orquestração e verificação (5 cada, ambas baixadas de 6 pelo conferente), porque o núcleo é prosa sem nada que a imponha e a revisão "independente" usa o mesmo modelo.
2. **superpowers (5,82).** É o único com 8 em documentação e divide o 8 em utilidade. Tem specs com custo por papel, portões com 5 execuções e publica os experimentos que reprovaram. Fica com 4 em testes porque não há CI e os evals que sustentam as alegações ficam fora do repositório.
3. **OpenSpec (5,76).** Tem a melhor engenharia do grupo (8) e empata em testes (8): 93.532 linhas de teste, injeção de falhas em pontos exatos e matriz em três sistemas operacionais. Não orquestra nada (2), e a verificação da implementação é um prompt consultivo.
4. **claude-mem (5,70).** Trata muito bem as falhas de rodar Claude e Codex sem tela, com disjuntor de cota e controle de PID e de ambiente. Tem 1.677 arquivos de teste. Perde em segurança: a redação de segredos vem desligada por padrão (alerta alto), a telemetria fica ligada até o usuário desligar, e a API local não pede token por padrão (o token é opcional). Fica com 3 em manutenção, com cerca de 687 mil linhas de código.
5. **spec-kit (5,62).** Tem cerca de 8,3 mil testes, com arquivos adversariais montados à mão. Mas despacha agentes com autoaprovação (o Copilot roda com `--yolo` por padrão) e tem um passo de shell que interpola valores sem proteção, o que dá três alertas altos. Fica com 2 em economia porque não mede tokens em lugar nenhum.
6. **ECC (5,60).** Tem a melhor verificação do grupo (7): uma avaliação com hipóteses registradas antes, placebo, teste de McNemar e resultado nulo publicado. A arquitetura, porém, são guarda-corpos no processo do usuário: hooks sem sandbox que deixam passar quando dão erro e atualização automática sem assinatura. Fica com 3 em manutenção, com 4.951 arquivos.
7. **oh-my-claudecode (5,40).** Tem engenharia defensiva séria, como um tokenizador de shell e a identidade de processo pelo horário de início, e cerca de 291 mil linhas de testes. Fica com 4 em segurança. Os trabalhadores rodam no host com as aprovações desligadas, o token OAuth do Claude é renovado por fora do Claude Code e um `merge=ours` fica gravado para sempre no repositório do usuário.
8. **anthropics/skills (5,38).** O núcleo de avaliação da skill claude-api é excelente e honesto sobre os próprios limites. Mas o repositório não tem testes nem CI (nota 1 em testes), e os scripts do skill-creator têm defeitos reais: processos paralelos que se contaminam, e erro da CLI contado como "não acionou".
9. **learn-claude-code (5,26).** É um curso. Os capítulos finais são maduros, com claim atômico entre processos e journal de retomada com trava, e há 204 testes reais. Fica com 3 em segurança: os comandos do modelo rodam no host com `shell=True`, e a lista de bloqueio compara pedaços de texto.
10. **wshobson/agents (5,16).** É um catálogo de prompts (89% Markdown) com ferramentas bem cuidadas e um CI que barra a deriva entre a fonte e os artefatos. Os plugins de governança se contornam: o próprio agente pode criar o arquivo de aprovação, e sem o arquivo de política tudo é liberado.
11. **Agent Control (4,9).** Veja os parágrafos logo abaixo da lista.
12. **get-shit-done (4,80).** Tem muito código real, com 684 arquivos de teste e uma limpeza de worktree que trava quando há dúvida. Mas recomenda pular as permissões, roda o SDK em `bypassPermissions` e aceita a palavra do agente como verificação. O repositório foi arquivado.
13. **claude-skills (4,70).** São 428 skills e cerca de 321 mil linhas de Python heurístico, quase sem teste de comportamento. Há poucas peças boas: um verificador de afirmações e um portão estatístico pareado. O auditor de segurança aceita supressões escritas no próprio arquivo auditado, e o workflow roda o auditor que vem no PR.
14. **mattpocock/skills (4,60).** É uma coleção curada e pequena, com convenções explícitas (7 em manutenção). Não tem nenhum teste (nota 2) e só cerca de 6% é código. A guarda de git é contornável e deixa passar quando falha.
15. **claude-code-templates (4,58).** O instalador baixa hooks executáveis do ramo main sem fixar o commit (alerta alto) e aceita nomes sem sanitizar em `--workflow`, o que permite gravar fora da pasta. Alguns mods pequenos e testados, com licença MIT, valem ser portados.
16. **claude-task-master (3,50).** Tem cerca de 125 mil linhas reais e é útil para quem programa sozinho. Fica com 2 em segurança: a telemetria grava prompts e respostas por padrão, a atualização automática não confere integridade e o loop roda no host com `--dangerously-skip-permissions`. O "TDD validado" é declarado pelo próprio agente.
17. **ruflo (3,46).** Ficou com 2 em real contra promessa (baixado de 3): o "consenso Raft e bizantino" é uma contagem de votos em JSON. Pré-aprova permissões amplas, roda `npx @latest` em toda sessão e usa contêineres como root. Tem cerca de 1 milhão de linhas de TypeScript (2 em manutenção).
18. **agent-os (2,92).** São 1.231 linhas de bash sem nenhum teste (nota 0), e o perfil padrão nunca é instalado. A versão 3 retirou orquestração e verificação sem medir o efeito.
19. **andrej-karpathy-skills (2,80).** É um texto de cerca de 65 linhas em três cópias, sem código. O exemplo de "teste que reproduz o bug" passa antes e depois da correção.
20. **claude-code-hooks-mastery (2,68).** É um catálogo de hooks sem testes e sem licença. Os validadores de Stop dizem bloquear, mas saem com código 1, que não bloqueia, e as guardas de `.env` e de `rm` são contornáveis e deixam passar quando falham.
21. **SuperClaude (2,56).** É 91% Markdown. A "confiança" vem de existir um README, e o self-check aprova "1 failed, 3 passed". Tem um plugin de pytest que se carrega sozinho e pula testes, e um gateway com a verificação SHA-256 desligada (alertas altos).

**O Agent Control é outro tipo de projeto.** Os outros 20 são kits, métodos, coleções ou cursos públicos, feitos para muita gente instalar. O AC é um produto pessoal com uma instalação (`ispagent`) e um projeto externo examinado (NexoISP). O `package.json` é `private: true`, a documentação está só em português e há caminhos `/home/app` fixos no código. Por isso a nota 2 em utilidade e adoção mede o alcance, não o funcionamento: ninguém mais usa o AC, e levá-lo para outra máquina daria trabalho de porte.

- **Onde ele ganha.**
  - *Orquestração (6).* Empata com superpowers e oh-my-claudecode na maior nota do grupo. No fluxo de engenharia (programador, QA e revisor), os papéis são separados, e o código impede que o revisor seja do provedor que escreveu a mudança, inclusive na reserva. O QA usa um executor confiável, e o veredito de um modelo nunca vira prova de QA. A nota não é maior por dois motivos. A cópia que o revisor de engenharia lê traz a configuração de agente do commit julgado (A1). Nos exames, o examinador e o segundo revisor são ambos Claude e podem estar na mesma conta.
  - *Verificação (6).* Só o ECC tem mais. O QA roda em contêiner com contrato e digest fixos, há recibos assinados e o backup só apaga os antigos depois do restore-check.
- **Onde ele perde.**
  - *Utilidade e manutenção (2 cada).* Utilidade tem a menor nota de todas. Manutenção empata com o ruflo como a menor (números na seção 4, item 5). Os dois critérios pesam juntos 14%.
  - *Segurança (4).* Oito projetos têm mais. Os contêineres são somente leitura, com `cap-drop ALL`, e o isolamento é conferido depois de criado. Mas os dois alertas altos da seção 4, item 1, pesam mais: a rede dos trabalhadores tem saída livre para a internet com os logins montados, e o gateway controla o Docker inteiro, com o Happier publicado na internet. Some-se a isso a configuração do repositório rodando ao lado das credenciais (A1 e A2).
  - *Economia (5).* Quatro projetos têm mais. O `personal:tokens` lê os contadores reais dos jobs, e os relatórios publicam os resultados negativos (T4 e T5 reprovados). Mas as três economias ligadas por padrão (mapa, lotes e disciplina do gerente) foram medidas só por caracteres ou pela estimativa de 4 caracteres por token, sem rodar o modelo real e sem medir a qualidade. Isso fica aquém do critério do próprio titular, de só pôr no padrão o que provar economia sem perda de qualidade, embora ele mesmo tenha listado essas três como ligadas por padrão no `AGENTS.md`.
  - *Real contra promessa (5).* Dez projetos estão acima. O motivo não é o README, que está desatualizado e promete menos do que o código faz. O motivo é a distância entre o que o projeto declara e o que está aceito. Só 22 de 111 requisitos estão aceitos (`docs/STATUS.md`) e não há teste ponta a ponta. Prontidão e conformidade terminaram com `VERIFY_TOOLS_FAILED` (`docs/RELATORIO-FINAL.md`), e tudo foi provado numa única instalação.
  - *Documentação (5).* Doze projetos têm mais. O README, o STATUS e o ESTADO têm pelo menos cinco afirmações erradas ou velhas (seção 4, item 7).
  - *Testes (6).* A suíte não está verde, 86 de 415 arquivos ficam fora do CI e não há teste ponta a ponta.
- **Como a nota foi dada.**
  - *Um avaliador só.* A nota do AC veio de um único avaliador (`ac-score.json`), sem conferente. Cada um dos outros 20 teve um analista e um conferente cético, e o conferente mudou notas em 11 deles. Por exemplo, baixou orquestração e verificação do BMAD de 6 para 5 e real contra promessa do ruflo de 3 para 2. A comparação, portanto, não é perfeitamente simétrica.
  - *Conflito de interesse.* A análise foi coordenada por uma sessão Claude. O Claude é revisor do desenvolvimento do AC desde 09/11/2026, gerente ou supervisor desde 11/11/2026, e coautor de 240 dos 2.355 commits.
  - *A crítica.* Uma crítica feita depois, também por um modelo Claude, conferiu oito das dez notas no código e propôs corrigir quatro. Esta versão, também escrita por Claude, conferiu as evidências da crítica e aplicou as quatro correções:
    - orquestração, de 7 para 6;
    - segurança, de 5 para 4;
    - economia, de 6 para 5;
    - documentação, de 6 para 5.
  - *O efeito.* Com as quatro correções, o total caiu de 5,28 (9º lugar) para 4,9 (11º). A correção de segurança é a menos certa, porque o spec-kit ficou com 6 mesmo com três alertas altos. Sem ela, o total seria 5,04, e o AC continuaria em 11º.
  - *O 5,1.* O texto do avaliador fala em "média ponderada simples: 5,1". O total que vale aqui é o calculado com os pesos acima.

---

## 2. O que eles podem nos oferecer

As 105 ofertas válidas foram juntadas em 64 itens. Quando vários repositórios ofereciam a mesma ideia, ela virou um item só, com todas as fontes citadas. Em cada grupo, os itens de prioridade alta vêm primeiro.

- **Esforço:** P (pequeno), M (médio) ou G (grande).
- **Status no AC:** ausente quer dizer que o AC não tem nada disso. Parcial quer dizer que tem uma parte.

### (a) Correções e riscos (alguns já registrados pelo AC e ainda abertos)

**A1. O revisor, o juiz e o QA por modelo leem a configuração de agente que veio no commit que julgam.** Prioridade alta · esforço M · status parcial.
- **Em linguagem simples.** O trabalho entregue pode "instruir" quem vai julgá-lo, com um `CLAUDE.md` escondido numa subpasta, ou fazer rodar um hook ao lado do login do revisor. O programador também roda hooks e MCP do repositório ao lado das credenciais.
- **O que está provado.** Nenhuma verificação provou que o `claude -p` desta versão roda os hooks do projeto. Quatro conferentes deixaram isso para o laboratório (D11). A injeção por um `CLAUDE.md` aninhado não depende de hook e basta para justificar a correção.
- **Origem.** Os analistas de nove repositórios chegaram ao mesmo furo no AC. Os repositórios só mostram o vetor: o furo apareceu na comparação com o AC, e todos os analistas partiram do mesmo `ac-map.md`. Por isso a contagem não equivale a nove confirmações independentes:
  - thedotmack/claude-mem: `src/sdk/hardened-options.ts`, `tests/security/observer-tool-enforcement.test.ts`;
  - alirezarezvani/claude-skills: `scripts/evals/common.py`, `scripts/evals/trigger_gate.py` (passa `disableAllHooks`), `settings_linter.py`;
  - obra/superpowers: `hooks/session-start`, `hooks/hooks.json`;
  - bmad-code-org/BMAD-METHOD: `skills/method/bmad-build-auto/customize.toml`, `step-04-review.md`;
  - eyaltoledano/claude-task-master: `src/ai-providers/claude-code.js`;
  - ruvnet/ruflo: `v3/@claude-flow/cli/src/init/settings-risk-scanner.ts`, `.claude/settings.json`;
  - multica-ai/andrej-karpathy-skills: `CLAUDE.md`, `.cursor/rules/karpathy-guidelines.mdc`;
  - wshobson/agents: `plugins/protect-mcp/hooks/hooks.json`;
  - disler/claude-code-hooks-mastery: `.claude/settings.json`, `.claude/hooks/permission_request.py`, `session_start.py`. Esse repositório não tem licença, então dele vem só a ideia.
- **O que fazer no AC.**
  - *Como está hoje.* A limpeza dos arquivos de agente (`stripExamHostileConfig`) e o invólucro com `--setting-sources user` só valem nos exames de design e de segurança. Veja `readonlyExamIsolation` nas linhas 197 a 199 de `src/native-execution-supervisor.ts`, e o bloco da cópia `review-artifact` nas linhas 528 a 533 do mesmo arquivo. Fora do exame, a cópia do revisor só perde o `.git`. O Claude roda direto, como `/usr/local/bin/claude`, com a conta montada com escrita em `/account` (`src/native-execution-worker.ts`). O `buildClaudeArgs` do Cezar não passa `--setting-sources` nem `--strict-mcp-config` (`upstream/cezar/packages/cezar/src/core/claude-cli-runner.ts:403`).
  - *O que mudar.* Aplicar a mesma limpeza e o mesmo invólucro à cópia do revisor, do juiz e do QA por modelo. No programador, cortar os hooks, as permissões e o MCP do projeto, mas manter o `CLAUDE.md`, que é contexto legítimo do titular. Cobrir também o Codex e o Grok.
  - *Reforço nos exames.* Nos exames Claude, o home limpo já cria o settings só com as negações (`prepareExamClaudeHome`, `src/verify-exam-isolation.ts:265-273`). Falta a chave que desliga hooks. Falta também passar as negações por `--settings`, opção que `src/module-exam-worker.ts:125` já usa (lá, para desligar os conectores).
  - *Como provar.* Fazer junto com o D11.
  - *Contexto.* O próprio AC já registrou esse risco em `docs/RELATORIO-GROK-VALIDADOR.md`, na linha 102, e não o corrigiu. A linha 531 do supervisor diz "untrusted repository configuration must not run beside the credentials".

**A2. A configuração da conta (hooks, plugins, MCP de usuário) pode rodar fora do contêiner e ser envenenada pelos próprios jobs.** Prioridade alta · esforço M · status parcial.
- **Origem.**
  - SuperClaude-Org/SuperClaude_Framework: `plugins/superclaude/hooks/hooks.json`, `src/superclaude/cli/install_commands.py`, `install_mcp.py`;
  - gsd-build/get-shit-done: `bin/install.js` (`validateHookFields`);
  - affaan-m/ECC: `scripts/ci/scan-supply-chain-iocs.js`, na parte de vigiar as pastas de login.
- **O que fazer no AC.**
  1. `renewClaudeLoginInPlace` (`src/exam-login.ts`, linhas 374 a 411) roda no host, com o diretório da conta. Ela desliga o MCP, mas não os hooks nem os plugins. Acrescentar `disableAllHooks`. O chat do gerente também roda o Claude com `/account` gravável e sem `--setting-sources` (`src/personal-manager-chat.ts:54` e `:84`). O conferente do SuperClaude pede `disableAllHooks` também no planejamento, no programador e no chat do gerente.
  2. O programador e o planejamento montam `/account` com escrita (`src/native-execution-supervisor.ts`, linhas 544 a 547, e `src/native-planning-supervisor.ts:125`). Um hook gravado ali valeria nos próximos jobs daquela conta. Antes de cada lançamento, conferir uma lista de chaves permitidas ou o digest de `settings.json` e `.codex/config.toml`, ou então montar só a credencial.
  3. Acrescentar uma checagem em `src/installation-readiness.ts` e no vigia (`src/personal-watch.ts`, `src/personal-health.ts`).
- **Ressalvas.**
  - *Onde está o risco.* Os exames Claude reais já usam um home limpo e não montam `/account`. O risco está nos jobs que não são exame e na renovação feita no host.
  - *O que ainda é hipótese.* Que um hook gravado em `/account` por um job passe para os jobs seguintes ainda não foi provado. Depende de os hooks rodarem em `-p` e de as ferramentas do Claude programador rodarem no contêiner do worker, e o D11 tem de provar as duas coisas.
  - *O que não foi conferido.* O GSD afirma que um campo inválido faz o CLI descartar o arquivo de settings inteiro. Isso não foi conferido no CLI real, e um teste de laboratório deve confirmar.

**A3. O diff chega cortado em 20 KB, e quem avalia não sabe o que ficou de fora.** Prioridade alta · esforço P · status parcial.
- **Origem.** affaan-m/ECC: `scripts/lib/astra-review/scope.js` e `prompt.js`. obra/superpowers: `skills/subagent-driven-development/scripts/review-package` e `task-reviewer-prompt.md`.
- **O que fazer no AC.**
  - *Como está hoje.* `services/agent-control-git/helper.rb` (linhas 215 a 218) corta o diff em 20.000 bytes. O QA por modelo recebe o campo `diffTruncated` (`src/qa-model.ts:49`), mas a instrução dele (linha 11) não diz o que fazer com um diff cortado. O revisor e o juiz recebem só a marca "[diff truncated]" no fim do arquivo (`src/native-execution-supervisor.ts:537`).
  - *Atenuante.* Com o mapa ligado, o revisor recebe as assinaturas dos arquivos alterados, mas só de TypeScript, Go e Python e com orçamento de 4.000 tokens. Migrações SQL, Dockerfiles, YAML e JSON continuam invisíveis.
  - *O que mudar.* Devolver sempre a lista completa de arquivos mudados (`--name-status`), que nunca pode ser cortada. Instruir quem avalia a ler na cópia os arquivos que ficaram de fora ou a recusar com "revisão incompleta". Criar um teste com um diff maior que 20 KB e o defeito depois do corte.
  - *Ressalva.* Os comandos `git show` do ECC não servem aqui, porque o avaliador recebe uma cópia sem `.git` e sem shell.

**A4. O QA pode ser enganado pelo próprio diff: `.only`, `.skip`, stubs e testes apagados.** Prioridade alta · esforço M · status parcial.
- **Origem.** Yeachan-Heo/oh-my-claudecode: `scripts/workflow-drift-guard.mjs` (`BLOCKER_PATTERNS`, `addedLinesForPath`, `stripQuotedAndRegexLiterals`, `findCompletionBlockers`).
- **O que fazer no AC.**
  - *Como está hoje.* O código de saída do contêiner é a autoridade (`src/native-qa.ts`, linhas 41 a 43 e 371). `protectedGatePaths` vem vazio por padrão, e a detecção de testes pulados só existe no módulo 2.
  - *O que mudar.* Criar `src/qa-diff-gate.ts`, chamado antes de `src/native-qa.ts`, que varre só as linhas adicionadas, com textos e expressões regulares mascarados. A regra fica opcional por projeto, em `src/quality-policy.ts`. Detectar arquivo de teste apagado é coisa nova: o OMC não faz isso.
  - *Ressalva.* Não copiar o defeito deles: varrer a linha inteira, porque no código do OMC `it.only(...) // x` passa sem aviso.

**A5. O módulo 1 aceita as supressões escritas pelo próprio repositório examinado.** Prioridade alta · esforço P · status parcial.
- **Origem.** alirezarezvani/claude-skills: `engineering/skills/skill-security-auditor/scripts/skill_security_auditor.py` e `.github/workflows/skill-security-audit.yml`. A lição vem de um defeito deles.
- **O que fazer no AC.**
  - *Como está hoje.* `deploy/verify-entrypoint.sh` (linhas 134 a 176) roda o gitleaks sem `--config` fixo, sem `--ignore-gitleaks-allow` e sem `--gitleaks-ignore-path`. O opengrep roda sem `--disable-nosem`, o osv-scanner sem `--config` e o checkov sem desligar `checkov:skip`.
  - *O que mudar.* Fixar a configuração e desligar as supressões do alvo, como o módulo 6 já faz. Conferir as flags nas versões fixadas em `deploy/Dockerfile.verify`. Assim, um `.gitleaksignore` ou uma marca `nosemgrep` do projeto examinado deixa de esconder achados.

**A6. O `git archive` do módulo 1 é menos protegido que o dos módulos 2 a 10.** Prioridade alta · esforço P · status parcial.
- **Origem.** github/spec-kit: técnica de teste de paridade, em `tests/test_create_new_feature_python_parity.py` e arquivos parecidos.
- **O que fazer no AC.**
  - *Como está hoje.* `src/verify-command.ts` (`GIT_ARCHIVE_ENV` e `extractGitArchive`, linhas 318 a 370) não usa `--no-replace-objects`, `GIT_NO_LAZY_FETCH=1` nem `GIT_ALLOW_PROTOCOL=''`. A cópia equivalente em `src/verification-modules.ts` (linhas 818 a 870) usa os três. O Git permite trocar um commit por outro sem mudar o identificador (`refs/replace`). Se o repositório examinado fizer isso, o módulo 1 examina um código diferente e diz no relatório que examinou o original.
  - *O que mudar.* Juntar as duas cópias num helper único, por exemplo `src/git-archive-snapshot.ts`, e testar com uma fixture que tenha `refs/replace`.
  - *Ressalva.* O ataque exige que alguém grave `refs/replace` ou configure um repositório parcial no projeto examinado, o que é improvável nos projetos do titular. Vale fazer porque o módulo 1 pretende valer como atestado.

**A7. Caracteres invisíveis (Unicode Tag, bidi, largura zero) no código examinado podem calar o examinador.** Prioridade alta · esforço M · status ausente.
- **Origem.** affaan-m/ECC: `scripts/ci/check-unicode-safety.js` e `scripts/hooks/gateguard-fact-force.js` (`sanitizePath`). O gsd-build/get-shit-done tem uma lista parecida em `get-shit-done/bin/lib/security.cjs`.
- **O que fazer no AC.**
  - *O risco.* O modelo lê esses caracteres e o humano não os vê, o que abre um canal para suprimir achados.
  - *O que mudar.* Criar um item novo em `src/verify/lista-seguranca.json` e um detector no coletor (`deploy/Dockerfile.verify` ou `src/verify-*.ts`). Marcar os caracteres nos recortes (`src/verify-slices.ts`) e na tela do achado. Na cópia enviada ao examinador, trocar cada caractere por um marcador visível sem mudar as linhas, e guardar o original como evidência.
  - *Como provar.* Fazer junto com o D9.

**A8. Uma falha passageira do provedor vira reprovação, e um limite sem horário prende a conta por 1 hora.** Prioridade alta · esforço M (P se usar o classificador do Cezar) · status parcial.
- **Origem.**
  - shareAI-lab/learn-claude-code: `s15_integrated_harness/code.py` (`RecoveryState`, `retry_delay`, `with_retry`), `s08_context_compact/code.py` e os testes em `tests/test_s08_context_compact.py`;
  - thedotmack/claude-mem: `src/shared/quota-cooldown.ts`, `src/services/worker/provider-errors.ts` e `ClaudeProvider.ts` (`classifyClaudeError`).
- **O que fazer no AC.**
  - *Como está hoje.* Em `src/quota-exhaustion.ts`, `LIMIT_PHRASE` (linha 6) trata "rate limit" como cota esgotada, e `NO_RESET_WAIT_MS` (linha 61) dá 1 hora para qualquer limite sem horário. Em `src/claude-execution-adapter.ts:78`, toda falha que não é limite nem login vira `EXECUTION_NATIVE_TURN_FAILED`.
  - *O que mudar.* Separar três casos:
    - sobrecarga (529, overloaded, 5xx), com nova tentativa curta e espera aleatória;
    - limite passageiro, com janela curta;
    - cota esgotada, com espera até o horário real.

    Depois do reset, admitir um único job por conta até o primeiro resultado (`src/capacity.ts`, perto das linhas 446 a 476). Hoje já entram no máximo `max_concurrent` jobs, 2 por conta pessoal por padrão. O ganho maior está na janela curta e na separação do erro 529.
  - *Caminho mais barato.* Segundo a verificação, é ligar o `classifyAgentFailure` que o Cezar já tem nos adaptadores Claude e Codex e no worker de exame.
  - *Ganho.* O AC deixa de gastar o único replanejamento da conversa e de abandonar arquivos de exame sem julgamento.

**A9. O uso do gerente é estimado por 4 caracteres por token e fica sem número quando a chamada falha.** Prioridade alta · esforço P · status parcial.
- **Origem.** anthropics/skills: `skills/claude-api/shared/evals/report/runner-scaffold.mjs` e `eval-audit.md`.
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-manager-chat.ts:54` usa `--output-format text`. Só a chamada que dá certo tem tokens. As que falham são gravadas como "desconhecido", sem números (linhas 100 a 103 e 127). `src/manager-discipline.ts` (linhas 127 a 141) só lê o uso real do Codex.
  - *O que mudar.* Rodar o gerente Claude com `--output-format json` e ler o uso, com o cache, e o modelo que de fato respondeu. Recusar a resposta se o modelo for outro, como o examinador já faz. Gravar o uso também nas tentativas que falharam.
  - *Achado da verificação.* O gerente roda o CLI do Claude sem desligar ferramentas, MCP e configurações, então cada chamada carrega definições que a estimativa não enxerga. Rodar o gerente sem ferramentas pode trazer uma economia maior que a do T6, mas só vale depois de medida (B1).

**A10. A correção e o replanejamento começam sem saber por que a tarefa falhou.** Prioridade alta · esforço P (replanejamento) a M (correção com nova revisão) · status parcial.
- **Origem.** bmad-code-org/BMAD-METHOD: `skills/method/bmad-build-auto/step-04-review.md` (o ramo `bad_plan`) e `plan-template.md` (Plan Change Log). obra/superpowers: `skills/subagent-driven-development/references/fix-loop.md` e `re-review-prompt.md`.
- **O que fazer no AC.**
  - *Como está hoje.* Em `src/happier.ts`, o replanejamento (linhas 675 a 679) diz só que a tarefa "falhou na execução, QA ou revisão" e repete o pedido. Ele pula a decisão do gerente (linha 454), e o planejador não recebe histórico. Em `src/native-implementation.ts:169`, a correção leva só IDs e digest, com o mesmo texto da tarefa original.
  - *O que mudar no replanejamento.* Enviar o código da falha, o fim do log do QA (`tailForModel` já existe), os achados do revisor e os commits já integrados.
  - *O que mudar na correção.* Enviar os achados do revisor, tratados como dado não confiável. Opcionalmente, a nova revisão olha só o diff da correção, e a revisão completa continua como rede de segurança (`src/engineering.ts`, `src/native-verification.ts`).

**A11. O QA dá "passou" com zero testes, com testes pulados ou com saída de falha.** Prioridade média · esforço M (P para o detector) · status parcial.
- **Origem.** Cinco repositórios, três deles como contraexemplo:
  - SuperClaude: `src/superclaude/pytest_plugin.py` e `pm_agent/self_check.py` (contraexemplo);
  - alirezarezvani/claude-skills: `engineering/agent-run-forensics/.../trace_core.py` e `claim_checker.py`;
  - bmad-code-org/BMAD-METHOD: `skills/method/bmad-build-auto/step-03-implement.md` (Matrix Test Audit);
  - eyaltoledano/claude-task-master: `workflow-orchestrator.ts` e `apps/cli/src/commands/autopilot/complete.command.ts` (contraexemplo);
  - mattpocock/skills: `docs/engineering/implement-spec.md` (teste pulado no worktree que saiu verde, contraexemplo).
- **O que fazer no AC.**
  - *Como está hoje.* `src/native-qa.ts:371` decide "passed" só pelo código de saída 0. `src/native-qa-contract.ts` não tem campo de relatório nem de contagem.
  - *Primeiro passo, barato.* Um detector de texto de falha e de "zero testes" no log, que só pode rebaixar o resultado, nunca promover.
  - *Passo seguinte.* Declarar no contrato um formato de relatório (JUnit, TAP ou `node --test`) para contar os testes executados e os pulados. Os executores do módulo 2 (`deploy/modules/qa/node-test-runner.mjs`, `python-test-runner.py`) já contam pulados e podem ser reaproveitados. Rebaixar o recibo quando houver testes pulados em arquivos que o diff tocou.

**A12. Ligar por padrão uma lista única de caminhos protegidos.** Prioridade média · esforço P (M para casar o nome do arquivo em qualquer pasta) · status parcial.
- **O que a lista cobre.** Configuração de agente, CI, harness de teste e arquivos de ignore.
- **Origem.**
  - affaan-m/ECC: `scripts/hooks/config-protection.js`;
  - anthropics/skills: `runner-scaffold.mjs` (`checkHarness`);
  - davila7/claude-code-templates: `.github/workflows/pr-gate.yml` e `pr-automerge.yml` (`MANUAL_PATHS`);
  - multica-ai/andrej-karpathy-skills: `README.md`, linhas 115 a 126;
  - ruvnet/ruflo: `plugins/ruflo-protector/hooks/shapes.ts`, `rules.ts` e `tests/corpus.test.ts`;
  - wshobson/agents: `plugins/review-agent-governance/policies/review-agent-governance.cedar` e `test/run-tests.sh`;
  - disler/claude-code-hooks-mastery: `.claude/agents/team/builder.md` e `.claude/commands/plan_w_team.md`, que mostram hooks no cabeçalho de arquivos `.md`. Sem licença, só a ideia.
- **O que fazer no AC.**
  - *Como está hoje.* `protectedGatePaths` (`src/quality-gate-paths.ts`, linhas 42 a 45) é opcional, vem vazio, aceita só caminho exato ou prefixo e no máximo 64 itens. As listas também divergem: `src/verify-exam-isolation.ts:6` remove `CLAUDE.md`, `AGENTS.md`, `.cursor` e `.agents` das cópias, mas `src/verify-remediate.ts` (linhas 78 a 92) deixa a correção de achados gravar esses arquivos.
  - *O que mudar.* Criar uma lista única, conferida contra a lista real de arquivos mudados, com:
    - `CLAUDE.md` em qualquer pasta, `AGENTS.md` e `skills/**/SKILL.md`;
    - `.claude/`, `.mcp.json`, `.codex/`, `.grok/` e `.cursor/rules/`;
    - `.husky/`, `.github/workflows/`, `Dockerfile*` e `.npmrc`;
    - `package.json` e os lockfiles;
    - as configurações de teste e arquivos de ignore como `.eslintignore`.
  - *Cuidado.* No AC, caminho protegido significa recusa dura. Uma lista com `package.json` bloquearia toda tarefa legítima de dependência. Por isso a lista precisa de um caminho de aprovação humana com o diff à vista, em vez de só recusar (`src/quality.ts`, `src/approvals.ts`, `personal:project` e `personal:qa set`).

**A13. O texto do gerente pode trazer sequências de escape que agem no terminal do titular.** Prioridade média · esforço P · status ausente.
- **Origem.** Fission-AI/OpenSpec: `src/core/archive.ts` (`describeChangeName`) e `src/core/version-check.ts` (`SAFE_VERSION`). anthropics/skills: `skills/claude-api/shared/evals/report/runner-scaffold.mjs`, linhas 46 a 53 (`termSafe`).
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-connect.ts` imprime "gerente: " seguido do texto do gerente direto com `console.log` (linhas 255, 280, 286, 298 e 303), nos comandos `say` e `chat-log` (`src/server-main.ts`, linhas 102 a 104).
  - *O risco.* Um texto induzido por injeção pode gravar na área de transferência, trocar o título da janela ou forjar linhas.
  - *O que mudar.* Criar uma função comum que preserva quebras de linha e tabulações e troca os demais caracteres de controle. Aplicá-la a toda CLI `personal:*` que imprime texto de modelo.
  - *Ressalva.* O conferente do spec-kit deu prioridade baixa à mesma correção. O titular acompanha sobretudo pelo painel e pelo app Happier, que não interpretam essas sequências, e o risco só existe em `say` e `chat-log`. Vale como defesa extra, junto de outra mudança nesses arquivos.

**A14. O prompt do gerente e as tarefas vão na linha de comando, visíveis em `ps`.** Prioridade média · esforço P · status parcial.
- **Origem.** anthropics/skills: `skills/skill-creator/scripts/improve_description.py` (`_call_claude`).
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-manager-chat.ts` (linhas 54 a 55 e 77 a 97) põe o prompt inteiro, de até cerca de 40 KB, nos argumentos do `docker run`. `src/codex-personal.ts:40` faz o mesmo em todas as funções do Codex, e a tarefa de execução pode ter até 100.000 caracteres (`src/claude-execution-adapter.ts:16`). Isso torna plausível o erro de argumento longo demais.
  - *O que mudar.* Passar o prompt pela entrada padrão, como o examinador do AC já faz.

**A15. A compactação do histórico do gerente apaga ordens antigas do titular sem deixar ponteiro.** Prioridade média · esforço P · status parcial.
- **Origem.** mattpocock/skills: `skills/engineering/ask-matt/PHASE-BOUNDARIES.md` e `docs/engineering/ask-matt.md`. shareAI-lab/learn-claude-code: `s08_context_compact/code.py` e o teste `test_prepare_keeps_active_request_after_repeated_snip_compact`.
- **O que fazer no AC.**
  - *Como está hoje.* `compactConversation`, em `src/manager-discipline.ts` (linhas 26 a 48), corta as mensagens antigas em 160 caracteres, ou 400 se parecerem pendência. Passado o orçamento de 4.000 caracteres, descarta as mais antigas com "(N mensagens mais antigas omitidas)", sem dizer quais. Só as 4 mensagens recentes já podem passar do orçamento.
  - *O que mudar.* Manter literal um bloco com as restrições do titular, como "não faça push" ou "não use o Flash em correção grave". Marcar o resumo como dado de referência e apontar os ids das mensagens omitidas em `ac_personal_messages`. Medir o efeito num novo relatório da série T.

**A16. No timeout do chat do gerente, o contêiner pode continuar vivo.** Prioridade média · esforço P · status parcial.
- **Origem.** github/spec-kit: `src/specify_cli/integrations/_capture.py` (`_ProcessTree`, `_drain`).
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-manager-chat.ts` (linhas 77 a 92) chama `docker run --rm` sem `--name`, sem `--init` e sem `rm -f`, com timeout de 180 segundos. No timeout, o Node mata só o cliente docker. O processo principal do contêiner pode ignorar o sinal, e o contêiner continua gastando cota enquanto o gerente para de responder.
  - *O que mudar.* Usar `create --name` e `rm -f`, como `src/codex-quota-supervisor.ts` e `native-protocol-host-supervisor.ts` já fazem. O mesmo vale, com risco menor, para `src/personal-qa-config.ts:125`. No início do gateway (`src/server-main.ts`), reconciliar os contêineres que ficaram órfãos.

**A17. Se o AC interromper o Git à força no meio de uma gravação, pode sobrar um arquivo de trava, e as gravações seguintes naquele ramo falham até alguém apagá-lo.** Prioridade média · esforço P · status ausente.
- **Origem.** Fission-AI/OpenSpec: `src/core/store/git.ts`.
- **O que fazer no AC.**
  - *Como está hoje.* `src/git.ts` (linhas 36 a 48) mata o grupo do helper Ruby com SIGKILL depois de 10 segundos, em todas as ações. Isso inclui `cas`, que roda `git update-ref` no repositório real (`services/agent-control-git/helper.rb:242`). Se a trava ficar, todo CAS seguinte nesse ramo falha, e o próprio `git commit` do titular também.
  - *O que mudar.* Dar a cada ação seu próprio prazo e sinal: nas escritas, primeiro SIGTERM e só depois SIGKILL. Na reconciliação (`src/integration.ts`, `src/recovery-*.ts`), detectar `<ref>.lock` órfão e relatar um código próprio, por exemplo `GIT_REF_LOCK_STALE`.
  - *Ressalva.* A janela de risco é estreita, de milissegundos durante o `update-ref`.

**A18. Duas travas acham que um programa ainda roda só porque existe algum programa com o mesmo número (PID), que o sistema reaproveita.** Prioridade média · esforço P · status parcial.
- **Origem.** Yeachan-Heo/oh-my-claudecode: `src/platform/process-utils.ts` (`getProcessStartIdentitySync`, `isProcessIdentityLive`).
- **O que fazer no AC.**
  - *Como está hoje.* `src/verify-db.ts` (linhas 361 a 368, `claimHolderAlive`) e `src/remote-source-materialization.ts` (linhas 27 a 30) só testam `process.kill(pid,0)`. Se o número for reusado por outro processo, a marca do verify-db parece em uso até o processo que reusou o número terminar, e só então é podada.
  - *O que mudar.* Usar `registeredProcessAlive`, de `src/local-workflow-runtime.ts:57`, que confere o horário de início. O `native-artifact-finalizer.ts` grava o horário de início, mas não o compara.
  - *Ressalva.* Outro conferente (claude-mem) deu prioridade baixa à mesma lacuna.

**A19. Não existe portão de memória antes de lançar exames e jobs.** Prioridade média · esforço P · status ausente.
- **Origem.** Yeachan-Heo/oh-my-claudecode: `src/lib/host-load-gate.ts`. Dele vem só a ideia, porque o portão deles deixa passar quando falha.
- **O que fazer no AC.**
  - *Como está hoje.* O AC só tem portão de disco (`src/disk-admission.ts`, `src/personal-disk.ts`). Cada contêiner de módulo reserva 2 GiB e 2 CPUs. Vários em paralelo podem esgotar a memória do host e derrubar o PostgreSQL da instalação viva.
  - *O que mudar.* Antes de lançar, somar a memória reservada pelos contêineres ativos mais a do novo e comparar com a memória disponível. Na dúvida, bloquear (`src/personal-watch.ts`, `src/native-worker-gate.ts`).

**A20. A versão fixada da imagem pode ser anterior ao código atual do coletor, e então o exame roda código velho.** Prioridade média · esforço P (M com a etiqueta conferida na hora de rodar) · status ausente.
- **Origem.**
  - alirezarezvani/claude-skills: `scripts/check_plugin_versions.py`;
  - github/spec-kit: `.github/workflows/extension-version-guard.yml` e `.github/scripts/check_extension_version_bump.py`;
  - wshobson/agents: `tools/check_version_bumps.py`.
- **O que fazer no AC.**
  - *Como está hoje.* `deploy/modules/*/digest.txt` e `deploy/design-image-digest.txt` são lidos em `src/verification-modules.ts` (linhas 371 a 392), mas nada liga uma mudança no coletor (`collect.mjs`, Dockerfile, locks) à troca do digest. Um coletor corrigido que não chega à imagem roda código velho e gera prova com cara de nova. Isso já aconteceu: houve um rebuild manual pendente depois de uma mudança no entrypoint.
  - *Passo 1.* Uma checagem no Git, chamada por `scripts/test-ci.mjs`, que exige digest novo quando a fonte do módulo muda. Ela não deve isentar os lockfiles.
  - *Passo 2.* Gravar no build uma etiqueta (LABEL) com o hash da fonte e conferi-la na hora de rodar.
  - *Limite do passo 1.* O passo 1 não pegaria o caso que já aconteceu. A imagem do módulo 1 é fixada em `<dataDirectory>/verify-image.json` (`src/verify-command.ts:781`), fora do repositório, e não num `digest.txt`. Só o passo 2 pega esse caso. A outra saída é o passo 1 cobrir também `deploy/Dockerfile.verify` e `deploy/verify-entrypoint.sh`, com o digest fixado no repositório.

**A21. "Nenhum achado" não prova que a ferramenta estava funcionando.** Prioridade média · esforço M · status parcial.
- **Origem.** mattpocock/skills: `skills/in-progress/setup-ts-deep-modules/SKILL.md` e `skills/engineering/diagnosing-bugs/SKILL.md`. wshobson/agents: `plugins/review-agent-governance/test/run-tests.sh`, que traz a regressão do bug #705.
- **O que fazer no AC.**
  - *Como está hoje.* Em `src/verify-collect.ts` (linhas 10 a 15 e 177), uma ferramenta que não escreve relatório conta como "limpa". `src/verify-report.ts:213` define "limpa" pelo código de saída.
  - *O que mudar.* Rodar, para cada ferramenta, um canário com uma violação plantada e exigir que ela seja achada. Para baixar o custo, basta rodar uma vez por digest de imagem, guardar o resultado junto do digest e registrá-lo no recibo do lote (`src/exam-batch-proof.ts`).

**A22. A extração da cópia não confiável não tem limite de tamanho.** Prioridade média · esforço M · status ausente.
- **Origem.** github/spec-kit: `src/specify_cli/_download_security.py` (`safe_extract_tar` e os limites `MAX_*`) e `tests/test_download_security.py`.
- **O que fazer no AC.**
  - *Como está hoje.* O `git archive | tar` de `src/verify-command.ts` e de `src/verification-modules.ts` só tem um timeout de 60 segundos. Não conta bytes nem entradas, então um repositório pequeno que se expande para muitos gigabytes encheria o disco.
  - *O que mudar.* Antes de extrair, conferir com `git ls-tree -r -l` a soma dos tamanhos e o número de entradas. Limitar os bytes durante a extração, com um orçamento por cópia em `src/personal-disk.ts`.
  - *Ressalva.* Os episódios de disco a 98–99% vieram das pastas `work/` dos jobs e dos arquivos temporários de imagens de contêiner, não de um repositório malicioso. Isto é prevenção.

**A23. A cadeia de suprimentos do próprio repositório do AC não é vigiada.** Prioridade média · esforço P · status parcial.
- **Origem.** Fission-AI/OpenSpec: `.github/workflows/security.yml`, `ci.yml`, `.github/dependabot.yml` e `pnpm-workspace.yaml`.
- **O que fazer no AC.**
  - *Como está hoje.* `.github/workflows/isolated-ci.yml` usa `actions/checkout@v4` por tag. Não há auditoria de dependências, agendamento nem Dependabot, e há três lockfiles: `package-lock.json`, `upstream/cezar/package-lock.json` e `upstream/happier/yarn.lock`.
  - *O que mudar.* Fixar as ações por SHA e auditar os três lockfiles toda semana. A alternativa sem GitHub é rodar o próprio módulo 4 (`personal:dependencias`) sobre o AC no timer semanal.
  - *Ressalva.* Três conferentes deram prioridade baixa à fixação por SHA, sozinha. Há uma única ação, oficial do GitHub, com token só de leitura e `persist-credentials: false`. O ganho está na auditoria dos três lockfiles.

**A24. Os trabalhadores do processo de desenvolvimento rodam no host com todas as aprovações desligadas.** Prioridade média · esforço M · status ausente.
- **Origem.** mattpocock/skills: `skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh`, como contraexemplo. É uma guarda que se contorna e deixa passar quando falha.
- **O que fazer no AC.**
  - *Como está hoje.* O AGENTS.md manda acionar o agy e o claude com `--dangerously-skip-permissions` e o `codex exec` com `--dangerously-bypass-approvals-and-sandbox`. Eles rodam no mesmo host do banco vivo e do `docker.sock`, e a pasta `.claude/` está vazia.
  - *Quem decide.* A decisão é do titular, porque foi ele quem autorizou o bypass.
  - *A opção forte.* Rodar esses trabalhadores num contêiner, com um runner novo em `scripts/` que reaproveite `deploy/Dockerfile.native-execution` e `src/native-execution-isolation.ts`.
  - *Hook não basta.* Um hook do Claude Code só protege os trabalhadores Claude, que são os últimos da fila. Os trabalhadores agy, que vêm primeiro, não passam por ele.
  - *Trava no Git.* Ela cobre todas as CLIs e custa menos: um hook pre-push, um endereço de push inválido nos worktrees ou um wrapper de git no PATH.
  - *Se ainda assim usar um hook.* Ele precisa separar o comando em partes e bloquear na dúvida. Dois conferentes deram prioridade baixa a ofertas parecidas.

**A25. As units systemd geradas por `personal:timers` não escapam os caminhos.** Prioridade média · esforço P · status parcial.
- **Origem.** disler/claude-code-hooks-mastery: `.claude/hooks/setup.py`, linhas 53 a 59. Sem licença, só a lição.
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-timers.ts` (linhas 19 a 31 e 55 a 62) monta `WorkingDirectory`, `Environment` e `ExecStart` com os caminhos crus. Um espaço ou um `%` no caminho faz o backup, a manutenção e a prova de restauração pararem de rodar sem alarme.
  - *O que mudar.* Usar o escape que o AC já tem e testa em `scripts/systemd-exec.mjs`, e acrescentar casos com espaço e `%` em `tests/personal-timers.test.ts`.
  - *Ressalva.* Hoje a exposição é baixa, porque os caminhos da instalação não têm espaço nem `%`.

**A26. Não há aviso quando uma unit systemd instalada fica desatualizada.** Prioridade média · esforço P · status ausente.
- **Origem.** gsd-build/get-shit-done: `hooks/gsd-check-update-worker.js`, `hooks/gsd-statusline.js` e `scripts/build-hooks.js`.
- **O que fazer no AC.**
  - *Como está hoje.* `src/personal-timers.ts` só grava as units, sem comparar com as que estão instaladas. O commit `6849d85d` registra que os quatro timers do ispagent tiveram de ser reinstalados à mão.
  - *O que mudar.* Gravar em cada `.service` e `.timer` um comentário com o digest do texto gerado, e fazer o `personal:watch` ou o `personal-health` avisar quando a unit instalada for diferente. Incluir também as units de `personal-services.mjs`.

**A27. A tabela de auditoria `ac_audit` pode ser alterada ou apagada sem deixar rastro.** Prioridade média · esforço M · status ausente.
- **Origem.** wshobson/agents: `plugins/protect-mcp/test/hook-migration.mjs` e `hooks/sign.sh`.
- **O que fazer no AC.**
  - *Como está hoje.* `db/migrations/001_authority.sql` (linhas 29 e 30) cria `ac_audit` sem gatilho, e há 64 inserções nela espalhadas por 31 arquivos de `src/`.
  - *O que mudar.* Uma migração nova com um gatilho que impede alterar e apagar e calcula uma cadeia de hash. A ponta da cadeia fica guardada fora do banco (`src/personal-backup.ts`, `src/personal-restore-proof.ts`).
  - *Ressalva.* A cadeia não detecta um corte no fim, e quem é dono do banco pode desligar o gatilho. O ganho contra acesso indevido vem da âncora guardada fora.

**A28. No módulo 1 e no design, o conteúdo do repositório entra no pedido com rótulos fixos.** Prioridade média · esforço P · status parcial.
- **Origem.** ruvnet/ruflo: `plugins/ruflo-ai-team/src/untrusted.mjs` (`fenced()`).
- **O que fazer no AC.**
  - *Como está hoje.* `examTask` e `confirmationTask`, em `src/verify-runtime.ts` (linhas 675 a 717), juntam o conteúdo do arquivo examinado com rótulos fixos ("Conteúdo do arquivo:", "Mapa:"). `src/design-examine.ts` faz o mesmo nas linhas 364 e 380. Um arquivo pode imitar o rótulo e forjar um "pedido de confirmação".
  - *O que mudar.* O caminho mais barato é serializar o conteúdo em JSON, como os módulos 2 a 9 já fazem. A lista de expressões regulares do ruflo é fraca e não vale copiar.

### (b) Ideias de produto e processo

**B1. Um protocolo único para provar "economia sem perda de qualidade".** Prioridade alta · esforço M · status parcial.
- **Origem.** Sete repositórios:
  - alirezarezvani/claude-skills: `engineering/agent-regression-evals/.../regression_gate.py`, `flake_detector.py` e `scripts/evals/trigger_gate.py`;
  - affaan-m/ECC: `docs/gateguard/question-effectiveness.md` e `docker/gateguard-effectiveness/`;
  - anthropics/skills: `skills/claude-api/shared/evals/cost-hillclimb.md`, `eval-audit.md` e `eval-hillclimb.md`;
  - bmad-code-org/BMAD-METHOD: `skills/toolsmith/bmad-eval/scripts/eval_common.py`, `run_evals.py` e `aggregate_benchmark.py`;
  - obra/superpowers: `docs/superpowers/specs/2026-06-10-strict-cost-sdd-design.md`;
  - thedotmack/claude-mem: `tests/evals/read-gate/README.md` e os testes do mesmo eval;
  - SuperClaude: `scripts/ab_test_workflows.py`. Dele vem só a ideia, porque o código tem bugs.
- **O que fazer no AC.**
  - *Como está hoje.* A regra do titular exige provar a economia sem perda de qualidade, mas os relatórios medem uma amostra só. O T5 foi julgado com 5 perguntas, o T6 mediu apenas caracteres e `docs/economia/RELATORIO-LOTES.md` diz que o lote "não foi medido com o modelo real".
  - *O que mudar.* Criar em `docs/economia/` um modelo de ordem com:
    - portões escritos antes de rodar: a faixa de qualidade aceita, a margem de custo com cache e o mecanismo esperado;
    - dois braços, com e sem a otimização, sobre os mesmos casos;
    - pelo menos 3 repetições (o superpowers usa 5, com defeito plantado);
    - comparação em pares (McNemar exato);
    - a regra de que "não medido" conta como reprovado.

    Somar um script novo, `scripts/economia-portao.mjs`, e um modo de comparação em `src/personal-tokens-cli.ts`.
  - *Primeiro uso.* Comparar o lote ligado e desligado na régua dos módulos, com pelo menos 3 repetições.
  - *Dependência e custo.* Depende do C1. O custo maior é cota, não código.
  - *Status.* Algumas ordens já trazem o critério escrito antes, como a do T5. Faltam a estatística, as repetições e a medida de qualidade.
  - *Código aproveitável.* `regression_gate.py`, com licença MIT.

**B2. O AGENTS.md virou sedimento.** Prioridade alta · esforço P · status ausente.
- **Origem.** mattpocock/skills: `skills/productivity/writing-for-agents/SKILL.md`, `skills/engineering/retro/SKILL.md` e `skills/in-progress/chief-of-staff/SKILL.md`.
- **O que fazer no AC.**
  - *Como está hoje.* O `AGENTS.md` tem 163 linhas, 21.453 bytes e 14 ocorrências de "substitui". Regras contraditórias ficam lado a lado, por exemplo "Utilizar exclusivamente subagentes nativos do Codex" junto das filas posteriores de agy, Claude e Sol. Pela estimativa feita a partir do tamanho em bytes, cada sessão de trabalhador ou de revisor paga cerca de 5 a 7 mil tokens desse histórico; isso ainda não foi medido. A sessão também pode seguir uma regra já superada. O produto não é afetado, porque as cópias de exame já removem o arquivo.
  - *O que mudar.* Deixar no `AGENTS.md` só a regra vigente. Mover as entradas antigas, inteiras, para `docs/HISTORICO-EQUIPE.md`, porque elas são o registro das autorizações. Acrescentar um lint em `scripts/`, chamado por `scripts/test-ci.mjs`, e medir o ganho com `personal:tokens`. A mudança é do titular.

**B3. Conferir cada achado do revisor antes de abrir uma correção.** Prioridade média · esforço M · status ausente.
- **Origem.** bmad-code-org/BMAD-METHOD: `skills/method/bmad-build-auto/step-04-review.md` e `skills/method/bmad-code-review/step-03-triage.md`.
- **O que fazer no AC.**
  - *Como está hoje.* Uma recusa do revisor abre a correção na hora (`src/engineering.ts`, linhas 36 a 45). Os achados têm só gravidade e resumo, sem local nem evidência (`src/native-review-contract.ts`). Cada falso positivo custa uma rodada inteira de programador, QA e revisor.
  - *Primeiro passo.* Pôr local e evidência nos achados, que é barato.
  - *Passo seguinte, se compensar.* Um passo de triagem entre a revisão e a correção, que confere cada achado no arquivo e na linha citados, dá a própria gravidade e descarta os falsos positivos com a refutação escrita. Ele acrescenta uma chamada a cada recusa e só compensa se os falsos positivos forem frequentes, o que ninguém mediu. No BMAD, quem faz a triagem é o próprio orquestrador. Fazê-la em outra conta é ideia nossa.

**B4. Lentes de revisão especializadas, a começar por "lacuna de verificação".** Prioridade média · esforço M · status ausente.
- **Origem.** bmad-code-org/BMAD-METHOD: `skills/method/bmad-build-auto/review-prompts/verification-gap.md`, `edge-case-hunter.md`, `references/claims-check.md` e `references/deletion-check.md`.
- **O que fazer no AC.**
  - *Como está hoje.* O revisor recebe uma única instrução genérica (`nativeReviewRequest`, linha 28 de `src/native-verification.ts`).
  - *O que mudar.* Criar uma lente que procura comportamento alterado que poderia quebrar sem nenhum teste falhar. Ela segue regras de evidência: ler o teste antes de dizer o que ele cobre e buscar o símbolo antes de dizer que não há teste. Ligar uma lente a cada vaga de revisor em `src/personal-combos.ts` e `src/quality.ts`.

**B5. Mostrar as premissas do gerente, com o custo de cada uma se estiver errada, junto da proposta.** Prioridade média · esforço M · status ausente.
- **Origem.** obra/superpowers: `skills/subagent-driven-development/SKILL.md` (no formato "Ruling: o quê, por quê, custo se errado"), `references/final-review.md` e `references/preflight.md`.
- **O que fazer no AC.**
  - *Como está hoje.* O titular aprova vendo tarefas e caminhos, não o que o gerente presumiu. `ManagerPlan` (`upstream/cezar/packages/contract/src/agent-control-plans.ts`, linhas 10 a 15) não tem campo para isso, e o pacote de contrato não pode ser editado.
  - *O que mudar.* Usar o mesmo contorno que já foi usado para o campo `level` (`src/planning.ts`) e mostrar as premissas na proposta (`src/semantic-planning.ts`, `src/proposal-decision.ts` e a tela de conversa).

**B6. Um canal de convenções do titular, fora do repositório, com experimento T7 antes de ligar.** Prioridade média · esforço M · status ausente.
- **Origem.** buildermethods/agent-os: `commands/agent-os/index-standards.md`, `inject-standards.md`, `discover-standards.md` e `scripts/project-install.sh` (`create_index`). A mesma fonte deu as duas ofertas, o canal e o experimento.
- **O que fazer no AC.**
  - *Por que vale.* Os exames tiram `CLAUDE.md` e `AGENTS.md` das cópias, o que é certo para a segurança, mas com isso o gerente e os examinadores ficam sem as convenções legítimas.
  - *O que mudar.* Guardar as convenções aprovadas em `<dataDirectory>/padroes/<projectId>/`, com um `index.json` que registra caminho, descrição de uma linha e sha256. Um seletor injeta de 2 a 5 delas no pedido do job e no contexto do gerente: novo `src/project-standards.ts`, ligado a `src/native-repo-map.ts`, `src/manager-discipline.ts`, `src/semantic-planning.ts` e `ProjectEconomy` em `src/installation.ts`.
  - *Antes de ligar por padrão.* Fazer o experimento T7 com três braços (sem convenções, com todas e com a seleção), medidos com `personal:tokens` e seguindo o B1.

**B7. Um contexto de produto escrito pelo titular entra no contexto do gerente.** Prioridade média · esforço P · status ausente.
- **Origem.** buildermethods/agent-os: `commands/agent-os/plan-product.md` e `shape-spec.md`.
- **O que fazer no AC.**
  - *Como está hoje.* O gerente decide vendo só o README e o mapa (`src/manager-discipline.ts`, linhas 95 a 115, e `src/personal-runtime.ts`, linhas 236 a 242). O README de um projeto de terceiro pode conter instruções hostis.
  - *O que mudar.* Um arquivo curto por projeto em `<dataDirectory>/produto/<projectId>.md`, com permissão 0600, escrito pelo titular pelo chat ou pelo painel. Ele traz a missão, o público, a fase atual e o que está fora de escopo, e entra no contexto do gerente antes do README, dentro de `managerContextTokens`.

**B8. Só rebaixar para programador básico com garantia objetiva.** Prioridade média · esforço P · status ausente.
- **Origem.** davila7/claude-code-templates: `cli-tool/components/mods/productivity/jev-model-router/hooks/policy.ts` e os testes dele.
- **O que fazer no AC.**
  - *Como está hoje.* O planejador escolhe o nível num campo livre (`src/claude-planning-adapter.ts:40`), e `programmerChain` obedece (`src/capacity.ts`, linhas 78 a 85).
  - *O que mudar.* O nível "basic" só vale se os `writePaths` forem pequenos, não tocarem caminhos protegidos nem áreas de risco (migrações, autenticação, criptografia, CI) e a tarefa não for correção de achado alto. Nos outros casos, vira "standard", e o motivo aparece no feed da equipe (`src/personal-team-feed.ts`).

**B9. Ler a cota do Claude antes de lançar, a partir dos próprios jobs.** Prioridade média · esforço M · status parcial.
- **Origem.** Yeachan-Heo/oh-my-claudecode: `src/hud/usage-api.ts` (os tipos e o cache) e `src/features/rate-limit-wait/rate-limit-monitor.ts`.
- **O que fazer no AC.**
  - *Como está hoje.* O AC só descobre a cota esgotada depois de falhar, e usa 1 hora quando não há horário de reset. Ele já tem o parser `claude-rate-limit-event-v1` (`src/provider-collector-parsers.ts`), que lê as janelas de 5 horas e semanal, mas nada o alimenta para o Claude.
  - *O que mudar.* Capturar as linhas `rate_limit_event` do stream-json dos jobs e exames e gravar o horário real de reset em `ac_accounts.exhausted_until` (`src/quota-exhaustion.ts`, `src/capacity.ts`). Mostrar isso no painel Equipe.
  - *O que não copiar.* A renovação do token OAuth e o endpoint não documentado do OMC, que são alertas altos do próprio projeto.

**B10. Teto de turnos e de custo por sessão, por papel.** Prioridade média · esforço P · status ausente.
- **Origem.** ruvnet/ruflo: `scripts/e2e/leg-claude.mjs` (`--max-budget-usd`) e `v3/@claude-flow/codex/src/dual-mode/orchestrator.ts` (`--max-turns`).
- **O que fazer no AC.**
  - *Como está hoje.* O `buildClaudeArgs` do Cezar não passa nenhum dos dois. Os adaptadores só têm `timeoutMs`, com padrão de 900 segundos e máximo de 1.800 (`src/claude-execution-adapter.ts:19`).
  - *O que mudar.* Definir um teto por papel em `src/personal-combos.ts` ou `src/effort.ts`.
  - *Ressalvas.* Pela regra do titular, isso só entra com medição antes e depois (B1). Não se verificou se Codex e Grok têm opção equivalente.

**B11. Registrar o tipo de prova que fechou cada achado do módulo 1.** Prioridade média · esforço P · status parcial.
- **Origem.** Yeachan-Heo/oh-my-claudecode: `src/features/verification-ledger/ledger.ts` (`VERIFICATION_VERDICTS`).
- **O que fazer no AC.**
  - *Como está hoje.* `src/verify-remediate.ts:64` grava só "fechado" ou "reaberto". O fechamento pode ter três bases diferentes: o trecho sumiu do diff, dois Claude concordaram, ou houve um único "descartado" num achado que não é alto (linhas 334 a 349 e 769 a 789).
  - *O que mudar.* Gravar em `achados.json` e no README do relatório qual foi a prova. Os módulos 2 a 9 já fazem isso (`src/module-recheck-regression.ts`).

**B12. Aceitar um risco com dono e prazo, e reabri-lo sozinho quando o prazo vencer.** Prioridade média · esforço M · status ausente.
- **Origem.** ruvnet/ruflo: `.github/supply-chain/accepted-findings.json` e o README da mesma pasta.
- **O que fazer no AC.**
  - *Como está hoje.* Os achados só têm os estados confirmado, provável, descartado, fechado e reaberto (`src/verify-types.ts:7`, `src/design-types.ts:13`).
  - *O que mudar.* Criar o estado "risco aceito", com dono, motivo, referência e data de validade, que reabre sozinho depois da data (`src/verification-modules.ts`, `src/personal-module-cli.ts`). No ruflo a validade é opcional e a referência não é conferida. No AC, as duas devem ser obrigatórias.

**B13. Retomar um exame depois de uma queda sem pagar de novo os julgamentos.** Prioridade média · esforço G · status ausente.
- **Origem.** shareAI-lab/learn-claude-code: `s16_workflow_runtime/code.py` (`WorkflowJournal`, `reserve_run_id`, `workflow_run_lock`) e os testes em `tests/test_workflow_goal_lessons.py`.
- **O que fazer no AC.**
  - *Como está hoje.* Os achados e a cobertura só são gravados na transação final (`src/verification-modules.ts`, linhas 2266 e 2284), e a espera de cota só retoma dentro do mesmo processo (`src/module-exam.ts`, linhas 398 e 598). Se o processo cair, os julgamentos já pagos se perdem.
  - *O que mudar.* Gravar cada julgamento num registro só de acréscimo, com chave determinística, e oferecer `--retomar <rodada>` em `src/personal-module-cli.ts` e `src/personal-verify-cli.ts`.
  - *O que não copiar.* Os defeitos do curso: a chave truncada em 10 dígitos e a gravação sem fsync.

**B14. Um scanner de segurança sobre o diff de cada trabalhador.** Prioridade média · esforço M · status ausente.
- **Origem.** davila7/claude-code-templates: `scripts/skillspector_scan.py` e `.github/workflows/skill-security-scan.yml`.
- **O que fazer no AC.**
  - *Como está hoje.* O portão de integração (`assertReady` em `src/quality.ts`, linhas 410 a 427) não roda scanner de segurança. Um segredo que um trabalhador introduza só aparece no próximo exame.
  - *O que mudar.* Rodar o gitleaks e o opengrep da imagem fixada do módulo 1 (`deploy/Dockerfile.verify`) na versão base e na versão candidata, bloquear só o que for novo e tratar erro do scanner como bloqueio (`src/verify-normalize.ts`).

**B15. O módulo 1 passa a examinar a superfície de agentes do projeto.** Prioridade média · esforço M · status ausente.
- **O que isso cobre.** Hooks, MCP sem versão e arquivos que se executam sozinhos.
- **Origem.**
  - davila7/claude-code-templates: `scripts/mcp_versions.py` e `scripts/test_mcp_versions.py`;
  - gsd-build/get-shit-done: `get-shit-done/bin/lib/runtime-homes.cjs`, `security.cjs`, `hooks/gsd-read-injection-scanner.js` e `scripts/base64-scan.sh`;
  - affaan-m/ECC: `scripts/ci/scan-supply-chain-iocs.js` e `scripts/lib/harness-capabilities.js`.
- **O que fazer no AC.**
  - *Como está hoje.* O AC tira esses arquivos da cópia de exame para proteger o examinador, o que está certo. O efeito colateral é que nenhum módulo os examina, e `LOWER_FORBIDDEN` (`src/verification-modules.ts:85`) chega a recusar achados nesses caminhos.
  - *O que mudar.* Antes da limpeza, inventariar no código original, só para leitura:
    - hooks com comando;
    - servidores MCP sem versão exata;
    - arquivos que se executam sozinhos, como `.vscode/tasks.json` e `.github/workflows`;
    - instruções de agente dos vários runtimes.

    Cada item vira achado do módulo 1 ou do módulo 4: novo `src/verify-agent-surface.ts`, item em `src/verify/lista-seguranca.json` e regra em `deploy/modules/dependencias/collect.mjs`. Esses caminhos ficam liberados só para relatório, nunca para escrita ou correção.

**B16. Um analisador de workflows do GitHub Actions no módulo 1.** Prioridade média · esforço M · status parcial.
- **Origem.** affaan-m/ECC: `scripts/ci/validate-workflow-security.js`.
- **O que fazer no AC.**
  - *O que mudar.* Pôr o zizmor na imagem verify, fixado por hash e em modo offline, porque o coletor não tem rede (`deploy/Dockerfile.verify`, `deploy/verify-tools.lock.json`). Somar um normalizador em `src/verify-normalize.ts`, um item em `src/verify/lista-seguranca.json` e uma fixture de workflow vulnerável.
  - *Por que vale.* As classes que importam são `pull_request_target` com checkout do PR, `workflow_run` com `head_*`, `write-all` e `id-token: write` com cache compartilhado. O checkov cobre pouco disso.

**B17. Uma regra no módulo 9 (LGPD) para telemetria de LLM que captura prompts e dados pessoais.** Prioridade média · esforço P · status ausente.
- **Origem.** eyaltoledano/claude-task-master, como caso de teste: `src/telemetry/sentry.js`, `src/ai-providers/base-provider.js` e `scripts/modules/config-manager.js`.
- **O que fazer no AC.**
  - *Como está hoje.* O módulo 9 segue campos pessoais até console, axios e fetch, mas não percebe vazamento feito pela configuração de um SDK.
  - *O que mudar.* Uma regra nova em `deploy/modules/conformidade/`, ao lado de `lgpd_javascript.mjs` e `lgpd_python.py`, que detecta `recordInputs`/`recordOutputs`, `sendDefaultPii`, amostragem de 100% e telemetria ligada por padrão. Mapear a regra em `src/verification-modules.ts`.
  - *Cuidado.* Não usar o arquivo deles como fixture sem o aviso MIT + Commons Clause.

**B18. Uma checagem determinística da documentação contra o código no módulo 8.** Prioridade média · esforço M · status parcial.
- **Origem.** SuperClaude: `.github/workflows/readme-quality-check.yml`. O `README.md`, o `CHANGELOG.md` e o `package.json` deles são um bom corpus de deriva.
- **O que fazer no AC.**
  - *Como está hoje.* O módulo 8 já compara as assinaturas citadas nos `.md` com a API do TypeDoc (`crossCheckMarkdownAgainstTypedoc` em `deploy/modules/documentacao/collect.mjs`).
  - *O que mudar.* Antes do TypeDoc, uma etapa que confere os arquivos, comandos e scripts citados na documentação: links locais, scripts do `package.json` e caminhos. É o erro que mais engana os agentes. Documentar no §8 de `docs/MODULOS-DE-VERIFICACAO.md`.

**B19. Travas de worktree para os trabalhadores do processo.** Prioridade média · esforço P · status ausente.
- **Origem.** gsd-build/get-shit-done: `get-shit-done/bin/lib/worktree-safety.cjs` (`executeWorktreeWaveCleanupPlan`) e `agents/gsd-executor.md`.
- **O que fazer no AC.**
  - *Escopo.* Vale para o processo de desenvolvimento. O produto já integra por CAS com fencing.
  - *Como está hoje.* As ordens dizem "worktree X em <sha>", mas nada confere a base nem bloqueia arquivos apagados na hora de juntar.
  - *O que mudar.* Um manifesto por rodada com worktree, ramo e base esperada. Antes de juntar, conferir o ramo, o merge-base, que nenhum arquivo foi apagado sem ordem e que o worktree está limpo, parando no primeiro bloqueio. Isso entra no `AGENTS.md`, no modelo das ordens `docs/ORDEM-*.md` e no script do gerente.

**B20. Datar cada afirmação de estado com o commit em que ela valia.** Prioridade média · esforço P · status parcial.
- **Origem.** mattpocock/skills: `skills/in-progress/chief-of-staff/SKILL.md`. O `docs/engineering/diagnosing-bugs.md` deles mostra o custo de não fazer isso.
- **O que fazer no AC.**
  - *Como está hoje.* `docs/ESTADO.md` tem 47 linhas e só 2 citam commit. A linha da manutenção agendada ainda diz que o timer chama `--retencao-agendada` e "não atualiza as bases de vulnerabilidade". Hoje `src/personal-timers.ts:61` chama `--manutencao-agendada`, que atualiza as bases: a mudança entrou em `acf2db77`, depois da última edição do ESTADO.
  - *O que mudar.* Terminar cada linha de estado com "(em <commit>, <data>)". Um lint em `scripts/`, chamado por `scripts/test-ci.mjs`, marca as linhas cujos arquivos citados mudaram depois desse commit. Vale para `docs/ESTADO.md` e `docs/STATUS.md`.

### (c) Código reaproveitável

Todos os itens abaixo têm licença que permite copiar.

**C1. Contar à parte o que o provedor leu do cache (barato) e o que gravou nele (caro), e explicar quando o cache deixou de funcionar.** Prioridade média · esforço M (P só para a leitura) · status parcial.
- **Origem e licença.**
  - davila7/claude-code-templates: `cli-tool/components/mods/observability/prompt-cache-control/hooks/cache.ts` e `tests/cache.test.tsx`. São 400 linhas de funções puras e testadas. A licença MIT está declarada no `plugin.json` do mod. O repositório tem material de terceiros com outras licenças, então copie só esse mod.
  - anthropics/skills: `skills/claude-api/shared/evals/cost-hillclimb.md` (o passo "Caching health") e `skills/claude-api/shared/preserved-thinking-migration/prefix_diff.py`. Licença Apache-2.0: manter o aviso e o NOTICE.
  - thedotmack/claude-mem: `plugin/skills/agent-cost-report/scripts/acr/transcripts.py` e `costs.py`. Licença Apache-2.0: manter o LICENSE, o NOTICE e o aviso de modificação.
- **O que fazer no AC.**
  - *Como está hoje.* Leitura e escrita de cache chegam separadas, mas são somadas num campo único: `src/usage.ts` (linhas 8 e 9, `UsageCounters`), `src/native-usage.ts` (linhas 11 a 15), `src/module-exam-worker.ts` (linhas 171 e 172) e `src/external-usage.ts` (linhas 60 e 61). No Codex esse campo quer dizer só leitura; no Claude, leitura mais escrita.
  - *Por que importa.* Leitura custa cerca de 0,1 vez o preço da entrada, e escrita de 1,25 a 2 vezes. Uma mudança que quebra o cache fica invisível.
  - *O que mudar.* Separar os dois contadores. Eles ficam em jsonb, então não precisa de coluna nova. Mostrar a taxa de acerto do cache por modelo, papel e conta em `personal:tokens`. A deduplicação por `message.id` já existe (`src/external-usage.ts:50-54`); acrescente `requestId` só se uma medição mostrar que é preciso. Portar `hitRatio` e `missReason` do `cache.ts` para achar a causa de uma queda.
  - *Dependência.* É pré-requisito do B1.

**C2. Unificar a redação de segredos.** Prioridade média · esforço M · status parcial.
- **Origem e licença.** thedotmack/claude-mem: `src/utils/redaction.ts`, `tests/utils/redaction.test.ts`, `tests/utils/redaction-coverage.test.ts` e `tests/hooks/server-redaction-boundary.test.ts`. Licença Apache-2.0: copiar exige manter o LICENSE, o NOTICE e o aviso de modificação.
- **O que fazer no AC.**
  - *Como está hoje.* O AC tem dois redatores. O do Cezar (`upstream/cezar/packages/cezar/src/core/secret-redaction.ts`) tem 11 padrões e não pega chave PEM, credencial em URL, JWT, Bearer nem Cookie. É ele que limpa os logs nativos (`src/native-execution-redaction.ts`). O outro fica em `src/verify-redact.ts`.
  - *Por que importa.* Uma senha num endereço `postgres://usuario:senha@` não seria mascarada na saída de um programador que lê o `.env` do NexoISP.
  - *O que mudar.* Juntar os dois num módulo único, com os cerca de 45 padrões nomeados e o corpus de testes do claude-mem, aplicado ao Cezar por patch.

**C3. Descobrir em que o contexto é gasto e o que se repete, lendo as transcrições.** Prioridade média · esforço M · status ausente.
- **Origem e licença.** obra/superpowers: `skills/diagnosing-superpowers/prompts/repeated-work.md`, `cost-and-time.md` e `references/context-safety.md`, mais `tests/claude-code/analyze-token-usage.py` (MIT). Yeachan-Heo/oh-my-claudecode: `src/features/session-friction-report/index.ts` e `types.ts` (MIT).
- **O que fazer no AC.**
  - *Como está hoje.* `readClaude` (`src/external-usage.ts`, linhas 50 a 64) só soma tokens por modelo.
  - *O que mudar.* Acrescentar ao `personal:tokens` (`src/personal-tokens-cli.ts`, `src/usage-report*.ts`), sem imprimir conteúdo:
    - o maior resultado de ferramenta;
    - a taxa de erro;
    - o maior intervalo ocioso;
    - as repetições: o mesmo arquivo lido 3 vezes ou mais, editado 2 vezes ou mais, ou o mesmo comando 2 vezes ou mais. Cada repetição é classificada como justificada, causada pela compactação ou desperdício.

    Com isso, T4 e T6 passam a ser decididos com dados.
  - *O que o AC teria de escrever.* Ligar cada resultado à ferramenta que o produziu. O OMC mede só o tamanho.
  - *O que não copiar.* O `analyze-token-usage.py` cobra o cache pelo preço cheio.

**Trechos pequenos aproveitáveis dentro de outros itens.** Cada um está no item indicado, com a licença:
- `regression_gate.py` e `flake_detector.py`, de alirezarezvani/claude-skills (MIT, 269 linhas só com a biblioteca padrão): B1.
- `FAIL_TEXT`, em `trace_core.py`, e `is_compound_tail_mismatch`, em `claim_checker.py`, de alirezarezvani/claude-skills (MIT, manter o aviso): A11.
- `settings_linter.py`, de alirezarezvani/claude-skills (MIT, manter o aviso): A1.
- `worktree-safety.cjs`, de gsd-build/get-shit-done (MIT, autocontido): B19.
- `safe_extract_tar`, em `_download_security.py`, de github/spec-kit (MIT, porte para TypeScript): A22.
- `scripts/mcp_versions.py`, de davila7/claude-code-templates (MIT): B15.
- `jev-model-router/hooks/policy.ts`, de davila7/claude-code-templates (MIT; basta a regra): B8.
- A lista padrão do mod `protected-paths-guard`, de davila7/claude-code-templates (MIT): A12.
- Os prazos e sinais de `src/core/store/git.ts`, de Fission-AI/OpenSpec (MIT, poucas linhas): A17.
- Os filtros de terminal de `archive.ts`, de Fission-AI/OpenSpec (MIT), e de `runner-scaffold.mjs`, de anthropics/skills (Apache-2.0): A13.

**Não copiar código** de disler/claude-code-hooks-mastery, que não tem licença, nem de eyaltoledano/claude-task-master, que é MIT com Commons Clause e não é licença aberta. De multica-ai/andrej-karpathy-skills também não: a licença é só declarada, sem arquivo LICENSE nem titular. Desses três, aproveitamos só as ideias.

### (d) Técnicas de teste

**D1. Um arquivo de teste com tudo pulado, ou uma seleção vazia, conta como "ok" no CI.** Prioridade alta · esforço P · status ausente.
- **Origem.** gsd-build/get-shit-done: `scripts/run-tests.cjs` e `.github/workflows/test.yml`, como contraexemplo, porque faixas vazias saem com 0. ruvnet/ruflo: o passo "Run tests" de `.github/workflows/v3-ci.yml`.
- **O que fazer no AC.**
  - *Como está hoje.* `scripts/test-ci.mjs:80` marca "ok" só pelo código de saída. Os testes rodam com o reporter TAP, mas ninguém lê o resumo. `AC_CI_ONLY` com um nome que não existe não dá erro (linhas 62 e 63). Por exemplo, `tests/module-qa-contracts-lab.test.ts`, classificado como "executar", tem um único teste, que pula quando `AC_MODULE_LAB` não é `1`.
  - *O que mudar.* Ler o resumo TAP (testes, aprovados, pulados, pendentes). Um arquivo "executar" com zero aprovados falha ou vai para laboratório. O resultado final soma os pulados. Um `AC_CI_ONLY` com nome inexistente falha (`scripts/test-ci-selection.mjs`).
  - *Ganho.* Corrige diretamente a contagem "CI 315 ok".

**D2. Comparar a classificação dos testes com a do merge-base, numa catraca que só anda para um lado.** Prioridade média · esforço P · status ausente.
- **Origem.** alirezarezvani/claude-skills: `scripts/evals/trigger_gate.py`, `scripts/smoke_json_output.py`, `scripts/smoke_json_baseline.txt` e `scripts/check_listing_budget.py`.
- **O que fazer no AC.**
  - *Como está hoje.* `scripts/test-ci-selection.mjs` (linhas 16 a 27) só exige um motivo de 8 caracteres ou mais.
  - *O que mudar.* Comparar `scripts/test-ci-classification.json` com a versão do merge-base e recusar um teste que passe de "executar" para "laboratorio" sem aprovação. Criar um contador de "PENDENTE", hoje em 40, que só pode cair. O código do portão também tem de vir da base.

**D3. Um HOME descartável para a suíte inteira.** Prioridade média · esforço P · status parcial.
- **Origem.** Fission-AI/OpenSpec: `vitest.config.ts` e `vitest.setup.ts`.
- **O que fazer no AC.**
  - *Como está hoje.* `scripts/test-ci.mjs:43` repassa todo o ambiente aos 329 arquivos de teste, no mesmo host da instalação viva e dos logins reais (`~/.claude`, `~/.codex`, `/home/app/.claude-trabalhadores`). O `scripts/test-isolated.mjs` já isola, mas só no modo isolado.
  - *O que mudar.* Apontar `HOME`, `XDG_*`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` e `GIT_CONFIG_GLOBAL` para uma pasta temporária nova a cada execução, mantendo `DOCKER_CONFIG` explícito para os testes de laboratório. Acrescentar um teste que falha se algo for escrito fora desse HOME.

**D4. Testar a atualização a partir de commits anteriores com dados.** Prioridade média · esforço M · status parcial.
- **Origem.** Fission-AI/OpenSpec: `test/cli-e2e/upgrade-from-releases.test.ts` e o job `release-upgrades` de `.github/workflows/ci.yml`.
- **O que fazer no AC.**
  - *Como está hoje.* `Ledger.migrate` (`src/ledger.ts`, linhas 43 a 56) só confere o digest de cada migração, e os testes migram bancos vazios, salvo alguns casos pontuais.
  - *O que mudar.* Criar `tests/upgrade-from-commits.test.ts`, de laboratório. Com o código antigo de 2 ou 3 commits marcados, rodar `personal:project`, `migrate` e uma semente de dados. Com o HEAD, rodar `migrate`, `installation-readiness` e `personal:maintenance` em prévia. A segunda execução não pode fazer nada, e o `combos.json` do titular tem de ficar intacto.

**D5. Um teste de contrato com o binário real dos CLIs, sem gastar cota.** Prioridade média · esforço M (P só para o Claude) · status parcial.
- **Origem.** SuperClaude: `tests/unit/test_install_mcp_registry.py`, a regressão #578. wshobson/agents: `tools/tests/test_cli_smoke.py` e `.github/workflows/validate.yml`.
- **O que fazer no AC.**
  - *Por que vale.* Uma chave de settings desconhecida é ignorada sem erro pelo CLI. Um endurecimento escrito errado vira nada, sem que ninguém perceba. Os testes atuais só conferem os argumentos montados.
  - *O que mudar.* Criar `tests/cli-contract-lab.test.ts`, de laboratório, que roda o Claude da imagem fixada com tokens inválidos e o endereço da API apontando para `127.0.0.1:1`. O CLI falha antes de qualquer requisição, então não gasta cota. O teste confere que cada opção e chave usada pelo AC é aceita, e um segredo canário prova que nada vaza. Rodar em `scripts/prepare-native-*-image.mjs` e `personal:images`.
  - *O que já existe.* O Codex tem um teste parecido só para o protocolo do app-server (initialize e model/list), em `src/native-protocol-compatibility.ts`. Nada exercita o `codex exec` do modo pessoal nem as opções do Claude.

**D6. Testar o artefato distribuído do Cezar e do Happier antes de aplicar na instalação viva.** Prioridade média · esforço M · status parcial.
- **Origem.** davila7/claude-code-templates: `scripts/prepublish-check.mjs`, `scripts/prod-smoke-test.mjs` e o comentário em `.github/workflows/cli-ci.yml` sobre a versão 1.33.0.
- **O que fazer no AC.**
  - *Como está hoje.* O `docs/ESTADO.md` admite que nenhum teste inicia cada adaptador Cezar com o artefato distribuído e que não há contrato com o Happier distribuído. `tests/cezar-dist-contract.test.ts` só confere que as exportações existem.
  - *O que mudar.* Montar o dist exato com os patches, instalá-lo numa pasta temporária e subir cada adaptador: novo `scripts/prepare-dist-smoke.mjs`, como pré-condição de `personal:images` e `personal:services`.

**D7. Um teste ponta a ponta com gasto limitado.** Prioridade média · esforço M · status ausente.
- **Origem.** ruvnet/ruflo: `scripts/e2e/host-matrix.mjs`, `lib.mjs`, `leg-claude.mjs` e `leg-codex.mjs`.
- **O que fazer no AC.**
  - *Como está hoje.* O `docs/ESTADO.md` (linha 32) diz que não há teste ponta a ponta com contas sintéticas no modo pessoal.
  - *O que mudar.* Uma matriz pequena: pedido, plano, programador, QA, revisor e integração. A parte sem custo roda no CI, com `src/synthetic-provider-adapter.ts`. A parte com modelo real exige dupla autorização (uma flag e uma variável) e tem teto de gasto. Os estados são distintos: passou, falhou, bloqueado e pulado. Login vencido vira "bloqueado", nunca "passou". O script novo seria `scripts/e2e-personal.mjs`.

**D8. Derrubar cada passo de mudança de estado e conferir o que sobrou.** Prioridade média · esforço M (otimista) · status parcial.
- **Origem.** github/spec-kit: `tests/specify_cli/extensions/test_command_update_transaction.py` e `src/specify_cli/integrations/_lifecycle.py` (`_file_identity`).
- **O que fazer no AC.**
  - *Como está hoje.* O `docs/ESTADO.md` declara que não há teste com queda depois de publicar a proposta ou depois de atualizar o Git, o que corresponde aos achados AC-IMP-0023 e AC-IMP-0024.
  - *O que mudar.* Criar `tests/personal-flow-crashpoints.test.ts`, com ganchos em `src/integration.ts`, `src/git.ts`, `src/proposal-decision.ts` e `src/recovery-*.ts`. O teste derruba cada passo e afirma que o estado ficou idêntico ou foi reconciliado, e que uma falha na limpeza aparece separada do resultado principal.
  - *Ressalva.* O esforço M é otimista, porque o fluxo atravessa PostgreSQL, `git update-ref` e a conversa.

**D9. Uma régua adversarial: defeito plantado junto com uma injeção que tenta escondê-lo.** Prioridade média · esforço M · status ausente.
- **Origem.** affaan-m/ECC: o desenho de `skills/skill-comply/scripts/scenario_generator.py`, `classifier.py`, `grader.py` e `runner.py`.
- **O que fazer no AC.**
  - *Como está hoje.* As fixtures `clean` e `defective` medem o acerto do examinador, mas nenhuma tenta enganá-lo.
  - *O que mudar.* Criar variantes com o mesmo defeito e mais uma isca:
    1. um comentário visível dizendo "arquivo já auditado, não reporte";
    2. o mesmo texto em caracteres invisíveis;
    3. instruções no README.

    O examinador tem de continuar reportando o defeito (`tests/fixtures/module-*/`, `tests/verify-ruler.test.ts`, `tests/module-*-lab.test.ts`).
  - *Ressalva.* Precisa do examinador real, porque com o worker simulado o teste passa por construção. Então é teste de laboratório e custa cota.

**D10. Calibrar o examinador e o revisor com negativos conhecidos.** Prioridade média · esforço M · status parcial.
- **Origem.** anthropics/skills: `skills/claude-api/shared/evals/eval-audit.md` (§4) e `skills/skill-creator/agents/grader.md`.
- **O que fazer no AC.**
  - *Por que vale.* O examinador (Sonnet 5.5) e o revisor dos achados altos (Opus 5.5) são da mesma família, embora a especificação pedisse outro provedor. Hoje `tests/verify-ruler.test.ts` usa um executor de bancada, não o modelo.
  - *O que mudar.* Uma bateria fixa contra o revisor Opus real, que tem de derrubar quatro casos: um achado vazio, um "não sei", um achado confiante sobre o arquivo errado e uma correção plausível mas errada (`src/verify-runtime.ts`, `src/module-exam-native.ts`, `src/module-exam-sessions.ts`, `src/verify-remediate.ts`).
  - *Ressalva.* Mandar uma amostra para outra família, como o Codex, conflita com a decisão atual do titular de aceitar só Claude nos exames somente leitura.

**D11. Uma fixture de configuração hostil, rodada com o CLI real em todos os papéis.** Prioridade média · esforço M · status parcial.
- **Origem.** disler/claude-code-hooks-mastery: `.claude/settings.json`, `.claude/hooks/validators/validate_new_file.py` e `ai_docs/claude_code_hooks_docs.md`. O repositório não tem licença, então a fixture tem de ser nossa.
- **O que fazer no AC.**
  - *O que mudar.* A fixture traz:
    - um hook marcador em cada um dos 13 eventos;
    - `statusLine` e uma permissão `Bash(*)`;
    - um `.mcp.json` que grava marcador;
    - um `CLAUDE.md` aninhado.

    Rodar com o CLI real em todos os papéis e exigir que nenhum marcador apareça (`tests/engineering-hostile-config.test.ts`, de laboratório, reaproveitando o helper de `tests/verify-exam-isolation.test.ts`).
  - *Por que vale.* É a prova de que o A1 funcionou. Também prova as duas hipóteses do A2.

**D12. Para correção de bug, o teste tem de falhar antes e passar depois.** Prioridade média · esforço G · status parcial.
- **Origem.** multica-ai/andrej-karpathy-skills: `EXAMPLES.md`, linhas 454 a 488, um exemplo de falsa reprodução, e `CLAUDE.md`, linhas 48 a 52.
- **O que fazer no AC.**
  - *O que mudar.* Rodar os testes novos ou alterados sobre a árvore base, sobrepondo só os arquivos de teste, e exigir que falhem. Depois, exigir que passem na versão nova (`src/native-qa.ts`, `src/native-qa-contract.ts`, `src/qa-waiver-binding.ts` e o fluxo de correção em `src/happier.ts` e `src/managed-plan.ts`).
  - *O que já existe.* A reverificação dos módulos já faz isso (`src/module-recheck-local.ts`, linhas 48 a 84) e serve de modelo.
  - *Ressalva.* O conferente do claude-task-master deu prioridade baixa à mesma ideia. Ela dobra o tempo de QA, precisa separar os arquivos de teste e dá falso alarme em refatoração, em que o teste passar na base é o correto.

**D13. Um corpus único de saídas reais do provedor para todos os classificadores de limite, login e falha.** Prioridade média · esforço P · status parcial.
- **Origem.** shareAI-lab/learn-claude-code: `tests/test_agent_teams_runtime.py`, `tests/test_compaction_tool_pairs.py` e `tests/test_agent_loop_boundaries.py`.
- **O que fazer no AC.**
  - *Como está hoje.* A mesma classificação é feita em pelo menos 7 arquivos, com entradas diferentes: `src/claude-execution-adapter.ts`, `src/claude-planning-adapter.ts`, `src/personal-manager-chat.ts`, `src/module-exam-worker.ts`, `src/module-exam.ts`, `src/module-exam-codex.ts` e `src/codex-personal.ts`.
  - *O que mudar.* Uma tabela de saídas reais e anonimizadas do Claude e do Codex em `tests/fixtures/provider-outputs/`, aplicada a todos os classificadores num só teste. A lógica já está centralizada em `src/quota-exhaustion.ts`. O ganho é pegar as diferenças de entrada, como a expressão genérica `/usage limit|rate limit|quota/` do gerente.

---

## 3. Descartados

Das 76 ofertas descartadas, 3 foram marcadas "descartar" e 73 ficaram com prioridade baixa. Só 3 têm status "já existe" (1) ou "inaplicável" (2). Das 73 de prioridade baixa, 43 tratam de coisas que o AC não tem e 29 de coisas que ele tem em parte: saíram por ganho pequeno, não por já existirem. Abaixo estão as mais tentadoras:

1. **Cópia de login do exame preserva hooks do settings.json da conta** (affaan-m/ECC). *Já resolvido no caminho real:* os exames Claude usam home limpo com token e não montam `/account`. A cópia do login só roda para Codex e Grok, que hoje são recusados em exame somente leitura (`src/exam-provider.ts`, linhas 68 a 70). O que sobra está no A2.
2. **Não compartilhar a pasta de conta gravável entre chamadas simultâneas do gerente** (anthropics/skills). *Não se aplica:* o CLI do Claude foi feito para várias sessões no mesmo diretório. Uma cópia somente leitura impediria a renovação do token e criaria o problema que se quer evitar.
3. **Gerente espera por estado explícito, não pela ausência no `pgrep`** (davila7/claude-code-templates). *Não se aplica ao produto:* as esperas consultam o ledger com recuo (`src/manager-discipline.ts`, linhas 144 a 170). O `pgrep` só aparece no AGENTS.md, que já admite esperar pelo arquivo de saída.
4. **Sumário com faixas de linha para o PROGRESSO-FINAL.md** (bmad-code-org/BMAD-METHOD). *Não se aplica:* é um log de acréscimos com só 3 títulos, o AGENTS.md já manda ler só o fim, e a questão é de processo, não de produto.
5. **Critérios de aceite como requisitos com cenários** (Fission-AI/OpenSpec). *A parte essencial já existe:* `src/semantic-planning.ts` (linhas 136 a 139) valida as referências sem LLM e recusa com `PLANNING_OUTPUT_REJECTED`. O formato de cenário seria uma camada nova, de esforço G, sem valor demonstrado.
6. **Varredura de risco no texto da proposta (lookout)** (Yeachan-Heo/oh-my-claudecode). *Já coberto:* o isolamento impede o que o lookout mais teme, porque o agente não tem credencial de push nem acesso ao banco real. O pedido de "pular testes" é coberto melhor pelo portão de diff do A4.
7. **Contrato do Antigravity (agy) para um adaptador de execução** (Yeachan-Heo/oh-my-claudecode). *Não se aplica hoje:* não há adaptador agy no produto. Se houver um dia, a base é `upstream/cezar/.../antigravity-runner.ts`, que já manda o prompt pelo stdin.
8. **Deduplicar o uso do Claude por `message.id` entre arquivos** (affaan-m/ECC). *Já existe dentro de cada transcrição:* entre arquivos, a cópia medida foi de 40 em 11.648 ids, cerca de 0,3%, e os jobs não retomam sessões.
9. **Lista revisada de dependências com scripts de instalação** (thedotmack/claude-mem). *Já existe na maioria das imagens:* `npm ci --omit=dev --ignore-scripts` em qa, prontidao, desempenho, documentacao e dependencias, com testes. Faltam design e arquitetura, e fixar as versões no `deploy/Dockerfile.personal`, que está na seção 4, item 9.
10. **"Nunca pagar duas vezes": orçamento de reenvios** (thedotmack/claude-mem). *Já existe teto de chamadas por execução* (`modelCallBudget` e `VERIFY_MODEL_BUDGET` em `src/verify-runtime.ts`). Com assinatura, o custo é cota, e o ganho marginal é pequeno.
11. **Fusível global de lançamentos para quem usa o mesmo login** (ruvnet/ruflo). *Já existe dentro da instalação:* tetos por conta, por contexto e global (`src/capacity.ts`, linha 456), e `exhausted_until` vale para a instalação toda. A lacuna só apareceria entre instalações.
12. **Revisor criado como subagente herda a conclusão do autor** (mattpocock/skills). *Já coberto:* no produto, o revisor roda com sessão nova (`freshSession:true`) e só Read, Grep e Glob. No processo, o revisor é outro processo (`codex exec --sandbox read-only`).
13. **Normas de "mudança cirúrgica" para o programador** (multica-ai/andrej-karpathy-skills). *Já cobrado em três camadas:* a instrução "nothing beyond it" (`src/native-implementation.ts:169`), os `writePaths` com `INVALID_SCOPE` e o revisor que rejeita excesso.
14. **Assinatura normalizada de falha para não repetir correção** (SuperClaude). *A parte que importa já existe:* `src/native-qa.ts` separa "sem resultado" (timeout, falta de memória, saídas 126, 127, 137 e 143) de "falhou". O resto tem ganho incerto sem dados reais.

---

## 4. Pontos fracos do Agent Control revelados

**1. A instalação viva tem duas portas abertas, e a documentação não as descreve** (alertas altos do avaliador).
- *Rede dos workers.* A rede dos contêineres de trabalho (`ac-native-provider`) é criada sem a opção que corta o acesso à internet (`--internal`, em `src/native-setup.ts`), e está assim na instalação viva. Os agentes rodam sem aprovação, com os logins OAuth montados, e têm saída livre para a internet. O proxy restrito só libera os endereços da OpenAI e só entra com `AC_PERSONAL_EGRESS=1`. Uma injeção num repositório pode levar as credenciais embora. Isso não aparece em `docs/ESTADO.md`.
- *Docker do gateway.* O gateway controla o Docker inteiro, o que equivale a ser root no host. No arquivo de implantação (`compose`), esse acesso passa por um repassador de conexões (`socat`) que aceita qualquer pedido, sem senha. Na instalação viva, o gateway roda no host via systemd, e o Happier fica publicado na internet. O ESTADO.md diz que isso é "de laboratório".

**2. A revisão independente tem um furo (A1 e A2), a que chegaram as análises de nove repositórios.**
- *O furo.* O endurecimento existe só nos exames. Na engenharia, o revisor de outro provedor lê o commit do programador com a configuração de agente intacta e com a própria conta montada com escrita. O AC já tinha registrado isso (A1, "Contexto") e não corrigiu, e o item não aparece nos achados abertos.
- *A independência é estreita.* Ela se resume a "outro provedor". Nos exames, o examinador e o revisor dos achados altos são ambos Claude, embora a especificação peça outro provedor (`docs/MODULOS-DE-VERIFICACAO.md`, linha 39). O código prefere outra conta Claude, mas depois de 3 tentativas aceita a mesma (`src/exam-provider.ts`, linhas 74 a 89).
- *A equipe declarada não é a que roda.* O combo "intermediário" põe Codex como revisor e como um dos três programadores (`src/personal-combos.ts`, linhas 46 a 53). Nas tarefas feitas pelo programador Codex, quem revisa é a reserva (Sonnet), não o revisor declarado. A checagem `REVIEWER_SAME_AS_PROGRAMMER` (`src/engineering.ts`, linhas 694 e 697) não tem teste.

**3. A prova é mais fraca do que parece.**
- *QA.* O QA aprova pelo código de saída, sem contar testes executados nem pulados (A11; cinco projetos mostraram esse modo de falha).
- *CI.* O CI conta como "ok" um arquivo cujos testes foram todos pulados (D1).
- *Diff.* Revisor, juiz e QA por modelo recebem o diff cortado em 20 KB, sem a lista do que ficou de fora (A3).
- *"Limpo".* Um resultado limpo não prova que a ferramenta estava apta a achar algo (A21).
- *Imagem.* A versão fixada da imagem pode ser anterior ao código atual do coletor, e então o exame roda código velho (A20).
- *Assinaturas.* As assinaturas Ed25519 são autoatestadas: o mesmo processo assina e confere, com a mesma chave, no mesmo host do banco. Elas provam que o banco não foi adulterado, não que outra parte conferiu.

**4. A economia é medida com uma régua curta.**
- *Amostras pequenas.* A regra do titular exige provar a economia sem perda de qualidade, mas o T5 foi julgado com 5 perguntas, o T6 mediu só caracteres e os lotes não foram medidos com o modelo real (B1).
- *Medição imprecisa.* O uso do gerente é estimado por 4 caracteres por token (A9), e o cache lido e o escrito são somados (C1).
- *Comparação.* Sete projetos trouxeram protocolos estatísticos, e superpowers e ECC publicam resultados nulos com o método. O AC acerta ao registrar os negativos, mas ainda não tem como separar ruído de efeito.

**5. O tamanho não cabe em um titular.**
- *Volume.* São 64.367 linhas em `src`, 87.953 em testes, 114 migrações com 154 tabelas, 92 gatilhos e 55 funções SQL, 25.485 arquivos vendorizados de Cezar e Happier e um patch de 3.421 linhas. São 2.355 commits em 21 dias e 846 documentos.
- *Estrutura.* Há módulos enormes que misturam tudo: `src/verification-modules.ts` tem 3.601 linhas e `src/native-execution-supervisor.ts` tem 2.119. São 312 arquivos num diretório plano e 1.330 linhas com mais de 200 caracteres.
- *Erros engolidos.* 206 blocos `catch` engolem erros. Por exemplo, `planTasksByRun` devolve lista vazia se a consulta falhar.
- *Comparação.* OpenSpec e spec-kit também são grandes, mas sustentam o tamanho com nota 8 em testes.

**6. Os testes não fecham.**
- A suíte não está totalmente verde. No último registro (`6c7411a1`, 20/11, 19:55), passaram 315 arquivos, e o registro diz que as falhas restantes são "as ambientais conhecidas", sem listá-las. Antes, em `d6c99df6`, foram 282 aprovados e 11 falhas.
- 86 de 415 arquivos (21%) ficam fora do CI, 40 deles marcados "PENDENTE DE VALIDAÇÃO".
- Não há teste ponta a ponta, nem teste dos adaptadores com o artefato distribuído (D6 e D7).
- Cerca de 10 testes conferem o texto do código por expressão regular em vez do comportamento.

**7. A documentação contradiz o código e a si mesma.** Há pelo menos cinco afirmações erradas ou velhas nos três documentos de estado:
- `README.md:20` diz que a execução das propostas está "ainda não ativada", e o código a executa.
- `docs/STATUS.md:29` ainda lista a inferência com contas reais como pendente.
- `docs/STATUS.md:34` aponta a rodada R6 como a última registrada.
- `docs/ESTADO.md:37` diz que o timer chama `--retencao-agendada` e não atualiza as bases de vulnerabilidade. O timer chama `--manutencao-agendada` (`src/personal-timers.ts:61`), e a etapa `bases` as atualiza (`src/personal-maintenance.ts`, linhas 455 a 480). O avaliador do AC deu crédito justamente a essa afirmação.
- `docs/ESTADO.md:41` diz que o `docker.sock` "é de laboratório", embora a instalação viva dê ao gateway o daemon inteiro. Além disso, o ESTADO não menciona a saída livre da rede dos workers.

Os três arquivos foram editados pela última vez no commit `0f1cef47`, "correção de afirmações contraditórias". São 846 `.md`, 951 `.log` e 20 MB em `docs/`, um volume que esconde a parte honesta, como o ESTADO.md curto.

**8. O processo de desenvolvimento é instável e arriscado.**
- *Ritmo.* Foram 2.355 commits em 21 dias, com cerca de 12 modelos como coautores.
- *AGENTS.md.* Acumula 14 "substitui" e mais de 20 trocas de equipe em 4 dias (B2).
- *Trabalhadores.* Rodam no host com todas as aprovações desligadas, no mesmo host do banco vivo (A24).
- *Disco.* O próprio produto encheu o disco até 99%: 611 cópias `work/`, com 23 GB, e 11 GB de arquivos temporários de imagens de contêiner. A retenção veio depois. O padrão do código é "preview" (`src/personal-maintenance.ts:459`), mas a instalação viva passou para "apply" em 20/11, às 18:25. Na mesma ocasião, uma limpeza feita à mão pelo supervisor levou o disco de 95% para 83% (`docs/PROGRESSO-FINAL.md`).

**9. Pontos menores.**
- *Cadeia de suprimentos, gravidade média.* `deploy/Dockerfile.personal` instala os CLIs sem versão. A ação de CI vai por tag (`checkout@v4`), mas esse risco é baixo (A23). OpenSpec, ECC, wshobson, spec-kit e learn-claude-code fixam as próprias ações por SHA.
- O prompt do gerente vai na linha de comando, visível em `ps` (A14).
- Uma expressão genérica de cota no stderr pode marcar uma conta como esgotada por engano (D13).
- Ficou no código de produção um gancho de depuração, `AC_DEBUG_QUOTA_EXHAUSTED`, que força o estado de cota esgotada.
- O mapa `seenRuns` cresce sem limite.
- `extractJsonObject` está duplicado e é quadrático (cúbico no pior caso) sobre até 256 KB de saída.
- Há caminhos `/home/app` fixos no código.

---

## 5. Ordem recomendada

Antes desta lista, resolva os dois alertas altos do item 1 da seção 4, a rede dos workers sem `--internal` e o gateway com o Docker inteiro. Eles não vieram dos concorrentes, mas pesam mais que qualquer item abaixo.

1. **A1, junto com D11 e A2.** É o furo a que mais análises chegaram (nove, todas a partir do mesmo mapa do AC) e que o próprio AC já registrou. As peças da correção já existem. Sem ela, o que o programador escreve pode influenciar o revisor. Comece pelo D11, que prova o efeito.
2. **A3.** Esforço pequeno, e reduz as aprovações dadas sem ver parte da mudança. A correção dá a lista e a instrução, mas não obriga o avaliador a ler.
3. **D1.** Esforço pequeno, e faz o "CI 315 ok" voltar a significar que os testes rodaram.
4. **A5.** São flags no entrypoint, mas exigem reconstruir a imagem de verificação, fixar o digest novo e conferir as flags nas versões fixadas. Impedem que o projeto examinado esconda os próprios achados do módulo 1.
5. **A6.** Esforço pequeno: o módulo 1 é o que pretende valer como atestado e hoje pode, em tese, examinar outra árvore.
6. **A9.** Esforço pequeno. Conserta a medição do gerente e pode mostrar que rodar o gerente sem ferramentas economiza mais que o T6.
7. **A10.** Hoje a única chance de replanejar é gasta às cegas, e levar a causa da falha custa pouco.
8. **A8.** Com o classificador que o Cezar já tem, o esforço é pequeno, e o AC deixa de perder replanejamentos e julgamentos de exame por falha passageira.
9. **A4, com o primeiro passo do A11.** Fecha o QA verde de mentira por `.only`, `.skip`, testes apagados ou zero testes.
10. **B1, com o C1 antes.** Sem pares, repetições e cache separado, nenhuma economia nova pode entrar por padrão como a regra do titular exige.

Logo depois vêm A7 (Unicode invisível), B2 (limpar o AGENTS.md), A12 (lista única de caminhos protegidos) e A20 (imagem fixada mais velha que o código), todos baratos ou ligados à integridade da prova.

---

## Correções da crítica não aplicadas

Todas as outras correções foram aplicadas como a crítica pediu. Estas não foram aplicadas, ou foram aplicadas só em parte:

- **Correção 5, parte "como fazer".** A crítica pedia para atualizar `ac-score.json` e `dados-sintese.json` e gerar a tabela de novo pelo script, sem editar à mão. Não fiz isso, porque a tarefa era revisar só o relatório, e os arquivos de dados continuam sendo a fonte. Recalculei o total do AC com os pesos de `dados-sintese.json` (490 dividido por 100), arredondei para uma casa (4,9) e reposicionei o AC na tabela.
- **Correção 3, em parte.** Tirei "contraria a regra do titular". O próprio titular listou o mapa, os lotes e a disciplina do gerente como ligados por padrão no `AGENTS.md`. O texto agora diz que essas economias ficam aquém do critério que ele mesmo fixou.
- **Correção 7, em parte.** O Claude é revisor do desenvolvimento desde 09/11/2026 (`AGENTS.md`, "Revisão independente com Claude"), e não só desde 11/11.
- **Correção 10, em parte.** O número 44 está errado. Das 73 ofertas de prioridade baixa, 43 têm status "ausente". A 44ª ausente é uma das três marcadas "descartar", a do BMAD. Usei 43.
- **Correção 11, em parte.** A queda do disco de 95% para 83% veio da limpeza feita à mão pelo supervisor naquele dia, e não da retenção automática (`docs/PROGRESSO-FINAL.md`, registro de 18:25). O texto agora diz isso.
- **Correção 16, em parte.** `src/module-exam-worker.ts:125` usa `--settings` só para desligar os conectores, não para as negações. O texto diz que a opção já é usada ali, e não que as negações já passam por ela.
- **Correção 34, em parte.** Só existem T1 a T6 em `docs/economia/`. O T7 é a proposta do B6.
- **Correção 35, em parte.** No título do A17, "todos os comandos Git seguintes falham" exagera. A trava só bloqueia as gravações naquele ramo, inclusive o `git commit` do titular (análise do OpenSpec). Usei essa versão.

---

## Conferência do supervisor (21/11/2026)

Conferi na máquina os dois alertas altos da seção 4, item 1:
- `docker network inspect ac-native-provider` mostra `internal=false`. Isso é de propósito, porque é por essa rede que os agentes alcançam as APIs dos provedores. O risco real é outro: a saída não tem lista de destinos permitidos, fora do modo `AC_PERSONAL_EGRESS=1`. As redes `ac-native-exec-*` são `internal=true`.
- `agent-control-happier-ispagent` está ativo, e o Caddy publica as rotas do Happier (`/home/app/infra/caddy/sites/happier-ispagent.caddy`). O gateway roda como o usuário `app`, que pertence ao grupo `docker`, e por isso tem o Docker inteiro.

Como o trabalho foi feito: 20 repositórios baixados (clone raso) e só lidos, nunca executados. Cada um teve um analista e um conferente independente, e o conferente buscou cada proposta no código do Agent Control. A nota do Agent Control veio de um avaliador independente e severo, foi conferida por um crítico hostil, que corrigiu 4 notas, e passou por uma revisão final. Os dados estão em `dados-sintese.json`.
