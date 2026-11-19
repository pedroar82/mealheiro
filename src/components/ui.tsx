import type { PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space } from '@/constants/theme';

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && styles.segmentOn]}>
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}>
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.button, styles[variant], off && styles.disabled, pressed && styles.pressed]}>
      {busy ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : colors.ink} />
      ) : (
        <Text style={[styles.buttonText, variant !== 'primary' && { color: variant === 'danger' ? colors.danger : colors.ink }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function FieldLabel({ children, nativeID }: PropsWithChildren<{ nativeID?: string }>) {
  return (
    <Text nativeID={nativeID} style={styles.label}>
      {children}
    </Text>
  );
}

export function Muted({ children }: PropsWithChildren) {
  return <Text style={styles.muted}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.md, gap: space.md },
  segmented: { flexDirection: 'row', backgroundColor: '#EEF0F3', borderRadius: 12, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  segmentText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  segmentTextOn: { fontWeight: '600', color: colors.ink },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: '#D5D8DF', backgroundColor: colors.card, justifyContent: 'center' },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 14, fontWeight: '500', color: colors.ink },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  button: { minHeight: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: '#D5D8DF' },
  danger: { backgroundColor: colors.card, borderWidth: 1, borderColor: '#F2C4BF' },
  buttonText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  muted: { fontSize: 13, color: colors.muted },
});
