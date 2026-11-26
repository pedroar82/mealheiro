import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useDeferredValue, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { PriceComparisonView } from '@/components/price-comparison';
import { ProductPicker } from '@/components/product-picker';
import { BarChart } from '@/components/charts';
import { Screen } from '@/components/screen';
import { Card, Chip, FieldLabel, Muted, Segmented } from '@/components/ui';
import { chartColors, colors, radius, space } from '@/constants/theme';
import { EVER_FROM, explore, loadExploreData, type Row, type Target } from '@/lib/explore';
import { formatDate, formatEUR, monthStart, parseDate, todayISO } from '@/lib/format';
import { useCategories, useGroups } from '@/lib/queries';

type Kind = Exclude<Target['type'], 'group'>; // a group is chosen inside 'category'
type PeriodKey = 'month' | '3m' | 'year' | 'ever' | 'custom';
type Breakdown = 'category' | 'shop' | 'product';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'Este mês' },
  { key: '3m', label: '3 meses' },
  { key: 'year', label: 'Este ano' },
  { key: 'ever', label: 'Desde sempre' },
  { key: 'custom', label: 'Personalizado' },
];

const PLACEHOLDER: Record<'shop' | 'place', string> = {
  shop: 'ex.: Continente, Lidl, Starbucks',
  place: 'ex.: Lisboa, Porto',
};

