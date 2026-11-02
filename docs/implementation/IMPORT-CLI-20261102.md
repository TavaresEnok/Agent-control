# Importação explícita pelo gateway local

Implementação acrescentada em 02/11/2026. Não foi executada migração operacional.

O gateway oferece `import-stage CONFIG DESCRIPTOR`, `import-deliver CONFIG DESCRIPTOR` e `import-archive CONFIG DESCRIPTOR`. `serve` não chama essas operações. Configuração, descriptor, bundle, token e chaves são arquivos privados, regulares, do UID do controlador, sem hardlinks ou symlinks e fora dos repositórios. Nunca fornecer token/chave como argumento.

Descriptor stage: `{ "action":"stage", "bundleFile":"/diretorio-privado/bundle.json", "tokenFile":"/diretorio-privado/token", "sessionKeys":[{"sessionId":"sessao-destino", "variant":"legacy", "keyFile":"/diretorio-privado/chave-binaria"}] }`.

Descriptor deliver: substituir action por `deliver`, bundleFile por `importId` UUID. Descriptor archive: `{ "action":"archive", "importId":"UUID" }`, sem token/chave.

Bundle segue `ImportBundle` existente: identidade externa, projeto, sessões destino, fingerprints, ciphertexts e registros históricos. As sessões destino precisam existir no Happier e pertencer à conta. O comando não extrai bancos Paseo nem cria sessões em outro produto.

Stage verifica identidade da conta no servidor configurado, projeto owner, conjunto exato das chaves/sessões, fingerprint e decifrabilidade de cada mensagem antes de preparar a outbox PG. Deliver repete as verificações do transporte, usa localId determinístico e confirma ciphertext no histórico canônico antes do ACK local. Mensagens já entregues não são reenviadas após ACK PG; ACK perdido pode ser reenviado com o mesmo localId. Contextos são criados pausados; registros históricos não viram jobs. Archive recusa contexto em uso e apenas arquiva o contexto importado, sem apagar mensagens do Happier.

Rede limitada por chamada, redirects recusados e ACK com localId divergente rejeitado. Uma falha mantém estado pendente para repetição explícita; não habilita scheduler. Autenticação é verificada de novo em cada execução CLI. Buffers são zerados ao terminar, mas strings JS e buffers internos de bibliotecas não têm garantia de apagamento.

Limites: não houve execução ponta a ponta destes comandos novos, teste de timeout completo ou migração real; o core de importação possui evidência anterior delimitada. Compatibilidade e propriedade do pacote de origem precisam ser verificadas antes de usar dados reais. O CLI não é uma declaração de homologação RF-33/I8 nem substitui a autorização específica de migração.

## Exportação da conversa canônica

`export-context CONFIG DESCRIPTOR` lê somente o Happier e o PG. Descriptor privado: `{ "contextId":"UUID", "tokenFile":"/diretorio-privado/token", "outputFile":"/diretorio-privado/export.json" }`. Verifica identidade do token, propriedade da sessão e ACL local antes e durante a paginação. Exige pasta de destino privada e cria arquivo novo 0600, sem substituir arquivo existente. Não inclui token nem chave; ciphertexts não são decifrados.

O arquivo combina os metadados limitados do contexto com até 10 mil mensagens/32 MiB, ordem cronológica e sequência superior observada. Overflow, cursor inválido ou histórico ainda incompleto após 100 páginas abortam sem publicar arquivo de sucesso. Não trunca silenciosamente o histórico. O limite dos metadados é declarado separadamente. O digest detecta alteração do pacote, mas não é assinatura de origem. Arquivo é `restorable:false`: a adaptação para importação, chaves e prova de restore continuam separadas.

Não há snapshot transacional comum entre PG e Happier, nem garantia contra eliminação concorrente de mensagens no servidor. A sequência superior delimita as mensagens vistas na primeira página; novas mensagens posteriores não entram neste arquivo. Confia-se na raiz privada e no UID local; este comando não protege contra um processo hostil com o mesmo UID trocando diretórios. Queda durante escrita pode deixar arquivo privado parcial, que não deve ser tratado como pacote íntegro. Não foi executado export real ou ensaio ponta a ponta deste comando; checagem de tipos não é homologação.
