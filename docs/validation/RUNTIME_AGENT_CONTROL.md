# Configuração privada do runtime Agent Control

A configuração é carregada ao iniciar o processo a partir do caminho absoluto em `AC_RUNTIME_ACCOUNTS_FILE`. Se a variável estiver ausente ou o arquivo for inválido, nenhuma conta de runtime é habilitada. Reinicie o processo para aplicar alterações. O serviço não executa teste de login, consulta de saldo ou chamada ao provedor durante a leitura.

O arquivo deve ser regular, pertencer ao usuário efetivo do processo controlador, ter no máximo 1 MiB e permissões `0600` ou `0400`. O caminho e seus diretórios não podem conter links simbólicos; diretórios ancestrais devem pertencer ao controlador, ao root ou, nos caminhos de autenticação, ao UID do agente, sem escrita por grupo ou outros. Diretórios root com bit sticky, como `/tmp`, são aceitos. Proteja também os diretórios e o backup do arquivo, pois ele contém caminhos de autenticação e configuração operacional.

Exemplo estrutural com identificadores e atestado **sintéticos**; substitua-os somente depois de verificar a conta, o provedor, o modo e a origem documental no ambiente autorizado:

```json
{
  "version": 1,
  "allowed_networks": [],
  "accounts": {
    "123": {
      "image": "registry.example/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "argv": ["claude", "--model", "{model}", "--effort", "{effort}", "{prompt}"],
      "uid": "1000:1000",
      "network": "none",
      "memory_bytes": 2147483648,
      "cli_adapter": "claude_code",
      "agent_type": "claude_code",
      "auth_mode": "subscription",
      "auth_files": {
        "/srv/agent-control/accounts/123/auth.json": "/home/agent/.claude.json"
      },
      "attestation": {
        "status": "documented_supported",
        "mode": "subscription",
        "cli_adapter": "claude_code",
        "credential_id": "123",
        "source": "https://example.invalid/documented-evidence",
        "observed_at": "2026-11-01T00:00:00Z",
        "valid_until": "2026-11-02T00:00:00Z"
      }
    }
  }
}
```

A chave da conta é o ID exato de `AgentCredential` selecionado no perfil; `agent_type` e `cli_adapter` devem corresponder à credencial e ao perfil. Cada arquivo de autenticação deve ser exclusivo no arquivo de configuração (caminhos ou hard links ao mesmo inode são recusados); isso não comprova que dois arquivos diferentes pertençam a contas distintas. O arquivo de autenticação deve ser regular, não ser link simbólico, ter permissões `0600` ou `0400` e pertencer ao UID não root do agente; é montado somente para leitura. O UID e o GID devem ser positivos. A imagem deve estar fixada por digest SHA-256. O comando deve apontar para a CLI correspondente e vincular explicitamente `{model}`, `{effort}` e `{prompt}`. Redes além de `none` exigem inclusão explícita em `allowed_networks`; rede `host` e redes de outro container não são aceitas.

O atestado é uma declaração operacional local com origem HTTPS, instante de observação e validade; `unknown`, fonte ausente ou vencimento bloqueiam o despacho. Não comprova, por si só, titularidade, plano, entitlement, versão instalada, termos ou suporte real do provedor. A elegibilidade do perfil e a observação positiva de cota continuam sendo verificações separadas. `network: none` não dá acesso a um provedor remoto; habilitar uma rede exige revisão explícita fora deste documento.

`GET /api/v1/agent_control/runtime_readiness?company_id=...` exige autenticação e associação ativa à empresa e retorna apenas prontidão agregada da configuração, sem caminhos, IDs, arquivos ou credenciais. A prontidão não inicia containers, não consulta o provedor e não comprova conectividade, disponibilidade da imagem, saldo ou aprovação para produção.
