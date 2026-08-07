# Labeler CNC - ESP32 DevKit V1

Control CNC de dos drivers STEP/DIR y un servo RC basado en FluidNC 4.0.3.

El proyecto PlatformIO activo está en `firmware/FluidNC`. El sketch Arduino
experimental anterior fue retirado para evitar cargar accidentalmente un
firmware sin planificador CNC.

## Estructura

- `firmware/FluidNC`: código fuente fijado a FluidNC v4.0.3.
- `firmware/esp32-data/config.yaml`: configuración de los ejes X, Y y A.
- `github-pages`: assets HTML, CSS y JavaScript para GitHub Pages.

La aplicación se publica automáticamente en
`https://diejfer.github.io/labeler`, busca `http://labeler.local` mediante las
APIs REST y no depende de archivos web almacenados en el ESP32.

El navegador debe soportar Local Network Access y conceder permiso a GitHub
Pages para buscar dispositivos en la red local. La implementación apunta a
Chrome/Edge 142 o posterior. El ESP32 y el navegador deben estar en la misma
red Wi-Fi con mDNS habilitado.

## Aplicación de etiquetas

La interfaz permite seleccionar cintas de 6, 9, 12, 18, 24 o 36 mm, o ingresar
un ancho particular. Puede generar etiquetas de uno o dos renglones. El texto
se convierte en trazos mediante una fuente matricial 5x7 incluida en
`github-pages/app.js`.

El eje X corresponde al sentido longitudinal de la cinta, Y a su ancho y el eje
A al servo que acerca o aleja el marcador. Antes de imprimir se muestra el
G-code completo para inspección.

Los siguientes datos sólo existen en la pestaña actual del navegador y nunca se
guardan en el ESP32:

- ancho seleccionado;
- formato de uno o dos renglones;
- textos de la etiqueta;
- programa G-code generado.

## API persistente

El firmware agrega estos endpoints a FluidNC:

```text
GET  /api/labeler/config
POST /api/labeler/config
```

La configuración se almacena en NVS bajo el espacio `labeler`. Incluye pasos
por milímetro, velocidades máximas, aceleraciones, velocidades de traslado e
impresión, margen, separación de caracteres, posiciones del servo y espera del
servo.

Al abrir una conexión, el cliente aplica la parametría persistente a los ejes X
e Y mediante los ajustes de ejecución de FluidNC. El archivo YAML conserva
valores iniciales conservadores para que la máquina no pueda arrancar con una
calibración mecánica desconocida.

## Pines

| Dispositivo | STEP/PWM | DIR | ENABLE |
|---|---:|---:|---:|
| Motor X | GPIO26 | GPIO27 | GPIO25 |
| Motor Y | GPIO32 | GPIO33 | GPIO14 |
| Servo A | GPIO13 | - | - |

Los dos A4988 y el servo deben compartir GND con el ESP32. El servo debe usar
una fuente externa de 5 V; no debe alimentarse desde 3V3.

## Calibración inicial

El YAML inicial usa `steps_per_mm: 1`. Al conectarse la aplicación, reemplaza
esos valores en memoria con la configuración persistente. Para calcularlos:

```text
steps_per_mm = pasos_motor_por_vuelta * micropasos / avance_mm_por_vuelta
```

Actualizar luego `max_rate_mm_per_min`, `acceleration_mm_per_sec2` y
`max_travel_mm` con valores reales de la máquina.

El servo es el eje A. FluidNC usa el rango interno A=-180..0 y la interfaz lo
traduce a 0..180 grados.

## Instalación

Desde `firmware/FluidNC`:

```powershell
platformio run -e wifi
platformio run -e wifi -t upload
```

Para construir y cargar el sistema de archivos con `config.yaml`:

```powershell
platformio run -e wifi -t buildfs
platformio run -e wifi -t uploadfs
```

También pueden cargarse ambos archivos desde el administrador web de FluidNC.
Reiniciar el controlador después de cargar `config.yaml`.

Al arrancar por primera vez, FluidNC crea su punto de acceso. Para que los
assets externos funcionen, configurar el modo Station con las credenciales de
la red local desde la interfaz de FluidNC.

## Seguridad

La parada desde navegador no reemplaza una parada de emergencia cableada. Antes
de usar el sistema en una máquina real, agregar E-stop y finales de carrera a
pines dedicados y declararlos en `config.yaml`.
