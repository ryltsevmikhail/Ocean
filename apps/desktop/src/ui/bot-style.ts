import { reactive } from 'vue';
export const shapes = ['dev', 'review', 'docs'] as const;
export const colors = ['#228AFF', '#FFA021', '#16BD85', '#9255FA', '#F64686', '#EFEFEF'] as const;
export type Shape = (typeof shapes)[number];
export type Color = (typeof colors)[number];
type Style = { shape: Shape; color: Color };
const cache = reactive(new Map<string, Style>());
function defaults(handle: string): Style {
  const i = handle === 'dev' ? 0 : handle === 'review' ? 1 : 2;
  return { shape: shapes[i], color: colors[i] };
}
export function botStyle(handle: string): Style {
  const cached = cache.get(handle);
  if (cached) return cached;
  const base = defaults(handle);
  const [s, c] = (localStorage.getItem('avatar.' + handle) ?? '').split('/');
  return {
    shape: shapes.find((v) => v === s) ?? base.shape,
    color: colors.find((v) => v === c) ?? base.color,
  };
}
export function setBotStyle(handle: string, style: Style | null) {
  if (style) {
    localStorage.setItem('avatar.' + handle, style.shape + '/' + style.color);
    cache.set(handle, style);
  } else {
    localStorage.removeItem('avatar.' + handle);
    cache.set(handle, defaults(handle));
  }
}
