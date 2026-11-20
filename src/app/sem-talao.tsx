// "Compras no banco sem talão" (SPEC §6.5): card purchases from the CGD import with no receipt attached.
// Optional to-do — attach a receipt (photo/PDF) or mark "não tem talão".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Chip, Muted } from '@/components/ui';
import { colors, maxContentWidth, radius, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { formatDate, formatEUR, monthStart, todayISO } from '@/lib/format';
import { useCategories } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

type Row = { id: string; date: string; amount_cents: number; description: string | null; category_id: string | null };

const MINIMUMS = [0, 1000, 2000, 5000];

export default function SemTalao() {
  const { index } = useCategories();
  const qc = useQueryClient();
  const [min, setMin] = useState(1000);
  const today = todayISO();
  const from = monthStart(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 3);

  const list = useQuery({
    queryKey: ['transactions', 'sem-talao', from, min],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, date, amount_cents, description, category_id')
        .eq('kind', 'expense')
        .eq('source', 'bank_csv')
        .is('document_id', null)
        .eq('no_receipt', false)
        .gte('amount_cents', min)
        .gte('date', from)
        .order('date', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data as Row[];
    },
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('transactions').update({ no_receipt: true }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  });

  const attach = (id: string, how: 'camera' | 'file') =>
    router.push({ pathname: how === 'camera' ? '/digitalizar' : '/importar-documento', params: { para: id } });

  const total = (list.data ?? []).reduce((s, r) => s + r.amount_cents, 0);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.inner}>
        <Muted>
          Compras pagas com cartão (extrato CGD) dos últimos 3 meses sem talão nem fatura. Juntar o talão acrescenta os
          produtos e a loja ao movimento do banco — não cria outro. É opcional.
        </Muted>
        <View style={styles.chips}>
          {MINIMUMS.map((m) => (
            <Chip key={m} label={m === 0 ? 'Todas' : `≥ ${formatEUR(m, { decimals: false })}`} selected={min === m} onPress={() => setMin(m)} />
          ))}
        </View>

        {list.isLoading && <ActivityIndicator />}
        {list.error && <Text style={styles.error}>{list.error.message}</Text>}
        {dismiss.error && <Text style={styles.error}>{dismiss.error.message}</Text>}
        {list.data && (
          <Text style={styles.summary}>
            {list.data.length === 0 ? 'Nada por fazer. 🎉' : `${list.data.length} compras · ${formatEUR(total)}`}
          </Text>
        )}

        {list.data?.map((r) => (
          <Card key={r.id} style={styles.card}>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Abre o movimento"
              onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: r.id } })}
              style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.desc} numberOfLines={1}>{r.description ?? 'Compra'}</Text>
                <Muted>
                  {formatDate(r.date)} · {categoryPath(index, r.category_id)}
                </Muted>
              </View>
              <Text style={styles.amount}>{formatEUR(r.amount_cents)}</Text>
            </Pressable>
            <View style={styles.actions}>
              {Platform.OS !== 'web' && <Action label="Fotografar talão" onPress={() => attach(r.id, 'camera')} primary />}
              <Action label={Platform.OS === 'web' ? 'Juntar talão ou fatura' : 'PDF'} onPress={() => attach(r.id, 'file')} primary={Platform.OS === 'web'} />
              <Action label="Não tem talão" onPress={() => dismiss.mutate(r.id)} />
            </View>
          </Card>
        ))}
      </View>
    </ScrollView>
  );
}

function Action({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, primary && styles.actionPrimary, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.actionText, primary && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { color: colors.danger, fontSize: 14 },
  summary: { fontSize: 15, fontWeight: '600', color: colors.ink },
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 },
  desc: { fontSize: 15, fontWeight: '600', color: colors.ink },
  amount: { fontSize: 15, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { minHeight: 40, paddingHorizontal: 14, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  actionPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionText: { fontSize: 14, fontWeight: '600', color: colors.ink },
});
