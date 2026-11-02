# ADR-011 — Login nativo Happier e bootstrap privado

02/11/2026 — America/Fortaleza. Implementado em ambiente isolado, sem promoção operacional.

## Decisão

O cockpit Cezar usa o pareamento existente do Happier. `adapters/happier-browser-auth.ts` encapsula a criação/validação V3 e links originais. Não existe outro chat ou credencial de modelo criada pelo login.

A chave efêmera, segredo de pareamento e eventual chave de conteúdo são processados no navegador. A chave de conteúdo recebida no envelope autenticado é descartada; esse login não entrega ao controlador autorização de decifrar a conversa. O relay aceita somente origem configurada, corpos pequenos e contratos fechados; não aceita URLs do cliente, redirects ou bearer no pareamento. O token aprovado vira sessão opaca HttpOnly/SameSite=Strict, cifrado no PostgreSQL. HTTPS exige cookie Secure; HTTP só é permitido em loopback.

A identidade de assinatura administrativa é outra chave, não extraível, em IndexedDB e separada por principal. Uma chave antiga só é adotada se seu ID já estiver autorizado para aquele principal. Login não cadastra dispositivo de administração automaticamente: o bootstrap de curta duração permanece obrigatório.

## Bootstrap sem fixture

`src/installation.ts` e `src/server-main.ts` adicionam inicialização explícita com configuração privada. Arquivos precisam ser regulares, do usuário do processo, 0600, sem symlink/hardlink; o diretório privado 0700 fica fora do repositório de projeto. A chave de cookie persiste entre reinícios. Inicialização idempotente recusa conflitos de proprietário/label. O comando local de bootstrap gera arquivo privado; não imprime token.

`serve` sobe somente gateway administrativo em loopback. Não migra banco, adquire gerente, inicia polling de trabalho ou ativa adaptadores. O modo é explicitamente `administration-only`: sessão de gerente/custódia e execução real ainda não estão conectadas. Isso não é um deploy de produção concluído.

## Evidências

- `browser-login-final-20261102.log` + `browser-login-proof.json`: Chromium mobile 390px, servidor Happier e criptografia nativos, duas identidades sintéticas, logout/login, chaves administrativas distintas, comandos assinados persistidos, bearer sem assinatura recusado e origem externa recusada.
- Aprovação do pareamento foi feita por cliente sintético usando envelope nativo. Não exercitou a tela nativa de aprovação ou telefone físico.
- `browser-login-first-20261102.log`: negativo preservado. O teste consultava cookies na raiz embora o cookie seja corretamente restrito a `/api/`; corrigiu-se o teste.
- `installation-bootstrap-first-20261102.log`: PostgreSQL descartável; inicialização repetida, persistência da chave, zero gerentes/intents/grants, recusa de arquivo público, symlink, origem HTTP externa e diretório de segredo dentro do projeto.

## Limites

Não homologados: criação/recuperação do login Happier por usuário novo, aprovação no app distribuído, custódia do endpoint gerente, rotação de chave de cookie, múltiplos projetos no mesmo gateway e implantação HTTPS completa. Nenhuma assinatura/CLI real foi utilizada.

## Revisão cruzada e primeiro contexto

A revisão encontrou dependência de orçamento para iniciar administração e dependência de contexto para ativar dispositivo. `start(administration-only)` não exige capacidade nem executa recovery; identidade do operador é consultável sem contexto. O painel pode vincular sessão Happier existente apenas após verificar credencial, principal, ID e E2EE explícito. O vínculo é idempotente e não inicia gerente. Não há doação implícita de chave de conteúdo.

`browser-login-bootstrap-final-20261102.log` e `browser-login-bootstrap-proof.json` ampliam a prova com banco novo, primeiro contexto via UI, retry de vínculo sem duplicação e sessão de outra identidade recusada. A primeira tentativa do incremento revelou conflito de middleware e banco de laboratório com migração intermediária: negativos preservados, sem editar digests já aplicados.
