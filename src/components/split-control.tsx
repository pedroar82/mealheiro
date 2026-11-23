import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FieldLabel, Muted, Segmented } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { formatEUR } from '@/lib/format';
import { splitPart } from '@/lib/shared';
import type { SplitMode } from '@/lib/types';

export type Split = { people: number; mode: SplitMode }; // people 1 = not split

const MAX_PEOPLE = 50;

/**
 * "Dividir a conta" for restaurant / café bills: number of people and, when the bill has items,
 * whether the user pays an equal part or only what they consumed.
 */
export function SplitControl({
  value,
  onChange,
  amountCents,
  lines,
}: {
  value: Split;
  onChange: (v: Split) => void;
  amountCents: number | null;
  lines?: { total_cents: number; consumed: boolean }[]; // receipt items (with the "Consumi" flag), if any
}) {
  const { people, mode } = value;
  const hasLines = (lines?.length ?? 0) > 0;
  const effectiveMode = hasLines ? mode : 'equal';
  const part = amountCents != null && people > 1 ? splitPart(amountCents, people, effectiveMode, lines) : null;
  const notConsumed = lines?.filter((l) => !l.consumed).length ?? 0;
  const set = (n: number) => onChange({ ...value, people: Math.min(MAX_PEOPLE, Math.max(1, n)) });

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <FieldLabel>Dividir a conta</FieldLabel>
          <Muted>{people > 1 ? `Por ${people} pessoas` : 'Não dividida (paga tudo)'}</Muted>
        </View>
        <Stepper label="Menos uma pessoa" text="−" disabled={people <= 1} onPress={() => set(people - 1)} />
        <Text style={styles.count} accessibilityLabel={`${people} ${people === 1 ? 'pessoa' : 'pessoas'}`}>{people}</Text>
        <Stepper label="Mais uma pessoa" text="+" disabled={people >= MAX_PEOPLE} onPress={() => set(people + 1)} />
      </View>

      {people > 1 && hasLines && (
        <Segmented
          options={[
            { value: 'equal', label: 'Dividir igualmente' },
            { value: 'consumed', label: 'Pelo que consumi' },
          ]}
          value={mode}
          onChange={(m) => onChange({ ...value, mode: m })}
        />
      )}

      {part != null && (
        <Text style={styles.part}>
          A sua parte: {formatEUR(part)}
          <Text style={styles.partDetail}>
            {effectiveMode === 'equal'
              ? ` (${formatEUR(amountCents!)} ÷ ${people})`
              : ` (o que consumiu ÷ ${people})`}
          </Text>
        </Text>
      )}
      {people > 1 && hasLines && (
        <Muted>
          {effectiveMode === 'equal'
            ? 'Paga a mesma parte que os outros. Os produtos que marcar como "Não consumi" ficam fora das suas estatísticas de produtos.'
            : 'Paga só o que consumiu, dividido pelas pessoas. Marque abaixo os produtos que não consumiu.'}
          {notConsumed > 0 ? ` ${notConsumed} ${notConsumed === 1 ? 'produto marcado' : 'produtos marcados'} como não consumido.` : ''}
        </Muted>
      )}
    </View>
  );
}

function Stepper({ label, text, disabled, onPress }: { label: string; text: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.step, disabled && { opacity: 0.35 }, pressed && { opacity: 0.6 }]}>
      <Text style={styles.stepText}>{text}</Text>
    </Pressable>
  );
}

/** "Consumi / Não consumi" toggle shown on each receipt item while a bill is split. */
export function ConsumedToggle({ consumed, onChange, name }: { consumed: boolean; onChange: (v: boolean) => void; name: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: consumed }}
      accessibilityLabel={`Consumi ${name}`}
      onPress={() => onChange(!consumed)}
      hitSlop={6}
      style={[styles.toggle, !consumed && styles.toggleOff]}>
      <Text style={[styles.toggleText, !consumed && styles.toggleTextOff]}>{consumed ? 'Consumi' : 'Não consumi'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  step: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  stepText: { fontSize: 22, fontWeight: '600', color: colors.accent },
  count: { minWidth: 28, textAlign: 'center', fontSize: 20, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  part: { fontSize: 16, fontWeight: '700', color: colors.ink },
  partDetail: { fontSize: 14, fontWeight: '400', color: colors.muted },
  toggle: { alignSelf: 'flex-start', minHeight: 32, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 16, backgroundColor: colors.accentSoft },
  toggleOff: { backgroundColor: colors.warningSoft },
  toggleText: { fontSize: 13, fontWeight: '600', color: colors.accent },
  toggleTextOff: { color: colors.warning },
});
