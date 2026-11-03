# Despacho nativo delimitado — 03/11/2026

## Entrega implementada

A receita `engineering-native-v1` conecta a mensagem canônica cifrada do Happier ao grafo existente do Cezar: implementação, QA, revisão, julgador quando exigido e integração condicionada. Não há um segundo scheduler nem um segundo chat.

O proprietário publica template com branch, revisão de qualidade e caminhos autorizados. O ingresso só aceita a mensagem pelo endpoint Happier autorizado; entrada direta, escopo com travessia e colisão de mensagem são recusados. O supervisor recebe a mensagem decifrada apenas por callback da instância/época autorizada. PostgreSQL persiste referências, digest e contrato imutável, não o texto da solicitação.

A migração 054 congela a base Git e o escopo da tarefa. O programador reserva capacidade e produz artefato finalizado; QA usa imagem fixada e comando autorizado em Docker sem rede/credenciais, com código somente leitura. Revisão usa sessão separada e contrato tipado vinculado ao mesmo commit. O integrador preserva a comparação atômica da base esperada. A opção visual fica desabilitada quando os adaptadores não estão disponíveis.

## Prova executada

Comando reproduzível, na raiz do repositório:

```sh
AC_LAB_DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose -f deploy/compose.lab.yml --profile native-dispatch run --rm -T native-dispatch-controller-proof
```

O socket pertence somente ao controlador confiável do laboratório, não ao worker. A prova usa banco e repositório descartáveis. **Programação e revisão são substitutos sintéticos explícitos no teste**, enquanto Cezar, cifragem Happier, PostgreSQL, finalização Git, QA Docker e integração CAS são reais. Nenhuma assinatura, conta real ou CLI de modelo foi acionada. Não é homologação dos provedores nem teste de aplicativo móvel.

Evidências: `native-dispatch-cezar-final-20261103.log` e `native-dispatch-cezar-release-final-20261103.log`; a primeira inclui troca de gerente e fechamento tardio do endpoint anterior sem remover a fonte da nova época. ACK perdido não lança outro programador; comando repetido preserva uma intenção. Recuperação observa o job original concluído. Os três casos de regressão Git/composição, artefato nativo e conversa semântica passaram em `native-dispatch-regressions-final-20261103.log`. Build do núcleo e typecheck web possuem logs próprios. Não foi repetida a suíte geral nem a prova visual após essa alteração.

## Defeitos encontrados e corrigidos

1. A cópia Git do QA não trazia objetos candidatos sem branch alcançável. O helper agora busca explicitamente o hash validado antes do checkout. Regressão adicionada para commit composto sem ref.
2. Dois observadores concorrentes podiam finalizar o mesmo job e o segundo ver vínculo já encerrado. O supervisor só aceita replay após reler o mesmo job terminal, preservando resultado assinado; não lança novamente.
3. Erro na preparação anterior à primeira solicitação Docker do QA passa a produzir recibo de não execução. Erros após uma solicitação continuam conservadoramente incertos.
4. A reserva do programador é vinculada antes da preparação Git falível, permitindo liberação da concessão exata quando comprovadamente não houve lançamento. Queda entre reserva e vínculo ainda depende da reconciliação conservadora; não foi declarada cobertura universal.

Logs das falhas iniciais foram preservados. Os rótulos do grafo nativo foram alinhados aos seus adaptadores; isso não muda a receita sintética histórica.

## Limites e continuidade obrigatória

Esta é uma tarefa raiz com escopo fixado, não a execução nativa de um plano semântico com múltiplos filhos, correções e composição. Não demonstra recuperação de todos os intervalos de falha nem isolamento hostil completo. Fonte autorizada é restabelecida pelo endpoint da nova época; não há plaintext durável como atalho.

O bootstrap configurável ainda é administrativo. Ativação de contas reais permanece bloqueada; elegibilidade oficial e autorização específica continuam necessárias. Permanecem pendentes integração configurável do runtime nativo, fallback real entre provedores e homologação do roteamento, planejamento e correções nativos, coletores reais, homologação móvel e revisão independente. QA ainda usa a concessão de avaliação existente; separação de recurso local permanece evolução aberta.

Todos os 111 critérios continuam sem aceite final. Nenhum gate de produto ou prontidão de produção é declarado por esta prova.

## Continuação: concessão e roteamento por conta

A escolha do supervisor passa a considerar a conta da concessão, além do digest e da chave em recuperações históricas. Programação e revisão não escolhem mais o primeiro executor apenas por haver um único registro. O fixture integrado inclui um executor incompatível na primeira posição e exige que ele nunca receba o trabalho. Isso não ativa contas nem implementa detecção de cota real; Capacity continua responsável pela seleção de perfil.

A falha de preparação foi exercitada removendo somente a ref de destino do repositório descartável: nenhum job de modelo foi criado, nenhuma chamada adicional ocorreu e a concessão foi liberada com `not_started`. Evidência verde: `native-dispatch-preparation-second-20261103.log`; o primeiro log preserva erro do próprio teste por campo extra, corrigido sem modificar a validação de produção. O teste de roteamento integrado inclui essa contraprova. Não demonstra recuperação de queda entre transações.

A rodada de roteamento encontrou duas falhas preservadas nos logs: a consulta de observação não projetava `account_id` (corrigida em produção) e o substituto de modelo inseria o job sem a ordem de locks da implementação real, causando deadlock com o tick. O substituto agora adquire contexto/época antes da inserção, como o supervisor real. Nenhum retry cego de efeito externo foi acrescentado para mascarar o deadlock.
