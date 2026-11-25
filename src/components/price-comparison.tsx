import { StyleSheet, Text, View } from 'react-native';

import { PriceLine } from '@/components/charts';
import { Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import type { PriceComparison } from '@/lib/explore';
import { formatDate, formatEUR } from '@/lib/format';

/** Price history of one product on a comparable basis (€/kg, €/l, €/un or per package) and the price at each shop. */
export function PriceComparisonView({ prices, name }: { prices: PriceComparison | null; name: string }) {
  const p = prices?.points ?? [];
  if (p.length === 0) return <Muted>Digitalize talões para ver a evolução dos preços dos produtos que compra.</Muted>;
  const per = prices!.basisLabel;
  if (p.length === 1) {
    return (
      <Muted>
        Só há uma compra registada ({formatEUR(p[0].cents)} {per}, {formatDate(p[0].date)}). O gráfico aparece a partir da segunda.
      </Muted>
    );
  }
  const first = p[0];
  const last = p[p.length - 1];
  const change = first.cents > 0 ? (last.cents - first.cents) / first.cents : 0;
  const pct = Math.abs(Math.round(change * 100));
  const trend = pct === 0 ? `Preço igual desde ${formatDate(first.date)}` : `${change > 0 ? 'Subiu' : 'Desceu'} ${pct}% desde ${formatDate(first.date)}`;
  const cheapest = p.reduce((a, b) => (b.cents < a.cents ? b : a));
  const where = [cheapest.store, cheapest.brand].filter(Boolean).join(', ');
  const shops = prices!.byShop;

  return (
    <View style={styles.wrap}>
      <PriceLine points={p} label={`Preço de ${name} ${per}`} />
      <Text style={styles.readout}>
        {trend} (preço {per}). Mais barato: {formatEUR(cheapest.cents)}
        {where ? ` (${where})` : ''}, {formatDate(cheapest.date)}.
      </Text>
      {shops.length > 1 && (
        <View style={styles.table} accessibilityLabel={`Preço ${per} por loja`}>
          <View style={styles.tr}>
            <Text style={[styles.th, styles.shop]}>Loja</Text>
            <Text style={styles.th}>Média</Text>
            <Text style={styles.th}>Mín.</Text>
            <Text style={styles.th}>Última</Text>
          </View>
          {shops.map((s, i) => (
            <View key={s.label} style={styles.tr}>
              <Text style={[styles.td, styles.shop, i === 0 && styles.best]} numberOfLines={1}>
                {s.label} <Text style={styles.n}>{s.count}×</Text>
              </Text>
              <Text style={[styles.td, i === 0 && styles.best]}>{formatEUR(s.avg)}</Text>
              <Text style={styles.td}>{formatEUR(s.min)}</Text>
              <Text style={styles.td}>{formatEUR(s.last)}</Text>
            </View>
          ))}
        </View>
      )}
      {prices!.skipped > 0 && (
        <Muted>{prices!.skipped} compras ficaram de fora por não terem o mesmo tipo de preço (ex.: sem o tamanho da embalagem).</Muted>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  readout: { fontSize: 13, color: colors.muted },
  table: { gap: 4 },
  tr: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  th: { width: 64, fontSize: 12, color: colors.muted, textAlign: 'right' },
  td: { width: 64, fontSize: 13, color: colors.ink, textAlign: 'right', fontVariant: ['tabular-nums'] },
  shop: { flex: 1, width: undefined, textAlign: 'left' },
  best: { color: colors.income, fontWeight: '600' },
  n: { fontSize: 12, color: colors.muted },
});
