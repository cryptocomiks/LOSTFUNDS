// Gentle sound design for the 15s lostfunds reel, synthesized from scratch → reel.wav (48 kHz stereo).
import { writeFileSync } from "node:fs";

const SR = 48000, DUR = 15, N = SR * DUR;
const dryL = new Float32Array(N), dryR = new Float32Array(N);
const send = new Float32Array(N); // reverb send (mono)

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const smooth = (x) => x * x * (3 - 2 * x);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

function add(i, l, r, s = 0) { if (i >= 0 && i < N) { dryL[i] += l; dryR[i] += r; send[i] += s; } }

/* ───── pad: chord progression with slow crossfades ───── */
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12); // midi → Hz
const CHORDS = [
  { t: 0, notes: [45, 52, 57, 61, 64, 68] },      // A maj9-ish (A2 E3 A3 C#4 E4 G#4)
  { t: 5.2, notes: [42, 49, 54, 57, 61, 64] },    // F#m7 (tension: the problem)
  { t: 8.0, notes: [50, 57, 61, 64, 66, 69] },    // Dmaj9 (the product)
  { t: 11.2, notes: [45, 52, 57, 61, 64, 71] },   // A add9 (resolution)
];
function chordGain(ci, t) {
  const start = CHORDS[ci].t, end = CHORDS[ci + 1]?.t ?? 99;
  const inG = ci === 0 ? 1 : smooth(clamp((t - start + 0.35) / 0.7));
  const outG = 1 - smooth(clamp((t - end + 0.35) / 0.7));
  return inG * outG;
}
for (let ci = 0; ci < CHORDS.length; ci++) {
  CHORDS[ci].notes.forEach((m, k) => {
    const f = hz(m), amp = 0.045 / (1 + k * 0.15);
    const detune = [0.997, 1.003];
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      const gC = chordGain(ci, t);
      if (gC <= 0) continue;
      const master = smooth(clamp(t / 2.2)) * (1 - smooth(clamp((t - 13.9) / 1.1))) * (1 + 0.35 * smooth(clamp((t - 11.1) / 0.8)) * (1 - smooth(clamp((t - 13) / 1.2))));
      const lfo = 1 + 0.25 * Math.sin(2 * Math.PI * (0.13 + k * 0.03) * t + k);
      const a = amp * gC * master * lfo;
      const sL = Math.sin(2 * Math.PI * f * detune[0] * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t);
      const sR = Math.sin(2 * Math.PI * f * detune[1] * t + 0.7) + 0.25 * Math.sin(2 * Math.PI * f * 2.001 * t);
      add(i, a * sL, a * sR, a * 0.25 * (sL + sR));
    }
  });
}

/* ───── soft sub thumps on the cuts ───── */
for (const [t0, lvl] of [[0.62, 0.3], [2.4, 0.22], [5.2, 0.26], [8.0, 0.22], [11.2, 0.3], [13.25, 0.26]]) {
  let ph = 0;
  for (let i = 0; i < SR * 0.9; i++) {
    const t = i / SR, f = 38 + 55 * Math.exp(-t * 9);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, t / 0.008) * Math.exp(-t * 5.5);
    const v = lvl * env * Math.sin(ph);
    add(Math.floor(t0 * SR) + i, v, v, 0);
  }
}

/* ───── whooshes: noise through a sweeping resonant band-pass (state-variable filter) ───── */
function whoosh(t0, dur, lvl, pan = 0) {
  let low = 0, band = 0;
  for (let i = 0; i < SR * dur; i++) {
    const u = i / (SR * dur);
    const fc = 250 + 3200 * Math.sin(Math.PI * u) ** 2;
    const F = 2 * Math.sin((Math.PI * fc) / SR), Q = 0.35;
    const x = rand();
    low += F * band; const high = x - low - Q * band; band += F * high;
    const env = Math.sin(Math.PI * u) ** 2;
    const v = lvl * env * band;
    const p = pan + 0.6 * (u - 0.5); // moves across the stereo field
    add(Math.floor(t0 * SR) + i, v * (1 - p) * 0.7, v * (1 + p) * 0.7, v * 0.4);
  }
}
whoosh(2.05, 0.55, 0.16, -0.2); whoosh(4.9, 0.6, 0.18, 0.2); whoosh(7.7, 0.55, 0.15, -0.1); whoosh(10.95, 0.55, 0.17, 0.1); whoosh(12.95, 0.6, 0.14, 0);

