# Aplicação da rotação da chave mestra — 03/11/2026

`context-key-rotate-apply` re-envelopa os arquivos `<contexto>-<versão>.vault` sob uma mestra nova. Não abre ledger, banco nem cofre de produção. O programador não aprova a revisão e isto não aceita os 111 requisitos.

## Ordem sem janela ilegível

1. `ContextVault.load` e `loadCustodyPlaintext` tentam, nesta ordem, as mestras que existem: `masterFile`, `masterFile.new`, `masterFile.old`. Cada uma tem 32 bytes e passa pelas checagens de `privateRead` (arquivo regular, `nlink` 1, 0600, dono). A primeira que autentica o envelope vale. Se nenhuma autentica, a leitura das mestras e do envelope se repete, no máximo 3 vezes, e só então devolve `VAULT_AUTHENTICATION_FAILED`. Permissão, caminho inseguro e arquivo inseguro não são repetidos. Só `masterFile` reproduz o comportamento anterior.
2. `reenvelope` decifra com a mestra antiga, confere `keyFingerprint` com o cabeçalho e grava `.rot-<digest do plano>-<contexto>-<versão>` com `O_EXCL`, modo 0600 e fsync. O original não é alterado.
3. `verify` decifra o candidato só com a mestra nova. Falha de autenticação é `corrupted`. Candidato ausente ou ilegível é `uncertain`.
4. `promote` instala a mestra nova antes de trocar envelopes. A cópia antiga é escrita num temporário privado da mesma pasta, `masterFile.old.tmp-` mais 16 hex do digest do plano (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600, fsync). Esse nome não é mestra: `load` e a abertura das chaves só leem `masterFile`, `.new` e `.old`. O `rename` para `masterFile.old` publica o arquivo já completo e o diretório recebe fsync. Se `.old` já existe e o fingerprint é o da mestra antiga, ele é reaproveitado e o temporário é apagado. Um temporário órfão, inclusive curto, é apagado e refeito sem trocar a mestra ativa. Só então o `rename` de `masterFile.new` sobre `masterFile` (o nome ativo não some e todo arquivo permanece com `nlink` 1). Depois troca cada original pelo candidato. Em qualquer ponto as mestras que existem abrem o envelope.
5. `retire` relê cada entrada com a mestra nova. Só então apaga candidatos, o temporário da cópia e `masterFile.old`, e faz fsync do diretório.

`observe` é leitura. Candidato que já abre com a mestra nova entra no progresso. A impressão ativa só passa a ser a da mestra nova quando `masterFile` já é essa mestra e toda entrada original abre com ela; antes disso a retomada reentra em `promote` e continua os `rename` que faltam. A aposentadoria sai de `masterFile.old` ausente. O passo seguinte adota esse disco e não repete o efeito já visível. Checkpoint 0600 guarda plano e passo: ids, versões, fingerprints e digests. Não guarda chave, plaintext, nonce nem ciphertext.

## Comando

Descritor absoluto, 0600, sem campo de chave:

- `root`, `masterFile`, `nextMasterFile`, `checkpointFile`
- `nextKeyVersion`
- `batchSize` opcional, de 1 a 256

```
npm run gateway -- context-key-rotate-apply /caminho/descritor.json
npm run gateway -- context-key-rotate-apply /caminho/descritor.json --confirm-apply
```

O descritor é o único argumento posicional. Um caminho de instalação antes dele é uso inválido (saída 1) e não é aberto. Sem `--confirm-apply` nada é escrito. Saída 0 concluído, 3 bloqueado, 1 recusa ou uso. Mestra nova igual à atual, entrada corrompida, symlink, hardlink ou modo diferente de 0600 não promovem.

## Queda

O checkpoint é gravado a cada passo. Uma queda no meio do lote deixa os candidatos já sincronizados; a retomada os adota. Uma queda no meio de `promote` pode ocorrer antes da cópia (só `masterFile` e `.new`), durante a escrita do temporário (arquivo curto; `.old` ainda não existe e `load` não o trata como mestra), depois do `rename` da cópia (três inodes, `nlink` 1, `.new` ainda presente), depois do `rename` da mestra (ativa nova, `.old` com a antiga, envelopes ainda antigos) ou entre cada troca de envelope. A retomada apaga o temporário órfão e publica `.old` completo; `retire` também apaga esse temporário. `masterFile` não fica ausente. `load` continua abrindo: tenta as mestras presentes e, se a lista lida ficou para trás do `rename` e nenhuma autentica, relê. Entrada ou candidato corrompido bloqueia antes do `promote`; `masterFile.old` não substitui a mestra ativa.

`masterFile.new`, cada candidato e o checkpoint são gravados num irmão `.<nome>.<uuid>.part` (0600 e fsync) e só então publicados com `rename` no mesmo diretório. Uma queda no meio da escrita deixa o `.part` e não o nome definitivo. `load` não lê `.part`. Com `--confirm-apply`, a retomada zera e remove só o irmão de `masterFile.new`, o irmão deste checkpoint e, quando o plano já está no checkpoint, o irmão de cada candidato `.rot-<digest deste plano>-<contexto>-<versão>`. Um `.<outro>.<uuid>.part` no mesmo diretório permanece. Um `masterFile.new` com menos de 32 bytes, ou um candidato deste plano que não é um envelope bem formado, é resíduo deste caminho e é substituído. Um candidato bem formado que não autentica permanece `corrupted` e não é substituído. Sem a flag, o resíduo fica intocado.

## Limites

Sem PostgreSQL neste runner. O teste `context vault load tries present masters` exercita `ContextVault.load` com ledger e é o único ignorado sem `AC_TEST_DATABASE_URL`; fica para a administração. Não há homologação nem rotação de produção.
