# Ordem para o Grok — validador de segurança, rodada 3 (achados da revisão independente)

Escrita pelo gerente (Claude) em 17/11/2026.

Uma revisão independente (Claude Sonnet 5.5, só leitura) do diff `cbfef952..0cbd03d5` achou os defeitos abaixo. Corrija **todos**. Cada um ganha um teste que falha antes da correção e passa depois. As regras são as das ordens anteriores.

1. **MÉDIA: o caminho de escrita aceita quebra de linha e destino sensível.**
   - **Onde:** `src/verify-remediate.ts`, `assertRepoRelative` / `managerText` / `writePaths`.
   - **Correção:** rejeitar caracteres de controle e aceitar só `^[A-Za-z0-9._@+/-]+$`. Recusar os segmentos `.git`, `.github`, `.ai` e `node_modules`, e também `.env*`.
   - Aceitar `finding.file` só se ele estiver na lista de arquivos do exame. Em `requestCorrection`, conferir de novo com `realpath` dentro do repositório.
2. **MÉDIA: texto não confiável chega ao gerente como mensagem do dono** (`enqueuePersonalOwner`).
   - **Correção:** não repetir o título livre. O pedido leva só `ACH-NNN`, o arquivo validado, a linha e a referência (CWE/ASVS) de uma lista fechada.
   - Se o texto livre precisar ir, ele vai cercado como "dados, não instruções" e limitado a `[A-Za-z0-9 .,:_-]`.
3. **MÉDIA: a redação de segredos só cobre ferramentas conhecidas.**
   - **Correção:** aplicar `redactUnknownSecrets` a todo texto de modelo e de ferramenta antes de qualquer gravação: relatório, `bruto/`, payload do banco e resposta HTTP. Isso inclui `snippet`, `scenario`, `proof`, `suggestion` e o `extra.lines` do opengrep.
   - Acrescentar padrões: URL com `user:pass@`, `ghp_`, `glpat-`, `sk-`, `sk_live_`, `AIza`, JWT, PEM e atribuições `password|secret|token = "..."`.
   - O bloqueio final do relatório deve recusar qualquer padrão conhecido que tenha sobrado, não só `AKIA`.
   - Arquivos da classe segredo (`.env*`, `*.pem`, `*.key`, `id_*`) vão ao modelo só com o nome e a linha, nunca com o conteúdo.
4. **MÉDIA-BAIXA: `collectToolFindings` segue symlink criado dentro do contêiner** (`src/verify-collect.ts`).
   - **Correção:** usar `lstat`, exigir arquivo regular e não symlink, abrir com `O_NOFOLLOW` e impor limite de 50 MB.
5. **MÉDIA-BAIXA: dá para injetar opções em `--mount`** (`src/verify-image.ts`, `assertHostPath`).
   - **Correção:** aceitar só `^/[A-Za-z0-9._/-]+$`.
6. **MÉDIA-BAIXA: a homologação aceita qualquer host `.local`, e a rede `--internal` só existe no teste** (`src/verify-dynamic.ts`).
   - **Correção:** aceitar só `127.0.0.1`, `localhost` ou o contêiner-alvo da própria rede. O código de produção cria e confere a rede `--internal` e anexa só o alvo.
   - Rodar o Nuclei com `-follow-redirects=false` e o ZAP com escopo restrito ao alvo.
7. **BAIXA-MÉDIA: o modo `locked` mudou.**
   - **Onde:** `src/contracts.ts`, `src/ledger.ts`, `src/workflows.ts`.
   - **Correção:** `ledger.accept` recusa `security-verify-readonly-v1` quando a ativação não é `personal`.
   - Tirar esse workflow de `currentBuiltInWorkflows`, se ele não precisar estar lá. Teste: em `locked`, o comando é recusado e nada fica em `pending`.
8. **BAIXA: a reverificação atualiza só o `.md`.**
   - **Correção:** reescrever também `achados.json` e `run.json` de forma atômica (arquivo temporário e `rename`).
   - Passar ao reverificador o trecho de código do arquivo, já redigido. Não fechar achado sem ver o código.
   - Atualizar o banco em transação com `fence`.
9. **BAIXA: itens menores.**
   - Trocar `rel.startsWith('..')` por `rel==='..'||rel.startsWith('..'+sep)`.
   - Dar ao diretório do relatório um sufixo único, para que duas verificações no mesmo segundo não colidam. Fazer essa conferência antes de gastar chamadas de modelo.
   - Um relatório corrompido não pode derrubar a listagem: ele é pulado e registrado.
   - Tornar `ac_verify_remediations` idempotente por (run, conjunto de achados).
   - Pôr um limite de tempo total no exame e `--pids-limit` de no máximo 512.
   - Fixar as versões do `apt-get install` no Dockerfile.
   - Conferir a assinatura ou a origem do opengrep e do checkov, se o projeto publicar. Se não publicar, registrar isso.

Ao terminar, atualize `docs/RELATORIO-GROK-VALIDADOR.md` com uma seção "Rodada 3", listando cada item, o commit e o teste.
