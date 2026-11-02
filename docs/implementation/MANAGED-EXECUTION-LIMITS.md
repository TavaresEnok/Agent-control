# Limite atual de correção gerenciada

Planos com `maxCorrections` maior que zero podem ser versionados e visualizados. A execução gerenciada sintética os recusa com `MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE` antes de persistir a receita ou iniciar os filhos, pois ainda não há executor de correção. Planos com `maxCorrections: 0` continuam elegíveis para execução, sujeitos às demais validações e políticas.
