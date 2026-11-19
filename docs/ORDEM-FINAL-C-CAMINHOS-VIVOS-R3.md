# Corrige cobertura de diretórios omitidos e rotas interceptadas

Resolva os casos do parecer em arquitetura. Teste o comportamento do host e do coletor para um caminho comum longo com vários componentes curtos e para um componente realmente protegido, ancestrais e token em texto livre. Garanta compatibilidade efetiva de publicação: se o contrato global de redação recusar um caminho, não contorne seu controle. Preserve evidência mínima e demonstração no caminho suportado e sem valores reais. Faça ajustes cirúrgicos nas métricas, na resolução de index da raiz e no reconhecimento das rotas de interceptação. Restrinja os testes aos casos de regressão. Não leia nem exponha dados reais.

O diff `c4972328..f810cb10` ainda deixa quatro defeitos concretos.

| Gravidade | Cenário e efeito | Arquivo |
|---|---|---|
| Alta | `src/international/payment/reconciliation.ts` é omitido da cópia de análise. O detector encontra 40 caracteres consecutivos no caminho até `.ts` porque conta `/` como caractere Base64. Nenhum dos segmentos isolados corresponde ao padrão. Um arquivo comum some do inventário e das análises. | [collect.mjs](/home/app/projects/agent-control/deploy/modules/arquitetura/collect.mjs:283) |
| Média | Se `src/credentials.v1/index.ts` importa `src/helper.ts`, a cópia omite o diretório `credentials.v1` inteiro. A heurística de cobertura trata `.v1` como extensão e ignora a omissão. Sem uma referência ao diretório no grafo restante, `helper.ts` pode sair com zero dependentes e instabilidade publicada sem marca de parcialidade. | [collect.mjs](/home/app/projects/agent-control/deploy/modules/arquitetura/collect.mjs:1630) |
| Média | Se `src/page.ts` importa `../` e o `index.ts` da raiz foi registrado como omitido, o alvo normalizado é `.`. A função encerra antes de procurar `index.ts` no inventário de omissões e o Knip mantém o falso achado de importação não resolvida. | [collect.mjs](/home/app/projects/agent-control/deploy/modules/arquitetura/collect.mjs:526) |
| Média | A rota de interceptação `app/(.)[identificadorInternacionalDaTransacao]/page.ts` perde a proteção de caminho no redator de alta entropia. O segmento longo `(.)[...]` fica fora das duas formas aceitas pela expressão, embora use o mesmo parâmetro longo da rota coberta pelo teste de publicação. O caminho fica sujeito a mascaramento no Markdown. | [verification-modules.ts](/home/app/projects/agent-control/src/verification-modules.ts:509) |

Nos trechos fornecidos, confirmei o bloqueio de ancestrais de classe sensível nos caminhos comuns e de prontidão, com a exceção de folha ainda vinculada a um achado estruturado. O Knip passou a consultar candidatos sem extensão, substituições ESM e índices abaixo da raiz. As métricas usam as arestas copiadas quando a omissão é reconhecida.

A revisão foi estática, com base no diff e nos trechos fornecidos. O sandbox impediu a leitura direta do checkout. Os testes físicos ficaram a cargo do gerente.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-CAMINHOS-VIVOS-R3.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>.
