# Ordem para o Grok — módulo de design, rodada 2

Escrita pelo gerente (Claude) em 17/11/2026, depois de ler `docs/RELATORIO-GROK-DESIGN.md`.

- Modelo: `grok-4.7`, esforço `high`, sem fast.
- Até 10 subagentes.
- Valem as mesmas regras de `docs/ORDEM-GROK-DESIGN.md`.

## Problema

O módulo ainda não foi provado de verdade:

- a imagem não foi construída;
- o examinador é uma bancada determinística, que confirma tudo, e não um modelo;
- o painel não pintou, então as capturas saíram como página preta;
- as heurísticas geram achado alto falso. Exemplos: `aria-label={...}` em JSX lido como "botão sem nome" e qualquer `.map(` lido como "estado vazio ausente".

## O que entregar

1. **Imagem.**
   - Construa `deploy/Dockerfile.design` de verdade. Antes, libere espaço apagando só o que esta tarefa criou e imagens `dangling`. Não apague imagens de outros projetos nem volumes.
   - Prove que a imagem roda sem root, com limites, e só na rede da URL declarada.
2. **Examinador real e multimodal**, pelo mesmo caminho nativo pessoal que o validador de segurança usa no ramo `task/validador-seguranca`. Leia `src/verify-native-launch.ts` e `src/personal-verify-cli.ts` naquele worktree, só leitura, e siga o mesmo desenho.
   - O examinador recebe as capturas como imagem, mais o código e os dados coletados.
   - O revisor é de outro provedor e confere cada achado olhando a mesma captura.
   - A bancada continua existindo só para os testes.
   - Comando `npm run personal:design -- <installation.json> <projectId> --url <url> [--login-file <arquivo 0600>]`.
3. **Heurísticas sem falso alto.**
   - `aria-label`, `aria-labelledby` e `title` em expressão JSX contam como nome acessível.
   - "Estado vazio ausente" só vira achado quando a captura do estado vazio mostra uma tela vazia sem mensagem, ou quando o código renderiza uma lista sem nenhum ramo para a lista vazia. Precisa de prova, não de padrão de texto.
   - Achado alto só sai com prova visual ou medida (contraste, tamanho de alvo, transbordamento).
   - A régua precisa continuar pegando os 8 defeitos plantados e deixando limpas as telas boas.
4. **Painel que pinta.**
   - Construa o painel com `VITE_AGENT_CONTROL_MANAGED=1`, do jeito que o gateway serve. O workspace Happier tem que estar instalado, como o validador fez na rodada 1.
   - Rode o módulo contra esse build servido localmente, com dados de exemplo: pode subir uma instalação descartável do gateway no Postgres de teste.
   - Grave capturas reais de pelo menos 6 telas em 375, 768 e 1440 px.
   - Atualize `docs/validation/verificacao-design-painel.md` com o resultado real, sem dados pessoais e sem segredos.
5. **Testes.**
   - Corrija `installation-readiness.test.ts` (aviso de `NO_COLOR` no stderr) e `workflow-runtime-bootstrap.test.ts` (boundary do Happier ausente), ou registre por que são do ambiente.
   - A suíte `npm test` precisa terminar com 0 falhas.
6. **Relatório.** Atualize `docs/RELATORIO-GROK-DESIGN.md` com uma seção "Rodada 2".

## Regras extras

- Pode copiar os logins de assinatura para uma instalação descartável, com permissão 0600, e apagar a cópia no fim.
- Não toque em `/home/app/.agent-control/ispagent/` nem no banco `ac_ispagent`, e não reinicie o gateway.
- É proibido comprar crédito.
- Faça um commit por item, com testes.
