#!/usr/bin/env bash
# Instala ou atualiza o supervisório num servidor Linux (Debian/Ubuntu), como serviço.
#
#   sudo bash tools/instalar-linux.sh                       # usa config.planta.json
#   sudo bash tools/instalar-linux.sh config.fx3u.json      # outra configuração
#   sudo bash tools/instalar-linux.sh config.planta.json --vpn ~/unidade-e01.conf
#                                      # e liga o gateway na VPN de manutenção (CENTRAL.md)
#
# Rode de dentro da pasta copiada do projeto. Na atualização, a configuração e o
# banco que já estão no servidor (dados/) são preservados — ver LINUX.md.
set -euo pipefail

DESTINO=/opt/supervisorio
USUARIO=supervisorio
SERVICO=supervisorio
CONFIG=config.planta.json
VPN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vpn) VPN="${2:-}"; shift 2 ;;
    *) CONFIG="$1"; shift ;;
  esac
done
ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"

falha() { echo "ERRO: $*" >&2; exit 1; }
passo() { echo; echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || falha "rode com sudo"
[ -z "$VPN" ] || [ -f "$VPN" ] || falha "arquivo da VPN não encontrado: $VPN"
[ -f "$ORIGEM/server.js" ] || falha "server.js não encontrado em $ORIGEM"
[ -f "$ORIGEM/$CONFIG" ] || [ -f "$DESTINO/$CONFIG" ] || falha "configuração $CONFIG não encontrada"

passo "Node.js"
command -v node >/dev/null || falha "Node.js não instalado — veja o passo 1 do LINUX.md"
MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAIOR" -ge 20 ] || falha "Node $(node -v) é antigo; precisa do 20 ou superior (LINUX.md, passo 1)"
NODE="$(readlink -f "$(command -v node)")"
case "$NODE" in
  /root/*|/home/*) falha "node em $NODE (nvm?): o serviço não enxerga /root nem /home — instale pelo NodeSource (LINUX.md, passo 1)";;
esac
echo "node $(node -v) em $NODE"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ]; then
  echo "ATENÇÃO: relógio sem sincronismo NTP — histórico e consumo por hora dependem da hora certa"
fi

passo "Usuário de serviço '$USUARIO'"
if ! id "$USUARIO" >/dev/null 2>&1; then
  useradd --system --home-dir "$DESTINO" --no-create-home --shell /usr/sbin/nologin "$USUARIO"
  echo "criado"
fi
usermod -aG dialout "$USUARIO"

passo "Arquivos em $DESTINO"
mkdir -p "$DESTINO/dados"
if [ "$ORIGEM" != "$DESTINO" ]; then
  # código, perfis e telas sempre substituídos; node_modules (binário do Windows)
  # e dados/ nunca vêm junto
  tar -C "$ORIGEM" --exclude=./node_modules --exclude=./dados --exclude='./config*.json' -cf - . \
    | tar -C "$DESTINO" -xf -
  # configuração: na atualização vale a do servidor (pode ter sido editada pela tela)
  for c in "$ORIGEM"/config*.json; do
    nome="$(basename "$c")"
    if [ -f "$DESTINO/$nome" ]; then
      if ! cmp -s "$c" "$DESTINO/$nome"; then
        cp "$c" "$DESTINO/$nome.nova"
        echo "mantida a $nome do servidor (a copiada ficou como $nome.nova)"
      fi
    else
      cp "$c" "$DESTINO/$nome"
    fi
  done
fi

passo "Dependências (npm ci)"
cd "$DESTINO"
ferramentas_de_compilacao() {
  command -v g++ >/dev/null && command -v make >/dev/null && command -v python3 >/dev/null && return 0
  echo "instalando compilador (build-essential, python3)…"
  apt-get update -q || echo "ATENÇÃO: apt-get update terminou com erro (algum repositório de terceiros); seguindo"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q build-essential python3 || true
}
# ARM de 32 bits (Banana Pi M1/M2, Raspberry Pi antigo): o banco (better-sqlite3)
# não tem binário pronto e é compilado na placa — leva de 5 a 15 minutos
case "$(uname -m)" in
  armv6l|armv7l)
    echo "processador $(uname -m): o módulo do banco será compilado aqui (5 a 15 min, não interrompa)"
    ferramentas_de_compilacao
    ;;
esac
if ! npm ci --omit=dev --no-audit --no-fund; then
  # sem binário pronto para esta placa: compila e tenta de novo
  ferramentas_de_compilacao
  npm ci --omit=dev --no-audit --no-fund || falha "não consegui instalar as dependências (veja a mensagem do npm acima)"
fi
# os dois módulos nativos: banco (better-sqlite3) e serial (bindings-cpp)
node -e "new (require('better-sqlite3'))(':memory:').close(); require('@serialport/bindings-cpp').autoDetect()" \
  || falha "módulos nativos não carregaram"
chown -R "$USUARIO:$USUARIO" "$DESTINO"

passo "Conferindo $CONFIG"
PORTAS="$(node -e "
const c=require('./$CONFIG');
const p=[...new Set((c.medidores||[]).map(m=>m.conexao&&m.conexao.porta_serial).filter(Boolean))];
console.log(p.join(' '));")"
for p in $PORTAS; do
  case "$p" in
    COM*|com*|'\\.\'*) echo "ATENÇÃO: $p é nome do Windows — troque pela porta Linux (LINUX.md, passo 4)";;
    *) [ -e "$p" ] && echo "ok  $p" || echo "ATENÇÃO: $p não existe agora (conversor desconectado ou nome errado)";;
  esac
done
HTTP="$(node -p "require('./$CONFIG').porta_http || 8080")"

if [ -n "$VPN" ]; then
  passo "VPN de manutenção"
  if ! command -v wg-quick >/dev/null; then
    # um repositório quebrado de outro programa (ex.: chave vencida do InfluxDB)
    # faz o "update" terminar com erro, mas as listas do Ubuntu atualizam mesmo assim
    apt-get update -q || echo "ATENÇÃO: apt-get update terminou com erro (algum repositório de terceiros); seguindo"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q wireguard-tools || true
    command -v wg-quick >/dev/null || falha "não consegui instalar o WireGuard — rode: sudo apt-get install -y wireguard-tools"
  fi
  mkdir -p /etc/wireguard
  install -m 600 -o root -g root "$VPN" /etc/wireguard/wg0.conf
  # o primeiro AllowedIPs do arquivo do gateway é o endereço da central (10.88.0.1/32)
  CENTRAL_IP="$(sed -n 's/^AllowedIPs *= *\([0-9.]*\)\/32.*/\1/p' /etc/wireguard/wg0.conf | head -n1)"
  [ -n "$CENTRAL_IP" ] || falha "não achei o endereço da central no arquivo da VPN"
  systemctl enable wg-quick@wg0 >/dev/null
  systemctl restart wg-quick@wg0
  # pela VPN chega só o técnico (a central bloqueia o resto): configurador e SSH
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    ufw allow in on wg0 to any port "$HTTP" proto tcp >/dev/null
    ufw allow in on wg0 to any port 22 proto tcp >/dev/null
  fi
  if ping -c 2 -W 3 "$CENTRAL_IP" >/dev/null 2>&1; then
    echo "central $CENTRAL_IP alcançável pela VPN"
  else
    echo "ATENÇÃO: a central $CENTRAL_IP ainda não respondeu. A porta UDP 51820 está liberada na Security List da Oracle?"
  fi
fi

passo "Serviço systemd"
sed -e "s#^ExecStart=.*#ExecStart=$NODE server.js --config $CONFIG#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$DESTINO#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=$DESTINO#" \
    "$DESTINO/supervisorio.service" > "/etc/systemd/system/$SERVICO.service"
systemctl daemon-reload
systemctl enable "$SERVICO" >/dev/null
INICIO="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart "$SERVICO"
sleep 3
systemctl is-active --quiet "$SERVICO" || { journalctl -u "$SERVICO" -n 40 --no-pager; falha "o serviço não subiu"; }

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  passo "Firewall (ufw): liberando a porta $HTTP"
  ufw allow "$HTTP/tcp" >/dev/null
fi

passo "Pronto"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Acesse: http://${IP:-<ip-do-servidor>}:$HTTP"
# só existe no primeiro start (banco sem admin); a troca é exigida no 1º login
SENHA="$(journalctl -u "$SERVICO" --since "$INICIO" --no-pager -o cat \
  | sed -n 's/.*Senha temporária: *\([^ ]*\).*/\1/p' | tail -n1 || true)"
[ -n "$SENHA" ] && echo "Primeiro acesso — usuário: admin   senha temporária: $SENHA"
echo
echo "Log ao vivo:  journalctl -u $SERVICO -f"
