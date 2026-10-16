#!/usr/bin/env bash
# Backup das chaves e do cadastro da VPN (cron diário, 3h30).
# Fica em /home/<usuário>/backup-central/ — baixe de vez em quando para fora da nuvem:
#   scp ubuntu@<IP>:backup-central/central-*.tgz .
# Com este arquivo e o pacote do projeto, a VPN volta em outra VM sem precisar
# reconfigurar nenhum gateway nem técnico (as chaves são as mesmas).
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
tar -czf "$arq" -C / etc/wireguard
chown -R "$dono:" "$dir"
chmod 700 "$dir"
chmod 600 "$dir"/*.tgz
# guarda os 14 mais recentes
ls -1t "$dir"/central-*.tgz | tail -n +15 | xargs -r rm -f
echo "backup: $arq"
