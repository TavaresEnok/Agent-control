# Exige a declaração da aresta no Mermaid publicado pela CLI

Faça exclusivamente a correção da asserção do laboratório em tests/verification-module-cli-lab.test.ts para exigir a linha da aresta verdadeira entre os IDs já extraídos, nunca uma ocorrência comentada ou texto de rótulo. Preserve os demais controles e o caminho físico, sem modificar o produto. O laboratório R5 já passou nos seis testes com PostgreSQL e imagem reais. Trabalhe somente na asserção necessária, não crie novas abstrações.

**Confirmação parcial para `4257aebc..c2a38c1a`.** O diff confere a proveniência dos dois achados por ferramenta, regra, referência, caminho e linha. Também verifica a cobertura por arquivo e relê `dependencias.mmd` do diretório do relatório. As novas verificações ficam no ramo `documentacao`, e as mudanças de fixture ficam no repositório sintético desse módulo. O diff apresentado preserva as verificações existentes dos demais módulos.

**Defeito de gravidade baixa.** A checagem da aresta Mermaid usa `includes`. Se a aresta for gravada como comentário (`%% ORIGEM-->DESTINO`), com os dois nós ainda presentes, a asserção passa mesmo com a ligação ausente do grafo. [verification-module-cli-lab.test.ts](/home/app/projects/agent-control/tests/verification-module-cli-lab.test.ts:502)

A preparação do Git sintético, a chamada à CLI, a seleção da imagem instalada e a releitura do relatório ficaram sem confirmação. Esses trechos estão fora do diff fornecido, e o sandbox falhou antes de abrir o checkout. A revisão foi estática.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-DOCUMENTACAO-VIVA-R6.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>.
