# Frecuencia

Una radio automática para un VPS, con biblioteca privada y una página pública para escuchar. Interfaz oscura inspirada en Spotify, adaptable a móvil, sin framework de frontend ni servicios externos.

## Instancia publicada

- Web: https://radio.otrasmaneras.com
- Emisión MP3 continua: https://radio.otrasmaneras.com/stream
- Proxy: Caddy en el host → aplicación en `127.0.0.1:4173` → Icecast en la red privada de Docker.
- DNS público: Cloudflare. Caddy administra el certificado HTTPS del origen.
- Configuración: `deploy/caddy/radio.caddy`, importada desde `/etc/caddy/Caddyfile`.
- `PUBLIC_ORIGIN` de la instancia: `https://radio.otrasmaneras.com`.

Entra en **Administrar**, carga canciones y pulsa **Iniciar emisión**. `/stream` devuelve audio mientras la estación emite y un estado de no disponibilidad cuando está detenida o vacía. Los oyentes escuchan la misma emisión continua, con el pequeño desfase de sus buffers; la preescucha de la biblioteca es privada y no cambia esa emisión.

Caddy tiene la API de administración desactivada en este VPS. Tras validar la configuración con `caddy validate --config /etc/caddy/Caddyfile`, se recarga mediante `systemctl kill --kill-who=main --signal=SIGUSR1 caddy`.

## Arranque con Docker

Requisitos: Docker Engine con Compose. Para desarrollar sin Docker: Node.js 22.13 o superior y FFmpeg/ffprobe.

```bash
node scripts/setup.mjs
docker compose up -d --build
```

Abre `http://127.0.0.1:4173`. En un VPS puedes acceder mediante un túnel desde tu ordenador:

```bash
ssh -L 4173:127.0.0.1:4173 tu_usuario@tu_vps
```

Abre entonces `http://localhost:4173` en tu navegador. Pulsa **Administrar** e introduce el valor de `ADMIN_PASSWORD` del archivo `.env`. El asistente genera secretos aleatorios y no sobrescribe una configuración existente.

La aplicación escucha solamente en loopback. Icecast y el puerto de control de Liquidsoap quedan dentro de la red de Docker. La emisión pública pasa por `/stream`; no hace falta exponer sus puertos.

## Qué incluye

- Carga múltiple y arrastrar archivos; se procesan uno a uno para limitar memoria.
- MP3, FLAC, WAV, OGG y M4A; hasta 50 MB por archivo, con validación mediante ffprobe.
- Metadatos de título, artista y duración; búsqueda en la biblioteca.
- Reordenar, mezclar la lista y eliminar canciones.
- Preescucha privada independiente de la emisión pública.
- Emisión MP3 estéreo a 128 kbps, repetición de la lista y controles de inicio, parada y salto.
- Estado de conexión, canción actual y oyentes consultados a Icecast.
- Contraseña de administración, cookie HttpOnly, validación de origen y límite de intentos de acceso.
- Sesiones revocables en el servidor, con caducidad absoluta y por inactividad.
- API sin root, raíz de contenedor en solo lectura y límites de CPU, memoria, procesos, subidas y oyentes.
- SQLite en modo WAL y archivos persistentes en el volumen `stream-radio_radio-data`.

Liquidsoap arranca la salida automáticamente con Docker. Si la biblioteca está vacía, la estación queda fuera del aire; al añadir canciones se incorporan a la lista y comienza la emisión. Detener la emisión cierra la salida de Icecast, pero los servicios siguen funcionando. Reiniciar Liquidsoap vuelve a iniciar la salida.

La API recarga la lista en Liquidsoap después de cada cambio de biblioteca. Los cambios se aplican a las próximas canciones; puede haber una canción ya preparada por Liquidsoap. Al iniciar una emisión se recarga la lista y se descarta la referencia de reproducción anterior. Mezclar genera un nuevo orden y lo repite hasta que la biblioteca o el modo cambien. Esta primera versión tiene una única lista; no incluye horarios, micrófono ni mezcla entre canciones.

## Desarrollo

```bash
npm ci
npm run setup
npm run typecheck
npm run build
npm test
npm run dev
```

Para comprobar la pila completa en ejecución, `npm run test:stream` carga un tono temporal, verifica audio y metadatos, prueba salto/parada/inicio, elimina el tono y deja la emisión detenida. `npm run test:browser` comprueba acceso, carga, búsqueda, preescucha y diseño en escritorio/móvil; requiere instalar Chromium con `npx playwright install chromium`. Estas comprobaciones son para una instancia de desarrollo.

El servidor de desarrollo usa los archivos de `dist/public`; repite `npm run build` tras cambiar la interfaz. Sin Icecast y Liquidsoap, puedes gestionar y preescuchar la biblioteca; el estado indica que la emisión no está conectada.

