# Relatório A3-R4

Base: `1869c6e3`. A ordem corrige os dois achados médios da revisão de A3-R3.

- A confirmação após rotação verifica os recibos e a prova assinada e aplica ao `request.json` presente a mesma validação usada na retirada inicial: digest, job, intenção, grant, sessão, papel e base. A ausência é aceita somente com o spool acessível e seguro; erros de acesso, arquivo inválido ou divergente, ligações simbólicas e diretórios inseguros recusam a confirmação.
- Se a inspeção falhar após a liberação pré-launch, o recibo físico é preservado e `start` retorna `NATIVE_PRELAUNCH_SETTLEMENT_PENDING` com o UUID. O consumidor de design propaga a pendência até a CLI, que informa o comando de manutenção. A conclusão automática preserva a recusa original de login; o código de pendência não é classificado como limite de quota.
- A documentação descreve a repetição, suas restrições e o procedimento de recuperação.

Verificação: `npx tsc --noEmit --skipLibCheck` e os testes `tests/native-interrupted-exam-recovery.test.ts` e `tests/design-model-failure.test.ts`, com Node 22 e PostgreSQL descartável, Docker simulado nas provas e entradas sintéticas. As regressões incluem ausência, pedido válido, conteúdo ou vínculo divergente, arquivo inválido, symlink, diretório inseguro e spool indisponível após rotação; também exercitam o consumidor nativo, a liberação de grant, o comando de manutenção e a recusa original após consolidação.

Não foram executados suíte completa ou laboratório, nem reconstruídas imagens ou alterada a instalação viva. A revisão independente e a aplicação em instalação real cabem ao gerente.
