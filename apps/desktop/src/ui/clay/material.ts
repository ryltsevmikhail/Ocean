// Highlight, light plane, turning plane, deepest edge. The pilot pigments
// are sampled from the approved clay reference. Static SVGs carry the same stops.
const pilots: Record<string, readonly [string, string, string, string]> = {
  '#0459bc': ['#318bee', '#1472dc', '#024192', '#0b3368'],
  '#e25002': ['#ff861a', '#ff6908', '#bb3a02', '#902f06'],
  '#7d2e91': ['#ad59c1', '#953fab', '#5e226b', '#461c4a'],
};
export function material(color: string) {
  const mix = (tone: string, percent: number) =>
    `color-mix(in srgb, ${color}, ${tone} ${percent}%)`;
  const [lit, soft, shade, deep] = pilots[color.toLowerCase()] ?? [
    mix('white', 18),
    mix('white', 5.5),
    mix('black', 31),
    mix('black', 53),
  ];
  return { '--face': color, '--lit': lit, '--soft': soft, '--shade': shade, '--deep': deep };
}
