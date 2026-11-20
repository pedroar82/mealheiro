import { useState } from 'react';
import { Platform, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Chip, FieldLabel, Segmented } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { addDays, centsToInput, formatDate, parseAmount, parseDate, todayISO } from '@/lib/format';
import { useAccounts, useCategories } from '@/lib/queries';
import type { Transaction, TransactionInput } from '@/lib/types';

type Props = {
  initial?: Transaction;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (input: TransactionInput) => void;
};

export function TransactionForm({ initial, busy, submitLabel, onSubmit }: Props) {
  const { index } = useCategories();
  const accounts = useAccounts();

  const [kind, setKind] = useState<'expense' | 'income'>(initial?.kind === 'income' ? 'income' : 'expense');
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amount_cents) : '');
  const [dateText, setDateText] = useState(formatDate(initial?.date ?? todayISO()));
  const [categoryId, setCategoryId] = useState<string | null>(initial?.category_id ?? null);
  const [accountId, setAccountId] = useState<string | null>(initial?.account_id ?? null);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [recurring, setRecurring] = useState(initial?.recurring ?? false);
  const [tried, setTried] = useState(false);

  // Default account for new entries: the bank account (card payments are the common case).
  const defaultAccountId = accounts.data?.find((a) => a.type === 'bank')?.id ?? accounts.data?.[0]?.id ?? null;
  const effectiveAccountId = accountId ?? (initial ? null : defaultAccountId);

  const cents = parseAmount(amount);
  const date = parseDate(dateText);
  const today = todayISO();

  const changeKind = (k: 'expense' | 'income') => {
    if (k === kind) return;
    setKind(k);
    setCategoryId(null); // categories are per kind
  };

  const submit = () => {
    setTried(true);
    if (!cents || !date) return;
    onSubmit({
      kind,
      amount_cents: cents,
      date,
      category_id: categoryId,
      account_id: effectiveAccountId,
      description: description.trim() || null,
      recurring,
    });
  };

  return (
    <View style={styles.form}>
      <Segmented
        options={[
          { value: 'expense', label: 'Despesa' },
          { value: 'income', label: 'Receita' },
        ]}
        value={kind}
        onChange={changeKind}
      />

      <View style={styles.field}>
        <FieldLabel nativeID="amount-label">Montante (€)</FieldLabel>
        <TextInput
          accessibilityLabelledBy="amount-label"
          value={amount}
          onChangeText={setAmount}
          placeholder="0,00"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          style={[styles.input, styles.amount, kind === 'income' && { color: colors.income }]}
          autoFocus={!initial && Platform.OS !== 'web'}
        />
        {tried && !cents && <Text style={styles.error}>Indique um montante válido, ex.: 12,50</Text>}
      </View>

      <View style={styles.field}>
        <FieldLabel nativeID="date-label">Data</FieldLabel>
        <View style={styles.row}>
          <Chip label="Hoje" selected={date === today} onPress={() => setDateText(formatDate(today))} />
          <Chip label="Ontem" selected={date === addDays(today, -1)} onPress={() => setDateText(formatDate(addDays(today, -1)))} />
          <TextInput
            accessibilityLabelledBy="date-label"
            value={dateText}
            onChangeText={setDateText}
            placeholder="dd/mm/aaaa"
            placeholderTextColor={colors.muted}
            keyboardType="numbers-and-punctuation"
            style={[styles.input, styles.dateInput]}
          />
        </View>
        {tried && !date && <Text style={styles.error}>Data inválida. Use dd/mm/aaaa.</Text>}
      </View>

      <View style={styles.field}>
        <FieldLabel>Categoria</FieldLabel>
        <CategoryPicker index={index} kind={kind} value={categoryId} onChange={setCategoryId} />
      </View>

      <View style={styles.field}>
        <FieldLabel nativeID="desc-label">Descrição</FieldLabel>
        <TextInput
          accessibilityLabelledBy="desc-label"
          value={description}
          onChangeText={setDescription}
          placeholder={kind === 'expense' ? 'ex.: Café pastelaria' : 'ex.: Salário novembro'}
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
      </View>

      <View style={styles.field}>
        <FieldLabel>Conta</FieldLabel>
        <View style={styles.row}>
          {(accounts.data ?? []).map((a) => (
            <Chip key={a.id} label={a.name} selected={effectiveAccountId === a.id} onPress={() => setAccountId(a.id)} />
          ))}
        </View>
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Repete todos os meses</Text>
        <Switch value={recurring} onValueChange={setRecurring} accessibilityLabel="Repete todos os meses" />
      </View>

      <Button label={submitLabel} onPress={submit} busy={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.lg },
  field: { gap: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.ink, backgroundColor: colors.card },
  amount: { fontSize: 32, fontWeight: '700', minHeight: 64 },
  dateInput: { flexGrow: 1, minWidth: 140 },
  error: { color: colors.danger, fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  switchLabel: { fontSize: 15, color: colors.ink },
});
