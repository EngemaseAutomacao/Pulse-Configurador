# Central de operação na Oracle Cloud (Always Free)

A central vê todas as lojas numa tela só e abre o Pulse Configurador completo de cada uma.
Tudo passa por uma VPN WireGuard: as lojas e os operadores **discam para a
central**, então nenhuma loja precisa de porta aberta no roteador, e a tela da
central não fica exposta na internet.

```
                 VM Oracle (São Paulo) — IP público, só a porta UDP 51820 aberta
                 ┌──────────────────────────────────────────────┐
                 │ WireGuard 10.88.0.1   ·   central :8080        │
                 └──────────▲─────────────────────▲─────────────┘
          lojas 10.88.1.x   │                     │  operadores 10.88.2.x
     (mini PC da loja disca)│                     │(PC com o app WireGuard)
```

* **Operador** alcança a central e o Pulse Configurador de qualquer loja.
* **Loja** só alcança a central. Uma loja não enxerga outra nem o PC do operador.
* A central lê de cada loja só um resumo, e o resumo responde apenas ao endereço da central.
  O configurador da loja continua pedindo o login da própria loja.

Custo: **zero** (Oracle Always Free). Os limites são de 2 núcleos ARM e 12 GB, e a
central usa uma fração disso.

---

## 1. Conta e VM na Oracle (uma vez)

1. Crie a conta em **oracle.com/cloud/free**. Como **região principal (home region)**, escolha
   **Brazil East (São Paulo)**. Ela não muda depois, e os recursos gratuitos só existem nela.
   A Oracle pede um cartão só para verificação: conta "Free Tier" não gera cobrança.
   Não converta para "Pay As You Go".
2. **Compute → Instances → Create instance**:
   * **Image:** Canonical **Ubuntu 24.04**.
   * **Shape:** Ampere → **VM.Standard.A1.Flex**, **1 OCPU e 6 GB** (sobra folga no limite gratuito).
   * **Networking:** crie a VCN com sub-rede **pública** e marque **Assign a public IPv4 address**.
   * **SSH keys:** **Generate a key pair for me** e baixe a **chave privada**. Sem ela você não
     entra na VM, então guarde em lugar seguro.
   * Se aparecer *"Out of capacity"*, troque o *Availability domain* ou tente mais tarde.
     Isso é comum no ARM gratuito.
3. Abra a porta da VPN: **Networking → Virtual cloud networks → (sua VCN) → Security Lists
   → Default Security List → Add Ingress Rules**:
   * Source CIDR `0.0.0.0/0` · IP Protocol **UDP** · Destination Port Range **51820**.
4. Anote o **IP público** da VM. Parar e ligar a VM mantém o IP; **apagar** a VM troca o IP, e
   aí cada loja precisaria de um arquivo de VPN novo.

## 2. Montar a central

**[Windows]** Proteja a chave baixada, senão o `ssh` se recusa a usá-la:

