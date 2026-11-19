import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Chip, FieldLabel, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import type { CategoryIndex } from '@/lib/categories';
import { centsToInput, formatDate, formatEUR, parseAmount, parseDate } from '@/lib/format';
import { findDuplicate, findMatches, type Draft, type DraftLine, type Match } from '@/lib/receipt';

/** Review an extracted receipt/invoice before saving. Shared by the web upload and the iPhone scanner. */
export function ReceiptReview({
  initial,
  index,
  busy,
  error,
  onSave,
  onDiscard,
}: {
  initial: Draft;
  index: CategoryIndex;
  busy: boolean;
  error: string | null;
  onSave: (d: Draft, mergeInto: string | null) => void;
  onDiscard: () => void;
}) {
  const [d, setD] = useState(initial);
  const [dateText, setDateText] = useState(formatDate(initial.date));
  const [totalText, setTotalText] = useState(centsToInput(initial.totalCents));
  const [duplicate, setDuplicate] = useState<{ issue_date: string | null } | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [mergeInto, setMergeInto] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    findDuplicate(initial).then((r) => alive && setDuplicate(r));
    return () => {
      alive = false;
    };
  }, [initial]);

  const date = parseDate(dateText);
  const total = parseAmount(totalText);

  // same purchase already recorded (Excel history, manual entry, bank line)? Offer to attach the receipt to it.
  useEffect(() => {
    if (!date || total == null) return;
    let alive = true;
    findMatches(date, total).then((m) => {
      if (!alive) return;
      setMatches(m);
      setMergeInto(m[0]?.id ?? null); // default: the closest one
    });
    return () => {
      alive = false;
    };
  }, [date, total]);
  const sum = d.lines.reduce((s, l) => s + l.total_cents, 0);
  const mismatch = total != null && d.lines.length > 0 && sum !== total;
  const uncategorised = d.lines.filter((l) => !l.category_id && l.total_cents > 0).length; // discounts follow the main category

  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: string) => setD((s) => ({ ...s, lines: s.lines.filter((l) => l.key !== key) }));
  const setAll = (category_id: string | null) => setD((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, category_id })) }));

  const save = () => {
    if (!date || total == null) return;
    onSave({ ...d, date, totalCents: total }, matches.some((m) => m.id === mergeInto) ? mergeInto : null);
  };

  return (
    <View style={{ gap: space.md }}>
      {duplicate && (
        <Card style={styles.warnCard}>
          <Text style={styles.warnTitle}>Esta fatura já foi registada</Text>
          <Muted>
            Mesmo NIF e número de documento ({d.docNumber}){duplicate.issue_date ? `, de ${formatDate(duplicate.issue_date)}` : ''}. Não é
            possível guardá-la duas vezes.
          </Muted>
          <Button label="Descartar" variant="secondary" onPress={onDiscard} />
        </Card>
      )}

      <Card>
        <FieldLabel>Comerciante</FieldLabel>
        <TextInput style={styles.input} value={d.merchantName} onChangeText={(merchantName) => setD((s) => ({ ...s, merchantName }))} placeholder="ex.: Continente" />
        <View style={styles.row2}>
          <View style={[styles.col, { flex: 2 }]}>
            <FieldLabel>Loja</FieldLabel>
            <TextInput style={styles.input} value={d.storeName ?? ''} onChangeText={(t) => setD((s) => ({ ...s, storeName: t || null }))} placeholder="ex.: Continente Lisboa" />
          </View>
          <View style={styles.col}>
            <FieldLabel>Localidade</FieldLabel>
            <TextInput style={styles.input} value={d.storeLocality ?? ''} onChangeText={(t) => setD((s) => ({ ...s, storeLocality: t || null }))} placeholder="ex.: Lisboa" />
          </View>
        </View>
        {d.storeAddress && <Muted>{d.storeAddress}</Muted>}
        <View style={styles.row2}>
          <View style={styles.col}>
            <FieldLabel>Data</FieldLabel>
            <TextInput style={[styles.input, !date && styles.invalid]} value={dateText} onChangeText={setDateText} placeholder="dd/mm/aaaa" inputMode="numeric" />
          </View>
          <View style={styles.col}>
            <FieldLabel>Total</FieldLabel>
            <TextInput style={[styles.input, total == null && styles.invalid]} value={totalText} onChangeText={setTotalText} inputMode="decimal" />
          </View>
        </View>
        <Muted>
          {[d.sellerNif && `NIF ${d.sellerNif}`, d.docNumber, d.vatCents != null && `IVA ${formatEUR(d.vatCents)}`,
            d.billingStart && d.billingEnd && `Período ${formatDate(d.billingStart)} – ${formatDate(d.billingEnd)}`]
            .filter(Boolean)
            .join(' · ')}
        </Muted>
        {d.warnings.map((w) => <Text key={w} style={styles.warning}>⚠ {w}</Text>)}
        {mismatch && (
          <Text style={styles.warning}>
            ⚠ As linhas somam {formatEUR(sum)}, o total é {formatEUR(total!)} (diferença {formatEUR(total! - sum)}). O total é o que conta.
          </Text>
        )}
      </Card>

      {date && total != null && matches.length > 0 && (
        <Card style={styles.matchCard}>
          <Text style={styles.warnTitle}>Já existe um movimento com este valor</Text>
          <Muted>
            Provavelmente é a mesma compra (do Excel, introduzida à mão ou do banco). Juntar o talão a esse movimento evita
            contá-la duas vezes; a data, o valor e a conta dele mantêm-se.
          </Muted>
          <View style={styles.chips}>
            {matches.map((m) => (
              <Chip
                key={m.id}
                label={`Juntar a: ${m.description ?? 'Despesa'} · ${formatDate(m.date)} · ${SOURCE[m.source] ?? m.source}`}
                selected={mergeInto === m.id}
                onPress={() => setMergeInto(m.id)}
              />
            ))}
            <Chip label="Não, é outra compra" selected={mergeInto === null} onPress={() => setMergeInto(null)} />
          </View>
        </Card>
      )}

      <Card>
        <View style={styles.linesHead}>
          <Text style={styles.h3}>{d.lines.length} {d.lines.length === 1 ? 'linha' : 'linhas'}</Text>
          {uncategorised > 0 && <Text style={styles.warningSmall}>{uncategorised} por categorizar</Text>}
        </View>
        <View>
          <FieldLabel>Mudar todas para</FieldLabel>
          <CategoryPicker index={index} kind="expense" value={null} onChange={setAll} />
        </View>
        {d.lines.map((l) => (
          <View key={l.key} style={styles.line}>
            <View style={styles.lineTop}>
              <TextInput style={[styles.input, styles.lineName]} value={l.name} onChangeText={(name) => setLine(l.key, { name })} accessibilityLabel="Produto" />
              <LineAmount line={l} onChange={(total_cents) => setLine(l.key, { total_cents })} />
              <Pressable accessibilityRole="button" accessibilityLabel={`Remover ${l.name}`} onPress={() => removeLine(l.key)} style={styles.remove}>
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
            <Muted>
              {l.raw_text}
              {l.quantity != null && l.quantity !== 1 ? ` · ${String(l.quantity).replace('.', ',')} ${l.unit ?? ''}` : ''}
              {l.needs_review && l.category_id === l.initial_category_id ? ' · sugestão automática' : ''}
            </Muted>
            <CategoryPicker index={index} kind="expense" value={l.category_id} onChange={(category_id) => setLine(l.key, { category_id })} />
          </View>
        ))}
        <Muted>As categorias que mudar ficam memorizadas para este produto.</Muted>
      </Card>

      {error && <Text style={styles.error}>{error}</Text>}
      <Button label={mergeInto ? 'Guardar e juntar' : 'Guardar'} onPress={save} busy={busy} disabled={!!duplicate || !date || total == null || busy} />
      <Button label="Descartar" variant="secondary" onPress={onDiscard} disabled={busy} />
    </View>
  );
}

