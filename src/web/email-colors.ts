// Color math for showing email HTML in dark mode. Colors are remapped the way
// dark-mode mail clients do it: dark text gets lighter, light backgrounds get
// darker, and saturated mid-tone colors (brand buttons, highlights) keep their
// look. Anything that cannot be parsed is left untouched.

type Rgba = { r: number; g: number; b: number; a: number };
type Hsl = { h: number; s: number; l: number };

/** The dark theme's card color, which a white email background becomes. */
export const DARK_EMAIL_BACKGROUND = "#16171a";
/** The dark theme's text color, for email text that sets no color. */
export const DARK_EMAIL_TEXT = "#edeef1";
export const DARK_EMAIL_LINK = "#8ab4f8";

const CARD_HUE = 225;
const CARD_SATURATION = 0.08;
const CARD_LIGHTNESS = 0.086;
const TEXT_SATURATION = 0.14;

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  gainsboro: "#dcdcdc",
  whitesmoke: "#f5f5f5",
  snow: "#fffafa",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  linen: "#faf0e6",
  red: "#ff0000",
  maroon: "#800000",
  darkred: "#8b0000",
  green: "#008000",
  darkgreen: "#006400",
  lime: "#00ff00",
  olive: "#808000",
  navy: "#000080",
  blue: "#0000ff",
  darkblue: "#00008b",
  mediumblue: "#0000cd",
  teal: "#008080",
  purple: "#800080",
  orange: "#ffa500",
  yellow: "#ffff00",
  lightyellow: "#ffffe0",
  lightblue: "#add8e6",
  aliceblue: "#f0f8ff",
  azure: "#f0ffff",
  honeydew: "#f0fff0",
  mintcream: "#f5fffa",
  ghostwhite: "#f8f8ff",
  floralwhite: "#fffaf0",
  seashell: "#fff5ee",
  lavender: "#e6e6fa",
};

export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS[text];
  if (named) return parseColor(named);

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
        a: parseInt(a + a, 16) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts[3] === undefined ? 1 : parseComponent(parts[3], 1);
  if (alpha === null) return null;

  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((part) => parseComponent(part, 255));
    if (r === null || g === null || b === null) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha, 0, 1) };
  }

  const h = Number.parseFloat(parts[0]);
  const s = parseComponent(parts[1], 1);
  const l = parseComponent(parts[2], 1);
  if (!Number.isFinite(h) || s === null || l === null) return null;
  return { ...hslToRgb({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 1), l: clamp(l, 0, 1) }), a: clamp(alpha, 0, 1) };
}

/** Text color for a dark background: dark colors get light, light ones stay. */
export function adaptTextColor(value: string): string {
  const color = parseColor(value);
  if (!color || color.a === 0) return value;
  const hsl = rgbToHsl(color);
  const l = Math.max(hsl.l, 0.94 - 0.35 * hsl.l);
  if (l === hsl.l) return value;
  const neutral = hsl.s < 0.12;
  return formatColor({
    ...hslToRgb({ h: neutral ? CARD_HUE : hsl.h, s: neutral ? TEXT_SATURATION : hsl.s, l }),
    a: color.a,
  });
}

/** Background or border color for dark mode: light colors get dark, others stay. */
export function adaptBackgroundColor(value: string): string {
  const color = parseColor(value);
  if (!color || color.a === 0) return value;
  const hsl = rgbToHsl(color);
  const l = Math.min(hsl.l, CARD_LIGHTNESS + (1 - hsl.l) * 0.9);
  if (l === hsl.l) return value;
  if (hsl.l >= 0.99 && color.a === 1) return DARK_EMAIL_BACKGROUND;
  // Darkened surfaces take the theme's own gray rather than a dark version
  // of their tint, so a pale blue box does not turn navy.
  return formatColor({ ...hslToRgb({ h: CARD_HUE, s: CARD_SATURATION, l }), a: color.a });
}

/**
 * The theme's gray at the same lightness, for a dark tinted surface (an
 * email's own dark styles, like a navy #111827); null for any other color.
 */
export function neutralDarkBackground(value: string): string | null {
  const color = parseColor(value);
  if (!color || color.a < 0.5) return null;
  const hsl = rgbToHsl(color);
  if (hsl.l >= 0.25 || hsl.s <= CARD_SATURATION + 0.04) return null;
  if (hsl.l <= CARD_LIGHTNESS + 0.04) return DARK_EMAIL_BACKGROUND;
  return formatColor({ ...hslToRgb({ h: CARD_HUE, s: CARD_SATURATION, l: hsl.l }), a: color.a });
}

