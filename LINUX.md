# Instalação em servidor Linux (via SSH)

Este guia serve para Debian 12 e Ubuntu 22.04 ou 24.04, em PC x86-64 ou ARM64. O
supervisório roda como serviço do systemd: sobe junto com a máquina, reinicia sozinho
se cair e manda o log para o `journalctl`.

Comandos marcados **[Windows]** rodam no PowerShell do seu PC. Os marcados
**[servidor]** rodam na sessão SSH.

---

## 1. Preparar o servidor

**[Windows]** Entre no servidor. O cliente SSH já vem no Windows 10/11:

```bash
ssh usuario@192.168.0.50
```

> **SSH fora da porta 22?** O `ssh` usa `-p` minúsculo (`ssh -p 1022 usuario@...`) e
> o `scp` usa `-P` maiúsculo (`scp -P 1022 arquivo usuario@...:~`). Trocar as duas
> letras é o erro mais comum.

**[servidor]** Instale o Node.js 24 (LTS) pelo repositório do NodeSource. O `nodejs`
do apt do Ubuntu é antigo demais: precisa da versão 20 ou mais nova.

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

> Não use o **nvm**. Ele instala o Node dentro de `/home` ou `/root`, e o serviço não
> enxerga essas pastas. O script de instalação recusa esse caso.

**[servidor]** Acerte o fuso e confirme o NTP. O consumo por hora depende do relógio:

```bash
sudo timedatectl set-timezone America/Sao_Paulo
timedatectl
```

Na saída do `timedatectl`, confira se aparece `System clock synchronized: yes`.

> **Rede isolada, sem NTP na internet?** Aponte o servidor para o NTP da rede da loja,
> se houver: edite `/etc/systemd/timesyncd.conf`, preencha `NTP=<ip>` e rode
> `sudo systemctl restart systemd-timesyncd`.

---

## 2. Copiar o projeto

**[Windows]** Empacote sem as pastas `node_modules` e `dados`. A `node_modules` traz
binários do Windows que não rodam no Linux, e a `dados` só tem bancos de teste.
Depois envie o pacote:

```bash
tar -czf $env:TEMP\painel.tgz --exclude=node_modules --exclude=dados -C C:\painel .
```

```bash
scp $env:TEMP\painel.tgz usuario@192.168.0.50:~
```

**[servidor]**

```bash
rm -rf ~/painel && mkdir ~/painel && tar -xzf ~/painel.tgz -C ~/painel
```

---

## 3. Descobrir as portas seriais

Ligue os dois conversores USB-RS485 no servidor. Em seguida:

**[servidor]**

```bash
ls -l /dev/serial/by-id/ /dev/serial/by-path/
```

No Linux os conversores aparecem como `/dev/ttyUSB0` e `/dev/ttyUSB1`, mas **não use
esses nomes na configuração**. A ordem entre eles muda a cada boot, e a subestação
pode acabar na porta dos medidores. Use um nome fixo:

| Situação | Use | Exemplo |
|---|---|---|
| Conversores com número de série próprio (FTDI costuma ter) | `/dev/serial/by-id/...` — o nome acompanha o conversor em qualquer USB | `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A10K3ZQ1-if00-port0` |
| Dois conversores iguais, sem número de série (CH340, CP2102 baratos) | `/dev/serial/by-path/...` — o nome é o **conector USB físico** | `/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0` |

Se usar o `by-path`, marque os conectores no gabinete (por exemplo, "RS485 SUB" e
"RS485 MED"). Trocar o conversor de USB troca o nome da porta.

**Qual conversor é qual?** Desconecte um deles e rode o `ls` de novo: some a linha do
conversor que saiu.

---

## 4. Ajustar as portas na configuração

A `config.planta.json` vem com os nomes do Windows: COM3 para a subestação e COM4
para os medidores e o 15CLP1. Troque pelos nomes do passo 3.

**[servidor]**

```bash
cd ~/painel
SUB=/dev/serial/by-path/COLE-AQUI-O-DA-SUBESTACAO
MED=/dev/serial/by-path/COLE-AQUI-O-DOS-MEDIDORES
sed -i "s#\"COM3\"#\"$SUB\"#g; s#\"COM4\"#\"$MED\"#g" config.planta.json
grep -c "$SUB" config.planta.json
grep -c "$MED" config.planta.json
```

O primeiro `grep` deve dar 2 (7CLP1 e gerador), e o segundo, 10 (nove medidores e o
15CLP1).

