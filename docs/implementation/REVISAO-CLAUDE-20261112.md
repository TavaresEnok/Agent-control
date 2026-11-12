# Revisão independente — painel, vários projetos, SSH (12/11/2026)

Revisão independente por modelo Claude distinto: dois revisores Claude Sonnet 5.5, esforço médio, somente leitura. Eles receberam o código e as garantias pretendidas, não a conclusão do autor. Versão revisada: HEAD `217488cc` (SSH), mais as rotas e cercas até `02573d12`. Não equivale a revisão humana nem de outro provedor. Uso real em produção continua exigindo revisão externa de segurança.

Nenhum achado alto. Os dois revisores confirmaram:

- a cerca de repositório (`jobRepository`);
- a proteção CSRF (cookie `SameSite=Strict` mais `checkOrigin`);
- a recusa de `..` e de symlink para fora nas pastas;
- a validação e as aspas do caminho remoto;
- o refspec só para `agent-control/*`;
- a chave SSH fora das montagens dos workers;
- o clone sem config, hooks ou fsmonitor do remoto.

## Achados a corrigir

| # | Sev. | Onde | Achado | Correção |
|---|---|---|---|---|
| S1 | médio | `src/personal-ssh.ts` (`sshOptionArgs`, `gitSshCommand`) | O ssh lê `~/.ssh/config`, `/etc/ssh/ssh_config` e `/etc/ssh/ssh_known_hosts` (ProxyCommand, ProxyJump, IdentityFile extra), e `UpdateHostKeys` pode acrescentar chaves ao pin. | `-F /dev/null`, `GlobalKnownHostsFile=/dev/null`, `UpdateHostKeys=no`, `ProxyCommand=none`, `ProxyJump=none`, `ForwardAgent=no`, `VerifyHostKeyDNS=no`, `PermitLocalCommand=no` |
| S2 | médio | `confirmPersonalHost` | Confirmar o mesmo host:porta com outro usuário troca a linha pinada. | Se já houver pin para host:porta, exigir o mesmo fingerprint; senão `HOST_KEY_CHANGED` (409). Nunca remover linha no confirm. |
| S3 | baixo | host | Host não normalizado para minúsculas. | `toLowerCase()` |
| S4 | baixo | `git()` no checkout remoto | Config local poderia redirecionar fetch ou push no futuro. | `-c protocol.allow=never -c protocol.ssh.allow=always -c submodule.recurse=false`, `--no-recurse-submodules` no fetch, URL explícito no push |
| S5 | baixo | criar projeto remoto × remover host | Projeto pode ficar sem vínculo remoto. | Revalidar o host dentro do lock. |
| P1 | médio | `POST /personal/accounts` (`authFile`) | Copia qualquer arquivo do servidor para o home da conta, que é montado nos workers. | Tirar `authFile` da rota HTTP (fica só na CLI). |
| P2 | médio | `personal-pair` | O bloqueio de 5 erros é global: um anônimo impede o dono de entrar. | Limite por IP (`x-forwarded-for` do Caddy) e teto global alto. |
| P3 | médio | rotas `personal/*` da instalação | `projectOwnership` usa o projeto selecionado, não o principal. | Exigir dono do projeto principal nas rotas que mudam a instalação. |
| P4 | baixo | `personal-push` | Endpoint de push aceita qualquer https (SSRF cego). | Só hosts de serviços de push conhecidos. |
| P5 | baixo | `panel-service-worker` | `//evil` passa no filtro de URL. | Exigir `/` sem `//` nem `/\`. |
| P6 | baixo | criar projeto local | TOCTOU entre resolver a pasta e registrar. | Conferir de novo que o `realpath` está dentro da raiz. |
| P7 | baixo | `pairCodeLogin` | O código é consumido antes de validar o token. | Validar antes de consumir. |

Ficaram de fora, opcionais: o lock compartilhado entre `fastForward` e a integração (que falha fechado) e o limite de varredura e de tamanho do clone.
