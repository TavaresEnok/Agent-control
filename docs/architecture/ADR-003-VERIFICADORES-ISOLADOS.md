# ADR-003 — verificadores sintéticos por contêiner

Estado: implementado e verificado no runtime isolado da bancada; produção não homologada.

O runtime que recebe `IsolatedImplementation` agora também injeta `IsolatedVerification` em QA, revisão e juiz. Cada sessão usa uma concessão existente e um contêiner distinto. O Cezar permanece responsável pelos nós e pelo paralelismo; o broker somente admite, executa e reconcilia operações físicas.

Reutilizamos `scripts/synthetic-verifier.mjs` sem alterar sua implementação. O wrapper fixo `scripts/sandbox-verifier.mjs` o executa dentro do contêiner, com o código montado em `/work` somente para leitura e uma pasta de resultado separada. Ambos os scripts têm hashes fixados no compose. A imagem, UID, mounts, limites de memória/CPU/PIDs, ausência de rede, raiz somente leitura e ausência de privilégios são verificados pelo broker. Nenhuma chave de assinatura, credencial de provedor ou socket administrativo é montado no worker.

O snapshot de lançamento de cada etapa é imutável no PostgreSQL. Antes de iniciar o contêiner, o broker verifica a concessão e seu papel, a intenção, o artefato, o commit e a árvore Git. No resultado, confronta o código de saída físico com o wrapper e o verificador; recusa recibos de outro artefato/papel. O controlador assina o parecer somente depois de conferir a concessão liberada pelo broker e a identidade do contêiner. O worker não assina a própria aprovação.

Os três revisores configurados continuam usando no máximo duas concessões simultâneas de avaliação; o terceiro aguarda pelo mesmo mecanismo de capacidade. Integração Git continua no controlador, condicionada aos pareceres do artefato exato, e não recebe um contêiner com credenciais de merge.

O wrapper testa a recusa de escrita no snapshot, o UID e a ausência dos caminhos administrativos conhecidos. O teste de engenharia verifica esses recibos para QA, três revisores e juiz. A prova final também cobre o probe anterior e a recuperação da implementação por SIGKILL. São verificadores determinísticos, não modelos de IA reais nem uma certificação contra qualquer ataque de kernel ou runtime.

Limites: o launcher antigo `lab-main.ts` continua sendo uma fixture local; não é um bootstrap de produção nem foi promovido automaticamente. A ativação do runtime isolado é explícita na construção do `CezarRuntime`. Autenticação de provedores, isolamento de contas reais, recuperação durante os nós de avaliação, ensaio hostil completo e revisão independente permanecem pendentes.
