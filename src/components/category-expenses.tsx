// The expenses behind a chart slice or a category row (Início donut, Análise): movements in the period with the part
// that falls in the category, and the products bought (receipt lines in the category), grouped by product.

import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Muted, Segmented } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { normDesc } from '@/lib/cgd-import';
import { formatDate, formatEUR } from '@/lib/format';
import { chunks, fetchAll } from '@/lib/import-io';
import { useProducts } from '@/lib/products';
import { supabase } from '@/lib/supabase';

type Fact = { date: string; amount_cents: number; category_id: string | null; transaction_id: string };
type Tx = { id: string; date: string; description: string | null };
type LineRow = { transaction_id: string; name: string; my_cents: number; category_id: string | null; product_id: string | null };

const PAGE = 25;

/**
 * `match` says which categories count (a subtree, one category, or null = uncategorised); `matchKey` identifies it
 * (the function itself changes every render).
 */
export function CategoryExpenses({ from, to, match, matchKey }: { from: string; to: string; match: (categoryId: string | null) => boolean; matchKey: string }) {
  const [view, setView] = useState<'tx' | 'products'>('tx');
  const [shown, setShown] = useState(PAGE);
  const products = useProducts();

  const facts = useQuery({
    queryKey: ['spend', 'list', from, to],
    queryFn: () =>
      fetchAll<Fact>((a, b) =>
        supabase
          .from('spend_facts')
          .select('date, amount_cents, category_id, transaction_id')
          .gte('date', from)
          .lte('date', to)
          // a view has no id: order on every column so pages never overlap (same as useSpendFacts)
          .order('date')
          .order('transaction_id')
          .order('amount_cents')
          .order('category_id')
          .order('product_id')
          .range(a, b),
      ),
  });

  // movements with their amount inside the category
  const byTx = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of facts.data ?? []) if (match(f.category_id)) m.set(f.transaction_id, (m.get(f.transaction_id) ?? 0) + f.amount_cents);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts.data, matchKey]);
  const ids = useMemo(() => [...byTx.keys()].sort(), [byTx]);

  const details = useQuery({
    queryKey: ['transactions', 'category-list', from, to, matchKey, ids.length],
    enabled: ids.length > 0,
    queryFn: async () => {
      const txs: Tx[] = [];
      const lines: LineRow[] = [];
      for (const part of chunks(ids, 100)) {
        const t = await supabase.from('transactions').select('id, date, description').in('id', part);
        if (t.error) throw new Error(t.error.message);
        txs.push(...(t.data as Tx[]));
        const l = await supabase.from('line_facts').select('transaction_id, name, my_cents, category_id, product_id').in('transaction_id', part).limit(5000);
        if (l.error) throw new Error(l.error.message);
        lines.push(...(l.data as LineRow[]));
      }
      return { txs, lines };
    },
  });

  const names = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p.name])), [products.data]);
  const lines = useMemo(
    () => (details.data?.lines ?? []).filter((l) => match(l.category_id) && l.my_cents !== 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [details.data, matchKey],
  );
  const linesByTx = useMemo(() => {
    const m = new Map<string, LineRow[]>();
    for (const l of lines) m.set(l.transaction_id, [...(m.get(l.transaction_id) ?? []), l]);
    return m;
  }, [lines]);

  const rows = useMemo(
    () =>
      (details.data?.txs ?? [])
        .map((t) => ({ ...t, cents: byTx.get(t.id) ?? 0 }))
        .filter((t) => t.cents !== 0)
        .sort((a, b) => b.date.localeCompare(a.date) || b.cents - a.cents),
    [details.data, byTx],
  );

  const productRows = useMemo(() => {
    const m = new Map<string, { key: string; name: string; cents: number; txs: Set<string> }>();
    for (const l of lines) {
      const key = l.product_id ?? `n:${normDesc(l.name)}`;
      const e = m.get(key) ?? { key, name: (l.product_id && names.get(l.product_id)) || l.name, cents: 0, txs: new Set<string>() };
      e.cents += l.my_cents;
      e.txs.add(l.transaction_id);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents);
  }, [lines, names]);

  if (facts.isLoading || (ids.length > 0 && details.isLoading)) return <ActivityIndicator />;
  const error = facts.error ?? details.error;
  if (error) return <Text style={styles.error}>{error.message}</Text>;
  if (rows.length === 0) return <Muted>Sem despesas neste período.</Muted>;

  const withoutDetail = rows.filter((r) => !linesByTx.has(r.id)).length;

  return (
    <View style={styles.wrap}>
      {productRows.length > 0 && (
        <Segmented
          options={[
            { value: 'tx', label: `Despesas (${rows.length})` },
            { value: 'products', label: `Produtos (${productRows.length})` },
          ]}
          value={view}
          onChange={(v) => (setView(v), setShown(PAGE))}
        />
      )}

      {view === 'tx' &&
        rows.slice(0, shown).map((r) => {
          const ls = linesByTx.get(r.id) ?? [];
          return (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              accessibilityHint="Abre o movimento"
              onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: r.id } })}
              style={styles.row}>
              <View style={styles.top}>
                <Text style={styles.date}>{formatDate(r.date).slice(0, 5)}</Text>
                <Text style={styles.desc} numberOfLines={1}>{r.description ?? 'Despesa'}</Text>
                <Text style={styles.amount}>{formatEUR(r.cents)}</Text>
              </View>
              {ls.length > 0 && (
                <Text style={styles.lines} numberOfLines={2}>
                  {ls
                    .slice(0, 5)
                    .map((l) => `${(l.product_id && names.get(l.product_id)) || l.name} ${formatEUR(l.my_cents)}`)
                    .join(' · ')}
                  {ls.length > 5 ? ` · +${ls.length - 5}` : ''}
                </Text>
              )}
            </Pressable>
          );
        })}

      {view === 'products' && (
        <>
          {productRows.slice(0, shown).map((p) => (
            <View key={p.key} style={[styles.row, styles.top]}>
              <Text style={styles.desc} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.count}>{p.txs.size}×</Text>
              <Text style={styles.amount}>{formatEUR(p.cents)}</Text>
            </View>
          ))}
          {withoutDetail > 0 && <Muted>{withoutDetail} despesas sem talão digitalizado não têm produtos (ver Despesas).</Muted>}
        </>
      )}

      {(view === 'tx' ? rows.length : productRows.length) > shown && (
        <Pressable accessibilityRole="button" onPress={() => setShown((n) => n + PAGE)} style={styles.more}>
          <Text style={styles.moreText}>Mostrar mais</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  row: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  date: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'], minWidth: 38 },
  desc: { flex: 1, fontSize: 14, color: colors.ink },
  count: { fontSize: 12, color: colors.muted },
  amount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  lines: { fontSize: 12, color: colors.muted, marginLeft: 38 + space.sm },
  more: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  moreText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
});
