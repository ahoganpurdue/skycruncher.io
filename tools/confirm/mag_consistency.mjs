#!/usr/bin/env node
// MAGNITUDE-CONSISTENCY DISCRIMINATOR (#2) — evidence measurement from BANKED artifacts.
// EVIDENCE-ONLY. Reports what is measured. Wrong-arm coincidences modeled by a
// label-permutation surrogate over REAL measured fluxes + REAL catalog mags
// (honestly labeled). No engine edits, no live solves.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC = 'test_results/g15u_cr2_adjudication_2026-07-22';
const OUT = 'test_results/magconsistency_2026-07-22';
fs.mkdirSync(OUT, { recursive: true });

const hy = JSON.parse(fs.readFileSync(path.join(SRC, 'hybrid_targets.json'), 'utf8'));
const g15 = JSON.parse(fs.readFileSync(path.join(SRC, 'g15u_targets.json'), 'utf8'));

// ---- helpers ----
const median = a => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.floor(s.length/2)]:NaN; };
const quantile = (a,q)=>{ const s=[...a].sort((x,y)=>x-y); if(!s.length) return NaN; const i=Math.min(s.length-1,Math.floor(q*(s.length-1))); return s[i]; };
function mulberry32(seed){ return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

// instrumental magnitude from measured SNR proxy: m_inst = -2.5 log10(snr).
// ZP fit so that <m_inst + ZP> == <catalog G> over a robust anchor set.
const instFromSnr = snr => -2.5 * Math.log10(snr);

// ---- 1. ZP fit from the TRUE-arm confirmed anchor (CR2 hybrid) ----
const hyConf = hy.filter(t => t.confirmed && t.snr > 0);
const hyAcc  = hy.filter(t => t.accepted && t.snr > 0);
const g15Acc = g15.filter(t => t.accepted && t.snr > 0); // true-WCS, false-refused arm (real stars)
// robust ZP = median(catalogG - m_inst) over confirmed true stars
const zpSamples = hyConf.map(t => t.mag - instFromSnr(t.snr));
const ZP = median(zpSamples);
const dmag = t => (instFromSnr(t.snr) + ZP) - t.mag;

// correlation diagnostics
function corr(pts){ const x=pts.map(t=>t.mag), y=pts.map(t=>Math.log10(t.snr)); const n=x.length; const mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n; let sxy=0,sxx=0,syy=0; for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;} return {slope:sxy/sxx, r:sxy/Math.sqrt(sxx*syy), n}; }

// ---- 2. TRUE-arm |Δmag| distribution (admitted = confirmed; candidate = accepted) ----
const trueAdmitted = hyConf.map(t => ({ r:t.r_norm, dmag:dmag(t), snr:t.snr, mag:t.mag }));
const trueCandidate = [...hyAcc, ...g15Acc].map(t => ({ r:t.r_norm, dmag:dmag(t), snr:t.snr, mag:t.mag }));

// radial trend on true admitted+candidate (vignetting envelope)
const radialBins = [[0,0.145],[0.145,0.3],[0.3,0.45],[0.45,0.7],[0.7,1.01]];
const trueAll = trueCandidate;
const radialTrend = radialBins.map(([lo,hi])=>{
  const inb = trueAll.filter(p=>p.r>=lo && p.r<hi);
  const ad = inb.map(p=>Math.abs(p.dmag));
  return { bin:`${lo}-${hi}`, n:inb.length,
    dmag_med: inb.length? median(inb.map(p=>p.dmag)):null,
    abs_p90: inb.length? quantile(ad,0.90):null,
    abs_p99: inb.length? quantile(ad,0.99):null,
    abs_max: inb.length? Math.max(...ad):null };
});

