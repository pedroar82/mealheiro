import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, maxContentWidth, space } from '@/constants/theme';

export function Screen({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.inner}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function Placeholder({ phase, text }: { phase: number; text: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.phase}>Fase {phase}</Text>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  title: { fontSize: 28, fontWeight: '700', color: colors.ink, marginTop: space.sm },
  card: { backgroundColor: colors.card, borderRadius: 20, padding: space.md, gap: space.xs },
  phase: { fontSize: 12, fontWeight: '600', color: colors.muted, textTransform: 'uppercase' },
  text: { fontSize: 15, color: colors.ink, lineHeight: 21 },
});
