#!/usr/bin/env bash
# Monta a central de operação numa VM Ubuntu (Oracle Cloud Always Free, ARM).
#
#   sudo bash central/montar-vm.sh <IP-PUBLICO-DA-VM>
#
# Rode de dentro da pasta do projeto copiada para a VM. Pode rodar de novo
# (atualização): nada é duplicado e as chaves da VPN são mantidas.
#
# O que fica no ar:
#   - WireGuard (wg0, 10.88.0.1) — lojas e operadores discam para cá, UDP 51820
#   - central (Node) em http://10.88.0.1:8080, só dentro da VPN
#   - backup diário de chaves e cadastro em /home/ubuntu/backup-central/
#
# Rede da VPN:  10.88.0.1 central · 10.88.1.x lojas · 10.88.2.x operadores
# Firewall: operador → lojas e → central; loja não fala com loja nem com operador.
set -euo pipefail

PUBLICO="${1:-}"
[ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
[ -n "$PUBLICO" ] || { echo "uso: sudo bash central/montar-vm.sh <IP-PUBLICO-DA-VM>"; exit 1; }
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO=/opt/central
PORTA_VPN=51820
passo() { echo; echo "==> $*"; }

passo "Memória"
# A VM gratuita AMD (E2.1.Micro) tem 1 GB: sem swap, o apt pode ser morto por falta de memória
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap de 2 GB criado (VM com ${MEM_MB} MB de RAM)"
else
  echo "${MEM_MB} MB de RAM"
fi

passo "Pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q wireguard iptables-persistent curl unattended-upgrades
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
echo "node $(node -v)"

passo "Encaminhamento de pacotes (operador → loja passa pela central)"
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-central-vpn.conf
sysctl -q --system

passo "WireGuard"
umask 077
mkdir -p /etc/wireguard/clientes
[ -f /etc/wireguard/central.key ] || wg genkey > /etc/wireguard/central.key
wg pubkey < /etc/wireguard/central.key > /etc/wireguard/central.pub
echo "$PUBLICO" > /etc/wireguard/endereco_publico
if [ ! -f /etc/wireguard/wg0.conf ]; then
  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.88.0.1/16
ListenPort = $PORTA_VPN
PrivateKey = $(cat /etc/wireguard/central.key)
# as lojas e os operadores são acrescentados abaixo por vpn-novo.sh
EOF
fi
umask 022

passo "Firewall"
# A imagem Ubuntu da Oracle já vem com iptables fechando tudo menos SSH (REJECT
# no fim de INPUT e FORWARD). As regras entram ANTES desse REJECT e ficam salvas.
garantir() {  # garantir CADEIA regra... → insere no topo se ainda não existe
  local cadeia="$1"; shift
  iptables -C "$cadeia" "$@" 2>/dev/null || iptables -I "$cadeia" 1 "$@"
}
garantir INPUT -p udp --dport "$PORTA_VPN" -j ACCEPT
garantir INPUT -i wg0 -p tcp --dport 8080 -s 10.88.2.0/24 -j ACCEPT
# FORWARD em ordem: (topo) operador→loja · respostas · (resto entre túneis) bloqueado
iptables -C FORWARD -i wg0 -o wg0 -j DROP 2>/dev/null || iptables -I FORWARD 1 -i wg0 -o wg0 -j DROP
garantir FORWARD -i wg0 -o wg0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
garantir FORWARD -i wg0 -o wg0 -s 10.88.2.0/24 -d 10.88.1.0/24 -j ACCEPT
netfilter-persistent save >/dev/null

systemctl enable --now wg-quick@wg0 >/dev/null
systemctl restart wg-quick@wg0

passo "Central em $DESTINO"
id central >/dev/null 2>&1 || useradd --system --home-dir "$DESTINO" --no-create-home --shell /usr/sbin/nologin central
mkdir -p "$DESTINO/publico" "$DESTINO/acesso"
cp "$ORIGEM/servidor.js" "$ORIGEM/web.js" "$DESTINO/"
cp "$ORIGEM/publico/"*.html "$DESTINO/publico/"
cp "$ORIGEM/publico/"*.png "$DESTINO/publico/" 2>/dev/null || true
cp "$ORIGEM/vpn-novo.sh" "$ORIGEM/backup.sh" "$ORIGEM/web.sh" "$ORIGEM/acesso.sh" "$DESTINO/"
[ -f "$DESTINO/lojas.json" ] || echo '{ "lojas": [] }' > "$DESTINO/lojas.json"
chown -R central:central "$DESTINO"
chmod 750 "$DESTINO/acesso"

cat > /etc/systemd/system/central.service <<EOF
[Unit]
Description=Central de operacao (Engemase Pulse Configurador)
After=wg-quick@wg0.service network-online.target
Wants=wg-quick@wg0.service network-online.target

[Service]
User=central
Group=central
WorkingDirectory=$DESTINO
ExecStart=$(command -v node) servidor.js
Environment=CENTRAL_ESCUTA=10.88.0.1
Environment=CENTRAL_PORTA=8080
# acesso pela internet (web.sh): só 127.0.0.1, atrás do Caddy e do login Google
Environment=CENTRAL_PROXY_PORTA=8081
Environment=TZ=America/Sao_Paulo
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=$DESTINO
# a tela Acessos grava a lista de e-mails
ReadWritePaths=-$DESTINO/acesso
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable central >/dev/null
systemctl restart central

passo "Backup diário (chaves da VPN + cadastro de lojas)"
cat > /etc/cron.d/central-backup <<EOF
30 3 * * * root bash $DESTINO/backup.sh
EOF
bash "$DESTINO/backup.sh"

timedatectl set-timezone America/Sao_Paulo 2>/dev/null || true

sleep 2
systemctl is-active --quiet central || { journalctl -u central -n 20 --no-pager; echo "ERRO: a central não subiu"; exit 1; }

# acesso pela internet já ligado: os endereços das lojas acompanham o cadastro
bash "$DESTINO/web.sh" --atualizar

passo "Pronto"
echo "VPN: $PUBLICO:$PORTA_VPN  (chave pública da central: $(cat /etc/wireguard/central.pub))"
echo "Central: http://10.88.0.1:8080  (só dentro da VPN)"
echo
echo "FALTA no painel da Oracle (uma vez só): na Security List da sub-rede da VM,"
echo "regra de ENTRADA: origem 0.0.0.0/0, protocolo UDP, porta de destino $PORTA_VPN."
echo
echo "Próximos passos:"
echo "  sudo bash $DESTINO/vpn-novo.sh operador <seu-nome>     → VPN do seu PC"
echo "  sudo bash $DESTINO/vpn-novo.sh loja <id> \"<Nome>\"       → VPN de cada loja"
echo "  sudo bash $DESTINO/web.sh <seu-email>                  → acesso pela internet com login Google"
