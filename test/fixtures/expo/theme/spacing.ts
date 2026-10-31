const isAndroid = process.env.EXPO_OS === 'android'

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
} as const

export const control = {
  minTouch: isAndroid ? 48 : 44,
} as const