## Publicación con dominio y HTTPS

Configura `PUBLIC_ORIGIN=https://radio.tudominio.com` en `.env`, apunta el dominio a tu VPS y utiliza un proxy inverso con TLS. Reinicia la aplicación tras cambiar `.env`:

```bash
docker compose up -d --force-recreate app
```

Ejemplo de bloque para un Nginx que ya gestione el certificado TLS:

```nginx
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 51m;
    proxy_read_timeout 1h;
}
location = /stream {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

La validación de origen requiere que el navegador use exactamente el `PUBLIC_ORIGIN` configurado. Sin esta variable, se admite el origen HTTP del encabezado Host. Para instalar varios proyectos en el mismo servidor, usa un subdominio para esta radio.

## Tamaño y recursos

La interfaz pesa aproximadamente 45 KB sin compresión, excluyendo mapas de código. Los servicios y sus dependencias ocupan bastante más; `docker image ls` muestra los tamaños de las imágenes y `docker system df` distingue el espacio compartido.

Presupuesto inicial, pendiente de medir con tu biblioteca y audiencia: 1 vCPU y 1 GB RAM; 2 GB ofrecen más margen. El consumo depende del decodificador, la codificación, los archivos y el número de oyentes. Los servicios codifican una sola emisión para todos.

Medición de desarrollo del 22/10/2026: aproximadamente 140 MiB de RAM entre los tres contenedores durante una prueba corta con audio sintético y sin audiencia real. CPU observada durante esa prueba: aproximadamente 6 % de un núcleo en total. No es una prueba de carga. Las imágenes construidas ocupan aproximadamente 708 MB (aplicación con FFmpeg) y 615 MB (imagen compartida por Icecast y Liquidsoap), antes de descontar capas compartidas.

A 128 kbps, sin contar sobrecarga del protocolo:

| Oyentes simultáneos | Salida de red | Tráfico en 30 días continuos |
| --- | --- | --- |
| 1 | 0,128 Mbps | 41,5 GB |
| 10 | 1,28 Mbps | 414,7 GB |
| 100 | 12,8 Mbps | 4,15 TB |

1.000 canciones de cuatro minutos a 192 kbps ocupan aproximadamente 5,76 GB. La biblioteca original se conserva; la emisión se convierte a 128 kbps en tiempo real.

```bash
docker stats --no-stream
docker compose logs --tail=100
```

## Datos y mantenimiento

Los registros Docker se rotan automáticamente. No ejecutes `docker compose down -v` si quieres conservar la biblioteca.

Para una copia consistente del volumen, detén los servicios durante la copia:

```bash
docker compose stop
mkdir -p backups
docker run --rm -v stream-radio_radio-data:/data:ro -v "$PWD/backups:/backup" debian:bookworm-slim tar czf /backup/radio-data.tar.gz -C /data .
docker compose start
```

Conserva también `.env` de forma privada. Las imágenes se basan en las ramas mantenidas Node 22 y Debian Bookworm; el archivo `package-lock.json` fija las dependencias de la aplicación. Actualiza y vuelve a construir periódicamente.

## Límites y actualización de instalaciones anteriores

Consulta [SECURITY.md](SECURITY.md) para los controles y sus límites. Por defecto se admiten dos subidas simultáneas, 100 oyentes, cuatro preescuchas y una biblioteca de hasta 5 GiB o 5.000 canciones. Los valores configurables aparecen en `.env.example`. Las subidas que excedan un límite se rechazan y se eliminan sus archivos parciales. Los límites de memoria/CPU de `compose.yaml` son topes, no recursos reservados.

Cerrar sesión invalida también cualquier copia de esa cookie. Las sesiones duran como máximo 12 horas y caducan tras dos horas sin actividad autenticada. Cambiar `ADMIN_PASSWORD` o `SESSION_SECRET` y reiniciar la aplicación invalida las sesiones existentes. Al actualizar desde la versión inicial hay que iniciar sesión de nuevo; la contraseña no cambia.

El contenedor de la API utiliza el UID/GID 1000 y las instalaciones nuevas reciben el volumen con ese propietario. Para una biblioteca existente creada por la versión que se ejecutaba como root, haz una copia de seguridad y migra sus permisos antes de levantar la nueva API:

```bash
docker compose build app
docker compose stop app
docker run --rm --network none --user 0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  -v stream-radio_radio-data:/data --entrypoint sh stream-radio-app \
  -c 'chown -R 1000:1000 /data && chmod 600 /data/radio.sqlite*'
docker compose up -d
```

El cambio afecta solo al volumen de esta radio. Liquidsoap conserva acceso de lectura a las canciones y a la lista. Esta misma migración de propietario es necesaria al restaurar una copia antigua que haya guardado archivos propiedad de root.
