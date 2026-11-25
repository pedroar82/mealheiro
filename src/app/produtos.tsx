// Produtos (decided 25/11/2026): receipt lines grouped into products automatically (Edge Function `group-products`);
// here the user groups old lines and fixes mistakes — rename, merge two products, move a printed text to another
// product, correct its brand or package size. Every fix applies to all lines with that printed text.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ProductPicker } from '@/components/product-picker';
import { Button, Card, Muted } from '@/components/ui';
import { colors, maxContentWidth, radius, space } from '@/constants/theme';
import { normDesc } from '@/lib/cgd-import';
import { errorText, fetchAll } from '@/lib/import-io';
import {
  dropIfEmpty,
  groupLines,
  loadUngrouped,
  mergeProducts,
  parseSize,
  renameProduct,
  setTextGrouping,
  sizeLabel,
  useProducts,
  type PackUnit,
} from '@/lib/products';
import { supabase } from '@/lib/supabase';

type GLine = { raw_text: string; product_id: string; brand: string | null; pack_qty: number | null; pack_unit: PackUnit | null };
type Text_ = { text: string; count: number; brand: string | null; pack_qty: number | null; pack_unit: PackUnit | null };
type Group = { id: string; name: string; count: number; brands: string[]; texts: Text_[] };

const MAX_SHOWN = 60;

function useInvalidate() {
  const qc = useQueryClient();
  return () => ['line_items', 'products', 'explore'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export default function Produtos() {
  const invalidate = useInvalidate();
  const products = useProducts();
  const ungrouped = useQuery({ queryKey: ['line_items', 'ungrouped'], queryFn: () => loadUngrouped() });
  const grouped = useQuery({
    queryKey: ['line_items', 'grouped'],
    queryFn: () =>
      fetchAll<GLine>((a, b) =>
        supabase.from('line_items').select('raw_text, product_id, brand, pack_qty, pack_unit').not('product_id', 'is', null).order('id').range(a, b),
      ),
  });
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const names = new Map((products.data ?? []).map((p) => [p.id, p.name]));
    const by = new Map<string, Group & { textMap: Map<string, Text_> }>();
    for (const l of grouped.data ?? []) {
      const g = by.get(l.product_id) ?? { id: l.product_id, name: names.get(l.product_id) ?? '…', count: 0, brands: [] as string[], texts: [] as Text_[], textMap: new Map<string, Text_>() };
      g.count++;
      if (l.brand && !g.brands.includes(l.brand)) g.brands.push(l.brand);
      const t = g.textMap.get(l.raw_text) ?? { text: l.raw_text, count: 0, brand: l.brand, pack_qty: l.pack_qty, pack_unit: l.pack_unit };
      t.count++;
      g.textMap.set(l.raw_text, t);
      by.set(l.product_id, g);
    }
    return [...by.values()]
      .map(({ textMap, ...g }) => ({ ...g, texts: [...textMap.values()].sort((a, b) => b.count - a.count) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt'));
  }, [grouped.data, products.data]);

  const shown = useMemo(() => {
    const n = normDesc(q.trim());
    if (!n) return groups;
    return groups.filter((g) => normDesc(g.name).includes(n) || g.brands.some((b) => normDesc(b).includes(n)) || g.texts.some((t) => normDesc(t.text).includes(n)));
  }, [groups, q]);

  const pending = ungrouped.data ?? [];
  const pendingTexts = new Set(pending.map((l) => normDesc(l.raw_text))).size;

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress('A começar…');
    try {
      const n = await groupLines(pending, (done, total) => setProgress(`A agrupar… ${done} de ${total} textos`));
      setResult(n);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      invalidate();
    }
  };

  if (products.isLoading || grouped.isLoading) return <ActivityIndicator style={{ marginTop: space.xl }} />;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        <Muted>
          Cada linha de um talão pertence a um produto (ex.: “Leite meio-gordo UHT”), com a marca e o tamanho da embalagem.
          O agrupamento é automático; aqui pode corrigir. Uma correção aplica-se a todas as compras com o mesmo texto impresso
          e às próximas.
        </Muted>

        {(pending.length > 0 || progress || result != null || error) && (
          <Card>
            {pending.length > 0 && (
              <>
                <Text style={styles.h3}>
                  {pending.length} {pending.length === 1 ? 'linha por agrupar' : 'linhas por agrupar'} ({pendingTexts} textos diferentes)
                </Text>
                <Muted>Linhas de talões guardados antes do agrupamento, ou cujo agrupamento falhou. Cada pedido ao modelo leva até 150 textos.</Muted>
                <Button label="Agrupar agora" busy={!!progress} disabled={!!progress} onPress={run} />
              </>
            )}
            {progress && <Muted>{progress}</Muted>}
            {result != null && <Text style={styles.ok}>{result} linhas agrupadas ✓</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
          </Card>
        )}

        <TextInput
          style={styles.input}
          value={q}
          onChangeText={setQ}
          placeholder="Procurar produto, marca ou texto"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        {(grouped.error ?? products.error) && <Text style={styles.error}>{(grouped.error ?? products.error)!.message}</Text>}
        <Muted>
          {groups.length} produtos{q.trim() ? ` · ${shown.length} encontrados` : ''}
        </Muted>

        {shown.slice(0, MAX_SHOWN).map((g) =>
          openId === g.id ? (
            <ProductCard key={g.id} g={g} onClose={() => setOpenId(null)} onMoved={(id) => setOpenId(id)} />
          ) : (
            <Pressable key={g.id} accessibilityRole="button" onPress={() => setOpenId(g.id)} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{g.name}</Text>
                {g.brands.length > 0 && <Muted>{g.brands.join(', ')}</Muted>}
              </View>
              <Text style={styles.count}>{g.count}×</Text>
            </Pressable>
          ),
        )}
        {shown.length > MAX_SHOWN && <Muted>+ {shown.length - MAX_SHOWN} — use a pesquisa para encontrar os restantes.</Muted>}
      </View>
    </ScrollView>
  );
}

function ProductCard({ g, onClose, onMoved }: { g: Group; onClose: () => void; onMoved: (id: string) => void }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(g.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      invalidate();
    }
  };

  return (
    <Card style={styles.open}>
      <View style={styles.inline}>
        <Text style={[styles.h3, { flex: 1 }]}>{g.name}</Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.small}>
          <Text style={styles.link}>Fechar</Text>
        </Pressable>
      </View>
      <View style={styles.inline}>
        <TextInput style={[styles.input, { flex: 1 }]} value={name} onChangeText={setName} accessibilityLabel="Nome do produto" />
        <Button
          label="Mudar nome"
          variant="secondary"
          disabled={busy || name.trim() === g.name}
          onPress={() => act(async () => onMoved(await renameProduct(g.id, name)))}
        />
      </View>
      <Muted>Se já existir um produto com esse nome, os dois juntam-se.</Muted>
      <ProductPicker
        value={null}
        exclude={g.id}
        title={`Juntar “${g.name}” a…`}
        placeholder="Juntar a outro produto…"
        onChange={(into) => act(async () => (await mergeProducts(g.id, into), onMoved(into)))}
      />

      <Text style={styles.sub}>Textos impressos ({g.texts.length})</Text>
      {g.texts.map((t) => (
        <TextRow key={t.text} t={t} productId={g.id} disabled={busy} act={act} />
      ))}
      {busy && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error}</Text>}
    </Card>
  );
}