/* ───── plucks & bells ───── */
function pluck(t0, f, lvl, decay = 3.5, pan = 0, wet = 0.8) {
  for (let i = 0; i < SR * 1.6; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * decay);
    const v = lvl * env * (Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 6));
    add(Math.floor(t0 * SR) + i, v * (1 - pan), v * (1 + pan), v * wet);
  }
}
function bell(t0, f, lvl, pan = 0) {
  const parts = [[1, 1, 1.3], [2.76, 0.35, 2.2], [5.4, 0.16, 3.5], [8.93, 0.07, 5]];
  for (let i = 0; i < SR * 3; i++) {
    const t = i / SR;
    let v = 0;
    for (const [r, a, d] of parts) v += a * Math.exp(-t * d) * Math.sin(2 * Math.PI * f * r * t);
    v *= lvl * Math.min(1, t / 0.003);
    add(Math.floor(t0 * SR) + i, v * (1 - pan), v * (1 + pan), v * 0.9);
  }
}
// logo shimmer
[81, 85, 88, 93].forEach((m, k) => pluck(0.78 + k * 0.09, hz(m), 0.05, 3, (k - 1.5) * 0.25));
// wordmark sparkle
[93, 97].forEach((m, k) => pluck(1.35 + k * 0.1, hz(m), 0.025, 4, 0.3 - k * 0.6));
// scene 2: soft note when the coin gets stuck
pluck(4.05, hz(66), 0.05, 2.2, -0.1);
pluck(4.12, hz(61), 0.04, 2.2, 0.1);
// scene 3: node pops (pentatonic, gentle)
[69, 73, 76, 78, 81, 85].forEach((m, k) => pluck(5.32 + k * 0.07, hz(m), 0.022, 7, (k - 2.5) * 0.2));
// stuck markers: low warm blips
[1, 3, 4].forEach((i) => pluck(6.2 + i * 0.12, hz(57 + i), 0.045, 5, i === 1 ? 0.4 : -0.3));

/* ───── UI: typing clicks, button, chip pings ───── */
function click(t0, lvl, bright = 0.85) {
  let hp = 0, prev = 0;
  for (let i = 0; i < SR * 0.012; i++) {
    const x = rand(); hp = bright * (hp + x - prev); prev = x;
    const env = Math.exp(-(i / SR) * 500);
    const v = lvl * env * hp;
    add(Math.floor(t0 * SR) + i, v, v, v * 0.2);
  }
}
const ADDR_LEN = 42;
for (let c = 0; c < ADDR_LEN; c++) click(8.4 + (c / ADDR_LEN) * 0.75 + (rand() * 0.004), 0.03 + 0.01 * rand());
// button press
for (let i = 0; i < SR * 0.12; i++) { const t = i / SR, v = 0.12 * Math.exp(-t * 40) * Math.sin(2 * Math.PI * (160 - 400 * t) * t); add(Math.floor(9.24 * SR) + i, v, v, 0.05 * v); }
click(9.22, 0.05, 0.6);
// chips: ascending pings as each check lands
const PENT = [81, 83, 85, 88, 90, 93, 95, 97];
for (let k = 0; k < 15; k++) {
  const t0 = 9.55 + k * 0.045 + 0.38;
  if (k === 11) { pluck(t0, hz(69), 0.07, 3, 0, 0.9); pluck(t0 + 0.05, hz(76), 0.05, 3, 0, 0.9); continue; } // the hit
  pluck(t0, hz(PENT[k % PENT.length]), 0.016, 14, ((k % 5) - 2) * 0.3, 0.5);
}

/* ───── reveal: counter ticks + bell ───── */
for (let k = 0; k < 18; k++) {
  const u = k / 17, t0 = 11.45 + (1 - Math.pow(1 - u, 0.35)) * 0.95; // ticks slow down with the counter
  click(t0, 0.015 + 0.01 * (1 - u), 0.7);
}
bell(12.15, hz(81), 0.07, -0.15);
bell(12.28, hz(88), 0.05, 0.15);

/* ───── outro: shimmer arpeggio + low bloom ───── */
[81, 85, 88, 92, 93].forEach((m, k) => pluck(13.3 + k * 0.08, hz(m), 0.035, 2.5, (k - 2) * 0.25));
for (let i = 0; i < SR * 1.7; i++) { const t = i / SR, env = Math.min(1, t / 0.3) * Math.exp(-t * 1.6), v = 0.09 * env * Math.sin(2 * Math.PI * 55 * t); add(Math.floor(13.25 * SR) + i, v, v, 0); }

/* ───── reverb (Schroeder: 4 combs + 2 allpasses per side) on the send bus ───── */
function reverb(input, offset) {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round((d + offset) * SR / 44100));
  for (const d of combs) {
    const buf = new Float32Array(d); let idx = 0, lp = 0;
    for (let i = 0; i < N; i++) { const y = buf[idx]; lp = y * 0.7 + lp * 0.3; buf[idx] = input[i] + lp * 0.84; idx = (idx + 1) % d; out[i] += y * 0.25; }
  }
  for (const d0 of [225, 556]) {
    const d = Math.round((d0 + offset / 3) * SR / 44100); const buf = new Float32Array(d); let idx = 0;
    for (let i = 0; i < N; i++) { const b = buf[idx]; const y = -out[i] + b; buf[idx] = out[i] + b * 0.5; out[i] = y; idx = (idx + 1) % d; }
  }
  return out;
}
const wetL = reverb(send, 0), wetR = reverb(send, 23);

/* ───── master: mix, gentle saturation, fades, normalize ───── */
const L = new Float32Array(N), R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = clamp(t / 0.25) * (1 - smooth(clamp((t - 14.6) / 0.4)));
  L[i] = Math.tanh((dryL[i] + wetL[i] * 0.42) * 1.2) * fade;
  R[i] = Math.tanh((dryR[i] + wetR[i] * 0.42) * 1.2) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 0.58 / peak; // headroom: not aggressive
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(clamp(L[i] * gain, -1, 1) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(clamp(R[i] * gain, -1, 1) * 32767), 46 + i * 4);
}
writeFileSync("reel.wav", buf);
console.log("reel.wav written, peak before gain", peak.toFixed(3));
