(() => {
  const families = {
    'hershey-roman-simplex': { label:'Hershey Sans (1 trazo)', type:'stroke' },
    'playwrite-de-sas-guides': { label:'Playwrite DE SAS Guides', type:'outline', regular:'vendor/google-fonts/PlaywriteDESASGuides-Regular.ttf' },
    orbitron: { label:'Orbitron', type:'outline', regular:'vendor/google-fonts/Orbitron-wght.ttf' },
    'lobster-two': {
      label:'Lobster Two', type:'outline',
      regular:'vendor/google-fonts/LobsterTwo-Regular.ttf',
      bold:'vendor/google-fonts/LobsterTwo-Bold.ttf',
      italic:'vendor/google-fonts/LobsterTwo-Italic.ttf',
      boldItalic:'vendor/google-fonts/LobsterTwo-BoldItalic.ttf'
    }
  };
  const materialFontUrl = 'vendor/material-symbols/MaterialSymbolsOutlined.ttf';
  const materialCodepointsUrl = 'vendor/material-symbols/MaterialSymbolsOutlined.codepoints';
  const fontCache = new Map();
  const glyphCache = new Map();
  let materialCodepoints = null;

  function variant(familyId, formatting) {
    const family = families[familyId];
    if (!family) throw new Error('Fuente desconocida.');
    if (family.type === 'stroke') return { family, url:null, nativeBold:false, nativeItalic:false };
    const requested = formatting.bold && formatting.italic ? 'boldItalic' : formatting.bold ? 'bold' : formatting.italic ? 'italic' : 'regular';
    return {
      family,
      url:family[requested] || family.regular,
      nativeBold:Boolean(formatting.bold && (family.bold || family.boldItalic)),
      nativeItalic:Boolean(formatting.italic && (family.italic || family.boldItalic))
    };
  }

  async function loadFont(url) {
    if (fontCache.has(url)) return fontCache.get(url);
    const promise = fetch(url,{ cache:'force-cache' }).then(response => {
      if (!response.ok) throw new Error(`No se pudo cargar ${url}: HTTP ${response.status}`);
      return response.arrayBuffer();
    }).then(buffer => window.opentype.parse(buffer));
    fontCache.set(url,promise);
    try {
      const font = await promise;
      fontCache.set(url,font);
      return font;
    } catch (error) {
      fontCache.delete(url);
      throw error;
    }
  }

  async function ensureFamily(familyId, formatting) {
    const selected = variant(familyId,formatting);
    if (selected.url) await loadFont(selected.url);
    return selected;
  }

  async function ensureIcons() {
    const [font,codepoints] = await Promise.all([
      loadFont(materialFontUrl),
      materialCodepoints || fetch(materialCodepointsUrl,{ cache:'force-cache' }).then(response => {
        if (!response.ok) throw new Error(`No se pudo cargar el catálogo de iconos: HTTP ${response.status}`);
        return response.text();
      }).then(text => new Map(text.trim().split(/\r?\n/).map(line => {
        const [name,hex] = line.trim().split(/\s+/);
        return [name,Number.parseInt(hex,16)];
      })))
    ]);
    materialCodepoints = codepoints;
    return { font,codepoints };
  }

  const distanceToLine = (point,start,end) => {
    const dx=end[0]-start[0],dy=end[1]-start[1];
    return Math.abs(dy*point[0]-dx*point[1]+end[0]*start[1]-end[1]*start[0])/(Math.hypot(dx,dy)||1);
  };

  function flattenQuadratic(start,control,end,tolerance,points,depth=0) {
    if (depth>8 || distanceToLine(control,start,end)<=tolerance) return points.push(end);
    const a=[(start[0]+control[0])/2,(start[1]+control[1])/2];
    const b=[(control[0]+end[0])/2,(control[1]+end[1])/2];
    const middle=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    flattenQuadratic(start,a,middle,tolerance,points,depth+1);
    flattenQuadratic(middle,b,end,tolerance,points,depth+1);
  }

  function flattenCubic(start,c1,c2,end,tolerance,points,depth=0) {
    if (depth>8 || Math.max(distanceToLine(c1,start,end),distanceToLine(c2,start,end))<=tolerance) return points.push(end);
    const a=[(start[0]+c1[0])/2,(start[1]+c1[1])/2];
    const b=[(c1[0]+c2[0])/2,(c1[1]+c2[1])/2];
    const c=[(c2[0]+end[0])/2,(c2[1]+end[1])/2];
    const d=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    const e=[(b[0]+c[0])/2,(b[1]+c[1])/2];
    const middle=[(d[0]+e[0])/2,(d[1]+e[1])/2];
    flattenCubic(start,a,d,middle,tolerance,points,depth+1);
    flattenCubic(middle,e,c,end,tolerance,points,depth+1);
  }

  function outlineGlyph(font,glyph,toleranceDesign) {
    const cacheKey = `${font.names.postScriptName?.en || 'font'}:${glyph.index}:${toleranceDesign.toFixed(3)}`;
    if (glyphCache.has(cacheKey)) return glyphCache.get(cacheKey);
    const factor = 10/(font.ascender-font.descender);
    const point = (x,y) => [x*factor,(y-font.descender)*factor];
    const tolerance = Math.max(0.01,toleranceDesign);
    const strokes=[];
    let stroke=null,current=null,start=null;
    for (const command of glyph.path.commands) {
      if (command.type==='M') {
        if (stroke?.length>1) strokes.push(stroke);
        current=point(command.x,command.y);start=current;stroke=[current];
      } else if (command.type==='L' && stroke) {
        current=point(command.x,command.y);stroke.push(current);
      } else if (command.type==='Q' && stroke) {
        const end=point(command.x,command.y),control=point(command.x1,command.y1);
        flattenQuadratic(current,control,end,tolerance,stroke);current=end;
      } else if (command.type==='C' && stroke) {
        const end=point(command.x,command.y),c1=point(command.x1,command.y1),c2=point(command.x2,command.y2);
        flattenCubic(current,c1,c2,end,tolerance,stroke);current=end;
      } else if (command.type==='Z' && stroke) {
        if (start && (current[0]!==start[0] || current[1]!==start[1])) stroke.push(start);
        if (stroke.length>1) strokes.push(stroke);stroke=null;current=null;start=null;
      }
    }
    if (stroke?.length>1) strokes.push(stroke);
    const result={ strokes,advance:(glyph.advanceWidth || font.unitsPerEm)*factor };
    glyphCache.set(cacheKey,result);
    return result;
  }

  function tokens(text) {
    const result=[];
    const pattern=/\{([a-z0-9_]+)\}/g;
    let cursor=0,match;
    while ((match=pattern.exec(text))) {
      if (match.index>cursor) result.push(text.slice(cursor,match.index));
      result.push({ icon:match[1] });cursor=pattern.lastIndex;
    }
    if (cursor<text.length) result.push(text.slice(cursor));
    return result;
  }

  function geometry(text,familyId,formatting,spacingDesign,toleranceDesign) {
    const selected=variant(familyId,formatting);
    const textFont=selected.url ? fontCache.get(selected.url) : null;
    if (selected.url && (!textFont || textFont instanceof Promise)) throw new Error('La fuente todavía se está cargando.');
    const iconFont=fontCache.get(materialFontUrl);
    const units=tokens(text).flatMap(unit => {
      if (typeof unit==='object') return [unit];
      if (selected.family.type==='stroke') return [...unit];
      return textFont.stringToGlyphs(unit).map(glyph => ({ glyph,font:textFont }));
    });
    const strokes=[];
    let cursor=0,previousGlyph=null,previousFont=null;
    units.forEach((unit,index) => {
      let glyphData,glyph,font;
      if (unit.icon) {
        if (!materialCodepoints || !iconFont || iconFont instanceof Promise) throw new Error('El catálogo de iconos todavía se está cargando.');
        const codepoint=materialCodepoints.get(unit.icon);
        if (!codepoint) throw new Error(`Icono desconocido: ${unit.icon}`);
        font=iconFont;glyph=font.charToGlyph(String.fromCodePoint(codepoint));
        glyphData=outlineGlyph(font,glyph,toleranceDesign);previousGlyph=null;previousFont=null;
      } else if (typeof unit==='string') {
        const character=unit.normalize('NFD').replace(/\p{Diacritic}/gu,'');
        glyphData=window.LABELER_VECTOR_FONT[character] || window.LABELER_VECTOR_FONT['?'];previousGlyph=null;previousFont=null;
      } else {
        font=unit.font;glyph=unit.glyph;
        if (previousGlyph && previousFont===font) cursor+=font.getKerningValue(previousGlyph,glyph)*10/(font.ascender-font.descender);
        glyphData=outlineGlyph(font,glyph,toleranceDesign);previousGlyph=glyph;previousFont=font;
      }
      glyphData.strokes.forEach(stroke => strokes.push(stroke.map(([x,y]) => [cursor+x,y])));
      cursor+=glyphData.advance+(index<units.length-1 ? spacingDesign : 0);
    });
    return { strokes,advance:cursor,selected };
  }

  function iconNames(query='') {
    if (!materialCodepoints) return [];
    const normalized=query.trim().toLowerCase().replace(/\s+/g,'_');
    return [...materialCodepoints.keys()].filter(name => !normalized || name.includes(normalized));
  }

  function iconGeometry(name,toleranceDesign=0.08) {
    const font=fontCache.get(materialFontUrl);
    const codepoint=materialCodepoints?.get(name);
    if (!font || font instanceof Promise || !codepoint) return null;
    return outlineGlyph(font,font.charToGlyph(String.fromCodePoint(codepoint)),toleranceDesign);
  }

  window.LabelerOutlineFonts={ families,variant,ensureFamily,ensureIcons,geometry,iconNames,iconGeometry };
})();
