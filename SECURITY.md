# Revisión de seguridad — 22/10/2026

Revisión del código, pruebas de acceso y configuración desplegada. No sustituye una auditoría independiente ni una prueba de penetración completa.

## Corregido en esta revisión

Se encontró una omisión de autenticación mediante segmentos de ruta codificados. Fastify resolvía la ruta, pero la comprobación de acceso usaba la URL sin normalizar. La autorización usa ahora la ruta reconocida por el router. Se añadieron pruebas para lectura, carga, borrado, orden, modo aleatorio y controles de emisión; las variantes codificadas se rechazan sin sesión.

La corrección se desplegó y se verificó mediante el dominio público. No se investigó el historial completo del servidor para determinar si el fallo fue explotado anteriormente.

## Controles existentes comprobados

- HTTPS y HSTS mediante Caddy.
- Cookies firmadas con caducidad de 12 horas, HttpOnly, Secure en HTTPS y SameSite=Strict.
- Sesiones registradas en SQLite mediante un hash del token. Cerrar sesión revoca el token en el servidor; cambiar la contraseña o el secreto invalida todas las sesiones al reiniciar. Caducidad por inactividad de dos horas y máximo de veinte sesiones.
- Validación del encabezado Origin en operaciones de escritura.
- Límite de seis intentos de inicio de sesión por minuto en el limitador actual.
- Carga autenticada, extensión permitida, nombre UUID, límite de 50 MiB y análisis con ffprobe con tiempo máximo de 15 segundos.
- ffprobe solo admite protocolos de archivo local y los demultiplexores MP3, OGG, FLAC, WAV y M4A/MP4. Recibe un entorno sin las contraseñas del servidor y se termina con SIGKILL si supera el tiempo de análisis.
- La API y ffprobe se ejecutan como UID 1000. La API y Liquidsoap tienen el sistema de archivos raíz en solo lectura, sin capacidades Linux y sin posibilidad de adquirir nuevos privilegios. Solo la API escribe en el volumen de datos; Liquidsoap lo monta en solo lectura.
- Límites de memoria, CPU y procesos por contenedor; límites de subidas, biblioteca y conexiones en la aplicación.
- SQL parametrizado y escape de metadatos al mostrar HTML.
- Archivo .env con permisos 0600; no se sirve desde la raíz pública.
- API vinculada a loopback en el host; Icecast y el control de Liquidsoap no publican puertos del host.
- Los archivos de preescucha mantienen `Cache-Control: no-store`; pausar la escucha en directo cierra la conexión y libera su plaza.
- npm audit --omit=dev: cero vulnerabilidades conocidas de dependencias JavaScript en el momento de la revisión.

## Pendiente de reforzar

1. Automatizar copias de seguridad periódicas de la biblioteca y la base de datos y comprobar su restauración. Se conserva una copia verificada anterior al refuerzo.
2. Mantener y analizar las imágenes y paquetes del sistema. npm audit no cubre Node, FFmpeg, Icecast, Liquidsoap, Debian ni Caddy.
3. Considerar un proceso/contenedor de análisis separado con aislamiento de red y archivos para archivos no confiables. La reducción de privilegios y los filtros actuales no sustituyen ese aislamiento.
4. Revisar con pruebas de carga los límites según la audiencia prevista. El límite de oyentes acota la transferencia simultánea; no hay una cuota mensual de tráfico ni una garantía contra ataques de denegación de servicio.

La emisión es pública por diseño; la administración y los archivos originales de la biblioteca requieren sesión.

## Límites de la configuración predeterminada

| Servicio | RAM máxima | CPU máxima | Procesos/hilos máximos |
| --- | --- | --- | --- |
| API y ffprobe | 384 MiB | 0,75 núcleos | 128 |
| Liquidsoap | 512 MiB | 0,75 núcleos | 256 |
| Icecast | 64 MiB | 0,25 núcleos | 64 |

Son topes por contenedor, no reservas ni consumo habitual. La API admite como máximo 256 conexiones HTTP, 100 escuchas simultáneas, cuatro preescuchas y dos subidas concurrentes. Biblioteca: 5 GiB o 5.000 canciones. Cada archivo puede ocupar hasta 50 MiB. Se conserva un margen de 512 MiB de disco libre antes de aceptar una subida, teniendo en cuenta las reservas de subidas en curso. Las variables de `.env.example` permiten ajustar estos límites de aplicación; los topes de los contenedores están en `compose.yaml`.