const SOURCE: Record<string, string> = { manual: 'manual', excel: 'Excel', bank_csv: 'banco', receipt: 'talão', pdf: 'PDF' };

function LineAmount({ line, onChange }: { line: DraftLine; onChange: (cents: number) => void }) {
  const [text, setText] = useState(centsToInput(Math.abs(line.total_cents)));
  const negative = line.total_cents < 0;
  return (
    <TextInput
      style={[styles.input, styles.lineAmount, negative && { color: colors.income }]}
      value={negative ? `−${text}` : text}
      inputMode="decimal"
      accessibilityLabel="Valor"
      onChangeText={(t) => {
        const clean = t.replace(/^[−-]/, '');
        setText(clean);
        const c = parseAmount(clean);
        if (c != null) onChange(negative ? -c : c);
      }}
    />
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 44, borderWidth: 1, borderColor: '#D5D8DF', borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  invalid: { borderColor: colors.danger },
  row2: { flexDirection: 'row', gap: space.md },
  col: { flex: 1, gap: 4 },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  linesHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  line: { gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  lineTop: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  lineName: { flex: 1 },
  lineAmount: { width: 96, textAlign: 'right', fontVariant: ['tabular-nums'] },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 16, color: colors.muted },
  warning: { fontSize: 13, color: colors.warning },
  warningSmall: { fontSize: 12, color: colors.warning, fontWeight: '600' },
  warnCard: { borderWidth: 1, borderColor: colors.warning },
  matchCard: { borderWidth: 1, borderColor: colors.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  warnTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
});
