import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'

import { Button } from '@/components/ui/button'
import { spacing } from '@/theme/spacing'

export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={{ color: '#ff3b30' }}>Something went wrong</Text>
      <TouchableOpacity onPress={() => {}} />
      <Button title="Delete" variant="danger" />
      <Button title="Retry" size="md" />
      <View style={[styles.row, { paddingHorizontal: spacing.md, marginTop: -8 }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    margin: 13,
    borderRadius: 12,
    gap: 0,
    backgroundColor: 'white',
  },
  row: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
  },
})

export const categories = [{ key: 'sale', color: '#10B981' }]
