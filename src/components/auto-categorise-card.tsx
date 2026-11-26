// "Categorizar automaticamente": runs src/lib/auto-categorise.ts and shows what changed, each movement tappable to fix,
// with "Anular" to put everything back. `txIds` + `autoStart` = right after an import, for the movements it created.

import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { autoCategorise, changedCount, undoAuto, type AutoResult, type How } from '@/lib/auto-categorise';
import { categoryPath } from '@/lib/categories';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';

const HOW: Record<How, string> = { rule: 'regra', history: 'como antes', model: 'sugerido' };
const SHOWN = 40;

export function AutoCategoriseCard({ txIds, autoStart, intro }: { txIds?: string[]; autoStart?: boolean; intro?: string }) {
  const qc = useQueryClient();
  const { index } = useCategories();
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<AutoResult | null>(null);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const started = useRef(false);

  const refresh = () => ['transactions', 'transaction', 'spend', 'explore', 'line_items', 'rules'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const run = async () => {
    setError(null);
    setResult(null);
    setUndone(false);
    setProgress('A começar…');
    try {
      setResult(await autoCategorise({ txIds, onProgress: setProgress }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      refresh();
    }
  };

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const undo = async () => {
    if (!result) return;
    setProgress('A anular…');
    setError(null);
    try {
      await undoAuto(result);
      setUndone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      refresh();
    }
  };

  const n = result ? changedCount(result) : 0;
  const lineCount = result ? result.lines.reduce((s, l) => s + l.ids.length, 0) : 0;
  const left = result ? result.leftMovements + result.leftLines : 0;

  return (
    <Card>
      <Text style={styles.h3}>Categorizar automaticamente</Text>
      {!result && !progress && (
        <>
          <Muted>
            {intro ??
              'Usa primeiro as suas regras e o que já categorizou antes (a mesma descrição do banco, o mesmo produto); o resto é sugerido pelo modelo e só é aplicado quando há confiança. Pode corrigir ou anular a seguir.'}
          </Muted>
          {!autoStart && <Button label="Categorizar agora" onPress={run} />}
        </>
      )}
      {progress && <Muted>{progress}</Muted>}
      {error && <Text style={styles.error}>{error}</Text>}

      {result && !undone && (
        <>
          <Text style={styles.summary} accessibilityLiveRegion="polite">
            {n === 0
              ? 'Nada para categorizar automaticamente.'
              : `${result.movements.length} movimentos e ${lineCount} produtos categorizados.`}
            {left > 0 ? ` ${left} ficaram por categorizar (sem confiança suficiente).` : ''}
          </Text>
          {n > 0 && <Muted>Toque num movimento para corrigir. As descrições aprendidas ficam em Definições › Regras.</Muted>}

          {(all ? result.movements : result.movements.slice(0, SHOWN)).map((m) => (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityHint="Abre o movimento para corrigir"
              onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: m.id } })}
              style={styles.row}>
              <View style={styles.top}>
                <Text style={styles.date}>{formatDate(m.date).slice(0, 5)}</Text>
                <Text style={styles.desc} numberOfLines={1}>{m.description}</Text>
                <Text style={styles.amount}>{formatEUR(m.amount_cents)}</Text>
              </View>
              <Text style={styles.to}>
                → {categoryPath(index, m.to)} <Text style={styles.how}>· {HOW[m.how]}</Text>
              </Text>
            </Pressable>
          ))}
          {(all ? result.lines : result.lines.slice(0, SHOWN)).map((l) => (
            <Pressable
              key={l.text}
              accessibilityRole="button"
              accessibilityHint="Abre o talão para corrigir"
              onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: l.txIds[0] } })}
              style={styles.row}>
              <View style={styles.top}>
                <Text style={styles.desc} numberOfLines={1}>{l.name}</Text>
                {l.ids.length > 1 && <Text style={styles.how}>{l.ids.length}×</Text>}
              </View>
              <Text style={styles.to}>
                → {categoryPath(index, l.to)} <Text style={styles.how}>· {HOW[l.how]}</Text>
              </Text>
            </Pressable>
          ))}
          {!all && (result.movements.length > SHOWN || result.lines.length > SHOWN) && (
            <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={styles.more}>
              <Text style={styles.link}>Ver tudo</Text>
            </Pressable>
          )}
          <View style={styles.actions}>
            {n > 0 && <Button label="Anular tudo" variant="secondary" busy={progress === 'A anular…'} disabled={!!progress} onPress={undo} />}
            {!autoStart && <Button label="Correr de novo" variant="secondary" disabled={!!progress} onPress={run} />}
          </View>
        </>
      )}
      {undone && (
        <>
          <Text style={styles.summary}>Anulado: os movimentos e produtos voltaram a ficar sem categoria.</Text>
          <Button label="Correr de novo" variant="secondary" onPress={run} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  summary: { fontSize: 14, color: colors.ink, fontWeight: '600' },
  row: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  date: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'], minWidth: 38 },
  desc: { flex: 1, fontSize: 14, color: colors.ink },
  amount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  to: { fontSize: 13, color: colors.accent },
  how: { fontSize: 12, color: colors.muted, fontWeight: '400' },
  more: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  link: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  actions: { gap: space.sm },
  error: { color: colors.danger, fontSize: 14 },
});
