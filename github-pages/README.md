# Frontend de Labeler CNC

Esta carpeta se publica directamente en `https://diejfer.github.io/labeler`.
La aplicación busca el controlador en `http://labeler.local` y usa sus APIs
REST, por lo que no necesita cargar HTML, CSS ni JavaScript desde el ESP32.

## Requisitos del navegador

La página solicita permiso para acceder a dispositivos de la red local. La
implementación principal apunta a Chrome/Edge 142 o posterior, donde Local
Network Access permite acceder desde una página HTTPS a un equipo HTTP `.local`.
El ordenador o teléfono y el ESP32 deben estar en la misma red y ésta debe
permitir mDNS.

## Protocolo

- `GET /api/labeler/status`: descubrimiento, estado y posición.
- `GET /api/labeler/command?cmd=...`: una línea G-code con respuesta síncrona.
- `POST /api/labeler/action`: pausa, continuación o reset.
- `GET/POST /api/labeler/config`: parametría persistente.

El cliente envía una línea G-code por vez y espera la respuesta HTTP antes de
continuar. Los datos de la etiqueta sólo viven en la memoria de la página.
