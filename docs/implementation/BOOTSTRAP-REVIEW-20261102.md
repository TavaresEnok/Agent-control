# Revisão independente focada — bootstrap e autenticação

Data: 02/11/2026, America/Fortaleza. Inspeção de código, sem execução de testes e sem alterações nos arquivos revisados. Não constitui gate ou homologação.

## Achados

1. **Alta — instalação nova não consegue iniciar administração.** `src/server-main.ts:31` chama `CezarRuntime.start()`, que chama `refreshSchedulerBudget()`; o loader de `src/cezar.ts:48` exige `ac_capacity_config`. `initializeInstallation()` cria projeto, owner/admin e chave, mas não essa configuração. Em um banco novo inicializado conforme a própria CLI, `serve` falha antes de aceitar HTTP. A prova `tests/installation.test.ts` verifica initialize, mas não serve. Correção recomendada: modo administrativo não exigir orçamento nem ativar recuperação/execução, ou inicialização explícita conservadora do orçamento. Não preencher cota artificialmente.

2. **Alta — primeira administração depende de contexto que não pode ser criado.** A instalação nova não possui contexto. `server-main.ts:32–35` recusa sempre o vínculo de sessão (`verifySessionAccess=false`). O formulário de bootstrap e recursos administrativos depende de `resources.data` no frontend, que depende de um contexto em `agent-control-section.tsx:47–51`. Resultado: mesmo depois de corrigir o item 1 e autenticar, não existe percurso para ativar dispositivo/configurar capacidade. Corrigir com administração/identidade de dispositivo independente de contexto ou vínculo real de primeira conversa autorizado. Não inventar transcript/contexto de usuário para escapar da dependência.

3. **Média — tráfego de credenciais permite HTTP fora de loopback sem declaração explícita.** `Installation.happier.upstreamOrigin` usa `origin(false)`, e `HappierAuthRelay` também aceita HTTP para qualquer hostname no upstream. `server-main.ts:26` envia o bearer de sessão a esse endereço; o relay devolve o bearer ao browser. Configurar um upstream público HTTP passa validação e expõe tokens nesse trecho. Origens públicas do browser já exigem HTTPS, mas não a verificação de identidade. Recomenda-se exigir HTTPS ou loopback por padrão, reservando eventual HTTP de rede privada a configuração explícita de transporte/integridade documentada, sem tornar o caminho inseguro o padrão.

4. **Baixa — exceção ao gerar entropia pode travar o formulário de login.** `agent-control-auth-gate.tsx:36–40` define `busy/current` e cria chave/claim/pairing antes do bloco `try`. Se a geração de entropia ou helper falhar, o `finally` não executa, deixando o formulário ocupado e a promessa de `login()` rejeitada sem captura no onClick. Gerar dentro do try com cleanup opcional elimina o caso. Não há prova de exploração remota nem de ocorrência nos browsers usados.

## Fronteiras que a inspeção preserva

- O relay possui origem fixa, esquemas estritos, limites de bytes, recusa de redirecionamento e timeout do upstream; não aceita URL enviada pelo browser.
- Segredo do pareamento/chave privada são gerados e usados no browser; o backend não precisa recebê-los. A chave de conteúdo nativa decifrada é descartada, sem alegar que a sessão do cockpit fornece custódia do chat ao gerente.
- Bearer cifrado permanece no backend; cookie é opaco, HttpOnly e SameSite=Strict. A chave fornecida à sessão é copiada antes de zerar o buffer de inicialização.
- Autenticar não cadastra uma chave de operador. Comandos administrativos continuam exigindo a assinatura separada. Não identifiquei bypass concreto dessa separação nos arquivos examinados.
- `administration-only` não inicia loop próprio de dispatch nem adquire gerente; entretanto `runtime.start()` ainda chama o recovery nativo, que modifica projeções de runs e executa lifecycle/limpeza. Um bootstrap estritamente administrativo deve tornar essa escolha explícita; não afirmar somente leitura universal.

## Cobertura e limites

Revisados `src/installation.ts`, `src/server-main.ts`, `src/auth-relay.ts`, `src/sessions.ts`, o gate de login e suas dependências imediatas em `src/cezar.ts`, `src/api.ts`, `src/operator.ts`, Settings e os helpers nativos de pareamento/recovery. A análise não executou browser, CLI, TLS, banco ou aparelho físico. Achados referem-se ao conteúdo encontrado nesta inspeção; mudanças posteriores do root precisam ser confrontadas antes de encerramento.

## Correções aplicadas — achados 3 e 4

O achado 3 foi corrigido em `src/installation.ts` e `src/auth-relay.ts`: todas as origens Happier exigem HTTPS fora de loopback, inclusive o upstream que recebe bearer. Não foi criada exceção implícita para host Docker/privado. `tests/auth-origins.test.ts` verifica sete origens inseguras e quatro permitidas nos dois contratos; log `auth-origin-hardening-20261102.log`, exit 0.

O achado 4 foi corrigido no gate: geração de chave, claim e segredo nativo agora fica dentro do `try`; cleanup opcional zera os objetos que chegaram a ser criados e restaura o formulário mesmo se o próximo helper falhar. Dois testes do componente real com falhas injetadas passaram, verificando ausência de POST de pareamento, botão reabilitado e segredo parcial zerado: `auth-entropy-cleanup-20261102.log`, exit 0. Nenhum browser completo foi repetido.

Inspeção adicional de `src/disk-admission.ts` e `src/storage.ts`: não identifiquei achado alto concreto dentro da fronteira declarada de spool privado do controlador. A admissão por `statfs` não reserva blocos contra escritores externos; a implementação explicita esse limite. A retenção confere grant encerrado, hold, política/revisão, hash e diretório privado fixado por FD; preserva arquivos desconhecidos. A revisão não prova recuperação após toda queda, host malicioso ou escritores do mesmo UID fora dessa fronteira.

## Revisão de integração e vínculo E2EE

Os dois bloqueios iniciais foram corrigidos por código: `start('administration-only')` pula orçamento de execução e `dispatch` recusa o modo; o endpoint `operator/identity` e o bootstrap visual independem de contexto. A sessão Happier existente pode ser vinculada depois de confirmar acesso com o bearer cifrado da sessão de browser, sem entregar chave de conteúdo ao backend.

A revisão encontrou uma lacuna nova: a resposta de acesso aceitava apenas o ID e não exigia E2EE, apesar de o Happier admitir sessões plain. Corrigido `BrowserSessions.verifyHappierSession()` para exigir `encryptionMode === 'e2ee'` explicitamente, recusar HTTP externo e tratar falha de verificação do bearer como recusa. Ausência do campo não é presumida como criptografia.

`tests/session-link.test.ts` passou em teste único PG real/banco descartável e fetch sintético: cookie/principal correto, principal errado, ID incorreto, sessão plain, criptografia ausente, acesso upstream403, falha do verificador, origem insegura, criação simultânea idempotente e conflito entre projetos. Evidência `session-link-ownership-20261102.log`, exit 0. Isso não substitui a prova browser com servidor nativo.

A integração de tipos do browser identificou que o claim opcional havia sido anotado genericamente como Uint8Array<ArrayBufferLike>; o tipo foi estreitado para Uint8Array<ArrayBuffer>, compatível com o buffer recém-alocado e WebCrypto, sem cast. O root preservou o log negativo e fará o build integrado.

A revisão da CI de distribuição não encontrou publicação/migração inferida: o job novo lê o commit e só executa o teste sintético e --check. Ele exige proveniência atualizada antes do commit; não deve ser desativado para esconder proveniência velha.
