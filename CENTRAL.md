# VPN de manutenção (central na Oracle Cloud Always Free)

A central é só uma VPN WireGuard. Por ela, o técnico entra no gateway de qualquer unidade
para **SSH, atualização e o Pulse Configurador**, de qualquer lugar. Os gateways e os
técnicos **discam para a central**, então nenhuma unidade precisa de porta aberta no roteador.

Leituras, gráficos, alarmes e a lista das unidades ficam no **Engemase Pulse**. A central não
tem tela nem nada exposto na internet além da porta da VPN. O endereço de cada gateway na VPN
aparece na administração do Pulse (página da unidade e Saúde do sistema).

```
                 VM Oracle (São Paulo) — IP público, só a porta UDP 51820 aberta
                 ┌──────────────────────────────────────────────┐
                 │            WireGuard 10.88.0.1               │
                 └──────────▲─────────────────────▲─────────────┘
       gateways 10.88.1.x   │                     │  técnicos 10.88.2.x
   (o gateway da unidade    │                     │ (PC ou celular com o
    disca e fica ligado)    │                     │  app do WireGuard)
```

* **Técnico** alcança o gateway de qualquer unidade: `ssh usuario@10.88.1.N` e
  `http://10.88.1.N:8080` (o configurador, que continua pedindo o login do próprio gateway).
* **Gateway** só alcança a central. Um gateway não enxerga outro nem o PC do técnico.

Custo: **zero** (Oracle Always Free). A VPN usa uma fração mínima da VM.

---

## 1. Conta e VM na Oracle (uma vez)

1. Crie a conta em **oracle.com/cloud/free**. Como **região principal (home region)**, escolha
   **Brazil East (São Paulo)**. Ela não muda depois, e os recursos gratuitos só existem nela.
   A Oracle pede um cartão só para verificação.
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
   aí cada gateway precisaria de um arquivo de VPN novo.

## 2. Montar a central

**[Windows]** Proteja a chave baixada, senão o `ssh` se recusa a usá-la:

```bash
icacls C:\Users\Arthur\Downloads\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

**[Windows]** Gere o pacote (o mesmo dos gateways) e envie:

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

O script instala o WireGuard, fecha o firewall (só a porta da VPN entra) e programa o backup
diário das chaves. Pode rodar de novo para atualizar: as chaves da VPN são mantidas.

## 3. Seu PC de técnico na VPN

**[VM]**

```bash
sudo bash /opt/central/vpn-novo.sh tecnico arthur
```

**[Windows]** Baixe o arquivo gerado:

```bash
scp -i C:\Users\Arthur\Downloads\ssh-key.key ubuntu@IP-DA-VM:tecnico-arthur.conf C:\Users\Arthur\
```

Instale o **WireGuard para Windows** (wireguard.com/install). Depois use **Import tunnel(s)
from file** com o `tecnico-arthur.conf` e clique em **Activate**. No celular, o app do
WireGuard importa o mesmo arquivo (ou um QR code: `qrencode -t ansiutf8 < tecnico-arthur.conf`
na VM, se instalar o `qrencode`).

Cada técnico tem o seu próprio arquivo. Não compartilhe, porque ele funciona como uma senha.

## 4. Cada gateway na VPN

**[VM]** O id é curto, sem espaço; o nome é só para você reconhecer na lista:

```bash
sudo bash /opt/central/vpn-novo.sh unidade e01 "Unidade Centro"
```

Leve o `unidade-e01.conf` até o gateway: baixe da VM para o Windows e envie para o gateway com
`scp`, como nos passos acima (ou num pendrive, com quem estiver na unidade).
**[gateway]** Instale ou atualize com a VPN:

```bash
cd ~/painel && sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/unidade-e01.conf
```

O instalador liga a VPN (ela volta sozinha a cada boot) e testa se a central responde. Se o
`ufw` estiver ligado no gateway, ele libera o SSH e o configurador **só pela VPN**. No próximo
envio, o endereço do gateway na VPN aparece na administração do Pulse.

## 5. Dia a dia

| O quê | Onde | Comando |
|---|---|---|
| Quem está cadastrado e conectado | VM | `sudo bash /opt/central/vpn-novo.sh listar` |
| Entrar no gateway de uma unidade | seu PC, túnel ativo | `ssh usuario@10.88.1.N` (o N está no `listar` e na administração do Pulse) |
| Abrir o configurador da unidade | seu PC, túnel ativo | `http://10.88.1.N:8080` |
| Atualizar o gateway | seu PC, túnel ativo | `scp painel.tgz usuario@10.88.1.N:~` e o instalador |
| Gateway roubado ou unidade encerrada | VM | `sudo bash /opt/central/vpn-novo.sh remover unidade e01` |
| Técnico saiu da empresa | VM | `sudo bash /opt/central/vpn-novo.sh remover tecnico fulano` |
| Atualizar a central | VM | refaça o passo 2 com o pacote novo |
| Baixar o backup | Windows | `scp -i ...\ssh-key.key ubuntu@IP-DA-VM:backup-central/*.tgz .` |

