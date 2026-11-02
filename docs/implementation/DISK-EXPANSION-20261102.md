# Expansão de disco do servidor principal — 02/11/2026

Executada conforme autorização explícita do proprietário para incorporar os
100 GiB acrescentados ao disco deste servidor. Host confirmado: `app`.
Nenhuma conexão ao NexoISP foi utilizada nesta operação.

## Identificação antes da alteração

- Disco `/dev/sda`: já reportava 300 GiB pelo kernel/QEMU.
- Última partição `/dev/sda3`: ainda aproximadamente 198 GiB, PV LVM.
- VG `ubuntu-vg`: um PV, um LV, sem extents livres.
- LV `/dev/ubuntu-vg/ubuntu-lv`: 212.596.686.848 bytes, raiz ext4 montada em `/`.
- Os 100 GiB novos eram contíguos após sda3. `growpart -N /dev/sda 3`
  confirmou crescimento do final sem mudar o início 4198400 ou UUIDs.
- A GPT secundária ainda estava no final antigo, situação esperada após o
  crescimento virtual. `growpart` corrigiu o limite sem alterar boot/sda2.

Metadados da tabela de partições e do VG foram copiados antes da mutação em
`.state/disk-expansion-20261102/`, diretório privado. Não são backup dos dados
do filesystem e não constituem rollback automático da expansão.

## Comandos aplicados

Todos via `sudo -n`, sem utilizar ou registrar senha:

```sh
growpart /dev/sda 3
pvresize /dev/sda3
lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
resize2fs /dev/ubuntu-vg/ubuntu-lv
```

Após `growpart`, o tamanho exposto pelo kernel foi verificado como
319.972.949.504 bytes antes do `pvresize`. O PV/VG passou a informar exatamente
107.374.182.400 bytes livres (100 GiB), atribuídos integralmente ao único LV
raiz. O `resize2fs` completou a ampliação online do ext4 montado.

Nenhum dado foi apagado ou formatado. Não houve limpeza de Docker/worktrees,
desmontagem, reinício do servidor, reinício de serviços ou alteração das
instalações Paseo. A política de blocos reservados do ext4 foi preservada.

## Resultado observado

| Medida | Antes | Depois |
|---|---:|---:|
| Disco virtual | 300 GiB | 300 GiB |
| Volume lógico raiz | 212.596.686.848 bytes | 319.970.869.248 bytes |
| Capacidade do filesystem (`df -B1`) | 208.930.103.296 bytes | 314.615.791.616 bytes |
| Disponível para uso comum (`df -B1`) | 23.894.478.848 bytes | 125.284.892.672 bytes |
| Apresentação arredondada `df -h` | 195G total / 23G livres / 89% | 294G total / 117G livres / 59% |
| Extents livres no VG | 0 | 0, incorporados ao LV |

O LV recebeu os 100 GiB completos. A diferença entre o tamanho do LV, tamanho
útil e espaço disponível decorre do ext4 e de seus blocos reservados; não
houve redução dessas reservas para aumentar artificialmente o número livre.
`/home/app/projects` continua no mesmo filesystem raiz ampliado.

## Evidências

- `docs/validation/evidence/disk-expansion-before-20261102.json`:
  inventário read-only antes, comandos e exit codes.
- `docs/validation/evidence/disk-expansion-commands-20261102.json`:
  expansão e confirmações intermediárias; todos os comandos exit0.
- `docs/validation/evidence/disk-expansion-after-20261102.json`:
  lsblk/findmnt/df/PV/VG/LV/tabela de partições após a expansão; exit0.

Esta operação de infraestrutura não altera percentuais ou gates de conclusão
do Agent Control; somente disponibiliza o espaço já provisionado ao Linux.
