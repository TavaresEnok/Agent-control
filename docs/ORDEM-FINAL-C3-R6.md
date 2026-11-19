# Arquitetura — normalização da cobertura no Knip

Revise o ajuste de caminhos raiz-relativos e a deduplicação na cobertura do Knip. Verifique a abertura sob o diretório de snapshot usando o contexto de implementação fornecido e as exclusões do inventário. Somente leitura. A enumeração de arquivos e a cópia no diretório de trabalho não devem seguir symlinks. Não execute ferramentas no projeto auditado.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C3-R6.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
