#!/bin/sh
set -eu
used=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
if [ "${used}" -ge 90 ]; then
  echo "DISK_ALERT: ${used}%"
fi
