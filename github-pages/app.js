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
    this.completionTimer = null;
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

  disconnect() {
    clearInterval(this.statusTimer);
    clearTimeout(this.completionTimer);
    this.statusTimer = null;
    this.completionTimer = null;
    this.online = false;
  }

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
    if (this.pending || this.queue.length || this.total) throw new Error('Ya hay un envío en curso.');
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
    if (this.pending || !this.online) {
      return;
    }
    if (!this.queue.length) {
      this.scheduleCompletionCheck();
      return;
    }
    const batch = [];
    let batchLength = 0;
    while (this.queue.length && batch.length < 12) {
      const next = this.queue[0];
      const nextLength = next.length + (batch.length ? 1 : 0);
      if (batch.length && batchLength + nextLength > 220) break;
      batch.push(this.queue.shift());
      batchLength += nextLength;
    }
    this.pending = batch;
    batch.forEach(line => this.emit('log', { text: `> ${line}` }));
    try {
      const response = await localFetch('/api/labeler/command', {
        method:'POST',
        headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
        body:new URLSearchParams({ program:batch.join('\n') })
      });
      const text = (await response.text()).trim();
      if (response.status === 503) {
        this.queue.unshift(...batch);
        this.pending = null;
        setTimeout(() => this.pump(), 150);
        return;
      }
      if (!response.ok || /(^|\n)(error:|ALARM:)/i.test(text)) throw new Error(text || `HTTP ${response.status}`);
      this.pending = null;
      this.sent += batch.length;
      this.emit('progress', { sent:this.sent, total:this.total, purpose:this.purpose });
      this.pump();
    } catch (error) {
      this.pending = null;
      this.queue = [];
      this.total = 0;
      this.emit('failure', { response:error.message, purpose:this.purpose });
    }
  }

  scheduleCompletionCheck() {
    if (this.completionTimer || !this.total) return;
    this.completionTimer = setTimeout(() => this.checkCompletion(), 200);
  }

  async checkCompletion() {
    this.completionTimer = null;
    if (!this.total || !this.online) return;
    try {
      const status = await this.pollStatus();
      if ((status.queued ?? 0) === 0 && status.state === 'Idle') {
        const purpose = this.purpose;
        this.total = 0;
        this.emit('complete', { purpose });
        return;
      }
      this.scheduleCompletionCheck();
    } catch (error) {
      this.total = 0;
      this.emit('failure', { response:error.message, purpose:this.purpose });
    }
  }

  cancel() {
    this.queue = [];
    this.pending = null;
    this.total = 0;
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
    this.action('reset').catch(error => this.emit('log', { text:error.message }));
    this.emit('progress', { sent: 0, total: 0 });
  }
}

const VECTOR_FONT = window.LABELER_VECTOR_FONT;

