# R4 — revisão independente de produto

Base retomada `c24cefb1`. Revisor em worktree própria `r4/20261105/review-product`; nenhum ajuste de produção é autoria do revisor. Esta revisão preserva os limites de R3 e não transforma prova focal em aceite dos 111 requisitos.

## Ambientes 079: `3d83c205` + `11bbcc4e` + `fc8d8970`

**Aprovado para integração na fatia backend versionada.** Reexecutei independentemente `tests/r3-project-environments.test.ts` em Node22.23.3: **1/1 passe, zero skips**, log `docs/validation/evidence/r4-review-product-environments.log`. Usei o PostgreSQL novo e descartável do autor com autorização; cada execução gera seus próprios UUIDs e repositórios Git temporários. Não criei nem removi o contêiner base do autor. Dependências e dist Cezar vieram de caches preexistentes por links locais, não de reconstrução independente do upstream.

A leitura estática e a prova cobrem comando humano assinado, autorização por projeto, versões imutáveis, replay por intenção e tentativa, CAS de revisão, caminhos Git reais e identidade de diretórios, recusa de traversal/symlink, source commit congelado por plano, proveniência de composição/correção e gate remoto por contrato/ambiente/revisão exatos. A ordem de locks project→head é exercitada com dois clientes PostgreSQL.

O revisor encontrou ausência de operações remotas pendentes no bloqueio de publicação: intenção cancelada e grant liberado não provam saída física. `fc8d8970` inclui operações remotas não terminais e workspace uncertain no bloqueio; a contraprova recusa publicação com operação uncertain e permite após canceled_confirmed. Workspace prepared é inerte e continua sujeito ao gate atual antes de novo efeito.

Artefatos, operações e decisões de composição dessa fixture são registros sintéticos do controlador; somente PostgreSQL e Git são físicos. Este parecer não aprova por extensão montagem gateway, browser, hooks remotos finais, fluxo conjunto ou todo RF-01/RF-02. Novo fallback de write-scope para a fábrica remota ainda exige revisão específica.

## UI e conversa

Revisão em andamento. Foi identificado no WIP de ambientes que uma recusa definitiva inicial409 seguida de reload perde a opção de descarte e prende o editor. A autora confirmou e prepara persistência dessa recusa. Uma resposta desconhecida seguida de falha de autorização não é prova de não aplicação e deve continuar recuperável.

RF-36 permanece suspenso até prova do menu canônico acessível→painel→alteração humana assinada e persistida. O contrato backend previamente aprovado continua válido em seu escopo. Não foi usado provedor oficial, conta real, API paga, deploy ou migração operacional nesta revisão.

## Montagem gateway: `a16d20fa` + `fcb1d48b`

**Aprovada na fatia estática e de contrato de dispatch.** A rota exata de ambientes é montada depois de autenticação e antes de selecionar runtime; não cai na whitelist pública. O caminho cookie passa por checkOrigin para mutações, e o serviço usa raízes/diretório privado da instalação. Reexecutei `tests/r4-environment-gateway.test.ts`: **1/1 passe, zero skips**, log `r4-review-product-environment-gateway.log`. O teste injeta o autenticador para provar sua posição e impede criação de runtime; não é prova HTTP real do autenticador nem substitui o browser final.
