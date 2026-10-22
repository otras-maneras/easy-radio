# Revisión de seguridad — 22/10/2026

Revisión del código, pruebas de acceso y configuración desplegada. No sustituye una auditoría independiente ni una prueba de penetración completa.

## Corregido en esta revisión

Se encontró una omisión de autenticación mediante segmentos de ruta codificados. Fastify resolvía la ruta, pero la comprobación de acceso usaba la URL sin normalizar. La autorización usa ahora la ruta reconocida por el router. Se añadieron pruebas para lectura, carga, borrado, orden, modo aleatorio y controles de emisión; las variantes codificadas se rechazan sin sesión.

La corrección se desplegó y se verificó mediante el dominio público. No se investigó el historial completo del servidor para determinar si el fallo fue explotado anteriormente.

## Controles existentes comprobados

- HTTPS y HSTS mediante Caddy.
- Cookies firmadas con caducidad de 12 horas, HttpOnly, Secure en HTTPS y SameSite=Strict.
- Validación del encabezado Origin en operaciones de escritura.
- Límite de seis intentos de inicio de sesión por minuto en el limitador actual.
- Carga autenticada, extensión permitida, nombre UUID, límite de 50 MiB y análisis con ffprobe con tiempo máximo de 15 segundos.
- SQL parametrizado y escape de metadatos al mostrar HTML.
- Archivo .env con permisos 0600; no se sirve desde la raíz pública.
- API vinculada a loopback en el host; Icecast y el control de Liquidsoap no publican puertos del host.
- npm audit --omit=dev: cero vulnerabilidades conocidas de dependencias JavaScript en el momento de la revisión.

## Pendiente de reforzar

1. Ejecutar el contenedor de la API y ffprobe sin root. Limitar privilegios y, cuando sea viable, aislar el análisis de archivos y sus protocolos de entrada.
2. Revocar sesiones en el servidor al cerrar sesión. Actualmente se elimina la cookie del navegador; una copia de un token sigue siendo válida hasta su caducidad o un cambio del secreto de firma.
3. Definir límites de CPU, RAM, subidas concurrentes, espacio total de biblioteca y conexiones/tráfico, de acuerdo con la audiencia prevista.
4. Automatizar copias de seguridad de la biblioteca y la base de datos y comprobar su restauración.
5. Mantener y analizar las imágenes y paquetes del sistema. npm audit no cubre Node, FFmpeg, Icecast, Liquidsoap, Debian ni Caddy.

La emisión es pública por diseño; la administración y los archivos originales de la biblioteca requieren sesión.
