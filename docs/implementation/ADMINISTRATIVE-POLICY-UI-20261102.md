# Política administrativa — interface

A interface seleciona somente operações registradas pelo servidor e IDs de perfis de gerente conhecidos na conversa, sem aceitar comandos ou parâmetros de shell. Cada operação selecionada exige ao menos um perfil conhecido. Publicar uma política vazia revoga as autorizações; a publicação não executa a operação. Uma revisão concorrente exige recarregar o rascunho, e operações cuja identidade deixou de coincidir com o registro precisam ser removidas explicitamente.

O bootstrap atual não registra helpers administrativos reais. Com o registro vazio não há operações a selecionar; com nenhum perfil de gerente conhecido, apenas uma política vazia pode ser publicada. A interface não demonstra execução administrativa real, nem amplia as permissões do gateway. A validação integrada de tipos e backend pertence ao coordenador.

O painel também apresenta, em páginas de dez, até 50 operações administrativas recentes desta conversa, com estado, versão, época e data. A leitura não expõe parâmetros ou recibos e não oferece execução ou repetição. Os IDs de gerente disponíveis vêm do registro atual; IDs antigos não disponíveis na lista podem ser removidos explicitamente da revisão carregada.
