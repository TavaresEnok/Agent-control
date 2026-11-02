# Importação explícita pelo gateway local

Implementação acrescentada em 02/11/2026. Não foi executada migração operacional.

O gateway oferece `import-stage CONFIG DESCRIPTOR`, `import-deliver CONFIG DESCRIPTOR` e `import-archive CONFIG DESCRIPTOR`. `serve` não chama essas operações. Configuração, descriptor, bundle, token e chaves são arquivos privados, regulares, do UID do controlador, sem hardlinks ou symlinks e fora dos repositórios. Nunca fornecer token/chave como argumento.

Descriptor stage: `{ "action":"stage", "bundleFile":"/diretorio-privado/bundle.json", "tokenFile":"/diretorio-privado/token", "sessionKeys":[{"sessionId":"sessao-destino", "variant":"legacy", "keyFile":"/diretorio-privado/chave-binaria"}] }`.

Descriptor deliver: substituir action por `deliver`, bundleFile por `importId` UUID. Descriptor archive: `{ "action":"archive", "importId":"UUID" }`, sem token/chave.

Bundle segue `ImportBundle` existente: identidade externa, projeto, sessões destino, fingerprints, ciphertexts e registros históricos. As sessões destino precisam existir no Happier e pertencer à conta. O comando não extrai bancos Paseo nem cria sessões em outro produto.

Stage verifica identidade da conta no servidor configurado, projeto owner, conjunto exato das chaves/sessões, fingerprint e decifrabilidade de cada mensagem antes de preparar a outbox PG. Deliver repete as verificações do transporte, usa localId determinístico e confirma ciphertext no histórico canônico antes do ACK local. Mensagens já entregues não são reenviadas após ACK PG; ACK perdido pode ser reenviado com o mesmo localId. Contextos são criados pausados; registros históricos não viram jobs. Archive recusa contexto em uso e apenas arquiva o contexto importado, sem apagar mensagens do Happier.

Rede limitada por chamada, redirects recusados e ACK com localId divergente rejeitado. Uma falha mantém estado pendente para repetição explícita; não habilita scheduler. Autenticação é verificada de novo em cada execução CLI. Buffers são zerados ao terminar, mas strings JS e buffers internos de bibliotecas não têm garantia de apagamento.

Limites: não houve execução ponta a ponta destes comandos novos, teste de timeout completo ou migração real; o core de importação possui evidência anterior delimitada. Compatibilidade e propriedade do pacote de origem precisam ser verificadas antes de usar dados reais. O CLI não é uma declaração de homologação RF-33/I8 nem substitui a autorização específica de migração.
