# Handoff autorizado — concluir Agent Control pelo Paseo

## Missão
Assuma como gerente único do desenvolvimento do Agent Control existente. Continue a implementação até satisfazer os requisitos normativos, com evidências honestas, revisão independente e registro durável. O proprietário quer acompanhar pelo celular e não consumir a conta Codex antiga neste trabalho. Não espere respostas do agente anterior.

## Equipe expressamente solicitada pelo proprietário
- Gerente: Claude Sonnet 5.5, esforço Médio, assinatura Claude.
- Programação: Grok 4.7, esforço Médio, CLI de assinatura.
- Revisor independente: GPT-6.1 Sol, esforço Médio, **provider codex-programmer / conta Codex nova**.
- NÃO usar provider codex / conta antiga para gerência, programação, revisão, subagentes ou fallback.
- Não substituir esses papéis por outros modelos/contas automaticamente. Se uma conta esgotar, conservar estado e aguardar sua recuperação; comunicar bloqueio no chat.
- Gerente coordena e integra, Grok implementa, Codex novo revisa em sessão independente. Não aprovar na sessão que implementou. Começar com um programador e um revisor; não aumentar consumo desnecessariamente.

## Checkout e baseline
Checkout de origem: /home/app/projects/agent-control-implementation
Se o Paseo criar worktree gerenciada para este handoff, trabalhe nela (cwd da conversa), preservando a origem e integrando commits aprovados posteriormente.
Branch: implementation/i0-i2
Última implementação: fcc54cf0; predecessor a0b40253.
Os arquivos locais podem incluir este documento ainda não commitado: preserve-os.
Não trabalhar no projeto antigo derivado de Aixle nem em /home/enok/Documentos/projetos/agent-control.

## Ler primeiro, seletivamente
1. AGENTS.md: instruções locais; a seção histórica de equipe solo é superada SOMENTE pela autorização de equipe deste handoff. Restrições de isolamento continuam.
2. docs/normative/: Diretriz Mestre e Prompt Mestre; fontes de escopo.
3. docs/STATUS.md: a seção mais recente prevalece sobre pendências históricas de incrementos anteriores.
4. docs/validation/FINDINGS.md e TRACEABILITY.json: 111 RF/RNF/T, todos ainda sem aceite final.
5. docs/implementation/NATIVE-DISPATCH-20261103.md.
6. docs/implementation/NATIVE-QA-20261103.md; NATIVE-ARTIFACT-REVIEW-20261103.md.

## Arquitetura irrevogada
Cezar + Happier + PostgreSQL. Reutilizar chat cifrado canônico Happier, editor e DAG do Cezar. Não reconstruir chat/editor/motor nem abrir pesquisa de plataformas. Cezar é único dono da sequência de execução; PostgreSQL guarda autoridade, capacidade e evidências. Não introduzir scheduler concorrente.

## Implementação atual
- Mensagem canônica cifrada -> receita engineering-native-v1 -> programação delimitada por escopo/base congelados -> finalização Git -> QA Docker real -> revisão independente tipada -> integração exata por CAS.
- Supervisor de execução nativa e ferramentas separadas; programação/revisão de prova ainda substituídas sinteticamente. Não houve inferência real na bancada.
- Roteamento seleciona supervisor pela conta da concessão e, no replay, digest/chave do job histórico. Não escolher simplesmente primeiro supervisor.
- Migrações 051–054 guardam jobs, artefatos, QA e inputs nativos imutáveis.
- Capacidade/contratos/pausa/fencing/cancelamento, propostas semânticas, planos managed sintéticos com composição/correções/especialista e UI administrativa já existem. Inspecionar antes de recriar.
- Bootstrap configurável em src/server-main.ts ainda é administration-only. UI desabilita receita nativa sem adaptadores.

## Pendências principais: implementar, não apenas descrever
1. Bootstrap/configuração seguros dos adaptadores e contexto autorizado, com modo explicitamente desativado por padrão e recuperação conservadora. Não remover os bloqueios de ativação para fingir conclusão.
2. Conectar planejamento semântico e execução nativa de planos com múltiplas tarefas, dependências, revisão e correções limitadas ao runtime existente; a receita nativa raiz não resolve isso sozinha.
3. Completar roteamento/fallback/coletores e elegibilidade dos provedores sem usar credenciais reais nos testes nem abrir a conta antiga.
4. Recuperação dos intervalos ainda não cobertos, custódia/rotação, SSH, restauração e migração conforme FINDINGS. Não migrar operacionalmente.
5. Percurso integrado de produto desktop/móvel e aceites normativos. Revisão independente é requisito; arquivos/telas/testes sintéticos não equivalem a homologação.

