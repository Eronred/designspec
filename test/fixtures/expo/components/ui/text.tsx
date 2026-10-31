import { Text, type TextProps } from 'react-native'

type Variant = 'body' | 'headline' | 'caption'

export function ThemedText({ variant = 'body', ...props }: TextProps & { variant?: Variant }) {
  return <Text {...props} />
}
