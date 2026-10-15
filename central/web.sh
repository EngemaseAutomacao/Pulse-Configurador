#!/usr/bin/env bash
# Acesso à central pela internet, sem VPN no aparelho do operador:
# HTTPS (Caddy) + login com conta Google (oauth2-proxy) + lista de e-mails.
#
#   sudo bash /opt/central/web.sh <seu-email>     primeira vez (você vira administrador)
#   sudo bash /opt/central/web.sh                 de novo: atualiza o oauth2-proxy e a configuração
#   sudo bash /opt/central/web.sh --atualizar     só reescreve os endereços das lojas (vpn-novo.sh chama)
#
# Antes da primeira vez (CENTRAL.md, "Acesso pela internet"):
#   - credencial OAuth criada no Google Cloud (o script pede o Client ID e o secret);
#   - portas TCP 80 e 443 liberadas na Security List da Oracle.
# A lista de e-mails é mantida entre execuções; quem cuida dela é a tela
# Acessos da central (ou /opt/central/acesso.sh).
set -euo pipefail

DESTINO=/opt/central
ACESSO=$DESTINO/acesso
CFG=/etc/oauth2-proxy/oauth2-proxy.cfg
[ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
[ -f "$DESTINO/servidor.js" ] || { echo "central não montada: rode antes central/montar-vm.sh"; exit 1; }
passo() { echo; echo "==> $*"; }
falha() { echo "ERRO: $*" >&2; exit 1; }

# endereços das lojas no Caddy, a partir de lojas.json (Caddyfile só troca se for válido)
caddy_atualizar() {
  node "$DESTINO/web.js" > /etc/caddy/Caddyfile.novo
  if ! caddy validate --config /etc/caddy/Caddyfile.novo --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config /etc/caddy/Caddyfile.novo --adapter caddyfile || true
    falha "configuração do Caddy inválida; a anterior foi mantida"
  fi
  mv /etc/caddy/Caddyfile.novo /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

if [ "${1:-}" = "--atualizar" ]; then
  [ -f "$DESTINO/web.json" ] && command -v caddy >/dev/null || exit 0   # acesso web não ligado: nada a fazer
  caddy_atualizar
  echo "endereços das lojas atualizados no Caddy"
  exit 0
fi

grep -q CENTRAL_PROXY_PORTA /etc/systemd/system/central.service \
  || falha "a central instalada é de uma versão anterior: rode antes 'sudo bash central/montar-vm.sh <IP>' com o pacote novo"

ADMIN="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
PUBLICO="$(cat /etc/wireguard/endereco_publico)"
RE_IP='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
[[ "$PUBLICO" =~ $RE_IP ]] || falha "IP público inválido em /etc/wireguard/endereco_publico: $PUBLICO"
BASE="${PUBLICO//./-}.sslip.io"
CENTRAL="central.$BASE"

passo "Lista de acessos ($ACESSO)"
mkdir -p "$ACESSO"
touch "$ACESSO/emails.txt" "$ACESSO/administradores.txt"
if [ -n "$ADMIN" ]; then
  [[ "$ADMIN" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$ ]] || falha "e-mail inválido: $ADMIN"
  grep -qxF "$ADMIN" "$ACESSO/emails.txt" || echo "$ADMIN" >> "$ACESSO/emails.txt"
  grep -qxF "$ADMIN" "$ACESSO/administradores.txt" || echo "$ADMIN" >> "$ACESSO/administradores.txt"
fi
[ -s "$ACESSO/administradores.txt" ] || falha "nenhum administrador cadastrado. Rode: sudo bash $DESTINO/web.sh <seu-email>"
chown -R central:central "$ACESSO"
chmod 750 "$ACESSO"
chmod 640 "$ACESSO"/*
echo "administradores: $(paste -sd ' ' "$ACESSO/administradores.txt")"

passo "Credencial do Google"
if [ -f "$CFG" ]; then
  CLIENT_ID="$(sed -n 's/^client_id *= *"\(.*\)"/\1/p' "$CFG")"
  CLIENT_SECRET="$(sed -n 's/^client_secret *= *"\(.*\)"/\1/p' "$CFG")"
  COOKIE_SECRET="$(sed -n 's/^cookie_secret *= *"\(.*\)"/\1/p' "$CFG")"
fi
if [ -z "${CLIENT_ID:-}" ] || [ -z "${CLIENT_SECRET:-}" ]; then
  echo "Cole os dados da credencial criada no Google Cloud (CENTRAL.md, passo B)."
  read -rp  "Client ID: " CLIENT_ID
  read -rsp "Client secret (não aparece ao digitar): " CLIENT_SECRET; echo
fi
[[ "$CLIENT_ID" == *.apps.googleusercontent.com ]] || falha "Client ID deve terminar em .apps.googleusercontent.com"
[ -n "$CLIENT_SECRET" ] || falha "Client secret vazio"
# 32 caracteres = chave de 32 bytes que cifra o cookie de login; trocar derruba todas as sessões
COOKIE_SECRET="${COOKIE_SECRET:-$(openssl rand -hex 16)}"
echo "ok (Client ID ${CLIENT_ID%%-*}…)"

passo "Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -q gnupg curl
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q || echo "ATENÇÃO: apt-get update terminou com erro; seguindo"
  apt-get install -y -q caddy
fi
caddy version | head -n1

passo "oauth2-proxy (login Google)"
case "$(uname -m)" in
  x86_64) ARQ=amd64 ;; aarch64) ARQ=arm64 ;; armv7l) ARQ=armv7 ;; *) falha "processador $(uname -m) não previsto" ;;
esac
TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/oauth2-proxy/oauth2-proxy/releases/latest | sed 's#.*/tag/##')"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || falha "não consegui saber a versão atual do oauth2-proxy (GitHub fora do ar?): '$TAG'"
if command -v oauth2-proxy >/dev/null && oauth2-proxy --version 2>&1 | grep -qF "$TAG"; then
  echo "oauth2-proxy $TAG já instalado"
else
  NOME="oauth2-proxy-$TAG.linux-$ARQ"
  URL="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/$TAG/$NOME.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/o.tgz" || falha "download do oauth2-proxy falhou: $URL"
  curl -fsSL "$URL-sha256sum.txt" -o "$TMP/o.sha" || falha "não achei a soma de verificação do oauth2-proxy"
  [ "$(awk '{print $1; exit}' "$TMP/o.sha")" = "$(sha256sum "$TMP/o.tgz" | awk '{print $1}')" ] \
    || falha "soma de verificação do oauth2-proxy NÃO confere — download corrompido ou adulterado"
  tar -xzf "$TMP/o.tgz" -C "$TMP"
  install -m 755 "$TMP/$NOME/oauth2-proxy" /usr/local/bin/oauth2-proxy
  rm -rf "$TMP"
  echo "oauth2-proxy $TAG instalado (soma de verificação conferida)"
fi
id oauth2-proxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin oauth2-proxy
usermod -aG central oauth2-proxy        # lê a lista de e-mails (grupo central, só leitura)

mkdir -p /etc/oauth2-proxy
umask 027
cat > "$CFG" <<EOF
# Gerado por /opt/central/web.sh — guarda o segredo da credencial do Google
provider = "google"
client_id = "$CLIENT_ID"
client_secret = "$CLIENT_SECRET"
redirect_url = "https://$CENTRAL/oauth2/callback"

# só os e-mails desta lista entram (a tela Acessos da central escreve nela)
authenticated_emails_file = "$ACESSO/emails.txt"

cookie_secret = "$COOKIE_SECRET"
cookie_name = "_central_login"
cookie_domains = [".$BASE"]
whitelist_domains = [".$BASE"]
cookie_secure = true
cookie_expire = "12h"

http_address = "127.0.0.1:4180"
reverse_proxy = true
set_xauthrequest = true
skip_provider_button = true
upstreams = ["static://202"]
EOF
umask 022
chown root:oauth2-proxy "$CFG"
chmod 640 "$CFG"

cat > /etc/systemd/system/oauth2-proxy.service <<EOF
[Unit]
Description=Login Google da central de operacao (oauth2-proxy)
After=network-online.target
Wants=network-online.target

[Service]
User=oauth2-proxy
Group=oauth2-proxy
ExecStart=/usr/local/bin/oauth2-proxy --config=$CFG
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
# lista alterada (tela Acessos ou acesso.sh) → o oauth2-proxy relê na hora
cat > /etc/systemd/system/oauth2-proxy-lista.path <<EOF
[Unit]
Description=Lista de acessos da central alterada

[Path]
PathChanged=$ACESSO/emails.txt

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/oauth2-proxy-lista.service <<EOF
[Unit]
Description=Recarrega o login Google com a lista nova

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart oauth2-proxy.service
EOF

passo "Central atrás do login"
printf '{ "base": "%s" }\n' "$BASE" > "$DESTINO/web.json"
chown central:central "$DESTINO/web.json"
systemctl daemon-reload
systemctl enable oauth2-proxy oauth2-proxy-lista.path >/dev/null
systemctl restart oauth2-proxy
systemctl restart oauth2-proxy-lista.path
systemctl restart central       # passa a abrir a porta 127.0.0.1:8081 (web.json existe)

passo "Firewall: portas 80 e 443"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
netfilter-persistent save >/dev/null

passo "Endereços no Caddy"
caddy_atualizar
systemctl enable caddy >/dev/null

passo "Testando https://$CENTRAL"
# o primeiro certificado leva alguns segundos; sem login, a resposta é um
# redirecionamento para o Google
for i in $(seq 1 20); do
  CODIGO="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$CENTRAL/" || true)"
  [ "$CODIGO" = "302" ] && break
  sleep 3
done
for s in oauth2-proxy central caddy; do
  systemctl is-active --quiet "$s" || { journalctl -u "$s" -n 25 --no-pager; falha "o serviço $s não está no ar"; }
done
if [ "${CODIGO:-}" = "302" ]; then
  echo "ok: HTTPS no ar e pedindo login"
else
  echo "ATENÇÃO: https://$CENTRAL ainda não respondeu (código ${CODIGO:-nenhum})."
  echo "  - as portas TCP 80 e 443 estão liberadas na Security List da Oracle?"
  echo "  - certificado: journalctl -u caddy -n 50 --no-pager"
fi

passo "Pronto"
echo "Central:  https://$CENTRAL"
echo "Acessos:  https://$CENTRAL/acessos   (cadastre os outros e-mails por lá)"
echo
echo "Confira no Google Cloud que a credencial tem EXATAMENTE este endereço em"
echo "'URIs de redirecionamento autorizados':"
echo "  https://$CENTRAL/oauth2/callback"