function TextRow({ t, productId, disabled, act }: { t: Text_; productId: string; disabled: boolean; act: (f: () => Promise<void>) => Promise<void> }) {
  const [brand, setBrand] = useState(t.brand ?? '');
  const [size, setSize] = useState(sizeLabel(t.pack_qty, t.pack_unit) ?? '');
  const parsed = parseSize(size);
  const changed = brand.trim() !== (t.brand ?? '') || size.trim() !== (sizeLabel(t.pack_qty, t.pack_unit) ?? '');

  return (
    <View style={styles.textRow}>
      <Text style={styles.printed}>
        {t.text}
        <Text style={styles.count}> · {t.count}×</Text>
      </Text>
      <View style={styles.inline}>
        <TextInput style={[styles.input, styles.flex]} value={brand} onChangeText={setBrand} placeholder="Marca" placeholderTextColor={colors.muted} accessibilityLabel="Marca" />
        <TextInput style={[styles.input, styles.sizeInput]} value={size} onChangeText={setSize} placeholder="ex.: 1 l, 500 g" placeholderTextColor={colors.muted} autoCapitalize="none" accessibilityLabel="Tamanho da embalagem" />
        <Button
          label="Guardar"
          variant="secondary"
          disabled={disabled || !changed || !parsed}
          onPress={() => act(() => setTextGrouping(t.text, { brand: brand.trim() || null, pack_qty: parsed!.qty, pack_unit: parsed!.unit }))}
        />
      </View>
      {!parsed && <Text style={styles.error}>Tamanho não reconhecido (ex.: 1 l, 33 cl, 500 g, 6 un).</Text>}
      <ProductPicker
        compact
        value={null}
        exclude={productId}
        title={`Mover “${t.text}” para…`}
        placeholder="Mover para outro produto"
        onChange={(to) => act(async () => (await setTextGrouping(t.text, { product_id: to }), await dropIfEmpty(productId)))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  sub: { fontSize: 14, fontWeight: '600', color: colors.ink, marginTop: space.sm },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  flex: { flex: 1 },
  sizeInput: { width: 110 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12 },
  open: { borderWidth: 1, borderColor: colors.accent },
  name: { fontSize: 15, color: colors.ink, fontWeight: '600' },
  count: { fontSize: 13, color: colors.muted, fontWeight: '400' },
  textRow: { gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  printed: { fontSize: 14, color: colors.ink, fontFamily: 'monospace' },
  small: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  link: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  ok: { color: colors.income, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
});
