#!/usr/bin/env bash
# Monta a VPN de manutenção numa VM Ubuntu (Oracle Cloud Always Free).
#
#   sudo bash central/montar-vm.sh <IP-PUBLICO-DA-VM>
#
# Rode de dentro da pasta do projeto copiada para a VM. Pode rodar de novo
# (atualização): nada é duplicado e as chaves da VPN são mantidas.
#
# O que fica no ar: só o WireGuard (wg0, 10.88.0.1, UDP 51820). Os gateways das
# unidades e os PCs dos técnicos discam para cá; nenhuma unidade precisa de
# porta aberta no roteador. Leituras, alarmes e a lista das unidades ficam no
# Engemase Pulse — esta máquina não tem tela nem nada exposto na internet além
# da porta da VPN (e do SSH da própria VM).
#
# Rede da VPN:  10.88.0.1 central · 10.88.1.x unidades · 10.88.2.x técnicos
# Firewall: técnico → unidades (SSH, configurador); unidade não fala com outra
# unidade nem com o PC do técnico.
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
apt-get install -y -q wireguard iptables-persistent unattended-upgrades

passo "Encaminhamento de pacotes (técnico → unidade passa pela central)"
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
# as unidades e os técnicos são acrescentados abaixo por vpn-novo.sh
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
# FORWARD em ordem: (topo) técnico→unidade · respostas · (resto entre túneis) bloqueado
iptables -C FORWARD -i wg0 -o wg0 -j DROP 2>/dev/null || iptables -I FORWARD 1 -i wg0 -o wg0 -j DROP
garantir FORWARD -i wg0 -o wg0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
garantir FORWARD -i wg0 -o wg0 -s 10.88.2.0/24 -d 10.88.1.0/24 -j ACCEPT
netfilter-persistent save >/dev/null

systemctl enable --now wg-quick@wg0 >/dev/null
systemctl restart wg-quick@wg0

passo "Scripts em $DESTINO"
mkdir -p "$DESTINO"
cp "$ORIGEM/vpn-novo.sh" "$ORIGEM/backup.sh" "$ORIGEM/enxugar.sh" "$DESTINO/"
chmod 755 "$DESTINO"/*.sh

passo "Backup diário (chaves da VPN)"
cat > /etc/cron.d/central-backup <<EOF
30 3 * * * root bash $DESTINO/backup.sh
EOF
bash "$DESTINO/backup.sh"

timedatectl set-timezone America/Sao_Paulo 2>/dev/null || true

passo "Pronto"
echo "VPN: $PUBLICO:$PORTA_VPN  (chave pública da central: $(cat /etc/wireguard/central.pub))"
echo
echo "FALTA no painel da Oracle (uma vez só): na Security List da sub-rede da VM,"
echo "regra de ENTRADA: origem 0.0.0.0/0, protocolo UDP, porta de destino $PORTA_VPN."
echo
echo "Próximos passos:"
echo "  sudo bash $DESTINO/vpn-novo.sh tecnico <seu-nome>         → VPN do seu PC"
echo "  sudo bash $DESTINO/vpn-novo.sh unidade <id> \"<Nome>\"      → VPN de cada gateway"
echo "  sudo bash $DESTINO/vpn-novo.sh listar                     → quem está cadastrado e conectado"