// ---- 3. WRONG-arm coincidence surrogate (label permutation) ----
// A wrong WCS mislabels which catalog star each real source is: measured flux is
// REAL (from an actual source in the frame), claimed catalog G is RANDOM. Admission
// requires a real source (high SNR), so draw instr_mag from the REAL admitted/candidate
// source pool and pair with a random catalog G from the examined catalog mag pool.
const sourcePool = trueCandidate; // real measured sources (flux + r_norm)
const magPool = hy.concat(g15).filter(t=>t.snr>0).map(t=>t.mag); // catalog mag distribution
const rng = mulberry32(20260722);
const NPERM = 20000;
const wrong = [];
for(let i=0;i<NPERM;i++){
  const s = sourcePool[Math.floor(rng()*sourcePool.length)];
  const claimedG = magPool[Math.floor(rng()*magPool.length)];
  const mInst = instFromSnr(s.snr) + ZP;
  wrong.push({ r:s.r, dmag: mInst - claimedG, snr:s.snr, claimedG });
}
// restrict wrong surrogate to the admission SNR regime actually seen in true admits
const admitSnrMin = Math.min(...trueAdmitted.map(t=>t.snr));
const wrongAdmit = wrong.filter(w=>w.snr>=admitSnrMin);
// tighter admission regime = the approx-confirm SNR floor (snrConfirmFloorApprox=5),
// the floor at which BY admissions like the row-539 singleton actually occur
const wrongAdmit5 = wrong.filter(w=>w.snr>=5);

// ---- 4. ROC: constant bound and radial bound ----
function retain(pop, boundFn){ let k=0; for(const p of pop){ if(Math.abs(p.dmag)<=boundFn(p.r)) k++; } return k/pop.length; }
const constBounds = [0.5,0.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0];
const rocConst = constBounds.map(b=>({
  bound:b,
  true_admit_retain: retain(trueAdmitted, ()=>b),
  true_cand_retain: retain(trueCandidate, ()=>b),
  wrong_reject_snr3: 1-retain(wrongAdmit, ()=>b),
  wrong_reject_snr5: 1-retain(wrongAdmit5, ()=>b),
}));
// radial bound form: bound(r) = base + slope * max(0, r - r0)  (vignette allowance beyond r0)
const r0 = 0.145;
function radialBoundFactory(base, slope){ return r => base + slope*Math.max(0, r-r0); }
const radialForms = [ [0.75,1.5],[1.0,1.5],[1.0,2.0],[0.75,2.5],[1.0,2.5] ];
const rocRadial = radialForms.map(([base,slope])=>{
  const f=radialBoundFactory(base,slope);
  return { form:`${base}+${slope}*(r-${r0})`, base, slope,
    true_admit_retain: retain(trueAdmitted, f),
    true_cand_retain: retain(trueCandidate, f),
    wrong_reject: 1-retain(wrongAdmit, f) };
});

// recommended: smallest constant bound keeping >=99% true admitted, then its wrong rejection
const p99true = quantile(trueAdmitted.map(t=>Math.abs(t.dmag)),0.99);
const p99cand = quantile(trueCandidate.map(t=>Math.abs(t.dmag)),0.99);

// ---- 5. Row-539 singleton evaluation ----
// singleton: k=1/32, per-star excess z ~ 8.0. Exact (snr, claimedG, r) not banked
// per-star; model with snr≈z=8 and the examined-set's favored bright catalog star.
const singZ = 8.0;
const singInst = instFromSnr(singZ) + ZP;
// claimed G scenarios: bright examined star (min mag), median examined mag
const examinedMags = hy.filter(t=>t.accepted).map(t=>t.mag);
const brightClaim = Math.min(...examinedMags);
const medClaim = median(examinedMags);
const singScenarios = [
  { claim:'bright_examined', G:brightClaim, dmag: singInst-brightClaim },
  { claim:'median_examined', G:medClaim, dmag: singInst-medClaim },
];

