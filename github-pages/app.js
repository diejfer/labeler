const CONTROLLER_URL = 'http://labeler.local';

function localFetch(path, options = {}) {
  return fetch(`${CONTROLLER_URL}${path}`, {
    cache: 'no-store',
    mode: 'cors',
    targetAddressSpace: 'local',
    ...options
  });
}

class FluidNCClient extends EventTarget {
  constructor() {
    super();
    this.online = false;
    this.queue = [];
    this.pending = null;
    this.sent = 0;
    this.total = 0;
    this.statusTimer = null;
    this.status = null;
  }

  emit(name, detail = {}) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  async connect() {
    this.disconnect();
    try {
      await this.pollStatus();
      this.online = true;
      this.emit('connection', { online: true });
      this.statusTimer = setInterval(() => this.pollStatus(), 750);
    } catch (error) {
      this.online = false;
      this.emit('connection', { online: false });
      throw new Error(`No se encontró labeler.local. ${error.message}`);
    }
  }

  disconnect() { clearInterval(this.statusTimer); this.statusTimer = null; this.online = false; }

  async pollStatus() {
    try {
      const response = await localFetch('/api/labeler/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      this.status = status;
      this.emit('status', { state:status.state, positions:[status.x,status.y,0,status.a] });
      return status;
    } catch (error) {
      if (this.online) {
        this.online = false;
        this.emit('connection', { online:false });
      }
      throw error;
    }
  }

  async action(action) {
    const response = await localFetch('/api/labeler/action', {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({ action })
    });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  }

  run(program, purpose = 'program') {
    if (!this.online) throw new Error('El controlador no está conectado.');
    if (this.pending || this.queue.length) throw new Error('Ya hay un envío en curso.');
    const lines = program.split(/\r?\n/).map(line => line.replace(/;.*$/, '').trim()).filter(Boolean);
    if (!lines.length) throw new Error('No hay comandos para enviar.');
    this.queue = lines;
    this.pending = null;
    this.sent = 0;
    this.total = lines.length;
    this.purpose = purpose;
    this.emit('progress', { sent: 0, total: this.total, purpose });
    this.pump();
  }

  async moveServo(angle) {
    if (!this.online) throw new Error('El controlador no está conectado.');
    if (this.pending || this.queue.length) throw new Error('Ya hay un envío en curso.');
    const status = await this.pollStatus();
    if (status.state !== 'Idle') throw new Error(`La máquina está en estado ${status.state}.`);
    const target = servoAxis(angle);
    const delta = fmt(target - status.a);
    if (Math.abs(delta) < 0.001) {
      this.emit('log', { text:`El servo ya está en ${angle}°.` });
      return;
    }
    this.run(`G91\nG0 A${delta} F3600\nG90`, 'manual');
  }

  async jogServo(deltaAngle) {
    if (!this.online) throw new Error('El controlador no está conectado.');
    if (this.pending || this.queue.length) throw new Error('Ya hay un envío en curso.');
    const status = await this.pollStatus();
    if (status.state !== 'Idle') throw new Error(`La máquina está en estado ${status.state}.`);
    const currentAngle = status.a + 180;
    const targetAngle = Math.max(0, Math.min(180, currentAngle + deltaAngle));
    const delta = fmt(targetAngle - currentAngle);
    if (Math.abs(delta) < 0.001) {
      this.emit('log', { text:`El servo alcanzó el límite de ${targetAngle}°.` });
      return;
    }
    this.run(`G91\nG0 A${delta} F3600\nG90`, 'manual');
  }

  async jogAxis(axis, steps, stepsPerMm, maxSpeedMmS) {
    if (!this.online) throw new Error('El controlador no está conectado.');
    if (this.pending || this.queue.length) throw new Error('Ya hay un envío en curso.');
    const status = await this.pollStatus();
    if (status.state !== 'Idle') throw new Error(`La máquina está en estado ${status.state}.`);
    if (!Number.isFinite(stepsPerMm) || stepsPerMm <= 0) throw new Error('Los pasos por milímetro deben ser mayores que cero.');
    const distance = fmt(steps / stepsPerMm);
    const feed = fmt(Math.min(maxSpeedMmS, 10) * 60);
    this.run(`G91\nG1 ${axis}${distance} F${feed}\nG90`, 'manual');
  }

  async zeroAxis(axis) {
    if (!this.online) throw new Error('El controlador no está conectado.');
    if (this.pending || this.queue.length) throw new Error('Ya hay un envío en curso.');
    const status = await this.pollStatus();
    if (status.state !== 'Idle') throw new Error(`La máquina está en estado ${status.state}.`);
    this.run(`G92 ${axis}0`, 'manual');
  }

  async pump() {
    if (this.pending || !this.queue.length || !this.online) {
      if (!this.pending && !this.queue.length && this.total) {
        const purpose = this.purpose;
        this.total = 0;
        this.emit('complete', { purpose });
      }
      return;
    }
    this.pending = this.queue.shift();
    this.emit('log', { text: `> ${this.pending}` });
    try {
      const response = await localFetch(`/api/labeler/command?cmd=${encodeURIComponent(this.pending)}`);
      const text = (await response.text()).trim();
      if (text) this.emit('log', { text });
      if (!response.ok || /(^|\n)(error:|ALARM:)/i.test(text)) throw new Error(text || `HTTP ${response.status}`);
      this.pending = null;
      this.sent++;
      this.emit('progress', { sent:this.sent, total:this.total, purpose:this.purpose });
      this.pump();
    } catch (error) {
      this.pending = null;
      this.queue = [];
      this.total = 0;
      this.emit('failure', { response:error.message, purpose:this.purpose });
    }
  }

  cancel() {
    this.queue = [];
    this.pending = null;
    this.total = 0;
    this.action('reset').catch(error => this.emit('log', { text:error.message }));
    this.emit('progress', { sent: 0, total: 0 });
  }
}

const FONT = {
  'A':['01110','10001','10001','11111','10001','10001','10001'],'B':['11110','10001','10001','11110','10001','10001','11110'],
  'C':['01111','10000','10000','10000','10000','10000','01111'],'D':['11110','10001','10001','10001','10001','10001','11110'],
  'E':['11111','10000','10000','11110','10000','10000','11111'],'F':['11111','10000','10000','11110','10000','10000','10000'],
  'G':['01111','10000','10000','10111','10001','10001','01110'],'H':['10001','10001','10001','11111','10001','10001','10001'],
  'I':['11111','00100','00100','00100','00100','00100','11111'],'J':['00111','00010','00010','00010','10010','10010','01100'],
  'K':['10001','10010','10100','11000','10100','10010','10001'],'L':['10000','10000','10000','10000','10000','10000','11111'],
  'M':['10001','11011','10101','10101','10001','10001','10001'],'N':['10001','11001','10101','10011','10001','10001','10001'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],'P':['11110','10001','10001','11110','10000','10000','10000'],
  'Q':['01110','10001','10001','10001','10101','10010','01101'],'R':['11110','10001','10001','11110','10100','10010','10001'],
  'S':['01111','10000','10000','01110','00001','00001','11110'],'T':['11111','00100','00100','00100','00100','00100','00100'],
  'U':['10001','10001','10001','10001','10001','10001','01110'],'V':['10001','10001','10001','10001','10001','01010','00100'],
  'W':['10001','10001','10001','10101','10101','11011','10001'],'X':['10001','10001','01010','00100','01010','10001','10001'],
  'Y':['10001','10001','01010','00100','00100','00100','00100'],'Z':['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],'1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],'3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],'5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'],'7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],'9':['01110','10001','10001','01111','00001','00001','01110'],
  ' ':['00000','00000','00000','00000','00000','00000','00000'],'-':['00000','00000','00000','11111','00000','00000','00000'],
  '.':['00000','00000','00000','00000','00000','00110','00110'],'/':['00001','00010','00010','00100','01000','01000','10000'],
  ':':['00000','00110','00110','00000','00110','00110','00000'],'?':['01110','10001','00001','00010','00100','00000','00100']
};