```bash
icacls C:\Users\Arthur\Downloads\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

**[Windows]** Gere o pacote (o mesmo das lojas) e envie:

```bash
tar -czf C:\Users\Arthur\painel.tgz --exclude=node_modules --exclude=dados -C C:\painel .
```

```bash
scp -i C:\Users\Arthur\Downloads\ssh-key.key C:\Users\Arthur\painel.tgz ubuntu@IP-DA-VM:~
```

**[Windows]** Entre na VM:

```bash
ssh -i C:\Users\Arthur\Downloads\ssh-key.key ubuntu@IP-DA-VM
```

**[VM]** Monte, trocando `IP-DA-VM` pelo IP público:

```bash
mkdir -p ~/painel && tar -xzf ~/painel.tgz -C ~/painel && cd ~/painel && sudo bash central/montar-vm.sh IP-DA-VM
```

O script instala o WireGuard e o Node, fecha o firewall, sobe a central como serviço e programa
o backup diário. Pode rodar de novo para atualizar: as chaves da VPN são mantidas.

## 3. Seu PC de operador na VPN

**[VM]**

```bash
sudo bash /opt/central/vpn-novo.sh operador arthur
```

**[Windows]** Baixe o arquivo gerado:

```bash
scp -i C:\Users\Arthur\Downloads\ssh-key.key ubuntu@IP-DA-VM:operador-arthur.conf C:\Users\Arthur\
```

Instale o **WireGuard para Windows** (wireguard.com/install). Depois use **Import tunnel(s)
from file** com o `operador-arthur.conf` e clique em **Activate**. Abra
**http://10.88.0.1:8080**: é a central.

Cada operador tem o seu próprio arquivo. Não compartilhe, porque ele funciona como uma senha.

## 4. Cada loja na VPN

**[VM]** O id é curto, sem espaço; o nome é o que aparece na tela:

```bash
sudo bash /opt/central/vpn-novo.sh loja e01 "Viza CD E01"
```

Leve o `loja-e01.conf` até o mini PC da loja: baixe da VM para o Windows e envie para a loja
com `scp`, como nos passos acima. **[mini PC da loja]** Instale ou atualize com a VPN:

```bash
cd ~/painel && sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/loja-e01.conf
```

O instalador liga a VPN (e ela volta sozinha a cada boot), grava na configuração da loja que
`10.88.0.1` é a central e testa se a central responde. Em até 5 s a loja aparece na central.

## Tela de alarmes — http://10.88.0.1:8080/alarmes

A tela que fica aberta na mesa do operador. Junta os alarmes ativos de **todas** as lojas
numa lista só:

* em cima, os que a central **ainda não viu**, piscando; depois por prioridade e por horário;
* **loja sem comunicação com a central também vira alarme** (prioridade alta) — sem ela, os
  alarmes daquela loja não chegariam;
* **som**: o navegador só permite tocar depois de um clique — clique em **Ativar som** ao abrir
  a tela. Alarme novo toca na hora; alarme **alto** continua tocando a cada 10 s até o
  operador dar **Ciente**;
* **Ciente** é só da central (o operador tomou ciência); o reconhecimento do alarme continua
  sendo feito na loja — **Abrir configurador** leva direto à tela de Alarmes daquela loja;
* o título da aba mostra quantos alarmes ainda não foram vistos, ex.: *(3) Alarmes*.

Um alarme leva até ~10 s para aparecer na central (a central consulta cada loja a cada 5 s, e a
tela atualiza a cada 5 s), além do atraso de confirmação que o próprio alarme tem na loja.

## Acesso pela internet, sem VPN no aparelho

O operador abre **https://central.146-235-41-191.sslip.io** em qualquer navegador, inclusive
no celular, e entra com a **conta Google**. Só entram os e-mails da lista, e essa lista é
cuidada pela tela **Acessos** da central.

```
operador ─HTTPS─► VM :443  Caddy ─► login Google (só e-mails da lista) ─► central
                                                                        └─ VPN ─► lojas
```

* **As lojas não mudam:** continuam ligadas à central só pela VPN.
* **Cada loja ganha um endereço**, `https://loja-<id>.146-235-41-191.sslip.io`. O botão
  "Abrir configurador" usa esse endereço quando a central foi aberta pela internet.
* **O configurador da loja continua pedindo o usuário e a senha da própria loja.**
* **O nome vem do sslip.io**, um serviço gratuito que transforma o IP em nome. É por isso
  que o endereço tem o IP, e não precisa comprar domínio.
* **Quem cuida de cada parte:**
  * o HTTPS e o certificado, o **Caddy**;
  * o login, o **oauth2-proxy**, com conta Google;
  * a senha e a verificação em duas etapas, o próprio Google.
* **O que fica aberto na VM:** só as portas 80 e 443. Nelas só responde a tela de login.

O IP público da VM está no endereço. Se ele mudar, mudam o endereço e o passo B.2
(configure um IP **reservado** na Oracle para isso não acontecer).

### Passo A — Oracle: liberar as portas 80 e 443 (uma vez)

1. Abra **Networking → Virtual cloud networks → (sua VCN) → Security Lists → Default Security List**.
2. Em **Add Ingress Rules**, crie duas regras, como fez com a 51820:
   * Source CIDR `0.0.0.0/0` · IP Protocol **TCP** · Destination Port Range **443**;
   * Source CIDR `0.0.0.0/0` · IP Protocol **TCP** · Destination Port Range **80**.

   A porta 80 só serve para emitir o certificado e para redirecionar a quem digitar `http://`.

### Passo B — Google Cloud: criar o login (uma vez, uns 10 min)

1. **Crie o projeto.** Em **console.cloud.google.com**, entre com a sua conta Google e crie
   um projeto: seletor de projetos no topo → **Novo projeto** → nome `central-operacao`.
