# Provas físicas isoladas

Esses scripts não são agentes e não fazem inferência. Exigem Docker, PostgreSQL e ferramentas instaladas na imagem de laboratório, além de bancos descartáveis próprios. Nunca apontar para uma base existente ou montar credenciais reais.

- `runtime_container_probe.rb`: exige `DATABASE_URL` com a base `ac_runtime_probe_test`, imagem sintética pinada em `/tmp/ac-synthetic-worker-image`, Docker socket somente no controlador de laboratório, raiz `/var/lib/agent-control-lab/runtime` montada no mesmo caminho do host e `ruby -Itest` dentro de Docker. `synthetic_claude.py` deve ser instalado como `claude` **apenas na imagem de prova**, nunca em uma imagem de trabalho real. O script exercita isolamento, Git, duplicação, falha, revisão e cancelamento; não valida um provedor.
- `shared_broker_probe.rb`: exige base vazia `ac_broker_probe_test`, dois processos Puma HTTPS, portas loopback 19443/19444 livres e certificado com SAN `localhost`. A chave fica privada; `SSL_CERT_FILE` aponta para a CA de laboratório. Nenhum `VERIFY_NONE` é usado no client. O cabeçalho traz a invocação e variáveis.
- O teste SSH físico usa o instalador em `../remote-supervisor/` em duas contas dedicadas novas. Provisione a chave SSH restrita e confira a chave pública do host por canal autenticado. Reiniciar o user-manager dedicado pode testar retenção de recibos; não reinicie o host ou um gerenciador de usuário de produção.

O executor de teste deve carregar o schema na base descartável indicada antes da prova. Não executar duas invocações de backend sobre a mesma base. Provas que usam bases distintas continuam exigindo coordenação de memória e CPU. Não divulgar chaves, arquivos de autenticação ou ambientes de processo em logs.

As histórias legadas são gravadas pelos scripts `../temporal/record_ac_{plan,task}_baseline.rb`, que conferem o SHA-256 da fonte `d9dbbef` antes de executar atividades sintéticas. Uma história gravada prova replay do caminho registrado, não de todos os estados e versões possíveis.