const DEFAULT_CONFIG = {
  xStepsPerMm:80, yStepsPerMm:80, xMaxSpeedMmS:40, yMaxSpeedMmS:25,
  xAccelerationMmS2:100, yAccelerationMmS2:100, travelSpeedMmS:25,
  printSpeedMmS:8, tapeMarginMm:1.5, glyphSpacingMm:1,
  servoUpAngle:90, servoDownAngle:35, servoDelayMs:180
};

let mechanical = { ...DEFAULT_CONFIG };
const client = new FluidNCClient();
const $ = selector => document.querySelector(selector);
const number = selector => {
  const value = Number($(selector).value);
  if (!Number.isFinite(value)) throw new Error(`Valor inválido: ${selector}`);
  return value;
};
const fmt = value => Number(value.toFixed(3));
const servoAxis = angle => fmt(angle - 180);

document.body.innerHTML = `
<div class="shell"><header class="topbar"><div><h1>Impresora de etiquetas</h1><span class="muted">Control FluidNC</span></div><div class="connection"><span id="dot" class="dot"></span><span id="connectionText">Desconectado</span><button id="connect" class="secondary">Conectar</button></div></header>
<nav class="tabs"><button data-tab="label" class="active">Etiqueta</button><button data-tab="manual">Control manual</button><button data-tab="config">Configuración</button></nav>

<section id="tab-label" class="tab active"><div class="layout">
  <section class="panel"><h2>Cinta y formato</h2><div class="fields">
    <div class="field"><label>Ancho de cinta</label><select id="tapePreset"><option value="6">6 mm</option><option value="9">9 mm</option><option value="12" selected>12 mm</option><option value="18">18 mm</option><option value="24">24 mm</option><option value="36">36 mm</option><option value="custom">Otro...</option></select></div>
    <div class="field" id="customWidthField" hidden><label>Ancho particular (mm)</label><input id="tapeWidth" type="number" min="4" max="100" step="0.1" value="12"></div>
    <div class="field"><label>Formato</label><select id="labelFormat"><option value="one">Un renglón</option><option value="two">Dos renglones</option></select></div>
  </div><div class="field"><label>Renglón 1</label><input id="line1" maxlength="40" value="ETIQUETA"></div><div class="field" id="line2Field" hidden><label>Renglón 2</label><input id="line2" maxlength="40" value="SEGUNDO RENGLON"></div></section>
  <section class="panel"><h2>Vista previa</h2><div id="tapePreview" class="tape-preview"><span id="preview1"></span><span id="preview2"></span></div><div class="label-info"><span>Ancho: <strong id="widthInfo">12 mm</strong></span><span>Largo estimado: <strong id="lengthInfo">--</strong></span></div></section>
  <section class="panel wide"><h2>Programa de impresión</h2><textarea id="program" spellcheck="false"></textarea><div class="progress"><div id="progressBar"></div></div><p id="progressText" class="muted">0 / 0 líneas</p><div class="actions"><button id="generate">Generar G-code</button><button id="print">Imprimir etiqueta</button><button id="pause" class="warn">Pausar</button><button id="resume" class="secondary">Continuar</button><button id="reset" class="danger">Detener</button></div></section>
</div></section>

<section id="tab-manual" class="tab"><div class="layout">
  <section class="panel wide"><h2>Estado</h2><div class="status-grid"><div class="metric"><span>Estado</span><strong id="machineState">--</strong></div><div class="metric"><span>X</span><strong id="posX">0 mm</strong></div><div class="metric"><span>Y</span><strong id="posY">0 mm</strong></div><div class="metric"><span>Servo</span><strong id="posA">--</strong></div></div><div class="actions"><button id="unlock" class="secondary">Desbloquear ($X)</button><button id="penUp" class="secondary">Alejar marcador</button><button id="penDown" class="warn">Acercar marcador</button></div></section>
  <section class="panel wide"><h2>Consola G-code</h2><div id="console" class="console"></div><div class="actions"><input id="manual" placeholder="G0 X10 Y5" class="grow"><button id="sendManual" class="secondary">Enviar</button></div></section>
</div></section>

<section id="tab-config" class="tab"><form id="configForm" class="panel config-panel"><h2>Configuración mecánica persistente</h2><p class="muted">Estos valores se guardan en la memoria NVS del ESP32. Los textos y el formato de etiqueta no se guardan.</p><div class="config-grid">
  <fieldset><legend>Motor X — avance longitudinal</legend>
    <div class="field"><label>Posición actual</label><strong id="motorXCalibrationPosition">--</strong></div>
    <div class="actions stepper-jog"><button type="button" data-axis-jog="X" data-steps="-100" class="secondary">-100 pasos</button><button type="button" data-axis-jog="X" data-steps="-10" class="secondary">-10</button><button type="button" data-axis-jog="X" data-steps="-1" class="secondary">-1</button><button type="button" data-axis-jog="X" data-steps="1" class="secondary">+1</button><button type="button" data-axis-jog="X" data-steps="10" class="secondary">+10</button><button type="button" data-axis-jog="X" data-steps="100" class="secondary">+100 pasos</button></div>
    <div class="actions"><button type="button" data-axis-zero="X" class="secondary">Poner X en cero</button></div>
    <div class="field"><label>Pasos por milímetro</label><input name="xStepsPerMm" type="number" min="0.01" step="0.01"></div><div class="field"><label>Velocidad máxima (mm/s)</label><input name="xMaxSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Aceleración (mm/s²)</label><input name="xAccelerationMmS2" type="number" min="0.1" step="0.1"></div>
  </fieldset>
  <fieldset><legend>Motor Y — ancho de cinta</legend>
    <div class="field"><label>Posición actual</label><strong id="motorYCalibrationPosition">--</strong></div>
    <div class="actions stepper-jog"><button type="button" data-axis-jog="Y" data-steps="-100" class="secondary">-100 pasos</button><button type="button" data-axis-jog="Y" data-steps="-10" class="secondary">-10</button><button type="button" data-axis-jog="Y" data-steps="-1" class="secondary">-1</button><button type="button" data-axis-jog="Y" data-steps="1" class="secondary">+1</button><button type="button" data-axis-jog="Y" data-steps="10" class="secondary">+10</button><button type="button" data-axis-jog="Y" data-steps="100" class="secondary">+100 pasos</button></div>
    <div class="actions"><button type="button" data-axis-zero="Y" class="secondary">Poner Y en cero</button></div>
    <div class="field"><label>Pasos por milímetro</label><input name="yStepsPerMm" type="number" min="0.01" step="0.01"></div><div class="field"><label>Velocidad máxima (mm/s)</label><input name="yMaxSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Aceleración (mm/s²)</label><input name="yAccelerationMmS2" type="number" min="0.1" step="0.1"></div>
  </fieldset>
  <fieldset><legend>Impresión</legend><div class="field"><label>Velocidad de traslado (mm/s)</label><input name="travelSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Velocidad con marcador apoyado (mm/s)</label><input name="printSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Margen de cinta (mm)</label><input name="tapeMarginMm" type="number" min="0" step="0.1"></div><div class="field"><label>Espacio entre caracteres (mm)</label><input name="glyphSpacingMm" type="number" min="0" step="0.1"></div></fieldset>
  <fieldset><legend>Servomotor</legend>
    <div class="field"><label>Posición actual</label><strong id="servoCalibrationPosition">--</strong></div>
    <div class="actions servo-jog"><button type="button" data-servo-jog="-10" class="secondary">-10°</button><button type="button" data-servo-jog="-1" class="secondary">-1°</button><button type="button" data-servo-jog="1" class="secondary">+1°</button><button type="button" data-servo-jog="10" class="secondary">+10°</button></div>
    <div class="field"><label>Ángulo marcador alejado</label><input name="servoUpAngle" type="number" min="0" max="180"></div>
    <div class="actions"><button id="captureServoUp" type="button" class="secondary">Usar posición actual</button><button id="testServoUp" type="button" class="secondary">Probar alejado</button></div>
    <div class="field"><label>Ángulo marcador apoyado</label><input name="servoDownAngle" type="number" min="0" max="180"></div>
    <div class="actions"><button id="captureServoDown" type="button" class="secondary">Usar posición actual</button><button id="testServoDown" type="button" class="warn">Probar apoyado</button></div>
    <div class="field"><label>Espera del servo (ms)</label><input name="servoDelayMs" type="number" min="0" max="5000"></div>
  </fieldset>
</div><div class="actions"><button>Guardar en ESP32</button><span id="configMessage" class="muted"></span></div></form></section>
</div>`;

