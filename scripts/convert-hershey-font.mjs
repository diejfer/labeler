import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'github-pages', 'vendor', 'hershey', 'rowmans.jhf');
const outputPath = path.join(root, 'github-pages', 'vector-font.js');
const characterNumbers = {
  A:501,B:502,C:503,D:504,E:505,F:506,G:507,H:508,I:509,J:510,K:511,L:512,M:513,N:514,O:515,P:516,Q:517,R:518,S:519,T:520,U:521,V:522,W:523,X:524,Y:525,Z:526,
  a:601,b:602,c:603,d:604,e:605,f:606,g:607,h:608,i:609,j:610,k:611,l:612,m:613,n:614,o:615,p:616,q:617,r:618,s:619,t:620,u:621,v:622,w:623,x:624,y:625,z:626,
  ' ':699,'0':700,'1':701,'2':702,'3':703,'4':704,'5':705,'6':706,'7':707,'8':708,'9':709,'.':710,',':711,':':712,';':713,'!':714,'?':715,'"':717,'°':718,'$':719,'/':720,'(':721,')':722,'|':723,'-':724,'+':725,'=':726,"'":731,'#':733,'&':734,'\\':804,'_':999,'*':2219,'[':2223,']':2224,'{':2225,'}':2226,'<':2241,'>':2242,'~':2246,'%':2271,'@':2273
};
const origin = 'R'.charCodeAt(0);
const descriptors = {};

for (const line of fs.readFileSync(sourcePath, 'ascii').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const number = Number.parseInt(line.slice(0,5),10);
  const vertexCount = Number.parseInt(line.slice(5,8),10)-1;
  const left = line.charCodeAt(8)-origin;
  const right = line.charCodeAt(9)-origin;
  const strokes = [[]];
  for (let index=0; index<vertexCount; index++) {
    const x = line.charCodeAt(10+index*2)-origin;
    const y = line.charCodeAt(11+index*2)-origin;
    if (x === -50 && y === 0) strokes.push([]);
    else strokes.at(-1).push([x,-y]);
  }
  descriptors[number] = { left, right, strokes:strokes.filter(stroke => stroke.length) };
}

const scale = 10/28;
const round = value => Number(value.toFixed(4));
const font = {};
for (const [character,number] of Object.entries(characterNumbers)) {
  const descriptor = descriptors[number];
  if (!descriptor) throw new Error(`Falta el glifo Hershey ${number} para ${character}`);
  font[character] = {
    strokes:descriptor.strokes.map(stroke => stroke.map(([x,y]) => [round((x-descriptor.left)*scale),round((y+16)*scale)])),
    advance:round((descriptor.right-descriptor.left)*scale)
  };
}

const banner = `// Generated from Hershey Roman Simplex. Do not edit by hand.\n// Original font: Dr. A. V. Hershey, U.S. National Bureau of Standards.\n// JHF distribution format: James Hurt, Cognition, Inc.\n// See vendor/hershey/HERSHEY-LICENSE.txt and scripts/convert-hershey-font.mjs.\n`;
fs.writeFileSync(outputPath, `${banner}(() => {\n  window.LABELER_VECTOR_FONT = ${JSON.stringify(font)};\n})();\n`);
console.log(`Generated ${Object.keys(font).length} Hershey glyphs in ${outputPath}`);