export default function Explorar() {
  const { index } = useCategories();
  const [kind, setKind] = useState<Kind>('category');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null); // a category group instead of a single category
  const groups = useGroups();
  const chosenGroup = groups.data?.find((g) => g.id === groupId) ?? null;
  const [text, setText] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null); // null = every brand
  const query = useDeferredValue(text);
  const [periodKey, setPeriodKey] = useState<PeriodKey>('year');
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [breakdown, setBreakdown] = useState<Breakdown>('category');

  // opened from the Início chart with a category and period: apply them once per new link
  const params = useLocalSearchParams<{ categoria?: string; de?: string; ate?: string }>();
  const link = params.categoria ? `${params.categoria}|${params.de ?? ''}|${params.ate ?? ''}` : null;
  const [applied, setApplied] = useState<string | null>(null);
  if (link && link !== applied) {
    setApplied(link);
    setKind('category');
    setGroupId(null);
    setCategoryId(params.categoria!);
    if (params.de && params.ate) {
      setPeriodKey('custom');
      setFromText(formatDate(params.de));
      setToText(formatDate(params.ate));
    }
  }

  const today = todayISO();
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const [from, to] = useMemo((): [string | null, string | null] => {
    switch (periodKey) {
      case 'month': return [monthStart(y, m0), today];
      case '3m': return [monthStart(y, m0 - 2), today];
      case 'year': return [`${y}-01-01`, today];
      case 'ever': return [EVER_FROM, today];
      case 'custom': {
        const f = parseDate(fromText);
        const t = parseDate(toText) ?? (f ? today : null);
        return f && t && f <= t ? [f, t] : [null, null];
      }
    }
  }, [periodKey, fromText, toText, today, y, m0]);

  const data = useQuery({
    queryKey: ['explore', from, to],
    enabled: !!from && !!to,
    queryFn: () => loadExploreData(from!, to!),
    staleTime: 60_000,
  });

  const target: Target | null =
    kind === 'category'
      ? chosenGroup ? { type: 'group', members: chosenGroup.members } : categoryId ? { type: 'category', id: categoryId } : null
      : kind === 'product' ? (productId ? { type: 'product', id: productId, brand } : null)
      : query.trim().length >= 2 ? { type: kind, q: query } : null;

  const result = useMemo(
    () => (data.data && target && from && to ? explore(data.data, index, target, from, to) : null),
    // target is rebuilt each render; its fields are the real dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.data, index, kind, categoryId, chosenGroup, query, productId, brand, from, to],
  );

  const localities = useMemo(() => {
    const set = new Set<string>();
    data.data?.stores.forEach((s) => s.locality && set.add(s.locality));
    return [...set].sort((a, b) => a.localeCompare(b, 'pt'));
  }, [data.data]);

  const brands = useMemo(() => {
    const set = new Set<string>();
    data.data?.lines.forEach((l) => l.product_id === productId && l.brand && set.add(l.brand));
    return [...set].sort((a, b) => a.localeCompare(b, 'pt'));
  }, [data.data, productId]);
  const productName = (productId && data.data?.products.get(productId)) || 'produto';

  const rows: Row[] = result ? (breakdown === 'category' ? result.byCategory : breakdown === 'shop' ? result.byShop : result.byProduct) : [];
  const maxRow = Math.max(1, ...rows.map((r) => Math.abs(r.cents)));

  return (
    <Screen title="Explorar">
      <Card>
        <Segmented
          options={[
            { value: 'category', label: 'Categoria' },
            { value: 'shop', label: 'Loja' },
            { value: 'place', label: 'Local' },
            { value: 'product', label: 'Produto' },
          ]}
          value={kind}
          onChange={setKind}
        />
        {kind === 'category' ? (
          <>
            {(groups.data?.length ?? 0) > 0 && (
              <View style={styles.chips}>
                {groups.data!.map((g) => (
                  <Chip
                    key={g.id}
                    label={`Grupo: ${g.name}`}
                    selected={groupId === g.id}
                    onPress={() => {
                      setGroupId(groupId === g.id ? null : g.id);
                      setCategoryId(null);
                    }}
                  />
                ))}
              </View>
            )}
            <CategoryPicker
              index={index}
              kind="expense"
              value={categoryId}
              onChange={(id) => {
                setCategoryId(id);
                setGroupId(null);
              }}
            />
          </>
        ) : kind === 'product' ? (
          <>
            <ProductPicker value={productId} onChange={(id) => (setProductId(id), setBrand(null))} />
            {brands.length > 0 && (
              <View style={styles.chips}>
                <Chip label="Todas as marcas" selected={!brand} onPress={() => setBrand(null)} />
                {brands.map((b) => <Chip key={b} label={b} selected={brand === b} onPress={() => setBrand(brand === b ? null : b)} />)}
              </View>
            )}
            <Pressable accessibilityRole="link" onPress={() => router.push('/produtos')}>
              <Text style={styles.link}>Gerir produtos</Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={PLACEHOLDER[kind]}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel={kind === 'shop' ? 'Loja' : kind === 'place' ? 'Localidade' : 'Produto'}
            />
            {kind === 'place' && localities.length > 0 && (
              <View style={styles.chips}>
                {localities.map((l) => <Chip key={l} label={l} selected={normEq(text, l)} onPress={() => setText(l)} />)}
              </View>
            )}
          </>
        )}

        <View style={styles.chips}>
          {PERIODS.map((p) => <Chip key={p.key} label={p.label} selected={periodKey === p.key} onPress={() => setPeriodKey(p.key)} />)}
        </View>
        {periodKey === 'custom' && (
          <View style={styles.row2}>
            <View style={styles.col}>
              <FieldLabel>De</FieldLabel>
              <TextInput style={styles.input} value={fromText} onChangeText={setFromText} placeholder="dd/mm/aaaa" inputMode="numeric" />
            </View>
            <View style={styles.col}>
              <FieldLabel>Até</FieldLabel>
              <TextInput style={styles.input} value={toText} onChangeText={setToText} placeholder="hoje" inputMode="numeric" />
            </View>
          </View>
        )}
      </Card>

      {data.isLoading && <ActivityIndicator />}
      {data.error && <Text style={styles.error}>{data.error.message}</Text>}

      {!target && !data.isLoading && (
        <Muted>
          {kind === 'category'
            ? 'Escolha uma categoria (pode ser uma subcategoria, ex.: Café e Pastelaria › Café simples) ou um grupo. Para todos os leites, escolha a categoria Leite.'
            : kind === 'product'
              ? 'Escolha um produto (ex.: Leite meio-gordo UHT) — todas as marcas, ou uma só.'
              : 'Escreva pelo menos 2 letras.'}
        </Muted>
      )}

      {result && (
        <>
          <Card>
            <Text style={styles.caption}>
              {periodKey === 'ever' ? 'Desde sempre' : `${formatDate(from!)} – ${formatDate(to!)}`}
            </Text>
            <Text style={styles.total} accessibilityRole="header">{formatEUR(result.total)}</Text>
            <View style={styles.stats}>
              <Stat label="Média mensal" value={formatEUR(result.monthlyAvg)} />
              <Stat label="Compras" value={String(result.purchases)} />
              <Stat label="Do total gasto" value={result.share == null ? '—' : `${(result.share * 100).toLocaleString('pt-PT', { maximumFractionDigits: 1 })}%`} />
            </View>
            {result.total !== 0 && <BarChart key={`${from}${to}`} bars={result.series} label="Gasto ao longo do tempo" height={130} />}
            {result.first && periodKey === 'ever' && <Muted>Primeira compra: {formatDate(result.first)}.</Muted>}
          </Card>

          {(result.noDetailShare > 0.005 || result.matchedByText > 0) && (
            <Card style={styles.note}>
              {result.noDetailShare > 0.005 && kind !== 'product' && (
                <Muted>
                  {Math.round(result.noDetailShare * 100)}% deste valor vem de movimentos sem detalhe de produtos (histórico do Excel,
                  banco ou registo manual) — aparecem nas categorias e lojas, mas não em Produtos.
                </Muted>
              )}
              {kind === 'product' && <Muted>Produtos só existem nos talões e faturas digitalizados.</Muted>}
              {result.matchedByText > 0 && (
                <Muted>{result.matchedByText} compras foram encontradas pela descrição (histórico sem loja registada).</Muted>
              )}
            </Card>
          )}

          {result.prices && (
            <Card>
              <Text style={styles.cardTitle}>Preço {result.prices.basisLabel}{brand ? ` · ${brand}` : ''}</Text>
              <PriceComparisonView prices={result.prices} name={productName} />
            </Card>
          )}

          <Card>
            <Segmented
              options={[
                { value: 'category', label: kind === 'category' ? 'Subcategorias' : 'Categorias' },
                { value: 'shop', label: 'Lojas' },
                { value: 'product', label: kind === 'product' ? 'Marcas' : 'Produtos' },
              ]}
              value={breakdown}
              onChange={setBreakdown}
            />
            {rows.length === 0 && <Muted>Sem dados para mostrar.</Muted>}
            {rows.slice(0, 15).map((r) => (
              <View key={r.key} style={styles.rowItem} accessible accessibilityLabel={`${r.label}: ${formatEUR(r.cents)}, ${r.count} compras`}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowLabel} numberOfLines={1}>{r.label}</Text>
                  <Text style={styles.rowCount}>{r.count}×</Text>
                  <Text style={styles.rowAmount}>{formatEUR(r.cents)}</Text>
                </View>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${(Math.abs(r.cents) / maxRow) * 100}%` }]} />
                </View>
              </View>
            ))}
            {rows.length > 15 && <Muted>+ {rows.length - 15} outros</Muted>}
          </Card>
        </>
      )}
    </Screen>
  );
}

const normEq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 44, borderWidth: 1, borderColor: '#D5D8DF', borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row2: { flexDirection: 'row', gap: space.md },
  col: { flex: 1, gap: 4 },
  error: { color: colors.danger, fontSize: 14 },
  link: { fontSize: 14, color: colors.accent, fontWeight: '600', paddingVertical: 6 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  caption: { fontSize: 13, color: colors.muted },
  total: { fontSize: 32, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', gap: space.md },
  stat: { flex: 1, gap: 2 },
  statLabel: { fontSize: 12, color: colors.muted },
  statValue: { fontSize: 16, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  note: { backgroundColor: '#F4F6FA', gap: space.xs },
  rowItem: { gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  rowLabel: { flex: 1, fontSize: 14, color: colors.ink },
  rowCount: { fontSize: 12, color: colors.muted },
  rowAmount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'], minWidth: 80, textAlign: 'right' },
  track: { height: 6, borderRadius: 3, backgroundColor: '#EEF0F3', overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: chartColors.bar },
});
