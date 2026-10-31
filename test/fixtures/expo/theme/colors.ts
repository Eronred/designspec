import { PlatformColor, type ColorValue } from 'react-native'

const brand: { accent: string } | null = null

function token(fallback: string, native: () => ColorValue) {
  return { fallback, native }
}

const specs = {
  label: token('#000000', () => PlatformColor('label')),
  systemBackground: token('#ffffff', () => PlatformColor('systemBackground')),
  systemRed: token('#ff3b30', () => PlatformColor('systemRed')),
  accent: brand ? token(brand.accent, () => brand.accent) : token('#007aff', () => PlatformColor('systemBlue')),
}

export const colors = {} as Record<keyof typeof specs, ColorValue>
