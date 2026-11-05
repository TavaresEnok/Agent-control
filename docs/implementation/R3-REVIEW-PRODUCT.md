# Revisão independente de produto — R3

Base `ae2e141b60e6ea90125dd43babb97e9a0abc0f16`. Revisor separado dos autores. Escopo: quota, devolução de artefato SSH, UI, autoridade de migração e auditoria individual dos 111 requisitos em conjunto com o revisor runtime. A matriz global continua sob responsabilidade do principal. Nenhuma conta, credencial, implantação ou migração operacional foi usada.

## Auditoria original

`R3-REQUIREMENT-AUDIT-PRODUCT.json`/`.md` examinam 48 linhas literais, separando implementação concreta, código/prova ainda faltante, pré-requisito externo e recomendação individual. O outro revisor examina 63 linhas. RF-43, RNF-14 e T17 merecem consideração específica após prova final do critério exato; conta real não é condição universal para critérios locais. Não se considera nenhum item aprovado só por herdar a matriz nem se usa `partial` como resposta automática.

Lacunas executáveis adicionais encaminhadas à gerência: configuração pelo chat RF-36; exportação/comparação de uso, tempo e retrabalho RF-40; conflito/reversão visual RF-42; publicação/reconexão Happier RF-35; backup/restauração/reimportação conjunta RF-33/34/T18; adaptador de worktree remota gravável RF-39; instrumentação de responsividade RNF-12. T01/T02/T16 exigem suas assinaturas/dispositivo específicos para a homologação do cenário original; substitutes sintéticos não os comprovam.

## Achados iniciais encaminhados

- Devolução: `transport.exchange({id:p.hostId,...row})` recebe `row` de `SELECT a.*`, sobrescrevendo o ID do host pelo ID do artefato. Solicitada construção explícita do host e contraprova. A transação declara retenção da identidade do registro do repositório, mas bloqueia explicitamente apenas host/membership; solicitada delimitação ou lock das linhas correspondentes. `expectedCommit` é o commit inicial de materialização: uma segunda devolução sucessiva conflita, limite que deve ficar explícito se mantido.
- Migração: desenho inicial retém reservas incertas, proíbe liberação por TTL e incrementa época em transferência/reversão. Porém `renew()` renova a reserva, não a credencial. RF-46 exige também renovação de credenciais; solicitado callback/bridge cercado por token ou declaração de ausência. A tabela separada não cerca automaticamente os caminhos normais de `Capacity`, portanto uma bancada com dois chamadores cooperantes não prova coexistência operacional completa.
- Quota: registro inativo não pode fabricar elegibilidade oficial por manifesto sintético; timeout/transporte desconhecido não significa cota esgotada nem logout. Quarentena de processos escapados deve sobreviver ao reinício antes de habilitar sobreposição. Esses contratos foram enviados ao autor.
- UI: preservação de desconhecido, quatro campos de diagnóstico e reconexão sobre estado real são critérios independentes da geometria. Viewport não é Android físico.

## Reexecução e limites

Node fixado `22.23.3`. A primeira tentativa independente de três arquivos de quota (`provider-collector-parsers`, `provider-collector-adapter`, `codex-readonly-quota-source`) falhou na preparação, antes dos corpos, pois o novo worktree não tinha `upstream/cezar/packages/cezar/dist/workflows/types.js`. Resultado: zero passes, três falhas de carregamento, zero skips. Isto é uma falta de preparação da bancada, não contraprova do parser nem sucesso de teste. Nenhum shim foi fabricado para promover esse resultado. As revisões iniciais acima são estáticas; deltas/provas finais serão examinados separadamente.