const result = {
  meta:{ frame:'sample_observation.cr2 (CR2 true-arm banked)', source:SRC,
    note:'wrong-arm = label-permutation surrogate over REAL measured fluxes + REAL catalog mags; snr used as measured-flux proxy (m_inst=-2.5log10 snr)',
    ZP, admitSnrMin, NPERM },
  correlation:{ confirmed:corr(hyConf), accepted:corr(hyAcc) },
  true_arm:{ n_admitted:trueAdmitted.length, n_candidate:trueCandidate.length,
    abs_dmag_admitted:{med:median(trueAdmitted.map(t=>Math.abs(t.dmag))), p90:quantile(trueAdmitted.map(t=>Math.abs(t.dmag)),0.9), p99:p99true, max:Math.max(...trueAdmitted.map(t=>Math.abs(t.dmag)))},
    abs_dmag_candidate:{med:median(trueCandidate.map(t=>Math.abs(t.dmag))), p90:quantile(trueCandidate.map(t=>Math.abs(t.dmag)),0.9), p99:p99cand},
    radial_trend:radialTrend },
  wrong_arm:{ n_surrogate:wrongAdmit.length, admitSnrMin,
    abs_dmag:{med:median(wrongAdmit.map(t=>Math.abs(t.dmag))), p50:quantile(wrongAdmit.map(t=>Math.abs(t.dmag)),0.5), p90:quantile(wrongAdmit.map(t=>Math.abs(t.dmag)),0.9)} },
  roc_const:rocConst,
  roc_radial:rocRadial,
  recommended:{ p99_true_admitted:p99true, p99_true_candidate:p99cand },
  singleton_row539:{ z:singZ, m_inst_at_z:singInst, scenarios:singScenarios },
};
fs.writeFileSync(path.join(OUT,'roc_and_bounds.json'), JSON.stringify(result,null,2));

