// Definições › Importações: what the model calls cost — this month, per task and per day (decided 25/11/2026).
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { cacheShare, FN_LABEL, formatUSD, summarise, useAiUsage } from '@/lib/ai-usage';
import { formatDate } from '@/lib/format';

const DAYS_SHOWN = 10;

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function AiCostSection() {
  const since = monthStart();
  const q = useAiUsage(since);
  const [allDays, setAllDays] = useState(false);
  const s = q.data ? summarise(q.data) : null;

  return (
    <Card>
      <Text style={styles.h3}>Custo do modelo este mês</Text>
      {q.isLoading && <Muted>A carregar…</Muted>}
      {q.error && <Muted>Ainda sem registo de custos (falta aplicar a migração ai_usage?).</Muted>}
      {s && s.total.calls === 0 && <Muted>Nenhuma chamada ao modelo este mês.</Muted>}
      {s && s.total.calls > 0 && (
        <>
          <Text style={styles.total} accessibilityLabel={`Total estimado ${formatUSD(s.total.cost)}`}>
            {formatUSD(s.total.cost)}
          </Text>
          <Muted>
            {s.total.calls} chamadas · {Math.round(cacheShare(s.total) * 100)}% da entrada veio da cache. Estimativa pela tabela
            de preços; o valor exato está na Console da Anthropic.
          </Muted>

          <Text style={styles.h4}>Por tarefa</Text>
          {s.fns.map(([fn, v]) => (
            <View key={fn} style={styles.row}>
              <Text style={styles.label} numberOfLines={1}>
                {FN_LABEL[fn] ?? fn} <Text style={styles.muted}>· {v.calls}×</Text>
              </Text>
              <Text style={styles.value}>{formatUSD(v.cost)}</Text>
            </View>
          ))}

          <Text style={styles.h4}>Por dia</Text>
          {(allDays ? s.days : s.days.slice(0, DAYS_SHOWN)).map(([day, v]) => (
            <View key={day} style={styles.row}>
              <Text style={styles.label}>
                {formatDate(day)} <Text style={styles.muted}>· {v.calls}×</Text>
              </Text>
              <Text style={styles.value}>{formatUSD(v.cost)}</Text>
            </View>
          ))}
          {!allDays && s.days.length > DAYS_SHOWN && (
            <Pressable accessibilityRole="button" onPress={() => setAllDays(true)} style={styles.more}>
              <Text style={styles.link}>Ver todos os dias</Text>
            </Pressable>
          )}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  h4: { fontSize: 13, fontWeight: '700', color: colors.muted, marginTop: space.sm },
  total: { fontSize: 24, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  label: { flex: 1, fontSize: 14, color: colors.ink },
  muted: { color: colors.muted, fontSize: 13 },
  value: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  more: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  link: { fontSize: 15, color: colors.accent, fontWeight: '600' },
});