function tapeWidth() { return $('#tapePreset').value === 'custom' ? number('#tapeWidth') : Number($('#tapePreset').value); }

function textMetrics(text, scale) {
  const chars = [...text];
  return Math.max(0, chars.length * 5 * scale + Math.max(0, chars.length - 1) * mechanical.glyphSpacingMm);
}

function rowStrokes(text, yBottom, scale, xOffset) {
  const strokes = [];
  let cursor = xOffset;
  const normalized = text.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  for (const rawChar of normalized) {
    const glyph = FONT[rawChar] || FONT['?'];
    for (let row = 0; row < 7; row++) {
      let column = 0;
      while (column < 5) {
        while (column < 5 && glyph[row][column] === '0') column++;
        const start = column;
        while (column < 5 && glyph[row][column] === '1') column++;
        if (column > start) strokes.push({ x1:cursor + start*scale, x2:cursor + column*scale, y:yBottom + (6-row+0.5)*scale });
      }
    }
    cursor += 5*scale + mechanical.glyphSpacingMm;
  }
  return strokes;
}

function buildLabel() {
  const width = tapeWidth();
  const rows = $('#labelFormat').value === 'two' ? 2 : 1;
  const texts = rows === 2 ? [$('#line1').value, $('#line2').value] : [$('#line1').value];
  if (texts.some(text => !text.trim())) throw new Error('Completá el contenido de todos los renglones.');
  const usable = width - 2*mechanical.tapeMarginMm;
  const rowGap = rows === 2 ? Math.min(1, usable*0.08) : 0;
  const rowHeight = (usable-rowGap*(rows-1))/rows;
  if (rowHeight <= 1) throw new Error('El margen configurado no deja espacio imprimible.');
  const scale = rowHeight/7;
  const widths = texts.map(text => textMetrics(text, scale));
  const labelLength = Math.max(...widths) + 2*mechanical.tapeMarginMm;
  const strokes = [];
  texts.forEach((text,index) => {
    const yBottom = mechanical.tapeMarginMm + (rows-1-index)*(rowHeight+rowGap);
    const xOffset = mechanical.tapeMarginMm + (labelLength-widths[index])/2;
    strokes.push(...rowStrokes(text,yBottom,scale,xOffset));
  });

  const up = servoAxis(mechanical.servoUpAngle);
  const down = servoAxis(mechanical.servoDownAngle);
  const dwell = fmt(mechanical.servoDelayMs/1000);
  const travelFeed = fmt(mechanical.travelSpeedMmS*60);
  const printFeed = fmt(mechanical.printSpeedMmS*60);
  const gcode = ['; Etiqueta generada por Labeler CNC','G21','G90',`G0 A${up}`,`G4 P${dwell}`,'G92 X0 Y0'];
  for (const stroke of strokes) {
    gcode.push(`G0 X${fmt(stroke.x1)} Y${fmt(stroke.y)} F${travelFeed}`);
    gcode.push(`G0 A${down}`);
    gcode.push(`G4 P${dwell}`);
    gcode.push(`G1 X${fmt(stroke.x2)} Y${fmt(stroke.y)} F${printFeed}`);
    gcode.push(`G0 A${up}`);
    gcode.push(`G4 P${dwell}`);
  }
  gcode.push(`G0 X${fmt(labelLength)} Y0 F${travelFeed}`,'M2');
  return { gcode:gcode.join('\n'), labelLength };
}

