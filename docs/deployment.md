# Despliegue y mantenimiento

Esta guía amplía el [inicio rápido](../README.md#empezar) con la publicación mediante un dominio, el almacenamiento y las tareas de mantenimiento.

## Dominio y HTTPS

Apunta el dominio a tu VPS y configura su origen exacto en `.env`, sin barra final:

```dotenv
PUBLIC_ORIGIN=https://radio.tudominio.com
```

La aplicación escucha en `127.0.0.1:4173`. Icecast y el puerto de control de Liquidsoap quedan dentro de la red privada de Docker; no necesitas exponerlos.

Con Caddy instalado en el host, añade un bloque como este a su configuración:

```caddyfile
radio.tudominio.com {
    encode zstd gzip

    request_body {
        max_size 55MB
    }

    handle /stream {
        reverse_proxy 127.0.0.1:4173 {
            flush_interval -1
        }
    }

    handle {
        reverse_proxy 127.0.0.1:4173
    }
}
```

Valida y recarga Caddy mediante el mecanismo de tu instalación. Reinicia la aplicación después de cambiar `.env`:

```bash
docker compose up -d --force-recreate app
```

La validación de origen requiere que el navegador use el `PUBLIC_ORIGIN` configurado. Sin esta variable se admite el origen HTTP del encabezado Host, útil para trabajar en local.

## Comportamiento de la emisión

Liquidsoap intenta iniciar la salida al arrancar. Si la biblioteca está vacía, la estación queda fuera del aire; al añadir canciones comienza la emisión. Detenerla cierra la salida de Icecast, pero mantiene los servicios funcionando. Reiniciar Liquidsoap vuelve a iniciar la salida.

Los cambios de biblioteca se aplican a las próximas canciones; puede haber una canción ya preparada. Mezclar genera un nuevo orden que se repite hasta que la biblioteca o el modo cambien. La preescucha del panel funciona de forma independiente.

`/stream` entrega audio mientras la estación emite y devuelve un estado de no disponibilidad cuando está detenida o vacía.

## Datos y copias de seguridad

La base de datos, la lista y las canciones se guardan en el volumen `stream-radio_radio-data`. El nombre cambia si utilizas otro nombre de proyecto de Compose.

Para hacer una copia consistente, detén los servicios durante la copia:

```bash
docker compose stop
mkdir -p backups
chmod 700 backups
docker run --rm \
  -v stream-radio_radio-data:/data:ro \
  -v "$PWD/backups:/backup" \
  debian:bookworm-slim \
  tar czf /backup/radio-data.tar.gz -C /data .
docker compose start
```

Conserva también una copia privada de `.env`. Comprueba periódicamente que puedes restaurar tus copias.

`docker compose stop` conserva los datos. `docker compose down -v` elimina el volumen y su contenido.

## Actualizaciones

Conserva una copia de seguridad antes de actualizar y revisa los cambios de configuración:

```bash
git pull --ff-only
docker compose up -d --build
```

Las instalaciones actuales ejecutan la API con UID/GID 1000. Si actualizas desde una versión que creó la biblioteca como root, migra sus permisos antes de levantar la nueva API:

```bash
docker compose build app
docker compose stop app
docker run --rm --network none --user 0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  -v stream-radio_radio-data:/data --entrypoint sh stream-radio-app \
  -c 'chown -R 1000:1000 /data && chmod 600 /data/radio.sqlite*'
docker compose up -d
```

Esta migración también es necesaria al restaurar archivos que hayan quedado con propietario root. Liquidsoap mantiene acceso de lectura a las canciones y la lista.

Cambiar `ADMIN_PASSWORD` o `SESSION_SECRET` y reiniciar la API invalida las sesiones existentes. Las sesiones caducan a las 12 horas o después de dos horas sin actividad autenticada.

## Recursos y diagnóstico

Como punto de partida, considera un VPS con 1 vCPU y 1 GB de RAM; 2 GB ofrecen más margen. El consumo real depende de los archivos y la audiencia. Los topes por contenedor están en [compose.yaml](../compose.yaml); son límites, no reservas.

La señal se codifica una sola vez. El tráfico de salida aumenta con cada oyente: a 128 kbps, cada uno consume aproximadamente 57,6 MB por hora, sin contar la sobrecarga del protocolo.

| Oyentes simultáneos | Salida de red aproximada |
| --- | --- |
| 1 | 0,128 Mbps |
| 10 | 1,28 Mbps |
| 100 | 12,8 Mbps |

Para consultar el estado, el consumo y los registros:

```bash
docker compose ps
docker stats --no-stream
docker compose logs --tail=100
```

Los registros Docker se rotan automáticamente. Mantén actualizados Node.js, las dependencias y las imágenes de los servicios. [SECURITY.md](../SECURITY.md) describe los controles actuales y sus límites.

## Pruebas de integración

Ejecuta estas pruebas en una instancia de desarrollo: crean archivos temporales y pueden cambiar el estado de la emisión.

```bash
npm run test:stream
```

La prueba de streaming carga un tono, verifica audio y metadatos, comprueba los controles, elimina el archivo y deja la emisión detenida.

Para comprobar la interfaz con Chromium:

```bash
npx playwright install chromium
npm run test:browser
```

Por defecto ambas pruebas utilizan `http://127.0.0.1:4173`. La variable `SMOKE_URL` permite indicar otra instancia; el origen debe coincidir con su configuración. Las credenciales se leen de `.env`.
