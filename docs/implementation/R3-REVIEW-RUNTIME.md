# Revisão independente de runtime R3

Base auditada `ae2e141b`. Revisor separado dos autores; nenhuma aprovação de autoria própria. Este documento e o JSON por requisito não homologam as 111 linhas. O JSON contém 63 critérios originais da partição runtime, com versão, implementação observada, prova faltante, dependência externa quando aplicável e recomendação explícita. As outras 48 linhas pertencem à revisão de produto. A matriz global permanece intocada.

## Reexecução independente inicial

Node `/tmp/node-v22.23.3-linux-x64/bin/node` 22.23.3; comando `--import tsx --test --test-concurrency=1 tests/r2-graph-cancellations.test.ts tests/qa-waiver-binding.test.ts tests/native-worker-security.test.ts tests/planning-parallelism.test.ts`: **16 passaram, zero skips**. São quatro casos de arquivos/assinatura/encaminhamento, um compilador de paralelismo, sete predicados/contrato de waiver e quatro controladores de reconciliação com substitutos de banco/supervisor. Isso não executa PostgreSQL, Docker, SSH, inferência, grafo físico nem serviço HTTP assinado.

A primeira tentativa falhou na resolução do dist Cezar ausente na worktree. Preparou-se link local exclusivamente para o dist já existente no checkout principal; a segunda execução acima passou. Não se alterou código de implementação nem credencial. `node_modules` é a dependência disponibilizada pelo principal. Resultados históricos dos autores são tratados como evidência relatada, não reexecução deste revisor.

## Contratos e achados antecipados

Histórico: páginas limitadas devem voltar a incerteza antiga e registros modificados atrás do cursor; checkpoint deve ser cercado por epoch; inserir continuamente não pode prolongar a mesma volta para sempre; efeitos antes de checkpoint devem aceitar replay. O custo do backlog geral sem paginação em Cezar é lacuna técnica da base, não limitação externa.

Remoto: inspecionados diretamente `worker.py` e `remote_supervisor.py` não commitados na worktree remote. Docker ID imutável com labels installation/operation/epoch e journal antes de start é primitiva adequada para fugir de PID histórico. Dois achados enviados ao autor: branch Docker saltava validação de comando/log/tempo; zero grupos encontrados após timeout de create não prova ausência, porque o daemon pode concluir mais tarde. Autor informou correções; aguardam delta e revisão final. Grupo sem prova continua incerto e ocupa capacidade.

Recursos: inspecionados diretamente helper, provisionador e teste físico não commitados na worktree resources. Cgroup v2 pai dedicado com leitura de CPU/memória/swap/PIDs e anchor Docker é distinto de mera contagem de admissões. Achados enviados: lock inclui euid e assim separa UIDs; maxJobs não está vinculado ao anchor e admite configurações divergentes; resourceCgroupRoot permite verificar árvore falsa; helper não cerca epoch global entre state dirs. Também pedida prova de identidade de operação/epoch nos hooks. Provisionador escreve somente slice derivado novo e recusa diretório existente; helper privilegiado monta cgroup host inteiro, mas código escreve somente caminho derivado. Corrida entre existência e criação e posse de limpeza devem ser delimitadas no parecer final.

Fluxo: prova R2 usa capacidade/HOME/elegibilidade substitutos. R3 precisa passar as mesmas guardas produtivas com fixture sintética explicitamente autorizada, sem afirmar execução oficial. Revisor pediu caminho de controle assinado, trabalho vivo durante queda e pausa preservada; aguarda commits. Nenhum recurso operacional/conta real autorizado.