## Evidências recentes e armadilhas
- Build núcleo: native-account-routing-build-final-20261103.log.
- Prova integrada final: native-account-routing-integrated-third-20261103.log.
- Regressões Git/artefato/conversa: native-dispatch-regressions-final-20261103.log.
- Typecheck web: native-dispatch-web-types-final-20261103.log.
- Logs ficam em docs/validation/evidence/. Preservar resultados negativos.
- Corrigidos: snapshot Git precisa buscar o commit candidato exato sem ref; observadores simultâneos devem reusar resultado terminal assinado; fonte antiga não pode apagar binding da nova época; erro antes do lançamento precisa liberar concessão comprovadamente não iniciada.
- Teste sintético de modelo precisa adquirir locks de contexto/época antes da inserção de job, como produção. Sem isso houve deadlock de FK; não mascarar com retry cego de efeitos.
- Tokens desconhecidos não são zero medido. Campo obrigatório de bookkeeping do Cezar não é saldo da assinatura.
- Contas reais continuam dormentes no produto, inclusive guarda SQL 042 e Capacity. Não remover a guarda sem implementar contrato de ativação/elegibilidade e autorização apropriada.

## Limites de autorização
Esta autorização permite usar as três assinaturas indicadas como equipe de desenvolvimento no Paseo. NÃO autoriza inferência das contas reais através do Agent Control em construção, APIs pagas, migração, deploy, retomada de projetos pausados, alterações globais das políticas/contas dos outros projetos ou reinício de instalações operacionais.
Trabalhar exclusivamente neste checkout e em worktrees/ambientes descartáveis dele. Docker somente pelo deploy/compose.lab.yml; socket só no controlador confiável, nunca em workers. Sem credenciais em Git, relatórios ou prompts.

## Primeiro passo operacional
Verifique perfis/contas reais disponíveis pelo Paseo antes de criar trabalhadores. Os perfis legados podem divergir: supervisor-fallback está Alto e limitado a fallback; qa-fallback aponta ao provider codex antigo; codex-programmer pode estar limitado a programação. NÃO reutilizar esses perfis sem conferir. Crie/aplique somente configuração específica deste projeto para cumprir a equipe solicitada. Se a instalação exigir alteração global, preserve-a e explique o impedimento neste chat móvel; não contorne tickets nem políticas. Nomear a conversa Agent Control — Sonnet gerente.

## Método e aceite
Transforme as pendências normativas em lotes objetivos. Delegue ao Grok implementação com escopo/branch/critério de aceite e ao Codex novo revisão do diff exato; integre correções aprovadas. Não reexecute baterias já válidas sem mudança pertinente. Faça checagens focadas e uma validação integrada ao final. Mantenha STATUS/FINDINGS/TRACEABILITY, proveniência upstream e manifestos atualizados. Não declarar 100% sem evidências; não esconder impedimentos. Continue autonomamente dentro deste escopo, mantendo o histórico acessível pelo celular.


## Autorização posterior do proprietário — revezamento de cota
Esta seção substitui a restrição anterior contra fallback entre os dois papéis. Sonnet 5.5 Médio gerencia normalmente; Sol 6.1 Médio do provider codex-programmer revisa. Se Sonnet esgotar, o Codex novo assume gerência E revisão em sessões separadas. Se o Codex novo esgotar, Sonnet assume gerência E revisão em sessões separadas. Quando a cota principal recuperar com evidência válida, restaurar os papéis preferidos no limite seguro entre execuções, sem interromper trabalho saudável. Nunca provider codex antigo, nunca API paga ou esforço maior. Se ambas esgotarem, aguardar renovação e não iniciar novas implementações; preservar tudo. Grok 4.7 Médio permanece o programador. Não é necessário manter o chat anterior aberto. Informe no celular se houver impedimento concreto; não declarar conclusão sem aceite.