2. **Configure a tela de consentimento.** No menu (☰), abra **Google Auth Platform** e
   clique em **Primeiros passos**. Em algumas telas o item se chama "APIs e serviços →
   Tela de permissão OAuth".
   * **Nome do app:** `Central de Operação`. **E-mail de suporte:** o seu.
   * **Público-alvo:** **Externo**.
   * **Dados de contato:** o seu e-mail. Aceite os termos e clique em **Criar**.
3. **Cadastre os usuários de teste.** Em **Público-alvo**, deixe o status em **Testando**:
   para publicar, o Google exige página inicial e política de privacidade num domínio
   próprio, que não temos. Em **Usuários de teste → + Add users**, inclua o e-mail Google de
   cada pessoa, **inclusive o seu**, e clique em **Salvar** (o limite é 100).
   * Em modo de teste, cada pessoa nova entra em **duas** listas: a do Google (quem pode
     tentar o login) e a tela **Acessos** da central (quem entra).
   * Para tirar alguém, basta remover na tela Acessos, e vale na hora.
   * No primeiro login aparece *"O Google não verificou este app"*: a pessoa clica em
     **Continuar**. A cada 7 dias o Google pode pedir de novo a confirmação.
   * Com domínio próprio no futuro, publique o app (**Publicar app**) e a lista do
     Google deixa de ser necessária.
4. **Crie a credencial.** Em **Clientes**, clique em **Criar cliente**:
   * **Tipo de aplicativo:** **Aplicativo da Web**. **Nome:** `central`.
   * **URIs de redirecionamento autorizados → Adicionar URI:**
     `https://central.146-235-41-191.sslip.io/oauth2/callback`
   * Clique em **Criar**.
5. **Copie o ID do cliente e a chave secreta na hora.** O Google pode não mostrar a chave
   secreta de novo. Guarde as duas como senha: elas vão no passo C.

### Passo C — na VM: ligar

**[Windows]** Gere o pacote e envie:

```bash
tar -czf C:\Users\Arthur\painel.tgz --exclude=node_modules --exclude=dados -C C:\painel .
```

```bash
scp -i C:\Users\Arthur\.ssh\central.key C:\Users\Arthur\painel.tgz ubuntu@146.235.41.191:~
```

```bash
ssh -i C:\Users\Arthur\.ssh\central.key ubuntu@146.235.41.191
```

**[VM]** Primeiro atualize a central (ela passa a ter a tela Acessos), depois ligue o acesso
pela internet. Troque o e-mail pelo seu, que vira o primeiro administrador:

```bash
rm -rf ~/painel && mkdir -p ~/painel && tar -xzf ~/painel.tgz -C ~/painel && cd ~/painel && sudo bash central/montar-vm.sh 146.235.41.191
```

```bash
sudo bash /opt/central/web.sh seu-email@gmail.com
```

O script pede o **Client ID** e o **Client secret** do passo B.5. O secret não aparece
enquanto você digita (cole com o botão direito). No fim, deve aparecer
`ok: HTTPS no ar e pedindo login`.

### Passo D — testar e cadastrar os outros

1. **Teste no celular**, fora do Wi-Fi da empresa: abra **https://central.146-235-41-191.sslip.io**
   e entre com a sua conta Google.
2. **Cadastre os outros:** clique em **Acessos** e libere o e-mail de cada um.
   * **Administrador** também cadastra e remove acessos. Deixe pelo menos duas pessoas como
     administradoras, para uma não depender da outra.
   * Use o e-mail **exatamente** como ele aparece na conta Google da pessoa.
3. **Remover vale na hora.** Ninguém consegue remover o próprio acesso nem tirar o próprio
   papel de administrador, então sempre sobra pelo menos um.
4. **Tudo fica registrado**, com quem liberou ou removeu e quando, em
   `/opt/central/acesso/registro.log`.

Se nenhum administrador conseguir entrar, use a linha de comando na VM (por SSH):

```bash
sudo bash /opt/central/acesso.sh liberar fulano@gmail.com admin
```

Ela também aceita `sudo bash /opt/central/acesso.sh` (lista) e `... remover fulano@gmail.com`.

### Passo E — atualizar o supervisório de cada loja

A loja precisa da versão nova do supervisório para:
* **o bloqueio de senha errada ver o IP real** de quem acessa pela internet. Sem isso, 5
  senhas erradas de um operador bloqueiam todos por 15 min;
