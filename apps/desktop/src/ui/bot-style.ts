import { reactive } from 'vue';
import { characters, ids, type Character } from './clay/characters.js';
export type Style = { character: Character; color: string };
const cache = reactive(new Map<string, Style>());
const oldShapes = { dev: 'curious', review: 'skeptic', docs: 'calm' } as const;
function defaults(handle: string): Style {
  const character = handle === 'dev' ? 'curious' : handle === 'review' ? 'skeptic' : 'calm';
  return { character, color: characters[character][1] };
}
export function botStyle(handle: string): Style {
  const cached = cache.get(handle);
  if (cached) return cached;
  const [saved, color] = (localStorage.getItem('avatar.' + handle) ?? '').split('/');
  const legacy = Object.entries(oldShapes).find(([shape]) => shape === saved)?.[1];
  const character = ids.find((id) => id === saved) ?? legacy ?? defaults(handle).character;
  return {
    character,
    color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : characters[character][1],
  };
}
export function setBotStyle(handle: string, style: Style | null) {
  if (style) {
    localStorage.setItem('avatar.' + handle, style.character + '/' + style.color);
    cache.set(handle, style);
  } else {
    localStorage.removeItem('avatar.' + handle);
    cache.set(handle, defaults(handle));
  }
}
