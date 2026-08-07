# Frontend de Labeler CNC

Esta carpeta se publica directamente con GitHub Pages. El ESP32 sirve un
`index.html` mínimo que descarga `app.css` y `app.js` desde la URL publicada.
Como el documento principal sigue perteneciendo al origen HTTP del ESP32, el
JavaScript puede abrir su WebSocket local sin caer en contenido mixto.

## Publicación

1. Copiar el contenido de esta carpeta a un repositorio GitHub.
2. En **Settings > Pages**, publicar desde la rama y carpeta elegidas.
3. Abrir la dirección HTTP del ESP32.
4. La primera vez, ingresar la URL de Pages, por ejemplo
   `https://usuario.github.io/labeler`.

El navegador debe tener acceso simultáneo al ESP32 y a Internet. Para eso se
recomienda configurar FluidNC en modo Station dentro de la red Wi-Fi local.

## Protocolo

La aplicación usa el WebSocket Grbl nativo de FluidNC en `ws://ESP32/`.
Envía una línea y espera `ok`, `error:` o `ALARM:` antes de enviar la siguiente.
También consulta estado con `?` y utiliza los comandos de tiempo real `!`, `~`
y `Ctrl-X`.

La parametría mecánica se lee y guarda con `GET/POST /api/labeler/config`. Los
datos de cada etiqueta permanecen sólo en la memoria de la página abierta.
