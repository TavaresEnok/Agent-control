# ADR-001 — implementação Cezar + Happier + PostgreSQL

Estado: aceito para desenvolvimento isolado pelo proprietário; não homologado para operação real.

A diretriz recebida define a base. O Cezar mantém a autoridade de progressão do grafo; o Happier mantém o histórico cifrado; o PostgreSQL mantém contextos, épocas, intenções, versões e recibos transacionais. Não foi introduzido outro scheduler, chat ou editor.

Os snapshots e patches estão em `upstream/PROVENANCE.json` e `upstream/patches/`. A instalação limpa do Cezar pelo lockfile passou no typecheck integral; não reproduziu a incompatibilidade histórica undici/maxRedirections. O pacote instalou a dependência 6.29.0 no workspace que a declara e 7.30.0 no consumidor transitivo correspondente, sem casts ou supressão de diagnósticos.

O adaptador novo usa UUID de contexto independente de projeto/sessão. A autoridade tem instance_id + epoch + lease no relógio PostgreSQL; uma nova aquisição incrementa epoch mesmo com o mesmo profile_id. O checkpoint é estruturado e contém referências protegidas, não transcrição integral. Snapshot de plano é imutável no banco.

Cezar não recebe texto de usuário como comando shell ou autoridade. Nesta fatia recebe somente IDs opacos e um workflow sintético fixo. O executor cria um commit em worktree de fixture; não integra em main. Não há segundo motor decidindo etapas.

Imports privados Happier são encapsulados em um entrypoint e bundle versionados. Isso reduz dispersão, mas não transforma APIs privadas em públicas. Atualização exige teste de contrato contra o servidor e o cliente exatos; AC-IMP-0005 registra a dívida.

O composer compartilhado do Cezar é substituído por orientação/link canônico quando `VITE_AGENT_CONTROL_MANAGED=1`. O build do produto usa esse valor; a distribuição standalone upstream mantém seu comportamento para testes de regressão. O bloqueio de escrita é aplicado adicionalmente no gateway e na factory de runners: o frontend não é uma barreira de autorização.

Limites da fatia e todos os bloqueadores são registrados exclusivamente em `docs/validation/FINDINGS.md`. Implementador não concede revisão independente nem promoção a si mesmo.

O patch histórico de `branchFor` preserva o ID completo em vez de oito caracteres. Isso evita colisão entre intenções duráveis com prefixos iguais. Uma asserção upstream de fallback ainda esperava o formato curto; foi atualizada para o contrato intencional deste fork e acompanhada de contraprova com IDs de prefixo igual. Não há migração implícita de branches antigas: a importação permanece um gate separado.
