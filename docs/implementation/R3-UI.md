# R3 UI

As configurações agora exibem a fonte de quota Codex separada do saldo: registro desabilitado, configurado/inativo ou laboratório sintético. Falha de leitura preserva a mensagem de saldo desconhecido, sem declarar esgotamento. A ativação real e a inferência continuam bloqueadas. O editor de política oferece reversão explícita: carrega o conteúdo de uma revisão histórica e o publica como nova revisão, com controle de concorrência pelo `expectedRevision` existente.

A administração de projetos oferece devolução de artefato aprovado à origem SSH com os candidatos autorizados do servidor. O navegador assina somente IDs e referência de destino; não fornece bundle ou caminho. A tela preserva a intenção após resposta incerta e reenvia o mesmo `intentId` com nova tentativa, inclusive se o candidato desaparecer da lista. A confirmação verifica identidade da operação e do artefato antes de remover o registro pendente.

O painel de autoridade exige um UUID de domínio de laboratório previamente cadastrado e uma resposta explicitamente `synthetic-laboratory`, com ativação operacional bloqueada. Pausa, transferência e reversão usam a identidade de dispositivo e assinatura existentes. A tentativa incerta fica pendente e pode ser retomada com a época e o conteúdo originais mesmo quando a projeção já avançou; não se descarta uma operação potencialmente aplicada.

## Prova autenticada de produto

`scripts/r3-ui-authenticated-browser.mjs` cria exclusivamente uma bancada descartável: PostgreSQL novo com label `org.agent-control.purpose=ac-r3-ui-disposable`, portas livres em loopback, Happier light real com SQLite e identidade criptográfica sintética, repositórios Git novos e `server-main.ts serve` real com o SPA managed compilado. O teste usa o endpoint de sessão de produção: o backend consulta o perfil no Happier canônico antes de emitir o cookie HttpOnly. Não substitui o verificador por função que aceita um principal fixo. A conversa criptografada existe no Happier e sua posse é verificada pela rota de vinculação do produto.

Em Chrome com viewports 360 e 390, recusa leituras sem autenticação, abre a tela de login, autentica, vincula a conversa existente, verifica diagnóstico único e ausência de overflow horizontal e faz logout, depois recusando novamente o cookie revogado. Em 360, recusa comando assinado por dispositivo não cadastrado (403), ativa o dispositivo por bootstrap de laboratório, publica política em duas abas com a mesma revisão (segunda recebe 409 `POLICY_CONFLICT`), reverte a política com o botão explícito e confirma no PostgreSQL a sequência 10→2→10 e igualdade exata dos snapshots 1 e 3. Pausa a conversa por comando assinado, reinicia o backend e verifica a pausa; cadastra outro projeto pela tela e confirma sua presença depois de segundo reinício. As tabelas de intents de execução, operações, outbox e concessões permanecem vazias.

A última amostra local registrou aceitação da pausa em 410 ms e projeção em 812 ms. A bancada mede tempo local do comando de pausa até a resposta e até sua projeção na tela; é uma única amostra em loopback e não homologação RNF-12. O token sintético só passa pelo cliente HTTP do Playwright e permanece no armazenamento de sessão cifrado no servidor. O teste não percorre a interface nativa de aprovação/pairing do Happier. Não há conta real, inferência, worker, deploy, Android físico ou migração operacional. Somente o esquema do PostgreSQL descartável recebe as migrações do produto.

## Checks e limites

Executar com Node 22.23.3 no PATH:

- `npm run build:server` em `upstream/cezar` prepara o Cezar local.
- `VITE_AGENT_CONTROL_MANAGED=1 npm run build --prefix upstream/cezar/packages/web` compila o SPA completo; aviso de chunk acima de 500 KiB permanece.
- `npm run typecheck --prefix upstream/cezar/packages/web` usa o compilador normal.
- `npm run test --prefix upstream/cezar/packages/web -- src/routes/settings/agent-control-installation-authority.test.tsx src/routes/settings/agent-control-remote-return.test.tsx src/routes/settings/agent-control-policy-editor.test.tsx src/routes/settings/agent-control-project-admin.test.tsx`: 24 testes passaram, zero skips. As contraprovas de transporte desses testes são fixtures e distinguem ACK incerto, identidade divergente e retomada após remount.
- `node --import tsx scripts/r3-ui-authenticated-browser.mjs`: prova completa acima; resultado em `docs/validation/evidence/r3-ui-authenticated-browser.log`, imagens `r3-ui-mobile-360.png` e `r3-ui-mobile-390.png`.

A prova autenticada cobre autenticação, conversa, controle, cadastro de projetos e autoridade de laboratório. Depois de criar explicitamente um domínio sintético pela API de serviço de laboratório, o navegador assina transferência para a segunda instalação, rollback à primeira e retomada; confirma épocas 1→2→3 e holder/pausa no PostgreSQL. Também publica e reutiliza um template pela tela, confirmando a cópia congelada de seu snapshot no banco. As superfícies de devolução SSH e relatório de uso ainda aguardam prova de browser com seus backends; os testes de componentes não substituem essa integração. O browser não executa devolução SSH. O relatório de uso oferece filtros UTC/perfil/correção registrada, comparação com período anterior, contadores inteiros exatos como strings e desconhecidos explícitos, paginação preservando os filtros originais e download CSV declarado como uma página.

RF-36 permanece dependente da implementação do RPC tipado de configuração no transporte de conversa. Não se promove esse trabalho a aceite exaustivo dos requisitos.

As dependências ausentes do Happier foram ligadas somente nesta worktree pelo helper reversível e manifesto próprio `/tmp/ac-r3-20261105/ui-deps-manifest.json`; o cache permaneceu intacto. A bancada elimina somente o container criado e validado por seu nome/label, seus filhos e diretório temporário. Nenhum serviço preexistente é usado ou encerrado.