/**
 * Whether a background reads as "paper": white, near white, light gray or a
 * pale tint. Emails that only use such backgrounds can be shown in dark
 * colors; anything else (brand colors, dark sections) is a designed email.
 */
export function isPaperBackground(value: string): boolean {
  const color = parseColor(value);
  if (!color) return true;
  if (color.a < 0.1) return true;
  const { s, l } = rgbToHsl(color);
  return l >= 0.93 || (l >= 0.85 && s <= 0.3);
}

/**
 * Whether a color is bright enough that dark mode text on it would be hard to
 * read, like a yellow highlight that keeps its color.
 */
export function isBrightColor(value: string): boolean {
  const color = parseColor(value);
  if (!color || color.a < 0.5) return false;
  return luminance(color) > 0.35;
}

/** WCAG contrast ratio between two opaque colors, or null if either is unreadable. */
export function contrastRatio(first: string, second: string): number | null {
  const a = parseColor(first);
  const b = parseColor(second);
  if (!a || !b) return null;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG relative luminance, from 0 (black) to 1 (white). */
export function relativeLuminance(value: string): number | null {
  const color = parseColor(value);
  return color ? luminance(color) : null;
}

function luminance({ r, g, b }: Rgba): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const COLOR_TOKEN =
  /url\([^)]*\)|#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|\b[a-zA-Z]+\b/g;

type ColorRole = "text" | "background";

function colorRole(property: string): ColorRole | null {
  const name = property.trim().toLowerCase();
  if (name === "color" || name === "-webkit-text-fill-color" || name === "caret-color") return "text";
  if (
    name === "background" ||
    name === "background-color" ||
    name === "outline-color" ||
    name === "column-rule-color" ||
    name === "text-decoration-color" ||
    /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/.test(name)
  ) {
    return "background";
  }
  return null;
}

/**
 * Remaps every color in CSS declarations (a style attribute or a style sheet).
 * With keepText, text colors stay as sent, for text on a bright background.
 */
export function adaptCssColors(css: string, { keepText = false } = {}): string {
  return css.replace(
    /(^|[;{\s])([-a-zA-Z]+)(\s*:\s*)([^;{}]*)/g,
    (match, lead: string, property: string, colon: string, value: string) => {
      const role = colorRole(property);
      if (!role || (keepText && role === "text")) return match;
      return lead + property + colon + adaptColorValue(value, role);
    },
  );
}

export function adaptColorValue(value: string, role: ColorRole): string {
  const adapt = role === "text" ? adaptTextColor : adaptBackgroundColor;
  return value.replace(COLOR_TOKEN, (token) => {
    if (/^url\(/i.test(token)) return token;
    if (/^[a-z]+$/i.test(token) && !NAMED_COLORS[token.toLowerCase()]) return token;
    return adapt(token);
  });
}

/** Every background color and whether a background image is set, in some CSS. */
export function cssBackgrounds(css: string): { colors: string[]; image: boolean } {
  const colors: string[] = [];
  let image = false;
  for (const match of css.matchAll(/(?:^|[;{\s])(background(?:-color|-image)?)\s*:\s*([^;{}]*)/gi)) {
    const value = match[2];
    if (/url\(|gradient\(/i.test(value)) image = true;
    if (match[1].toLowerCase() === "background-image") continue;
    for (const token of value.match(COLOR_TOKEN) ?? []) {
      if (/^url\(/i.test(token)) continue;
      if (/^[a-z]+$/i.test(token) && !NAMED_COLORS[token.toLowerCase()]) continue;
      colors.push(token);
    }
  }
  return { colors, image };
}

function parseComponent(value: string, scale: number): number | null {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return value.endsWith("%") ? (number / 100) * scale : number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rgbToHsl({ r, g, b }: Rgba): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === red) h = (green - blue) / d + (green < blue ? 6 : 0);
  else if (max === green) h = (blue - red) / d + 2;
  else h = (red - green) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function formatColor({ r, g, b, a }: Rgba): string {
  const channels = [r, g, b].map((channel) => Math.round(clamp(channel, 0, 255)));
  if (a < 1) return `rgba(${channels.join(", ")}, ${Number(a.toFixed(3))})`;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