function updatePreview() {
  const width = tapeWidth();
  const two = $('#labelFormat').value === 'two';
  $('#line2Field').hidden = !two;
  $('#preview1').textContent = $('#line1').value || ' ';
  $('#preview2').textContent = two ? ($('#line2').value || ' ') : '';
  $('#preview2').hidden = !two;
  $('#tapePreview').style.aspectRatio = `${Math.max(2.4, ($('#line1').value.length+1)*0.45)} / 1`;
  $('#widthInfo').textContent = `${width} mm`;
  try { $('#lengthInfo').textContent = `${buildLabel().labelLength.toFixed(1)} mm`; } catch { $('#lengthInfo').textContent = '--'; }
}

async function loadConfig() {
  try {
    const response = await localFetch('/api/labeler/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mechanical = { ...DEFAULT_CONFIG, ...await response.json() };
  } catch (error) { log(`No se pudo leer la configuración: ${error.message}`); }
  for (const [key,value] of Object.entries(mechanical)) {
    const field = $(`[name="${key}"]`);
    if (field) field.value = value;
  }
  updatePreview();
}

function runtimeConfigGcode() {
  return [
    `$/axes/x/steps_per_mm=${mechanical.xStepsPerMm}`,
    `$/axes/x/max_rate_mm_per_min=${mechanical.xMaxSpeedMmS*60}`,
    `$/axes/x/acceleration_mm_per_sec2=${mechanical.xAccelerationMmS2}`,
    `$/axes/y/steps_per_mm=${mechanical.yStepsPerMm}`,
    `$/axes/y/max_rate_mm_per_min=${mechanical.yMaxSpeedMmS*60}`,
    `$/axes/y/acceleration_mm_per_sec2=${mechanical.yAccelerationMmS2}`
  ].join('\n');
}

const log = text => {
  const box = $('#console');
  box.textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
  box.scrollTop = box.scrollHeight;
};

document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.id === `tab-${button.dataset.tab}`));
});

