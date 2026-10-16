#!/usr/bin/env bash
# Cadastra, lista ou revoga um gateway (unidade) ou um técnico na VPN de manutenção.
#
#   sudo bash /opt/central/vpn-novo.sh unidade <id> "<Nome da unidade>"
#   sudo bash /opt/central/vpn-novo.sh tecnico <nome>
#   sudo bash /opt/central/vpn-novo.sh listar                    (endereço e último contato de cada um)
#   sudo bash /opt/central/vpn-novo.sh remover unidade <id>      (gateway roubado, unidade encerrada)
#   sudo bash /opt/central/vpn-novo.sh remover tecnico <nome>    (técnico saiu da empresa)
#
# Gera o arquivo .conf do WireGuard que vai para o equipamento:
#   unidade → copiar para o gateway e instalar com tools/instalar-linux.sh --vpn
#   tecnico → importar no aplicativo WireGuard do Windows/celular
# Cada um tem a sua própria chave: revogar um não afeta os outros.
# "loja" e "operador" (nomes antigos) continuam valendo.
set -euo pipefail

WG=${WG_DIR:-/etc/wireguard}
CONF=$WG/wg0.conf
# WG_DIR só nos testes (pasta de mentira, sem root)
[ -n "${WG_DIR:-}" ] || [ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
[ -f "$CONF" ] || { echo "VPN da central não montada (rode central/montar-vm.sh)"; exit 1; }
uso() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
valido() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] || { echo "id inválido: '$1' (minúsculas, números, - e _)"; exit 1; }; }
# nome antigo → nome atual
tipo_de() { case "$1" in unidade|loja) echo unidade ;; tecnico|técnico|operador) echo tecnico ;; *) echo "" ;; esac; }
dono=${SUDO_USER:-ubuntu}
COPIA=${COPIA_DIR:-/home/$dono}

# Blocos [Peer] do wg0.conf: "tipo<TAB>id<TAB>ip<TAB>chave<TAB>nome", com o tipo já no nome atual.
pares() {
  awk '
    function sai() { if (chave != "") printf "%s\t%s\t%s\t%s\t%s\n", tipo, id, ip, chave, nome; tipo = id = ip = chave = nome = "" }
    /^\[Peer\]/ { sai(); dentro = 1; next }
    /^\[/ { sai(); dentro = 0; next }
    dentro && /^# / {
      n = split(substr($0, 3), p, " ")
      tipo = (p[1] == "loja" || p[1] == "unidade") ? "unidade" : (p[1] == "operador" || p[1] == "tecnico") ? "tecnico" : p[1]
      id = p[2]; nome = ""
      for (i = 3; i <= n; i++) nome = nome (i > 3 ? " " : "") p[i]
      next
    }
    dentro && /^PublicKey/ { sub(/^PublicKey *= */, ""); chave = $0; next }
    dentro && /^AllowedIPs/ { sub(/^AllowedIPs *= */, ""); sub(/\/32.*/, ""); ip = $0; next }
    END { sai() }
  ' "$CONF"
}

if [ "${1:-}" = "listar" ]; then
  agora=$(date +%s)
  declare -A contato=()
  while IFS=$'\t' read -r chave quando; do contato[$chave]=$quando; done < <(wg show wg0 latest-handshakes 2>/dev/null || true)
  # (o "Ç" ocupa 2 bytes e o printf conta bytes: a coluna do cabeçalho leva um a mais)
  printf '%-8s %-16s %-13s %-28s %s\n' TIPO ID ENDEREÇO NOME "ÚLTIMO CONTATO"
  while IFS=$'\t' read -r tipo id ip chave nome; do
    q=${contato[$chave]:-0}
    if [ "$q" -eq 0 ]; then visto="nunca"
    else
      s=$((agora - q))
      if [ "$s" -lt 180 ]; then visto="conectado"
      elif [ "$s" -lt 7200 ]; then visto="há $((s / 60)) min"
      elif [ "$s" -lt 172800 ]; then visto="há $((s / 3600)) h"
      else visto="há $((s / 86400)) dias"; fi
    fi
    printf '%-8s %-16s %-12s %-28s %s\n' "$tipo" "$id" "$ip" "${nome:0:28}" "$visto"
  done < <(pares | sort -t$'\t' -k1,1 -k3,3V)
  exit 0
fi

if [ "${1:-}" = "remover" ]; then
  TIPO=$(tipo_de "${2:-}"); ID=${3:-}
  [ -n "$TIPO" ] || uso
  valido "$ID"
  CHAVE=$(pares | awk -F'\t' -v t="$TIPO" -v i="$ID" '$1 == t && $2 == i { print $4 }')
  [ -n "$CHAVE" ] || { echo "$TIPO $ID não está cadastrado"; exit 1; }
  # tira o bloco [Peer] com essa chave (comentário e linhas em branco junto)
  # (index, não expressão regular: a chave tem "+" e "/")
  awk -v chave="$CHAVE" '
    function despeja() { if (bloco != "" && !index(bloco, "PublicKey = " chave "\n")) printf "%s", bloco; bloco = "" }
    /^\[Peer\]/ { despeja() }
    { bloco = bloco $0 "\n" }
    END { despeja() }
  ' "$CONF" > "$CONF.novo"
  # linhas em branco seguidas viram uma só
  cat -s "$CONF.novo" > "$CONF" && rm -f "$CONF.novo"
  chmod 600 "$CONF"
  wg set wg0 peer "$CHAVE" remove 2>/dev/null || true
  ANTIGO=$([ "$TIPO" = unidade ] && echo loja || echo operador)   # arquivo com o nome antigo
  rm -f "$WG/clientes/$TIPO-$ID.conf" "$WG/clientes/$ANTIGO-$ID.conf"
  echo "$TIPO $ID revogado: a chave dele não entra mais na VPN."
  exit 0
fi

TIPO=$(tipo_de "${1:-}"); ID=${2:-}
case "$TIPO" in
  # o gateway só alcança a central e os técnicos (que é quem abre o SSH e o configurador nele)
  unidade) REDE=10.88.1; NOME=${3:-$ID}; PERMITIDOS="10.88.0.1/32, 10.88.2.0/24" ;;
  tecnico) REDE=10.88.2; NOME=$ID; PERMITIDOS="10.88.0.0/16" ;;
  *) uso ;;
esac
valido "$ID"
[ -z "$(pares | awk -F'\t' -v t="$TIPO" -v i="$ID" '$1 == t && $2 == i')" ] \
  || { echo "$TIPO $ID já existe. Para refazer: remover e cadastrar de novo."; exit 1; }
SAIDA="$WG/clientes/$TIPO-$ID.conf"
mkdir -p "$WG/clientes"

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
# VPN de manutenção — $TIPO $ID ($NOME)
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
cp "$SAIDA" "$COPIA/$TIPO-$ID.conf"
chown "$dono:" "$COPIA/$TIPO-$ID.conf"
chmod 600 "$COPIA/$TIPO-$ID.conf"

echo "$TIPO $ID cadastrado em $IP"
echo "arquivo: $COPIA/$TIPO-$ID.conf  (guarda a chave privada — trate como senha)"
if [ "$TIPO" = unidade ]; then
  echo "leve para o gateway da unidade e instale com:"
  echo "  sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/$TIPO-$ID.conf"
  echo "depois, com o túnel do técnico ligado: ssh usuario@$IP  ·  http://$IP:8080"
else
  echo "importe no aplicativo WireGuard (wireguard.com/install) e ative o túnel;"
  echo "os gateways ficam em 10.88.1.x (sudo bash /opt/central/vpn-novo.sh listar)"
fi
