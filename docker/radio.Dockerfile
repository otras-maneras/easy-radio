FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends icecast2 liquidsoap gettext-base ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker/icecast.xml.template /etc/icecast.xml.template
COPY docker/radio.liq /etc/radio.liq
COPY docker/icecast-entrypoint.sh /usr/local/bin/start-icecast
RUN chmod +x /usr/local/bin/start-icecast && mkdir -p /var/log/icecast2 && chown icecast2:icecast /var/log/icecast2
