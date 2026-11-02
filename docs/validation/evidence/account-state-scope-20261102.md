# Escopo da prova de estado de contas e perfis

O teste usa exclusivamente PostgreSQL e identidades sintéticas da bancada. Não lançou processo de IA. A mudança assinada desabilita novas concessões, preserva o grant incerto existente, recusa revisão obsoleta e permite nova concessão após reativar conta e perfil. A consulta expõe `can_manage` somente ao titular com papel de proprietário do projeto; viewer não recebe controles de escrita.

A primeira prova ampliada tentou fechar e reabrir a admissão pelo caminho normal. A reabertura foi corretamente recusada porque há concessões incertas da fixture. O teste falhou na limpeza, e a saída foi preservada. Restaurou-se apenas o valor global anterior da fixture sintética por SQL, sem liberar qualquer concessão e sem chamar isso de aprovação do gate de reconciliação.

A prova final preserva esse resultado como asserção: desabilitar é permitido durante o fechamento, reativar é recusado e reabrir continua exigindo reconciliação. Depois, o teste restaura somente sua configuração global inicial para não afetar outros testes. Nenhuma instalação ou política operacional foi acessada.

O backend e os tipos/frontend compilaram. O build web conserva o aviso upstream de chunks acima de 500 kB. Logs de build têm estilos ANSI e espaços finais normalizados; não representam validação móvel ou login real.