['#tapePreset','#tapeWidth','#labelFormat','#line1','#line2'].forEach(selector => $(selector).addEventListener('input', () => {
  $('#customWidthField').hidden = $('#tapePreset').value !== 'custom';
  updatePreview();
}));

client.addEventListener('connection', event => {
  const online = event.detail.online;
  $('#dot').classList.toggle('online', online);
  $('#connectionText').textContent = online ? 'Conectado' : 'Desconectado';
  $('#connect').textContent = online ? 'Reconectar' : 'Conectar';
});
client.addEventListener('log', event => log(event.detail.text));
client.addEventListener('status', event => {
  const status = event.detail;
  $('#machineState').textContent = status.state;
  $('#machineState').className = status.state === 'Idle' ? 'state-idle' : 'state-run';
  $('#posX').textContent = `${(status.positions[0] ?? 0).toFixed(2)} mm`;
  $('#posY').textContent = `${(status.positions[1] ?? 0).toFixed(2)} mm`;
  $('#motorXCalibrationPosition').textContent = `${(status.positions[0] ?? 0).toFixed(3)} mm`;
  $('#motorYCalibrationPosition').textContent = `${(status.positions[1] ?? 0).toFixed(3)} mm`;
  const a = status.positions[3];
  $('#posA').textContent = Number.isFinite(a) ? `${(a+180).toFixed(1)}°` : '--';
  $('#servoCalibrationPosition').textContent = Number.isFinite(a) ? `${(a+180).toFixed(1)}°` : '--';
});
client.addEventListener('progress', event => {
  if (event.detail.purpose === 'configuration') return;
  const { sent,total } = event.detail;
  $('#progressBar').style.width = total ? `${sent/total*100}%` : '0';
  $('#progressText').textContent = `${sent} / ${total} líneas`;
});
client.addEventListener('complete', event => log(event.detail.purpose === 'configuration' ? 'Parámetros mecánicos aplicados.' : 'Programa completado.'));
client.addEventListener('failure', event => log(`Envío interrumpido: ${event.detail.response}`));