* **o resumo da loja recusar o que chega pelo proxy da central.** O Caddy já bloqueia esse
  caminho; isso é uma segunda trava.

Atualize como de costume (LINUX.md, "Atualizar"). A configuração e o banco são mantidos.

### Quando não abre

| Sintoma | Causa provável |
|---|---|
| A página não carrega | A porta 443 não está liberada na Security List (passo A). |
| Erro de certificado | O Caddy ainda não conseguiu emitir o certificado: `journalctl -u caddy -n 50 --no-pager`. Normalmente é a porta 80 fechada. |
| Google mostra `redirect_uri_mismatch` | A URI do passo B.4 está diferente; precisa ser idêntica, com `https://` e `/oauth2/callback`. |
| Google mostra "Acesso bloqueado" ou "o app está sendo testado" | O e-mail não está em **Usuários de teste** no Google (passo B.3). |
| "Acesso não liberado" depois do login | O e-mail não está na lista, ou está escrito diferente da conta Google. |
| A loja abre e pede login de novo | É o login da própria loja: usuário e senha do supervisório daquela loja. |

## 5. Dia a dia

| O quê | Onde | Comando |
|---|---|---|
| Liberar ou remover um operador | navegador | **https://central.146-235-41-191.sslip.io/acessos** (administrador) |
| Lista de acessos sem navegador | VM | `sudo bash /opt/central/acesso.sh` (listar · liberar · remover) |
| Quem liberou ou removeu, e quando | VM | `cat /opt/central/acesso/registro.log` |
| Log do login e do HTTPS | VM | `journalctl -u oauth2-proxy -n 50` · `journalctl -u caddy -n 50` |
| Ver quem está conectado | VM | `sudo wg show` (veja *latest handshake* de cada um) |
| Entrar no computador de uma loja | seu PC, túnel ativo | `ssh usuario@10.88.1.N` (o N está em `/opt/central/lojas.json`) |
| Log da central | VM | `journalctl -u central -f` |
| Mini PC roubado ou loja encerrada | VM | `sudo bash /opt/central/vpn-novo.sh remover loja e01` |
| Operador saiu da empresa | VM | `sudo bash /opt/central/vpn-novo.sh remover operador fulano` |
| Atualizar a central | VM | refaça o passo 2 com o pacote novo |
| Baixar o backup | Windows | `scp -i ...\ssh-key.key ubuntu@IP-DA-VM:backup-central/*.tgz .` |

**Backup:** todo dia às 3h30 a VM guarda as chaves da VPN, o cadastro de lojas e a lista de acessos em
`~/backup-central/` (os últimos 14 dias). **Baixe de tempos em tempos para fora da nuvem.**
Se a Oracle encerrar a VM, você monta outra, restaura esse arquivo
(`sudo tar -xzf central-AAAAMMDD.tgz -C /`) antes do `montar-vm.sh` e as lojas voltam sozinhas.
Se o IP mudar, troque o `Endpoint` no `/etc/wireguard/wg0.conf` de cada loja.

## 6. Quando algo não aparece

* **Loja "sem contato"** na central:
  * na VM, `sudo wg show`: sem *handshake* da loja = a VPN não fechou (internet da loja,
    arquivo errado, porta UDP 51820 na Security List);
  * no mini PC, `sudo wg show` e `ping 10.88.0.1`.
* **"VPN ok, mas o supervisório da loja não está no ar"**: no mini PC, `systemctl status supervisorio`.
* **"a loja não reconhece esta central"**: a configuração da loja não tem `central.ip`. Rode o
  instalador da loja de novo com `--vpn`.
* **A página da central não abre no seu PC**: o túnel do WireGuard está ativo (Activate)?

## Limites desta primeira versão

* A central mostra o estado e abre o configurador de cada loja. **Os comandos, inclusive o do
  disjuntor, são feitos no configurador da loja**, que já tem intertravamentos, confirmação e
  senha. O comando direto da tela da central, com assinatura, validade curta e proteção
  contra comando repetido, é a etapa seguinte.
* Cada loja tem os próprios usuários. Login único em todas é etapa futura.
* Plataforma gratuita, **sem garantia de serviço**: serve para piloto e apresentação.
  Para a operação comercial, a mesma montagem roda numa VPS paga sem mudar nada.