const DEFAULT_CONFIG = {
  xStepsPerMm:80, yStepsPerMm:80, xMaxSpeedMmS:40, yMaxSpeedMmS:25,
  xAccelerationMmS2:100, yAccelerationMmS2:100, travelSpeedMmS:25,
  xBacklashMm:0, yBacklashMm:0, printSpeedMmS:8, tapeMarginMm:1.5, glyphSpacingMm:1,
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
  </div><div class="field"><label>Renglón 1</label><input id="line1" maxlength="40" value="Etiqueta"></div><div class="field" id="line2Field" hidden><label>Renglón 2</label><input id="line2" maxlength="40" value="Segundo renglón"></div>
  <div class="label-formatting"><div class="field"><label>Interlineado (mm)</label><input id="lineSpacing" type="number" min="0" max="20" step="0.1" value="1"></div><label class="format-option"><input id="fontBold" type="checkbox"><strong>Negrita</strong></label><label class="format-option"><input id="fontItalic" type="checkbox"><em>Cursiva</em></label><label class="format-option"><input id="fontUnderline" type="checkbox"><u>Subrayado</u></label></div></section>
  <section class="panel"><h2>Vista previa vectorial</h2><div id="tapePreview" class="tape-preview"></div><div class="label-info"><span>Ancho: <strong id="widthInfo">12 mm</strong></span><span>Largo estimado: <strong id="lengthInfo">--</strong></span></div></section>
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
    <div class="field"><label>Pasos por milímetro</label><input name="xStepsPerMm" type="number" min="0.01" step="0.01"></div><div class="field"><label>Velocidad máxima (mm/s)</label><input name="xMaxSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Aceleración (mm/s²)</label><input name="xAccelerationMmS2" type="number" min="0.1" step="0.1"></div><div class="field"><label>Holgura / backlash (mm)</label><input name="xBacklashMm" type="number" min="0" max="10" step="0.001"><span class="muted">Usá 0 para desactivar la compensación.</span></div>
  </fieldset>
  <fieldset><legend>Motor Y — ancho de cinta</legend>
    <div class="field"><label>Posición actual</label><strong id="motorYCalibrationPosition">--</strong></div>
    <div class="actions stepper-jog"><button type="button" data-axis-jog="Y" data-steps="-100" class="secondary">-100 pasos</button><button type="button" data-axis-jog="Y" data-steps="-10" class="secondary">-10</button><button type="button" data-axis-jog="Y" data-steps="-1" class="secondary">-1</button><button type="button" data-axis-jog="Y" data-steps="1" class="secondary">+1</button><button type="button" data-axis-jog="Y" data-steps="10" class="secondary">+10</button><button type="button" data-axis-jog="Y" data-steps="100" class="secondary">+100 pasos</button></div>
    <div class="actions"><button type="button" data-axis-zero="Y" class="secondary">Poner Y en cero</button></div>
    <div class="field"><label>Pasos por milímetro</label><input name="yStepsPerMm" type="number" min="0.01" step="0.01"></div><div class="field"><label>Velocidad máxima (mm/s)</label><input name="yMaxSpeedMmS" type="number" min="0.1" step="0.1"></div><div class="field"><label>Aceleración (mm/s²)</label><input name="yAccelerationMmS2" type="number" min="0.1" step="0.1"></div><div class="field"><label>Holgura / backlash (mm)</label><input name="yBacklashMm" type="number" min="0" max="10" step="0.001"><span class="muted">Se aplica cuando el eje Y invierte el sentido.</span></div>
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

function labelFormatting() {
  return {
    lineSpacingMm:number('#lineSpacing'),
    bold:$('#fontBold').checked,
    italic:$('#fontItalic').checked,
    underline:$('#fontUnderline').checked
  };
}

function normalizedCharacters(text) {
  return [...text.normalize('NFD').replace(/\p{Diacritic}/gu, '')];
}

function textMetrics(text, scale, formatting) {
  const normalized = normalizedCharacters(text);
  const baseWidth = normalized.reduce((width, rawChar, index) => {
    const glyph = VECTOR_FONT[rawChar] || VECTOR_FONT['?'];
    return width + glyph.advance * scale + (index ? mechanical.glyphSpacingMm : 0);
  }, 0);
  return baseWidth + (formatting.italic ? 1.8*scale : 0) + (formatting.bold ? 0.3*scale : 0);
}

function offsetStroke(stroke, distance) {
  return stroke.map((point,index) => {
    const before = stroke[Math.max(0,index-1)];
    const after = stroke[Math.min(stroke.length-1,index+1)];
    const dx = after[0]-before[0];
    const dy = after[1]-before[1];
    const length = Math.hypot(dx,dy) || 1;
    return [point[0]-dy/length*distance,point[1]+dx/length*distance];
  });
}

function styledStrokes(strokes, formatting) {
  if (!formatting.bold) return strokes;
  return strokes.flatMap(stroke => [offsetStroke(stroke,-0.15),stroke,offsetStroke(stroke,0.15)]);
}

function rowPaths(text, yBottom, scale, xOffset, width, formatting) {
  const paths = [];
  const boldPadding = formatting.bold ? 0.15*scale : 0;
  const underlineLift = formatting.underline ? 0.8 : 0;
  let cursor = xOffset+boldPadding;
  const normalized = normalizedCharacters(text);
  for (const rawChar of normalized) {
    const glyph = VECTOR_FONT[rawChar] || VECTOR_FONT['?'];
    styledStrokes(glyph.strokes,formatting).forEach(stroke => paths.push(stroke.map(([x,y]) => ({
      x:cursor+(x+(formatting.italic ? y*0.18 : 0))*scale,
      y:yBottom+(y+underlineLift)*scale
    }))));
    cursor += glyph.advance*scale + mechanical.glyphSpacingMm;
  }
  if (formatting.underline) {
    styledStrokes([[[0,0.15],[(width-2*boldPadding)/scale,0.15]]],formatting).forEach(stroke => paths.push(stroke.map(([x,y]) => ({ x:xOffset+boldPadding+x*scale, y:yBottom+y*scale }))));
  }
  return paths;
}

function buildLabel() {
  const width = tapeWidth();
  const rows = $('#labelFormat').value === 'two' ? 2 : 1;
  const formatting = labelFormatting();
  const texts = rows === 2 ? [$('#line1').value, $('#line2').value] : [$('#line1').value];
  if (texts.some(text => !text.trim())) throw new Error('Completá el contenido de todos los renglones.');
  const usable = width - 2*mechanical.tapeMarginMm;
  const rowGap = rows === 2 ? formatting.lineSpacingMm : 0;
  const rowHeight = (usable-rowGap*(rows-1))/rows;
  if (rowHeight <= 1) throw new Error('El margen configurado no deja espacio imprimible.');
  const scale = rowHeight/(formatting.underline ? 10.8 : 10);
  const widths = texts.map(text => textMetrics(text,scale,formatting));
  const labelLength = Math.max(...widths) + 2*mechanical.tapeMarginMm;
  const paths = [];
  texts.forEach((text,index) => {
    const yBottom = mechanical.tapeMarginMm + (rows-1-index)*(rowHeight+rowGap);
    const xOffset = mechanical.tapeMarginMm + (labelLength-widths[index])/2;
    paths.push(...rowPaths(text,yBottom,scale,xOffset,widths[index],formatting));
  });

  const up = servoAxis(mechanical.servoUpAngle);
  const down = servoAxis(mechanical.servoDownAngle);
  const dwell = fmt(mechanical.servoDelayMs/1000);
  const travelFeed = fmt(mechanical.travelSpeedMmS*60);
  const printFeed = fmt(mechanical.printSpeedMmS*60);
  const gcode = ['; Etiqueta generada por Labeler CNC','G21','G90',`G0 A${up}`,`G4 P${dwell}`,'G92 X0 Y0'];
  const position = { x:0, y:0 };
  const direction = { x:0, y:0 };
  const backlash = { x:mechanical.xBacklashMm, y:mechanical.yBacklashMm };
  const moveTo = (motion, target, feed) => {
    const nextDirection = {
      x:Math.sign(target.x-position.x),
      y:Math.sign(target.y-position.y)
    };
    const reversals = ['x','y'].filter(axis => backlash[axis] > 0 && nextDirection[axis] && direction[axis] && nextDirection[axis] !== direction[axis]);
    if (reversals.length) {
      const takeup = reversals.map(axis => `${axis.toUpperCase()}${fmt(nextDirection[axis]*backlash[axis])}`).join(' ');
      const restore = reversals.map(axis => `${axis.toUpperCase()}${fmt(position[axis])}`).join(' ');
      gcode.push('G91',`G0 ${takeup} F${travelFeed}`,'G90',`G92 ${restore}`);
    }
    gcode.push(`${motion} X${fmt(target.x)} Y${fmt(target.y)} F${feed}`);
    ['x','y'].forEach(axis => {
      if (nextDirection[axis]) direction[axis] = nextDirection[axis];
      position[axis] = target[axis];
    });
  };
  for (const path of paths) {
    if (path.length < 2) continue;
    moveTo('G0', path[0], travelFeed);
    gcode.push(`G0 A${down}`);
    gcode.push(`G4 P${dwell}`);
    path.slice(1).forEach(point => moveTo('G1', point, printFeed));
    gcode.push(`G0 A${up}`);
    gcode.push(`G4 P${dwell}`);
  }
  moveTo('G0', { x:labelLength, y:0 }, travelFeed);
  gcode.push('M2');
  return { gcode:gcode.join('\n'), labelLength, paths, width };
}

function updatePreview() {
  const width = tapeWidth();
  const two = $('#labelFormat').value === 'two';
  $('#line2Field').hidden = !two;
  $('#lineSpacing').disabled = !two;
  $('#widthInfo').textContent = `${width} mm`;
  try {
    const job = buildLabel();
    const polylines = job.paths.map(path => `<polyline points="${path.map(point => `${fmt(point.x)},${fmt(job.width-point.y)}`).join(' ')}"/>`).join('');
    $('#tapePreview').innerHTML = `<svg viewBox="0 0 ${fmt(job.labelLength)} ${fmt(job.width)}" role="img" aria-label="Recorrido vectorial del marcador">${polylines}</svg>`;
    $('#tapePreview').style.aspectRatio = `${job.labelLength} / ${job.width}`;
    $('#lengthInfo').textContent = `${job.labelLength.toFixed(1)} mm`;
  } catch {
    $('#tapePreview').innerHTML = '';
    $('#lengthInfo').textContent = '--';
  }
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

['#tapePreset','#tapeWidth','#labelFormat','#line1','#line2','#lineSpacing','#fontBold','#fontItalic','#fontUnderline'].forEach(selector => $(selector).addEventListener('input', () => {
  $('#customWidthField').hidden = $('#tapePreset').value !== 'custom';
  $('#lineSpacing').disabled = $('#labelFormat').value !== 'two';
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
