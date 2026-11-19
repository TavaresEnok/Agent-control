# C5 — Origem de rejeições com posição ambígua

O coletor usa o cursor externo como posição exata quando ele identifica um comando SQL de nível superior e o diagnóstico é direto. Em um bloco `DO`, o parser SQL vê o corpo como um literal. Um cursor dentro desse literal informa a linha de detecção, mas pode apontar para outro comando do mesmo bloco.

A resolução direta de `SET CONSTRAINTS` dentro de `DO` só é atribuída ao início do bloco quando há um único bloco candidato, uma única instrução interna verificável e concordância entre os sinais presentes, incluindo a assinatura da rotina do PostgreSQL. Quando há consulta e quadro SQL, ambos devem conter a mesma instrução única e o cursor interno deve cair sobre ela. A linha reportada nesse caso identifica o início do bloco.

Quadros SQL múltiplos, instruções internas não verificáveis e sinais divergentes geram cobertura parcial a partir da primeira instrução do último arquivo alcançado. A evidência conserva o cursor externo válido como linha de detecção e registra a possível checagem antecipada de restrições quando aplicável. O relatório omite o SQL e o contexto bruto do servidor.

As fixtures cobrem um cursor em outro comando do mesmo `DO`, quadros divergentes em ambas as ordens, quadros repetidos e consultas internas com várias instruções. Os controles verificam o cursor exato em SQL de nível superior com texto multibyte, o início de um bloco com resolução demonstrável, o escritor único em violações de chave estrangeira e o sucesso de migrações normais. As rejeições simuladas verificam um único rollback e o arquivo seguinte pendente.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-banco-r3.test.ts` em modo nativo com fixtures sintéticas e PostgreSQL 17.12 efêmero passou com 8 testes e nenhum pulo.
- `ruby -c deploy/modules/banco/collector.rb` passou.
- `git diff --check` passou.
