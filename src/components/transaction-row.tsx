import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { formatEUR } from '@/lib/format';
import type { Account, Transaction } from '@/lib/types';

export function TransactionRow({ tx, index, accounts }: { tx: Transaction; index: CategoryIndex; accounts?: Account[] }) {
  const income = tx.kind === 'income';
  const transfer = tx.kind === 'transfer';
  const title = tx.description || (tx.category_id ? index.byId.get(tx.category_id)?.name : null) || (income ? 'Receita' : 'Despesa');
  const account = accounts?.find((a) => a.id === tx.account_id)?.name;
  const subtitle = [transfer ? 'Transferência' : categoryPath(index, tx.category_id), account].filter(Boolean).join(' · ');
  const amount = income ? formatEUR(tx.amount_cents, { sign: true }) : transfer ? formatEUR(tx.amount_cents) : formatEUR(-tx.amount_cents);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amount}, ${subtitle}`}
      onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: tx.id } })}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={[styles.dot, { backgroundColor: income ? '#DDF2E9' : transfer ? '#EEF0F3' : '#E6ECFD' }]}>
        <Text style={[styles.dotText, { color: income ? colors.income : transfer ? colors.muted : colors.accent }]}>
          {income ? '↑' : transfer ? '⇄' : '↓'}
        </Text>
      </View>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={[styles.subtitle, !tx.category_id && !transfer && { color: colors.warning }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Text style={[styles.amount, income && { color: colors.income }, transfer && { color: colors.muted }]}>{amount}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 12, minHeight: 56 },
  dot: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 18, fontWeight: '700' },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
