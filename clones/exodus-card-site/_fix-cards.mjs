import fs from 'fs';
const p = 'clones/exodus-card-site/assets/index-CtuewKp5.js';
let s = fs.readFileSync(p, 'utf8');
const reps = [
  ['font-style:italic">TRUST</span>', 'font-style:normal;letter-spacing:.12em">EXODUS</span>'],
  ['linear-gradient(135deg,#1a3fa0,#2563eb)', 'linear-gradient(135deg,#0b46f9,#8952ff)'],
  ['linear-gradient(135deg,#1a2860,#1e3a8a)', 'linear-gradient(135deg,#1a1050,#5b2fd6)'],
  ['linear-gradient(135deg,#111118,#1c1c2e)', 'linear-gradient(135deg,#05060a,#1a1230)'],
];
for (const [a, b] of reps) {
  const c = s.split(a).length - 1;
  console.log((c ? 'OK x' + c : 'MISS') + ' | ' + a.slice(0, 48));
  s = s.split(a).join(b);
}
console.log('>TRUST< left', (s.match(/>TRUST</g) || []).length);
fs.writeFileSync(p, s);
console.log('done', s.length);