Os nomes antigos `loja` e `operador` continuam valendo nos comandos.

**Backup:** todo dia às 3h30 a VM guarda as chaves e o cadastro da VPN em `~/backup-central/`
(os últimos 14 dias). **Baixe de tempos em tempos para fora da nuvem.** Se a VM se perder,
você monta outra, restaura esse arquivo (`sudo tar -xzf central-AAAAMMDD.tgz -C /`) antes do
`montar-vm.sh` e os gateways voltam sozinhos. Se o IP mudar, troque o `Endpoint` no
`/etc/wireguard/wg0.conf` de cada gateway.

**Máquina ociosa:** a Oracle pode recuperar instâncias Always Free que ficam ociosas por vários
dias, e uma VPN passa quase o tempo todo parada. Para evitar, converta a conta para
**Pay As You Go**: os recursos Always Free continuam gratuitos, mas o que não for gratuito
passa a ser cobrado, então crie um **alerta de orçamento** (Billing → Budgets) de poucos reais.
Sem converter, mantenha o backup sempre baixado.

## 6. Já tem a central antiga (tela, alarmes e login Google)?

A versão anterior tinha uma tela com as unidades, uma tela de alarmes e o acesso pela internet
com login Google (Caddy + oauth2-proxy, portas 80 e 443). Tudo isso agora está no Engemase
Pulse. Para deixar só a VPN, sem desligar nenhum gateway nem técnico:

**[VM]** com o pacote novo copiado (passo 2):

```bash
cd ~/painel && sudo bash central/montar-vm.sh IP-DA-VM && sudo bash /opt/central/enxugar.sh
```

O `enxugar.sh` faz um backup, desliga e remove a tela, o Caddy e o oauth2-proxy (com a
credencial do Google), fecha as portas 80 e 443 no firewall da VM e apaga os arquivos da
tela antiga. A VPN, as chaves e os cadastros não são tocados.

Depois, fora da VM (uma vez):
* **Oracle**, Security List da VM: apague as regras de entrada **TCP 80 e 443**. Fica só a
  **UDP 51820** (e o SSH da VM).
* **Google Cloud**: apague a credencial OAuth usada no login da central.

Os gateways também podem ser atualizados (passo 4) quando for conveniente: a versão nova não
tem mais o resumo que a tela antiga lia e manda o endereço da VPN para o Pulse.

## 7. Quando algo não conecta

* **Gateway "nunca" ou "há muito tempo" no `listar`**: a VPN não fechou. Confira a internet da
  unidade, o arquivo da VPN e a porta UDP 51820 na Security List. No gateway: `sudo wg show` e
  `ping 10.88.0.1`.
* **VPN ok, mas o configurador não abre**: no gateway, `systemctl status supervisorio`.
* **VPN ok, mas o SSH recusa**: o SSH está ligado no gateway (`systemctl status ssh`)? Com o
  `ufw` ligado, rode o instalador de novo com `--vpn` (ele libera a porta 22 pela VPN).
* **Nada abre no seu PC**: o túnel do WireGuard está ativo (Activate)?

## Segurança

* Entre no gateway por **chave SSH** e desligue o login por senha (`PasswordAuthentication no`
  em `/etc/ssh/sshd_config`). Troque a senha padrão da imagem antes de qualquer coisa.
* Um arquivo `.conf` vazado dá acesso à VPN: revogue na hora com `vpn-novo.sh remover`.
* Comando remoto (ligar e desligar pelo Pulse) **não** passa por aqui: fica para um projeto
  próprio de segurança no Engemase Pulse. Os comandos continuam no configurador da unidade,
  com os intertravamentos, a confirmação e a senha dele.
