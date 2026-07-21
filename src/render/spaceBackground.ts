/**
 * Neutral deep-space clear color shared by flight and map scenes.
 *
 * Keep this as a CSS hex value so Three.js performs the same sRGB-to-working
 * color conversion at every call site. Local atmosphere rendering owns the
 * blue limb and sky response around terrestrial bodies.
 */
export const SPACE_BACKGROUND = '#020304' as const;
