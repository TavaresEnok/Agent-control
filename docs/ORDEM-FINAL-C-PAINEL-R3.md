# Isolar a lista do projeto e preservar a consulta da instalação

Revise a proteção de nomes de arquivos também citados sem diretório em linhas estruturadas de cobertura e o ciclo de vida das consultas de projeto na troca de rota. Verifique que o acompanhamento de uma operação da instalação sobrevive a troca de projeto, sem exibir o resultado funcional tardio de outro projeto.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-PAINEL-R3.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
