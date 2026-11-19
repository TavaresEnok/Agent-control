# Aceite do prazo independente da leitura

Examine a única pendência: se a espera por readFile se mantiver pendente, a promessa de espera deve observar timeout ou saída do filho, sem aceitar marcador tardio nem rejeição não observada. Confira os controles determinísticos de comparação e o vínculo com os mesmos nove pontos de SIGKILL.