Depois de instalado, dá para trocar a porta pela tela: **Engenharia → Equipamentos**.

---

## 5. Instalar

**[servidor]**

```bash
cd ~/painel
sudo bash tools/instalar-linux.sh config.planta.json
```

O script:

1. confere o Node e o NTP;
2. cria o usuário de sistema `supervisorio`, com acesso às seriais pelo grupo `dialout`;
3. copia o projeto para `/opt/supervisorio`;
4. roda o `npm ci`, que baixa as dependências e os binários do Linux;
5. confere se as portas da configuração existem;
6. instala e sobe o serviço `supervisorio`;
7. libera a porta no `ufw`, se o firewall estiver ativo.

No fim, o script mostra o endereço de acesso e a **senha temporária do admin**. A troca
da senha é obrigatória no primeiro login.

```
Acesse: http://192.168.0.50:8080
Primeiro acesso — usuário: admin   senha temporária: ...
```

> **Erro no `npm ci` ao compilar o `better-sqlite3` ou o `serialport`?** Faltou
> compilador (acontece em ARM ou em distribuição mais velha). Rode
> `sudo apt install -y build-essential python3` e repita o passo 5.

> **Servidor sem internet?** O `npm ci` precisa baixar os pacotes. Faça os passos 2 a 5
> numa máquina Linux com internet, de mesma arquitetura (x86-64 ou ARM64) e mesma versão
> do Node. Depois copie a `/opt/supervisorio/node_modules` dela junto com o projeto.

---

## 6. Conferir

**[servidor]**

```bash
systemctl status supervisorio
```

```bash
journalctl -u supervisorio -f
```

No log da partida aparece a lista de equipamentos com a porta de cada um. Se uma porta
estiver errada ou sem permissão, o erro aparece ali.

Pelo navegador, abra `http://<ip>:8080`. Depois vá em **Engenharia → Diagnóstico**:
os 12 equipamentos devem estar em comunicação. A sequência de testes de campo está em
`PLANTA.md`.

---

## Operação do dia a dia

| O quê | Comando **[servidor]** |
|---|---|
| Parar, subir, reiniciar | `sudo systemctl stop supervisorio`, `start` ou `restart` |
| Log ao vivo | `journalctl -u supervisorio -f` |
| Log de ontem | `journalctl -u supervisorio --since yesterday` |
| Tamanho do banco | `du -h /opt/supervisorio/dados` |
| Senha perdida | `cd /opt/supervisorio && sudo -u supervisorio node tools/redefinir-senha.js --config config.planta.json` |

**Atualizar o supervisório:** repita os passos 2 e 5 com a versão nova. O script
preserva a `dados/` (histórico, usuários e auditoria) e as `config*.json` do servidor,
que podem ter sido editadas pela tela. Se a versão nova trouxer uma `config` diferente,
ela fica ao lado, com o nome `config.planta.json.nova`, para você comparar.

**Backup** (pode rodar com o serviço no ar):

```bash
cd /opt/supervisorio && sudo -u supervisorio node -e "new (require('better-sqlite3'))('dados/planta.db').backup('dados/backup-planta.db').then(()=>console.log('ok'))"
```

Copie `dados/backup-planta.db` e `config.planta.json` para fora do servidor. Do
Windows, por exemplo:
`scp usuario@192.168.0.50:/opt/supervisorio/dados/backup-planta.db .`

**Senha do admin perdida:** rode o comando abaixo, que pode rodar com o serviço no ar.
Ele gera uma senha temporária, reativa a conta e derruba as sessões abertas dela. A
troca da senha é exigida no próximo login, e a operação fica registrada na auditoria.
Para outro usuário, acrescente o login no fim (por exemplo, `... config.planta.json joao`).

```bash
cd /opt/supervisorio && sudo -u supervisorio node tools/redefinir-senha.js --config config.planta.json
```

Se a conta estiver travada por excesso de tentativas, o bloqueio dura 15 min; um
`sudo systemctl restart supervisorio` libera na hora.

---

## Banana Pi, Raspberry Pi e outras placas ARM

O procedimento é o mesmo, com Armbian ou Debian na placa. Antes, confira:

```bash
uname -m; cat /etc/os-release | head -3; free -m
```

