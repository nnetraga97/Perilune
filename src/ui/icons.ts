import { el } from './kit';

export const UTILITY_ICON_NAMES = [
  'science', 'save', 'account', 'settings', 'keyboard', 'orbit',
  'surface', 'vessel', 'alarm', 'transfer', 'fleet', 'log',
] as const;
export type UtilityIcon = (typeof UTILITY_ICON_NAMES)[number];

export const ICON_PATHS: Readonly<Record<UtilityIcon, readonly string[]>> = {
  science: ['M9 3h6', 'M10 3v5l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3', 'M8 14h8'],
  save: ['M5 3h12l2 2v16H5z', 'M8 3v6h8V3', 'M8 15h8v6'],
  account: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M4 21a8 8 0 0 1 16 0'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1'],
  keyboard: ['M3 6h18v12H3z', 'M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10'],
  orbit: ['M12 12m-8 0a8 3 0 1 0 16 0 8 3 0 1 0-16 0', 'M12 12m0-8a3 8 0 1 0 0 16 3 8 0 1 0 0-16', 'M12 10v4'],
  surface: ['M3 17l5-7 4 4 3-4 6 7', 'M3 20h18', 'M5 6h4'],
  vessel: ['M12 2l4 7v8l-4 5-4-5V9z', 'M8 14l-3 3M16 14l3 3', 'M10 9h4'],
  alarm: ['M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3z', 'M10 20h4', 'M5 4 3 2M19 4l-3 2'],
  transfer: ['M4 7h13', 'M14 4l3 3-3 3', 'M20 17H7', 'M10 14l-3 3 3 3'],
  fleet: ['M7 3l3 5-3 5-3-5z', 'M17 8l3 5-3 5-3-5z', 'M9 18h5'],
  log: ['M5 3h14v18H5z', 'M8 7h8M8 11h8M8 15h5'],
};

export function appendUiIcon(parent: HTMLElement, icon: UtilityIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('k-icon-svg');
  for (const d of ICON_PATHS[icon]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  parent.appendChild(svg);
  return svg;
}

export function iconButton(
  parent: HTMLElement,
  icon: UtilityIcon,
  label: string,
  onClick: () => void,
  className = '',
): HTMLButtonElement {
  const button = el('button', `k-icon-btn ${className}`.trim(), parent) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  appendUiIcon(button, icon);
  const tooltip = el('span', 'k-icon-tooltip', button, label);
  tooltip.setAttribute('aria-hidden', 'true');
  button.onclick = onClick;
  return button;
}
