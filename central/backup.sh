#!/usr/bin/env bash
# Backup das chaves da VPN, do cadastro de lojas e da lista de acessos da
# central (cron diário, 3h30).
# Fica em /home/<usuário>/backup-central/ — baixe de vez em quando para fora da nuvem:
#   scp ubuntu@<IP>:backup-central/central-*.tgz .
# Com este arquivo e o pacote do projeto, a central volta em outra VM sem
# precisar reconfigurar nenhuma loja (as chaves são as mesmas).
set -euo pipefail
# o usuário com que se entra por SSH: "ubuntu" na imagem da Oracle (que também
# tem um "opc" com uid 1000); em outra imagem, o primeiro usuário comum
if id ubuntu >/dev/null 2>&1; then
  dono=ubuntu
else
  dono=$(getent passwd 1000 | cut -d: -f1)
  dono=${dono:-root}
fi
dir="/home/$dono/backup-central"
mkdir -p "$dir"
arq="$dir/central-$(date +%Y%m%d).tgz"
# só o que existe: sem o acesso web ligado não há lista de e-mails nem oauth2-proxy
itens=""
for p in etc/wireguard opt/central/lojas.json opt/central/web.json opt/central/acesso etc/oauth2-proxy; do
  if [ -e "/$p" ]; then itens="$itens $p"; fi
done
# shellcheck disable=SC2086  # caminhos fixos, sem espaço
tar -czf "$arq" -C / $itens
chown -R "$dono:" "$dir"
chmod 700 "$dir"
chmod 600 "$dir"/*.tgz
# guarda os 14 mais recentes
ls -1t "$dir"/central-*.tgz | tail -n +15 | xargs -r rm -f
echo "backup: $arq"
