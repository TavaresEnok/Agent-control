# Consistência da retirada de design antes do lançamento

1. Uma intenção com marcador de exame aceita a retirada manual ou a repetição do comando quando outra tentativa da mesma intenção já é terminal. As tentativas ativas e os grants em aberto continuam bloqueando a retirada. O caminho explícito para uma intenção histórica ainda exige uma única tentativa.
2. O broker só considera a rede ausente quando o Docker responde HTTP 404. A inspeção por nome e a inspeção por ID validam a estrutura de uma resposta HTTP 200. JSON `null`, objeto sem os campos exigidos e JSON truncado resultam em `DOCKER_NETWORK_UNCERTAIN`.
3. A CLI valida a prova assinada de uma retirada concluída mesmo com o Docker indisponível, tanto antes quanto depois de retirar o par de imagens da configuração. A validação continua a conferir o dono, a locação do contexto, o projeto, o repositório, os vínculos do job e o `request.json` quando presente.
4. A retirada automática persiste primeiro a liberação do grant e o recibo físico. Depois, em outra transação protegida pela locação, consolida o job, a prova assinada e o fechamento da intenção. Se a segunda transação falhar, a CLI de design indica `--abandonar-design <jobId>` e a manutenção pode usar o recibo físico já persistido.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test --test-concurrency=1 tests/native-interrupted-exam-recovery.test.ts` aprovou os 4 testes, sem casos ignorados. A execução usou PostgreSQL 16 descartável, socket Docker simulado e arquivos de credenciais sintéticos. A renovação de login foi substituída por uma falha simulada.
- Os testes exercitam separadamente falhas na gravação da prova e no fechamento da intenção, além do retry com tentativa irmã concluída, do bloqueio de tentativa ativa, da rejeição de prova adulterada e da repetição do comando sem acesso ao Docker.
