#!/usr/bin/env bash
# Desliga o que a central antiga tinha além da VPN: a tela das unidades
# (central :8080), a tela de alarmes e o acesso pela internet com login Google
# (Caddy + oauth2-proxy, portas 80 e 443). Leituras, alarmes e a lista das
# unidades ficam no Engemase Pulse.
#
#   sudo bash /opt/central/enxugar.sh
#
# A VPN (wg0), as chaves e o cadastro dos gateways e técnicos NÃO são tocados:
# todos continuam conectados. Pode rodar de novo: o que já saiu é pulado.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
passo() { echo; echo "==> $*"; }
# o vpn-novo.sh antigo chama o web.sh, que sai daqui: os scripts novos vêm antes
grep -q 'listar' /opt/central/vpn-novo.sh 2>/dev/null \
  || { echo "rode antes: sudo bash central/montar-vm.sh <IP-PUBLICO> (atualiza os scripts da VPN)"; exit 1; }

passo "Backup antes de mexer"
[ -f /opt/central/backup.sh ] && bash /opt/central/backup.sh || echo "sem backup.sh; seguindo"

passo "Serviços"
for s in central caddy oauth2-proxy oauth2-proxy-lista.path oauth2-proxy-lista.service; do
  if systemctl cat "$s" >/dev/null 2>&1; then
    systemctl disable --now "$s" 2>/dev/null || true
    echo "desligado: $s"
  fi
done
rm -f /etc/systemd/system/central.service /etc/systemd/system/oauth2-proxy.service \
      /etc/systemd/system/oauth2-proxy-lista.path /etc/systemd/system/oauth2-proxy-lista.service
systemctl daemon-reload

passo "Programas do acesso pela internet"
if dpkg -s caddy >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -q caddy >/dev/null && echo "caddy removido"
fi
rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
rm -f /usr/local/bin/oauth2-proxy
# a credencial do Google (client secret) ficava aqui
rm -rf /etc/oauth2-proxy

passo "Firewall: fecha 80, 443 e a porta da tela antiga"
apagar() {  # apaga a regra enquanto ela existir (pode ter sido inserida mais de uma vez)
  while iptables -C "$@" 2>/dev/null; do iptables -D "$@"; done
}
apagar INPUT -p tcp --dport 80 -j ACCEPT
apagar INPUT -p tcp --dport 443 -j ACCEPT
apagar INPUT -i wg0 -p tcp --dport 8080 -s 10.88.2.0/24 -j ACCEPT
netfilter-persistent save >/dev/null 2>&1 || true

passo "Arquivos da tela antiga"
for f in servidor.js web.js web.sh acesso.sh web.json lojas.json; do rm -f "/opt/central/$f"; done
rm -rf /opt/central/publico /opt/central/acesso
id central >/dev/null 2>&1 && userdel central 2>/dev/null || true
chown -R root:root /opt/central

passo "Pronto"
echo "Ficou só a VPN. Confira quem está conectado: sudo bash /opt/central/vpn-novo.sh listar"
echo
echo "FALTA fora daqui (uma vez):"
echo "  - Oracle, Security List da VM: apague as regras de entrada TCP 80 e 443 (fica só UDP 51820 e o SSH)."
echo "  - Google Cloud: apague a credencial OAuth usada no login da central."
