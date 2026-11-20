import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { formatEUR } from '@/lib/format';
import { isHalfOfTheirs, isShared, myCost } from '@/lib/shared';
import type { Account, Transaction } from '@/lib/types';

export function TransactionRow({ tx, index, accounts }: { tx: Transaction; index: CategoryIndex; accounts?: Account[] }) {
  const income = tx.kind === 'income';
  const transfer = tx.kind === 'transfer';
  const refund = tx.kind === 'refund';
  const settlement = tx.kind === 'settlement';
  const half = tx.kind === 'expense' && isHalfOfTheirs(tx); // already the user's half of a bill the flatmate paid
  const shared = tx.kind === 'expense' && (isShared(tx) || half);
  const title = tx.description || (tx.category_id ? index.byId.get(tx.category_id)?.name : null) || (income ? 'Receita' : 'Despesa');
  const account = accounts?.find((a) => a.id === tx.account_id)?.name;
  const subtitle = [
    transfer ? 'Transferência' : refund ? 'Reembolso' : settlement ? 'Acerto da casa (não conta)' : categoryPath(index, tx.category_id),
    half ? 'a sua metade' : shared ? `pagou ${formatEUR(tx.amount_cents)}` : null,
    account,
  ]
    .filter(Boolean)
    .join(' · ');
  // expenses without a minus sign (decided 20/11/2026); a shared expense shows the user's part
  const amount = income || refund ? formatEUR(tx.amount_cents, { sign: true }) : formatEUR(tx.kind === 'expense' ? myCost(tx) : tx.amount_cents);
  const muted = transfer || settlement;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amount}${shared ? ', despesa partilhada, a sua parte' : ''}, ${subtitle}`}
      onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: tx.id } })}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={[styles.dot, { backgroundColor: income ? '#DDF2E9' : muted ? '#EEF0F3' : '#E6ECFD' }]}>
        <Text style={[styles.dotText, { color: income ? colors.income : muted ? colors.muted : colors.accent }]}>
          {income ? '↑' : muted ? '⇄' : '↓'}
        </Text>
      </View>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={[styles.subtitle, !tx.category_id && !transfer && !refund && !settlement && { color: colors.warning }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Text style={[styles.amount, income && { color: colors.income }, muted && { color: colors.muted }]}>
        {shared ? '👥 ' : ''}
        {amount}
      </Text>
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
