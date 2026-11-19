# Revisão independente das duas leituras imediatas

Revise o diff de c67a4f46 a 5f8a8789. O parecer anterior identificou duas lacunas concretas: a admissão poderia ser cancelada antes da recusa NATIVE_RETIREMENT_UNCONFIRMED, e o checkpoint poderia mudar antes da recusa da intenção divergente. Confira se a prova passa a detectar ambas e se o diff introduz uma regressão. Os testes de execução com PostgreSQL ficam a cargo do gerente. Você recebe a alteração, o trecho integral da prova e as consultas do produto.
