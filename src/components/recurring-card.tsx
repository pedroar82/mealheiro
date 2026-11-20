import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Card, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { centsToInput, formatDate, parseAmount, todayISO } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { dismissForMonth, loadRecurring, registerSuggestion, stopSeries, type Suggestion } from '@/lib/recurring';

/** Início: recurring income/expenses that are due this month and not registered yet. */
export function RecurringCard({ index }: { index: CategoryIndex }) {
  const today = todayISO();
  const q = useQuery({ queryKey: ['recurring', today], queryFn: () => loadRecurring(today) });
  if (!q.data?.length) return null;
  return (
    <Card>
      <Text style={styles.title}>Movimentos mensais por registar</Text>
      {q.data.map((s) => (
        <Item key={s.key} s={s} index={index} today={today} />
      ))}
    </Card>
  );
}

function Item({ s, index, today }: { s: Suggestion; index: CategoryIndex; today: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(centsToInput(s.last.amount_cents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseAmount(amount);
  const name = s.last.description || categoryPath(index, s.last.category_id);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      ['recurring', 'transactions', 'spend', 'explore', 'incomes'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <View style={styles.item}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{name}</Text>
          <Muted>
            {s.last.kind === 'income' ? 'Receita' : 'Despesa'} · costuma ser a {formatDate(s.dueDate).slice(0, 5)}
          </Muted>
        </View>
        <TextInput
          style={styles.amount}
          value={amount}
          onChangeText={setAmount}
          inputMode="decimal"
          accessibilityLabel={`Valor de ${name}`}
        />
        <Text style={styles.eur}>€</Text>
      </View>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <Button
            label="Registar"
            busy={busy}
            onPress={() => cents != null && cents > 0 && act(() => registerSuggestion(s, cents))}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Este mês não" variant="secondary" onPress={() => act(() => dismissForMonth(s, today))} />
        </View>
      </View>
      <Text style={styles.stop} accessibilityRole="button" onPress={() => act(() => stopSeries(s))}>
        Já não se repete
      </Text>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  item: { gap: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  amount: {
    minWidth: 96,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    fontSize: 16,
    textAlign: 'right',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  eur: { fontSize: 16, color: colors.muted },
  actions: { flexDirection: 'row', gap: space.sm },
  stop: { fontSize: 13, color: colors.muted, textDecorationLine: 'underline', alignSelf: 'flex-start', paddingVertical: 6 },
  error: { color: colors.danger, fontSize: 14 },
});
