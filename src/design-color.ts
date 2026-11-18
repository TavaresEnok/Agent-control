/** Contraste WCAG, ΔE2000 e APCA Lc. Números, sem texto de terceiros. */

export type Rgb = {r: number; g: number; b: number; a?: number};

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: Rgb): number {
  return 0.2126729 * channel(rgb.r) + 0.7151522 * channel(rgb.g) + 0.072175 * channel(rgb.b);
}

export function wcagContrast(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function pivot(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
}

function lab(rgb: Rgb): {L: number; a: number; b: number} {
  const r = channel(rgb.r);
  const g = channel(rgb.g);
  const b = channel(rgb.b);
  const x = pivot((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = pivot(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = pivot((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return {L: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z)};
}

function hue(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const angle = Math.atan2(b, a) * (180 / Math.PI);
  return angle >= 0 ? angle : angle + 360;
}

/** CIEDE2000. Cor idêntica devolve 0. */
export function deltaE2000(left: Rgb, right: Rgb): number {
  const lab1 = lab(left);
  const lab2 = lab(right);
  const avgL = (lab1.L + lab2.L) / 2;
  const c1 = Math.hypot(lab1.a, lab1.b);
  const c2 = Math.hypot(lab2.a, lab2.b);
  const avgC = (c1 + c2) / 2;
  const c7 = avgC ** 7;
  const g = 0.5 * (1 - Math.sqrt(c7 / (c7 + (25 ** 7))));
  const a1 = lab1.a * (1 + g);
  const a2 = lab2.a * (1 + g);
  const c1p = Math.hypot(a1, lab1.b);
  const c2p = Math.hypot(a2, lab2.b);
  const avgCp = (c1p + c2p) / 2;
  const h1 = hue(a1, lab1.b);
  const h2 = hue(a2, lab2.b);
  const dh = c1p === 0 || c2p === 0 ? 0 : Math.abs(h1 - h2) <= 180 ? h2 - h1 : h2 <= h1 ? h2 - h1 + 360 : h2 - h1 - 360;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * Math.PI) / 360);
  const avgHp = c1p === 0 || c2p === 0
    ? h1 + h2
    : Math.abs(h1 - h2) > 180
      ? (h1 + h2 + 360) / 2
      : (h1 + h2) / 2;
  const t = 1
    - 0.17 * Math.cos(((avgHp - 30) * Math.PI) / 180)
    + 0.24 * Math.cos((2 * avgHp * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180)
    - 0.20 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);
  const dLp = lab2.L - lab1.L;
  const dCp = c2p - c1p;
  const sl = 1 + (0.015 * ((avgL - 50) ** 2)) / Math.sqrt(20 + ((avgL - 50) ** 2));
  const sc = 1 + 0.045 * avgCp;
  const sh = 1 + 0.015 * avgCp * t;
  const avgCp7 = avgCp ** 7;
  const rc = 2 * Math.sqrt(avgCp7 / (avgCp7 + (25 ** 7)));
  const dt = 30 * Math.exp(-(((avgHp - 275) / 25) ** 2));
  const rt = -Math.sin((2 * dt * Math.PI) / 180) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

/**
 * APCA Lc (SAPC 0.0.98G), informativo. Texto preto em fundo branco fica acima de 100.
 * O sinal segue o par: positivo quando o fundo é mais claro.
 */
export function apcaLc(text: Rgb, background: Rgb): number {
  const normBG = 0.56;
  const normTXT = 0.57;
  const revTXT = 0.62;
  const revBG = 0.65;
  const blkThrs = 0.022;
  const blkClmp = 1.414;
  const scaleBoW = 1.14;
  const scaleWoB = 1.14;
  const loBoWoffset = 0.027;
  const loWoBoffset = 0.027;
  const loClip = 0.1;
  const deltaYmin = 0.0005;
  let textY = luminance(text);
  let backgroundY = luminance(background);
  if (textY <= blkThrs) textY += (blkThrs - textY) ** blkClmp;
  if (backgroundY <= blkThrs) backgroundY += (blkThrs - backgroundY) ** blkClmp;
  if (Math.abs(backgroundY - textY) < deltaYmin) return 0;
  if (backgroundY > textY) {
    const sapc = (backgroundY ** normBG - textY ** normTXT) * scaleBoW;
    return (sapc < loClip ? 0 : sapc - loBoWoffset) * 100;
  }
  const sapc = (backgroundY ** revBG - textY ** revTXT) * scaleWoB;
  return (sapc > -loClip ? 0 : sapc + loWoBoffset) * 100;
}

/** Src-over. Alfa ausente vale 1. Fundo opaco devolve `a: 1`. */
export function compositeRgb(foreground: Rgb, background: Rgb): Rgb {
  const fgA = foreground.a ?? 1;
  const bgA = background.a ?? 1;
  const outA = fgA + bgA * (1 - fgA);
  if (outA <= 0) return {r: 0, g: 0, b: 0, a: 0};
  const mix = (fg: number, bg: number) => (fg * fgA + bg * bgA * (1 - fgA)) / outA;
  return {
    r: mix(foreground.r, background.r),
    g: mix(foreground.g, background.g),
    b: mix(foreground.b, background.b),
    a: bgA >= 1 ? 1 : outA,
  };
}

function parseAlpha(token: string): number | null {
  const raw = token.trim();
  if (raw.length === 0) return null;
  const percent = raw.endsWith('%');
  const value = Number(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(value)) return null;
  const alpha = percent ? value / 100 : value;
  return Math.min(1, Math.max(0, alpha));
}

function rgbResult(r: number, g: number, b: number, a: number): Rgb | null {
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return {r, g, b, a};
}

export function parseCssColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^transparent$/i.test(trimmed)) return {r: 0, g: 0, b: 0, a: 0};
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
  if (hex?.[1]) {
    const digits = hex[1].length <= 4 ? hex[1].split('').map(char => char + char).join('') : hex[1];
    const r = Number.parseInt(digits.slice(0, 2), 16);
    const g = Number.parseInt(digits.slice(2, 4), 16);
    const b = Number.parseInt(digits.slice(4, 6), 16);
    const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return rgbResult(r, g, b, a);
  }
  const fn = /^rgba?\((.*)\)$/i.exec(trimmed);
  if (!fn?.[1]) return null;
  const inner = fn[1].trim();
  let channels: string[];
  let alphaToken: string | undefined;
  if (inner.includes(',')) {
    const parts = inner.split(',').map(part => part.trim()).filter(part => part.length > 0);
    if (parts.length < 3 || parts.length > 4) return null;
    channels = parts.slice(0, 3);
    alphaToken = parts[3];
  } else {
    const [body, alpha, extra] = inner.split('/');
    if (extra !== undefined) return null;
    channels = (body ?? '').trim().split(/\s+/).filter(part => part.length > 0);
    if (channels.length !== 3) return null;
    alphaToken = alpha?.trim();
  }
  const r = Number(channels[0]);
  const g = Number(channels[1]);
  const b = Number(channels[2]);
  const a = alphaToken === undefined || alphaToken.length === 0 ? 1 : parseAlpha(alphaToken);
  if (a === null) return null;
  return rgbResult(r, g, b, a);
}