* **`aarch64`** (Banana Pi M5, M2S, Raspberry Pi 4/5): tudo vem pronto, igual ao mini PC.
* **`armv7l`** (Banana Pi M1, M2, M3): o módulo do banco de dados é **compilado na própria
  placa** — o instalador instala o compilador e faz isso sozinho; leva de 5 a 15 minutos.
  O Node vem do mesmo NodeSource (`setup_24.x`; se a sua versão do sistema não tiver,
  use `setup_22.x`).
* Sistema muito antigo (Debian 9/10, Ubuntu 18.04 ou anterior): o NodeSource atual não
  atende — atualize o Armbian antes.

Cuidados próprios de placa:

* **Cartão SD gasta com escrita contínua** (o histórico grava a cada 15 s). Use cartão
  de alta durabilidade ("High Endurance") ou, melhor, o eMMC da placa ou um SSD USB.
* **Relógio**: a maioria das placas não tem bateria de relógio; depois de faltar energia ela
  só acerta a hora quando alcança o NTP. Confira com `timedatectl` (sincronizado = yes).
* **Senha padrão**: imagem Armbian/Raspberry vem com usuário e senha conhecidos. Troque
  antes de qualquer outra coisa (`passwd`) — é o primeiro que um invasor tenta.

## Instalar sem ir até a unidade

Só é preciso **alguém na unidade uma vez**, para ligar a placa na rede com internet — ou um
acesso remoto que já exista (SSH, AnyDesk/TeamViewer num computador da mesma rede). A
partir do momento em que a placa entra na VPN de manutenção ([CENTRAL.md](CENTRAL.md)),
todo o resto é remoto.

1. **Na central** (VM): `sudo bash /opt/central/vpn-novo.sh unidade e02 "Nome da unidade"` —
   gera o `unidade-e02.conf` e mostra o endereço do gateway na VPN (ex.: `10.88.1.2`).
2. **Levar dois arquivos até a placa** — o `painel.tgz` e o `unidade-e02.conf`:
   * com acesso remoto que já exista: `scp` por ele;
   * sem nenhum acesso: num pendrive, com quem estiver na unidade.
3. **Na placa** (pelo acesso remoto, ou quem estiver na unidade digita):
   ```bash
   mkdir -p ~/painel && tar -xzf ~/painel.tgz -C ~/painel && cd ~/painel && sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/unidade-e02.conf
   ```
4. **Daqui em diante, tudo pela VPN**, do seu PC com o túnel do WireGuard ativo:
   ```bash
   ssh usuario@10.88.1.2
   ```
   O configurador abre em `http://10.88.1.2:8080`, e o endereço aparece também na administração
   do Engemase Pulse. Atualizações: `scp painel.tgz usuario@10.88.1.2:~` e o instalador, sem
   sair do escritório.

A VPN volta sozinha a cada boot e não precisa de porta aberta no roteador da unidade.

## Detalhes

- **Porta 80 em vez de 8080:** o serviço não roda como root, então não pode abrir
  porta abaixo de 1024. Para usar a 80, acrescente
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` em `/etc/systemd/system/supervisorio.service`,
  troque `porta_http` para 80 na configuração e rode
  `sudo systemctl daemon-reload && sudo systemctl restart supervisorio`.
- **Fuso:** o serviço fixa `TZ=America/Sao_Paulo`. Assim, mesmo com o servidor em UTC, a
  barra das 14h da tela Consumo é 14h da loja.
- **Conversor FTDI e tempo de resposta:** o Linux segura os bytes recebidos por até 16 ms
  (`latency_timer`). Com 22 pedidos por ciclo na linha dos medidores, isso pesa. Para
  baixar para 1 ms, crie a regra abaixo e reconecte o conversor:

  ```bash
  echo 'ACTION=="add", SUBSYSTEM=="usb-serial", DRIVER=="ftdi_sio", ATTR{latency_timer}="1"' | sudo tee /etc/udev/rules.d/99-ftdi-latencia.rules
  sudo udevadm control --reload
  ```

  Conversores CH340 e CP2102 não têm esse ajuste e não precisam dele.
- **HTTPS:** fica para quando quiser ativar; está descrito no `README.md`. O certificado
  sai de `node tools/gerar-certificado.js`, rodado dentro de `/opt/supervisorio`.
- **O que o serviço pode fazer:** roda como `supervisorio`, sem root e sem login. Só
  escreve em `/opt/supervisorio` (a configuração salva pela tela e a pasta `dados/`). Não
  vê `/home`. Acessa as seriais pelo grupo `dialout`.
