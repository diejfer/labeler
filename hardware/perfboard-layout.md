# OBSOLETO — NO CONSTRUIR ESTA VERSIÓN

Este primer planteo contiene cruces pensados para cableado punto a punto y no es válido como routing de pistas de soldadura. Usar exclusivamente `perfboard-layout-v2.svg` y `perfboard-layout-v2.png`.

# Placa de expansión para ESP32 — versión 0.1

## Alcance

Placa perforada de islas independientes, paso 2,54 mm. El diseño ocupa las columnas 3–29 y filas 4–27 de la placa disponible de 50 × 32 agujeros. El ESP32 queda fuera de la placa y se conecta mediante cables Dupont.

Los dos A4988 se montan en zócalos hembra de 1 × 8 para poder reemplazarlos. Todas las coordenadas se leen mirando el **lado de componentes**, con la columna 1 a la izquierda y la fila 1 arriba.

## Conectores

### J1 — ESP32, 1 × 10

Ubicación: columna 3, filas 16–25.

| Fila | Señal | ESP32 |
|---:|---|---|
| 16 | +5V | VIN |
| 17 | 3V3 | 3V3 |
| 18 | GND | GND |
| 19 | STEP_CINTA | GPIO16 |
| 20 | DIR_CINTA | GPIO17 |
| 21 | STEP_X | GPIO18 |
| 22 | DIR_X | GPIO19 |
| 23 | ENABLE | GPIO22 |
| 24 | SERVO_PWM | GPIO21 |
| 25 | STOP | GPIO32 |

### J2 — alimentación ATX, 1 × 3

Ubicación: columna 29, filas 5–7.

| Fila | Señal |
|---:|---|
| 5 | +12 V amarillo |
| 6 | GND negro |
| 7 | +5 V rojo |

### J3/J4 — motores

Cada conector tiene cuatro contactos: `2B, 2A, 1A, 1B`. J3 corresponde al motor de cinta y J4 al motor transversal. La correspondencia final de bobinas debe comprobarse con multímetro.

- J3: columna 14, filas 14–17.
- J4: columna 27, filas 14–17.

### J5 — servo

Ubicación: columna 29, filas 20–22.

| Pin | Señal |
|---:|---|
| 1 | GND |
| 2 | +5 V |
| 3 | PWM GPIO21 |

### J6 — parada lógica

Conectar un pulsador normalmente cerrado entre `STOP_SW` y `GND`. R1 mantiene la entrada en nivel alto si se pulsa el botón o se corta el cable.

Ubicación: columna 29, filas 25–26; `STOP_SW` en fila 25 y `GND` en fila 26.

## Orientación de los A4988

Mirando el lado de componentes, ambos módulos tienen `EN` y `VMOT` hacia la parte superior. Antes de insertarlos, comparar obligatoriamente las etiquetas impresas en el módulo con esta tabla.

| Fila relativa | Hilera lógica | Hilera potencia/motor |
|---:|---|---|
| 0 | EN | VMOT |
| 1 | MS1 | GND potencia |
| 2 | MS2 | 2B |
| 3 | MS3 | 2A |
| 4 | RESET | 1A |
| 5 | SLEEP | 1B |
| 6 | STEP | VDD |
| 7 | DIR | GND lógica |

D1 ocupa columnas 7 y 12, filas 5–12. D2 ocupa columnas 20 y 25, filas 5–12.

## Netlist de cableado

Los puentes de señal pueden ser cable aislado AWG 24–26. Para `+12V`, `+5V`, VMOT y GND de potencia usar AWG 20–22 o equivalente. No formar pistas de potencia largas solamente con estaño.

| Red | Puntos conectados |
|---|---|
| +12V | J2-12V, D1-VMOT, D2-VMOT, C1+, C2+ |
| +5V | J2-5V, J1-VIN, J5-5V, C5+ |
| 3V3 | J1-3V3, D1-VDD, D2-VDD, D1-RESET, D1-SLEEP, D2-RESET, D2-SLEEP, R1 |
| GND | J2-GND, J1-GND, ambos GND de cada driver, MS1/MS2/MS3 de ambos drivers, J5-GND, J6-GND, C1−, C2−, C3, C4 y C5− |
| STEP_CINTA | J1-GPIO16, D1-STEP |
| DIR_CINTA | J1-GPIO17, D1-DIR |
| STEP_X | J1-GPIO18, D2-STEP |
| DIR_X | J1-GPIO19, D2-DIR |
| ENABLE | J1-GPIO22, D1-EN, D2-EN, R2 a 3V3 |
| SERVO_PWM | J1-GPIO21, J5-PWM mediante R3 de 470 ohm |
| STOP | J1-GPIO32 mediante R4 de 1 kohm, J6-STOP_SW, R1 de 10 kohm a 3V3, C6 de 100 nF a GND |

R2 es un pull-up de 10 kohm que mantiene deshabilitados los drivers durante el arranque.

## Capacitores y resistencias

| Ref. | Valor | Ubicación/función |
|---|---|---|
| C1, C2 | 100 µF, 25 V o más | Uno junto a VMOT/GND de cada A4988 |
| C3, C4 | 100 nF cerámico | Uno junto a VDD/GND de cada A4988 |
| C5 | 470–1000 µF, 10 V o más | Alimentación del servo |
| C6 | 100 nF cerámico | Antirrebote de STOP |
| R1 | 10 kohm | Pull-up de STOP |
| R2 | 10 kohm | Pull-up de ENABLE |
| R3 | 470 ohm | Serie con PWM del servo |
| R4 | 1 kohm | Serie con entrada GPIO32 |

El único capacitor de 100 nF disponible no alcanza para completar la placa. Para el montaje final hacen falta al menos tres adicionales si se implementa todo el filtrado indicado.

J1 también lleva +5 V al pin VIN del ESP32 para que todo arranque con la ATX. Evitar conectar simultáneamente esa alimentación y un USB cuya fuente pueda entrar en conflicto; para programar, apagar la ATX o usar un cable USB sin conductor de +5 V si la variante concreta del DevKit no incorpora aislamiento adecuado.

## Reglas de montaje

1. Soldar primero puentes, resistencias y zócalos, sin colocar ESP32, A4988, motores ni servo.
2. Comprobar continuidad de cada red y ausencia de cortos entre 12 V, 5 V, 3V3 y GND.
3. Alimentar la placa sin los A4988 y medir las tensiones en los zócalos.
4. Apagar, insertar un solo A4988 y ajustar su límite de corriente.
5. Repetir con el segundo driver.
6. Nunca conectar o desconectar un motor con la fuente encendida.

## Observación de seguridad

El botón conectado a GPIO32 es una parada lógica. No puede detener la máquina si el ESP32, el firmware o la alimentación de control fallan. No debe rotularse ni considerarse un paro de emergencia certificado.
