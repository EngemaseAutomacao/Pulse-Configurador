#!/usr/bin/env bash
# Lista de acessos da central pela linha de comando — para quando não dá para
# usar a tela Acessos (ex.: nenhum administrador consegue entrar).
#
#   sudo bash /opt/central/acesso.sh                          lista
#   sudo bash /opt/central/acesso.sh liberar <email>          operador
#   sudo bash /opt/central/acesso.sh liberar <email> admin    administrador
#   sudo bash /opt/central/acesso.sh remover <email>
#
# Vale na hora: o login Google relê a lista sozinho.
set -euo pipefail

ACESSO=/opt/central/acesso
EMAILS=$ACESSO/emails.txt
ADMINS=$ACESSO/administradores.txt
[ "$(id -u)" -eq 0 ] || { echo "rode com sudo"; exit 1; }
mkdir -p "$ACESSO"
touch "$EMAILS" "$ADMINS"

ACAO="${1:-listar}"
ALVO="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
registrar() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)  ${SUDO_USER:-root} (linha de comando)  $1  $ALVO" >> "$ACESSO/registro.log"; }
tirar() { grep -vxF "$ALVO" "$1" > "$1.tmp" || true; cat "$1.tmp" > "$1"; rm -f "$1.tmp"; }

case "$ACAO" in
  listar)
    if [ ! -s "$EMAILS" ]; then echo "nenhum e-mail com acesso"; exit 0; fi
    while read -r e; do
      [ -n "$e" ] || continue
      if grep -qxF "$e" "$ADMINS"; then echo "$e  (administrador)"; else echo "$e"; fi
    done < "$EMAILS"
    exit 0 ;;
  liberar)
    [[ "$ALVO" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$ ]] || { echo "e-mail inválido: '$ALVO'"; exit 1; }
    grep -qxF "$ALVO" "$EMAILS" || echo "$ALVO" >> "$EMAILS"
    if [ "${3:-}" = "admin" ]; then
      grep -qxF "$ALVO" "$ADMINS" || echo "$ALVO" >> "$ADMINS"
      registrar "liberou (administrador)"
    else
      tirar "$ADMINS"
      registrar "liberou"
    fi
    echo "$ALVO liberado" ;;
  remover)
    grep -qxF "$ALVO" "$EMAILS" || { echo "$ALVO não está na lista"; exit 1; }
    tirar "$ADMINS"
    tirar "$EMAILS"
    registrar "removeu"
    echo "$ALVO removido" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
# cat > arquivo (e não mv) mantém dono e permissões, e o aviso de alteração dispara
chown central:central "$EMAILS" "$ADMINS" "$ACESSO/registro.log" 2>/dev/null || true
chmod 640 "$EMAILS" "$ADMINS"
