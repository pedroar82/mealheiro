import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PairedBars, PriceLine } from '@/components/charts';
import { Screen } from '@/components/screen';
import { Card, Chip, Muted } from '@/components/ui';
import { chartColors, colors, radius, space } from '@/constants/theme';
import { focus, lastMonths, monthly, monthRoots, mostRepeated, priceHistory, productKey as keyOfLine, topProducts, type Income } from '@/lib/analysis';
import { categoryPath } from '@/lib/categories';
import { EVER_FROM, loadExploreData } from '@/lib/explore';
import { MONTHS, formatDate, formatEUR, todayISO } from '@/lib/format';
import { fetchAll } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

const SPANS = [3, 6, 12] as const;

export default function Analise() {
  const { index } = useCategories();
  const today = todayISO();
  const [span, setSpan] = useState<(typeof SPANS)[number]>(6);
  const months = useMemo(() => lastMonths(today, span), [today, span]);
  const [month, setMonth] = useState(months[months.length - 1]);
  const [rootPick, setRootPick] = useState<string | null | undefined>(undefined); // undefined = biggest
  const [productPick, setProductPick] = useState<string | null>(null);

  // same cache entry as Explorar › Desde sempre: everything is aggregated on the device
  const data = useQuery({ queryKey: ['explore', EVER_FROM, today], queryFn: () => loadExploreData(EVER_FROM, today), staleTime: 60_000 });
  const incomes = useQuery({
    queryKey: ['incomes', months[0]],
    queryFn: () =>
      fetchAll<Income>((a, b) =>
        supabase.from('transactions').select('date, amount_cents').eq('kind', 'income').gte('date', `${months[0]}-01`).order('date').order('id').range(a, b),
      ),
    staleTime: 60_000,
  });

  const d = data.data;
  const selMonth = months.includes(month) ? month : months[months.length - 1];
  const prevMonth = lastMonths(`${selMonth}-01`, 2)[0];

  const rows = useMemo(() => (d && incomes.data ? monthly(d, incomes.data, months) : []), [d, incomes.data, months]);
  const roots = useMemo(() => (d ? monthRoots(d, index, selMonth) : []), [d, index, selMonth]);
  const rootKey = rootPick !== undefined && roots.some((r) => r.key === (rootPick ?? 'none')) ? rootPick : roots[0] ? (roots[0].key === 'none' ? null : roots[0].key) : undefined;
  const f = useMemo(() => (d && rootKey !== undefined ? focus(d, index, rootKey, selMonth, prevMonth) : null), [d, index, rootKey, selMonth, prevMonth]);
  const products = useMemo(() => (d ? topProducts(d, selMonth) : []), [d, selMonth]);
  const fallbackProduct = useMemo(() => (d ? mostRepeated(d) : null), [d]);
  const productKey = productPick ?? products.find((p) => p.purchases >= 2)?.key ?? fallbackProduct?.key ?? products[0]?.key ?? null;
  const productName = productKey ? d?.lines.find((l) => keyOfLine(l) === productKey)?.name : undefined;
  const prices = useMemo(() => (d && productKey ? priceHistory(d, productKey) : []), [d, productKey]);

  const saved = rows.reduce((s, r) => s + r.income - r.expense, 0);
  const monthName = MONTHS[Number(selMonth.slice(5, 7)) - 1];
  const prevName = MONTHS[Number(prevMonth.slice(5, 7)) - 1].slice(0, 3);
  const maxSub = Math.max(1, ...(f?.subs.map((s) => s.cents) ?? []));

  const loading = data.isLoading || incomes.isLoading;
  const error = data.error ?? incomes.error;

  return (
    <Screen title="Análise">
      <View style={styles.chips}>
        {SPANS.map((n) => (
          <Chip key={n} label={`Últimos ${n} meses`} selected={span === n} onPress={() => setSpan(n)} />
        ))}
      </View>

      {loading && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error.message}</Text>}

      {d && incomes.data && (
        <>
          <Card>
            <View style={styles.headRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Receitas vs despesas</Text>
                <Muted>
                  {saved >= 0 ? `Poupou ${formatEUR(saved)}` : `Gastou mais ${formatEUR(-saved)} do que recebeu`} em {span} meses
                </Muted>
              </View>
              <View style={{ gap: 4 }}>
                <Legend color={chartColors.income} label="Receitas" />
                <Legend color={chartColors.expense} label="Despesas" />
              </View>
            </View>
            <PairedBars
              pairs={rows.map((r) => ({ key: r.key, label: r.label, a: r.income, b: r.expense }))}
              selected={selMonth}
              onSelect={(k) => (setMonth(k), setRootPick(undefined), setProductPick(null))}
              labels={['receitas', 'despesas']}
              label="Receitas e despesas por mês"
            />
            {rows.find((r) => r.key === selMonth) && (
              <Text style={styles.readout}>
                {monthName}: receitas {formatEUR(rows.find((r) => r.key === selMonth)!.income)} · despesas {formatEUR(rows.find((r) => r.key === selMonth)!.expense)}
              </Text>
            )}
          </Card>

          <Card>
            {roots.length === 0 ? (
              <Muted>Sem despesas em {monthName}.</Muted>
            ) : (
              <>
                <View style={styles.chips}>
                  {roots.slice(0, 6).map((r) => (
                    <Chip key={r.key} label={r.label} selected={(rootKey ?? 'none') === r.key} onPress={() => setRootPick(r.key === 'none' ? null : r.key)} />
                  ))}
                </View>
                {f && (
                  <>
                    <View style={styles.headRow}>
                      <View style={{ flex: 1 }}>
                        <Muted>
                          {monthName} · {roots.find((r) => r.key === (rootKey ?? 'none'))?.label}
                        </Muted>
                        <Text style={styles.big}>{formatEUR(f.total)}</Text>
                      </View>
                      {f.change !== null && (
                        <Text style={[styles.badge, f.change > 0 ? styles.badgeUp : styles.badgeDown]}>
                          {f.change > 0 ? '+' : '−'}
                          {Math.abs(Math.round(f.change * 100))}% vs {prevName}
                        </Text>
                      )}
                    </View>
                    {f.subs.map((s) => (
                      <View key={s.key} style={{ gap: 5 }} accessible accessibilityLabel={`${s.label}: ${formatEUR(s.cents)}`}>
                        <View style={styles.subTop}>
                          <Text style={styles.subName} numberOfLines={1}>{s.label}</Text>
                          <Text style={styles.subAmount}>{formatEUR(s.cents)}</Text>
                        </View>
                        <View style={styles.track}>
                          <View style={[styles.fill, { width: `${Math.max(0, (s.cents / maxSub) * 100)}%` }]} />
                        </View>
                      </View>
                    ))}
                    {f.shops.length > 0 && (
                      <View style={styles.tags}>
                        {f.shops.map((s) => (
                          <Text key={s.key} style={styles.tag}>
                            {s.label} {formatEUR(s.cents)}
                          </Text>
                        ))}
                      </View>
                    )}
                  </>
                )}
              </>
            )}
          </Card>

          <Card>
            <Text style={styles.cardTitle}>Produtos mais comprados em {monthName}</Text>
            {products.length === 0 && <Muted>Sem talões digitalizados neste mês.</Muted>}
            {products.map((p, i) => (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityHint="Mostra a evolução do preço"
                onPress={() => setProductPick(p.key)}
                style={[styles.prodRow, i > 0 && styles.prodBorder]}>
                <Text style={styles.rank}>#{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.prodName, productKey === p.key && { color: colors.accent }]}>{p.name}</Text>
                  <Muted>
                    {p.purchases}× · {categoryPath(index, p.categoryId)}
                  </Muted>
                </View>
                <Text style={styles.prodTotal}>{formatEUR(p.cents)}</Text>
              </Pressable>
            ))}
          </Card>

          <Card>
            <View style={styles.headRow}>
              <Text style={[styles.cardTitle, { flex: 1 }]}>Evolução de preço</Text>
              {productName && <Muted>{productName}</Muted>}
            </View>
            {prices.length < 2 ? (
              <Muted>
                {prices.length === 1
                  ? `Só há uma compra registada (${formatEUR(prices[0].cents)}, ${formatDate(prices[0].date)}). O gráfico aparece a partir da segunda.`
                  : 'Digitalize talões para ver a evolução dos preços dos produtos que compra.'}
              </Muted>
            ) : (
              <>
                <PriceLine points={prices} label={`Preço de ${productName ?? 'produto'}`} />
                <Text style={styles.readout}>{priceSummary(prices)}</Text>
              </>
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

function priceSummary(p: { date: string; cents: number; store: string | null; perKg: boolean }[]) {
  const first = p[0];
  const last = p[p.length - 1];
  const change = first.cents > 0 ? (last.cents - first.cents) / first.cents : 0;
  const pct = Math.abs(Math.round(change * 100));
  const trend = pct === 0 ? `Preço igual desde ${formatDate(first.date)}` : `${change > 0 ? 'Subiu' : 'Desceu'} ${pct}% desde ${formatDate(first.date)}`;
  const cheapest = p.reduce((a, b) => (b.cents < a.cents ? b : a));
  const where = cheapest.store ? ` no ${cheapest.store}` : '';
  const unit = last.perKg ? ' (preço por kg)' : '';
  return `${trend}${unit}. Mais barato: ${formatEUR(cheapest.cents)}${where}, ${formatDate(cheapest.date)}.`;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { color: colors.danger, fontSize: 14 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  readout: { fontSize: 13, color: colors.muted },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendText: { fontSize: 12, color: colors.ink },
  big: { fontSize: 22, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, overflow: 'hidden' },
  badgeUp: { backgroundColor: '#FDF3EA', color: '#9A4309' },
  badgeDown: { backgroundColor: '#E8F5EF', color: '#17785A' },
  subTop: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  subName: { flex: 1, fontSize: 13, color: colors.ink },
  subAmount: { fontSize: 13, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  track: { height: 10, borderRadius: 5, backgroundColor: '#EEF0F3', overflow: 'hidden' },
  fill: { height: 10, borderRadius: 5, backgroundColor: chartColors.bar },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: 4 },
  tag: { fontSize: 12, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: '#EEF0F3', color: colors.ink, overflow: 'hidden' },
  prodRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10, minHeight: 44 },
  prodBorder: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  rank: { width: 28, fontSize: 13, fontWeight: '600', color: colors.muted },
  prodName: { fontSize: 14, fontWeight: '600', color: colors.ink },
  prodTotal: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
});
