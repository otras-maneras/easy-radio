# Easy Radio

Una aplicación para levantar tu propio streaming de audio de forma simple. Sube tus canciones, organiza la lista y comparte una emisión continua desde un VPS.

Incluye un panel de administración para gestionar tu música y una página pública para escuchar la radio desde el navegador. La emisión sigue funcionando aunque cierres el panel.

## Qué puedes hacer

- Subir canciones arrastrando archivos o seleccionándolos desde tu equipo.
- Organizar la biblioteca, buscar por título o artista y cambiar el orden de reproducción.
- Mezclar la lista y reproducirla en bucle.
- Preescuchar canciones sin cambiar lo que escucha la audiencia.
- Iniciar o detener la emisión y saltar a la siguiente canción.
- Compartir un reproductor web o la URL directa del streaming.
- Consultar la canción actual y el número de oyentes conectados.

Acepta **MP3, FLAC, WAV, OGG y M4A**. La salida es una señal **MP3 estéreo a 128 kbps**, compatible con navegadores y reproductores como VLC.

## Empezar

Necesitas Docker con Compose y Node.js 22.13 o superior para generar la configuración inicial.

```bash
git clone https://github.com/otras-maneras/easy-radio.git
cd easy-radio
node scripts/setup.mjs
docker compose up -d --build
```

Abre **http://127.0.0.1:4173** y sigue estos pasos:

1. Pulsa **Administrar**.
2. Introduce la contraseña generada en `ADMIN_PASSWORD`, dentro de `.env`.
3. Sube tus canciones y elige el orden de la lista.
4. Pulsa **Iniciar emisión** si la estación está detenida.

El asistente crea contraseñas aleatorias y conserva tu configuración si `.env` ya existe. También puedes preparar ese archivo manualmente a partir de [`.env.example`](.env.example), sustituyendo todos los valores de ejemplo.

Si lo instalas en un VPS, puedes acceder al panel mediante un túnel SSH mientras configuras el dominio:

```bash
ssh -L 4173:127.0.0.1:4173 tu_usuario@tu_vps
```

## Compartir la radio

Al publicar la aplicación con un dominio tendrás dos enlaces:

| Enlace | Uso |
| --- | --- |
| `https://radio.tudominio.com` | Página pública con reproductor |
| `https://radio.tudominio.com/stream` | Audio MP3 continuo para reproductores externos |

Configura `PUBLIC_ORIGIN` en `.env` y utiliza un proxy inverso con HTTPS. La [guía de despliegue](docs/deployment.md) incluye un ejemplo con Caddy, configuración, copias de seguridad y actualizaciones.

## Cómo funciona

Easy Radio guarda la biblioteca y su configuración en SQLite. Liquidsoap reproduce las canciones y codifica la señal; Icecast la distribuye a quienes se conectan. Todos escuchan la misma emisión, con el pequeño desfase de sus reproductores.

Docker Compose levanta los tres servicios y conserva la música en un volumen persistente. La administración y los archivos originales requieren iniciar sesión; la emisión es pública.

Actualmente está pensado para una estación con una lista de reproducción automática.

## Configuración

Los valores predeterminados permiten empezar con una biblioteca pequeña e ir ajustando la instalación:

| Límite | Valor inicial |
| --- | --- |
| Tamaño por archivo | 50 MiB |
| Biblioteca | 5 GiB o 5.000 canciones |
| Subidas simultáneas | 2 |
| Oyentes simultáneos | 100 |

Puedes cambiar los límites de la aplicación en `.env`. Las variables disponibles están en [`.env.example`](.env.example); los límites de CPU y memoria están en [`compose.yaml`](compose.yaml).

Consulta [SECURITY.md](SECURITY.md) para conocer las medidas de seguridad y los aspectos pendientes de reforzar.

## Desarrollo y contribuciones

El panel y la API están escritos en TypeScript, con Node.js, Fastify y SQLite. La interfaz utiliza HTML y CSS.

Para desarrollar necesitas Node.js 22.13 o superior y FFmpeg con `ffprobe`:

```bash
npm ci
npm run setup
npm run build
npm run dev
```

Después de cambiar la interfaz, repite `npm run build`. Sin Icecast y Liquidsoap puedes trabajar en la biblioteca y la preescucha; para probar la emisión completa utiliza Docker Compose.

Para comprobar los cambios:

```bash
npm run typecheck
npm test
```

Las [pruebas de integración](docs/deployment.md#pruebas-de-integración) permiten verificar también el streaming y el navegador.

Las correcciones, mejoras de documentación y nuevas funciones son bienvenidas. Puedes abrir un issue para proponer un cambio o enviar una pull request explicando qué resuelve y cómo lo comprobaste.
