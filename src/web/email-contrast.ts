import {
  adaptTextColor,
  contrastRatio,
  DARK_EMAIL_BACKGROUND,
  DARK_EMAIL_TEXT,
  parseColor,
  relativeLuminance,
} from "./email-colors";

// Text that reads worse than this against what is behind it gets recolored.
const MIN_CONTRAST = 3;
const MAX_ELEMENTS = 5_000;
const DARK_TEXT = "#172033";

/**
 * A last pass over an email shown in dark colors, after its styles have
 * applied: text that ended up hard to read against its background (a color
 * set in a way the recoloring could not see, or an email whose own dark
 * styles only cover part of it) gets a readable color instead. Text on
 * background images is left alone, since the image's colors are unknown.
 */
export function fixLowContrastText(document: Document): void {
  const view = document.defaultView;
  if (!view || !document.body) return;

  const backgrounds = new Map<Element, string | null>();
  const backgroundOf = (element: Element | null): string | null => {
    if (!element) return DARK_EMAIL_BACKGROUND;
    const cached = backgrounds.get(element);
    if (cached !== undefined) return cached;
    const style = view.getComputedStyle(element);
    let background: string | null;
    if (style.backgroundImage && style.backgroundImage !== "none") {
      background = null;
    } else {
      const color = parseColor(style.backgroundColor);
      background = color && color.a >= 0.5 ? style.backgroundColor : backgroundOf(element.parentElement);
    }
    backgrounds.set(element, background);
    return background;
  };

  const elements = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && elements.size < MAX_ELEMENTS; node = walker.nextNode()) {
    if (node.parentElement && node.textContent?.trim()) elements.add(node.parentElement);
  }

  for (const element of elements) {
    const background = backgroundOf(element);
    if (!background) continue;
    const color = view.getComputedStyle(element).color;
    const ratio = contrastRatio(color, background);
    if (ratio === null || ratio >= MIN_CONTRAST) continue;

    let replacement = DARK_TEXT;
    if ((relativeLuminance(background) ?? 0) < 0.18) {
      const lighter = adaptTextColor(color);
      replacement = (contrastRatio(lighter, background) ?? 0) >= 4.5 ? lighter : DARK_EMAIL_TEXT;
    }
    (element as HTMLElement).style?.setProperty("color", replacement, "important");
  }
}