// ---- PNG scatter: Δmag vs r_norm, true (blue) vs wrong (red) ----
function makePNG(width,height,draw){
  const buf = Buffer.alloc(width*height*4);
  for(let i=0;i<buf.length;i+=4){ buf[i]=255;buf[i+1]=255;buf[i+2]=255;buf[i+3]=255; }
  const px=(x,y,r,g,b,a=255)=>{ x=Math.round(x);y=Math.round(y); if(x<0||y<0||x>=width||y>=height)return; const o=(y*width+x)*4; const af=a/255; buf[o]=Math.round(buf[o]*(1-af)+r*af); buf[o+1]=Math.round(buf[o+1]*(1-af)+g*af); buf[o+2]=Math.round(buf[o+2]*(1-af)+b*af); };
  const disc=(x,y,rad,r,g,b,a)=>{ for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++) if(dx*dx+dy*dy<=rad*rad) px(x+dx,y+dy,r,g,b,a); };
  draw({px,disc});
  // PNG encode (RGBA, filter 0 per row)
  const raw=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++){ raw[y*(width*4+1)]=0; buf.copy(raw,y*(width*4+1)+1,y*width*4,(y+1)*width*4); }
  const idat=zlib.deflateSync(raw);
  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc=b=>{let c=0xffffffff;for(let i=0;i<b.length;i++)c=crcTable[(c^b[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
  const chunk=(type,data)=>{ const len=Buffer.alloc(4);len.writeUInt32BE(data.length); const t=Buffer.from(type); const cd=Buffer.concat([t,data]); const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(cd)); return Buffer.concat([len,cd,cr]); };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
}
const W=900,H=560, mL=70,mR=20,mT=40,mB=60;
const pw=W-mL-mR, ph=H-mT-mB;
const yMin=-6, yMax=6; // Δmag range
const xOf=r=>mL + r*pw;
const yOf=d=>mT + (1-(d-yMin)/(yMax-yMin))*ph;
// compact 3x5 bitmap font for tick labels (digits, '.', '-')
const FONT={
 '0':['111','101','101','101','111'],'1':['010','110','010','010','111'],
 '2':['111','001','111','100','111'],'3':['111','001','111','001','111'],
 '4':['101','101','111','001','001'],'5':['111','100','111','001','111'],
 '6':['111','100','111','101','111'],'7':['111','001','010','010','010'],
 '8':['111','101','111','101','111'],'9':['111','101','111','001','111'],
 '.':['000','000','000','000','010'],'-':['000','000','111','000','000'],' ':['000','000','000','000','000']};
function text(px,x,y,str,r,g,b,sc=1){ let cx=x; for(const ch of str){ const gl=FONT[ch]||FONT[' ']; for(let ry=0;ry<5;ry++)for(let rx=0;rx<3;rx++) if(gl[ry][rx]==='1') for(let sy=0;sy<sc;sy++)for(let sx=0;sx<sc;sx++) px(cx+rx*sc+sx,y+ry*sc+sy,r,g,b); cx+=4*sc; } }
const png=makePNG(W,H,({px,disc})=>{
  // axes
  for(let x=0;x<pw;x++){ px(mL+x,mT+ph,60,60,60); px(mL+x,yOf(0),200,200,200,120);} // x-axis + zero line
  for(let y=0;y<ph;y++) px(mL,mT+y,60,60,60);
  // gridlines every 2 mag
  for(let d=yMin; d<=yMax; d+=2){ const yy=yOf(d); for(let x=0;x<pw;x+=6) px(mL+x,yy,220,220,220,100); }
  // wrong surrogate (subsample for legibility) - red
  const step=Math.max(1,Math.floor(wrongAdmit.length/3000));
  for(let i=0;i<wrongAdmit.length;i+=step){ const w=wrongAdmit[i]; disc(xOf(w.r),yOf(Math.max(yMin,Math.min(yMax,w.dmag))),2,220,60,60,70); }
  // true candidate - light blue
  for(const t of trueCandidate){ disc(xOf(t.r),yOf(Math.max(yMin,Math.min(yMax,t.dmag))),3,80,140,230,150); }
  // true admitted - dark blue larger
  for(const t of trueAdmitted){ disc(xOf(t.r),yOf(Math.max(yMin,Math.min(yMax,t.dmag))),4,20,50,180,230); }
  // recommended bound curves: constant p99 (green) and radial (orange)
  const bC=p99cand;
  for(let x=0;x<pw;x+=2){ const yy1=yOf(bC),yy2=yOf(-bC); px(mL+x,yy1,30,160,60,220); px(mL+x,yy2,30,160,60,220); }
  // y ticks (dmag)
  for(let d=-4; d<=4; d+=2){ const yy=yOf(d); for(let k=0;k<4;k++)px(mL-1-k,yy,60,60,60); text(px,mL-34,yy-2,(d<0?'-':'')+Math.abs(d),40,40,40,2); }
  // x ticks (r_norm)
  for(const rv of [0,0.25,0.5,0.75,1.0]){ const xx=xOf(rv); for(let k=0;k<4;k++)px(xx,mT+ph+1+k,60,60,60); text(px,xx-8,mT+ph+8,rv.toFixed(2),40,40,40,2); }
  // legend swatches (top-left): blue disc = true admitted, red = wrong-permuted
  disc(mL+10,16,4,20,50,180,255); disc(mL+120,16,3,220,60,60,255);
});
fs.writeFileSync(path.join(OUT,'dmag_vs_rnorm.png'), png);

console.log('ZP=',ZP.toFixed(4),'admitSnrMin=',admitSnrMin.toFixed(2));
console.log('corr confirmed', JSON.stringify(result.correlation.confirmed));
console.log('TRUE admitted |dmag| p99=',p99true.toFixed(3),'candidate p99=',p99cand.toFixed(3));
console.log('WRONG surrogate |dmag| med=',median(wrongAdmit.map(t=>Math.abs(t.dmag))).toFixed(3));
console.log('ROC const:'); for(const r of rocConst) console.log('  b='+r.bound, 'trueAdmit='+(r.true_admit_retain*100).toFixed(1)+'%', 'trueCand='+(r.true_cand_retain*100).toFixed(1)+'%', 'wrongRej(snr>=3.5)='+(r.wrong_reject_snr3*100).toFixed(1)+'%', 'wrongRej(snr>=5)='+(r.wrong_reject_snr5*100).toFixed(1)+'%');
console.log('Singleton z=8:', JSON.stringify(singScenarios.map(s=>({claim:s.claim,G:+s.G.toFixed(2),dmag:+s.dmag.toFixed(2)}))));
console.log('radial trend:'); for(const rb of radialTrend) console.log('  '+rb.bin, 'n='+rb.n, 'med='+(rb.dmag_med==null?'-':rb.dmag_med.toFixed(2)), 'p99abs='+(rb.abs_p99==null?'-':rb.abs_p99.toFixed(2)));
console.log('wrote', path.join(OUT,'roc_and_bounds.json'), 'and dmag_vs_rnorm.png');