async function connectController() {
  try {
    await client.connect();
    await loadConfig();
    client.run(runtimeConfigGcode(), 'configuration');
  } catch (error) { log(error.message); }
}

$('#connect').onclick = connectController;
$('#generate').onclick = () => { try { $('#program').value = buildLabel().gcode; } catch (error) { log(error.message); } };
$('#print').onclick = () => { try { const job=buildLabel(); $('#program').value=job.gcode; client.run(job.gcode,'label'); } catch (error) { log(error.message); } };
$('#pause').onclick = () => client.action('pause').catch(error => log(error.message));
$('#resume').onclick = () => client.action('resume').catch(error => log(error.message));
$('#reset').onclick = () => client.cancel();
$('#unlock').onclick = () => { try { client.run('$X','manual'); } catch(error) { log(error.message); } };
$('#penUp').onclick = () => client.moveServo(mechanical.servoUpAngle).catch(error => log(error.message));
$('#penDown').onclick = () => client.moveServo(mechanical.servoDownAngle).catch(error => log(error.message));
document.querySelectorAll('[data-servo-jog]').forEach(button => button.onclick = () => {
  client.jogServo(Number(button.dataset.servoJog)).catch(error => log(error.message));
});
document.querySelectorAll('[data-axis-jog]').forEach(button => button.onclick = () => {
  const axis = button.dataset.axisJog;
  const prefix = axis.toLowerCase();
  const steps = Number(button.dataset.steps);
  const stepsPerMm = number(`[name="${prefix}StepsPerMm"]`);
  const maxSpeed = number(`[name="${prefix}MaxSpeedMmS"]`);
  client.jogAxis(axis, steps, stepsPerMm, maxSpeed).catch(error => log(error.message));
});
document.querySelectorAll('[data-axis-zero]').forEach(button => button.onclick = () => {
  client.zeroAxis(button.dataset.axisZero).catch(error => log(error.message));
});
$('#captureServoUp').onclick = () => {
  const a = client.status?.a;
  if (!Number.isFinite(a)) return log('No hay una posición de servo disponible.');
  $('[name="servoUpAngle"]').value = fmt(a + 180);
};
$('#captureServoDown').onclick = () => {
  const a = client.status?.a;
  if (!Number.isFinite(a)) return log('No hay una posición de servo disponible.');
  $('[name="servoDownAngle"]').value = fmt(a + 180);
};
$('#testServoUp').onclick = () => client.moveServo(number('[name="servoUpAngle"]')).catch(error => log(error.message));
$('#testServoDown').onclick = () => client.moveServo(number('[name="servoDownAngle"]')).catch(error => log(error.message));
$('#sendManual').onclick = () => { try { client.run($('#manual').value,'manual'); $('#manual').value=''; } catch(error) { log(error.message); } };
$('#manual').onkeydown = event => { if (event.key === 'Enter') $('#sendManual').click(); };

$('#configForm').onsubmit = async event => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  $('#configMessage').textContent = 'Guardando...';
  try {
    const response = await localFetch('/api/labeler/config', {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams(formData)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    mechanical = { ...mechanical, ...result };
    $('#configMessage').textContent = 'Configuración guardada en el ESP32.';
    updatePreview();
    if (client.online) client.run(runtimeConfigGcode(),'configuration');
  } catch (error) { $('#configMessage').textContent = `Error: ${error.message}`; }
};

updatePreview();
connectController();
