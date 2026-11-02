# Inicialização configurável — escopo atual

A entrada `npm run gateway -- <comando> /caminho/config.json` substitui a dependência de fixture para o gateway administrativo. **Não inicia desenvolvimento ou contas de IA.** As instalações existentes não foram alteradas.

A configuração é JSON privado 0600, proprietário igual ao usuário do serviço, sem symlink/hardlink. Modelo ilustrativo, não preencher com segredo em Git:

```json
{
  "schemaVersion": 1,
  "mode": "administration-only",
  "databaseUrl": "postgresql://usuario:senha@host/banco_novo",
  "dataDirectory": "/diretorio/privado/agent-control",
  "project": {
    "id": "00000000-0000-4000-8000-000000000001",
    "label": "Projeto novo",
    "repo": "/caminho/canonico/repositorio",
    "owner": "id-da-conta-happier-verificada"
  },
  "http": {
    "listen": "127.0.0.1",
    "port": 18405,
    "publicOrigin": "https://control.exemplo.invalid"
  },
  "happier": {
    "upstreamOrigin": "http://127.0.0.1:18401",
    "webOrigin": "https://chat.exemplo.invalid",
    "publicServerOrigin": "https://happier.exemplo.invalid"
  },
  "sessionMaxAgeSeconds": 86400
}
```

O `owner` é a identidade nativa Happier, não e-mail inventado. O repositório precisa existir e o diretório privado deve ser externo a ele. O arquivo contém acesso ao banco: manter fora de Git, relatórios e workers. A origem pública exige HTTPS, exceto loopback de bancada. Um proxy HTTPS configurado pelo operador é necessário para acesso remoto; esta entrega não o instala.

1. `initialize`: aplica migrações somente ao banco explicitamente informado; cadastra projeto/proprietário e cria chave privada persistente. Não usar banco operacional como teste.
2. `operator-bootstrap`: prepara código de 10 minutos para o proprietário e informa somente o caminho do arquivo privado. Ler pelo terminal privado e inserir no painel; apagar o arquivo após uso. Não enviar pelo chat.
3. `serve`: exige instalação inicializada e chave existente. Inicia o cockpit, autentica sessão Happier e permite administração assinada. Não cria gerente, workers, contas nem contextos por credencial implícita.

Conversa canônica continua no Happier. O painel pode vincular uma sessão Happier existente: a credencial autenticada precisa provar acesso ao mesmo ID e a sessão deve declarar E2EE. A transcrição e a chave de conteúdo permanecem no Happier/cliente; vincular não autoriza custódia de gerente ou inferência. Não declarar desenvolvimento autônomo operacional por conseguir abrir a interface.

Rollback de código: parar somente o gateway novo e voltar ao commit anterior; não remover chaves/banco. Migrações adicionadas não são revertidas automaticamente. Restore e homologação de infraestrutura continuam sujeitos aos gates documentados.
