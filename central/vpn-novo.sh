#!/usr/bin/env bash
# Cadastra (ou revoga) uma loja ou um operador na VPN da central.
#
#   sudo bash /opt/central/vpn-novo.sh loja <id> "<Nome da loja>" [porta-do-painel]
#   sudo bash /opt/central/vpn-novo.sh operador <nome>
#   sudo bash /opt/central/vpn-novo.sh remover loja <id>       (mini PC roubado, loja encerrada)
#   sudo bash /opt/central/vpn-novo.sh remover operador <nome> (funcionário saiu)
#
# Gera o arquivo .conf do WireGuard que vai para o equipamento:
#   loja      → copiar para o mini PC e instalar com tools/instalar-linux.sh --vpn
#   operador  → importar no aplicativo WireGuard do Windows/celular
# Cada um tem a sua própria chave: revogar um não afeta os outros.
set -euo pipefail

WG=/etc/wireguard
CONF=$WG/wg0.conf
LOJAS=/opt/central/lojas.json
[ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
[ -f "$CONF" ] || { echo "VPN da central não montada (rode central/montar-vm.sh)"; exit 1; }
uso() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
valido() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] || { echo "id inválido: '$1' (minúsculas, números, - e _)"; exit 1; }; }
dono=${SUDO_USER:-ubuntu}

if [ "${1:-}" = "remover" ]; then
  TIPO=${2:-}; ID=${3:-}
  [ "$TIPO" = loja ] || [ "$TIPO" = operador ] || uso
  valido "$ID"
  node -e '
    const fs = require("fs"); const [conf, tipo, id, lojas] = process.argv.slice(1);
    const blocos = fs.readFileSync(conf, "utf8").split(/\n(?=\[Peer\])/);
    // o comentário do bloco é "# <tipo> <id> <nome>": o espaço depois do id evita que loja1 apague loja10
    const fica = blocos.filter((b) => !b.includes(`# ${tipo} ${id} `));
    if (fica.length === blocos.length) { console.error(`${tipo} ${id} não está cadastrado`); process.exit(1); }
    fs.writeFileSync(conf, fica.join("\n"));
    if (tipo === "loja" && fs.existsSync(lojas)) {
      const l = JSON.parse(fs.readFileSync(lojas, "utf8"));
      l.lojas = (l.lojas || []).filter((x) => x.id !== id);
      fs.writeFileSync(lojas, JSON.stringify(l, null, 2) + "\n");
    }' "$CONF" "$TIPO" "$ID" "$LOJAS"
  wg syncconf wg0 <(wg-quick strip wg0)
  rm -f "$WG/clientes/$TIPO-$ID.conf"
  [ "$TIPO" = loja ] && bash /opt/central/web.sh --atualizar
  echo "$TIPO $ID revogado: a chave dele não entra mais na VPN."
  exit 0
fi

TIPO=${1:-}; ID=${2:-}
case "$TIPO" in
  loja)     REDE=10.88.1; NOME=${3:-$ID}; PORTA=${4:-8080}; PERMITIDOS="10.88.0.1/32, 10.88.2.0/24" ;;
  operador) REDE=10.88.2; NOME=$ID; PERMITIDOS="10.88.0.0/16" ;;
  *) uso ;;
esac
valido "$ID"
SAIDA="$WG/clientes/$TIPO-$ID.conf"
[ -f "$SAIDA" ] && { echo "$TIPO $ID já existe ($SAIDA). Para refazer: remover e cadastrar de novo."; exit 1; }

# primeiro endereço livre da faixa
N=""
for i in $(seq 1 254); do
  grep -q "AllowedIPs = $REDE.$i/32" "$CONF" || { N=$i; break; }
done
[ -n "$N" ] || { echo "faixa $REDE.0/24 cheia"; exit 1; }
IP="$REDE.$N"

umask 077
PRIV=$(wg genkey)
PUB=$(echo "$PRIV" | wg pubkey)
cat >> "$CONF" <<EOF

[Peer]
# $TIPO $ID $NOME
PublicKey = $PUB
AllowedIPs = $IP/32
EOF
wg set wg0 peer "$PUB" allowed-ips "$IP/32"

cat > "$SAIDA" <<EOF
# VPN da central de operação — $TIPO $ID ($NOME)
[Interface]
PrivateKey = $PRIV
Address = $IP/32

[Peer]
PublicKey = $(cat "$WG/central.pub")
Endpoint = $(cat "$WG/endereco_publico"):51820
AllowedIPs = $PERMITIDOS
PersistentKeepalive = 25
EOF
umask 022
cp "$SAIDA" "/home/$dono/$TIPO-$ID.conf"
chown "$dono:" "/home/$dono/$TIPO-$ID.conf"
chmod 600 "/home/$dono/$TIPO-$ID.conf"

if [ "$TIPO" = loja ]; then
  node -e '
    const fs = require("fs"); const [arq, id, nome, ip, porta] = process.argv.slice(1);
    const l = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, "utf8")) : { lojas: [] };
    l.lojas = (l.lojas || []).filter((x) => x.id !== id).concat({ id, nome, ip, porta: Number(porta) });
    fs.writeFileSync(arq, JSON.stringify(l, null, 2) + "\n");' "$LOJAS" "$ID" "$NOME" "$IP" "$PORTA"
  # acesso pela internet ligado: a loja ganha o endereço dela (loja-<id>.<ip>.sslip.io)
  bash /opt/central/web.sh --atualizar
fi

echo "$TIPO $ID cadastrado em $IP"
echo "arquivo: /home/$dono/$TIPO-$ID.conf  (guarda a chave privada — trate como senha)"
if [ "$TIPO" = loja ]; then
  echo "leve para o mini PC da loja e instale com:"
  echo "  sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/$TIPO-$ID.conf"
else
  echo "importe no aplicativo WireGuard (wireguard.com/install) e ative o túnel;"
  echo "a central fica em http://10.88.0.1:8080"
fi
