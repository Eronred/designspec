import { ThemedText } from './text'
import { Touchable } from './touchable'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps {
  title: string
  variant?: Variant
  size?: 'sm' | 'md'
  onPress?: () => void
}

export function Button({ title, variant = 'primary', size = 'md', onPress }: ButtonProps) {
  return (
    <Touchable onPress={onPress}>
      <ThemedText>{title}</ThemedText>
    </Touchable>
  )
}
