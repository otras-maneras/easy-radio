#!/bin/sh
set -eu
# The generated secrets are hexadecimal; reject XML metacharacters in custom values.
case "$ICECAST_PASSWORD$ICECAST_ADMIN_PASSWORD" in
  *[!a-zA-Z0-9._-]*) echo 'Icecast passwords must use letters, digits, dots, underscores or hyphens.' >&2; exit 1 ;;
esac
# Keep generated credentials out of sticky /tmp. Reopening a file owned by
# icecast there is blocked by fs.protected_regular on subsequent starts.
mkdir -p /run/stream-radio
chmod 750 /run/stream-radio
chown root:icecast /run/stream-radio
envsubst '${ICECAST_PASSWORD} ${ICECAST_ADMIN_PASSWORD}' < /etc/icecast.xml.template > /run/stream-radio/icecast.xml
chmod 600 /run/stream-radio/icecast.xml
chown icecast2:icecast /run/stream-radio/icecast.xml
exec icecast2 -c /run/stream-radio/icecast.xml
