// Receipt items not yet at the most detailed level (decided 23/11/2026): items in a category that has subcategories,
// within Alimentação › Supermercado, Saúde › Higiene, Casa › Limpeza and Casa › Artigos para a Casa (e.g. old items in
// plain "Supermercado" or "Talho"). Claude suggests (Edge Function `categorise-lines`), the user reviews, then line
// items and line rules are updated.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { chunks, errorText, fetchAll } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import { linePattern } from '@/lib/receipt';
import { supabase } from '@/lib/supabase';

type Item = { key: string; text: string; name: string; ids: string[]; from: string[] }; // one per printed text (same product)
type Choice = { category_id: string | null; confidence: number };

const BATCH = 100;
/** The suggestion is where the item already is (nothing to move). */
const unchanged = (i: Item, id: string | null) => !id || (i.from.length === 1 && i.from[0] === id);
const LOW = 0.6;

const SCOPE = ['Alimentação › Supermercado', 'Saúde › Higiene', 'Casa › Limpeza', 'Casa › Artigos para a Casa'];

/** Categories in SCOPE that still have subcategories: items there can be detailed further. */
function eligible(idx: CategoryIndex): string[] {
  const out: string[] = [];
  for (const c of idx.byId.values()) {
    if (c.kind !== 'expense' || c.archived) continue;
    const path = categoryPath(idx, c.id);
    if (!SCOPE.some((s) => path === s || path.startsWith(`${s} › `))) continue;
    if ((idx.children.get(c.id) ?? []).some((x) => !x.archived)) out.push(c.id);
  }
  return out;
}

export default function ReorganizarSupermercado() {
  const qc = useQueryClient();
  const { index, isLoading } = useCategories();
  const scope = useMemo(() => eligible(index), [index]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const items = useQuery({
    queryKey: ['line_items', 'to-detail', scope.join()],
    enabled: scope.length > 0,
    queryFn: async () => {
      const rows = await fetchAll<{ id: string; raw_text: string; name: string; category_id: string }>((a, b) =>
        supabase.from('line_items').select('id, raw_text, name, category_id').in('category_id', scope).order('id').range(a, b),
      );
      const by = new Map<string, Item>();
      for (const r of rows) {
        const key = linePattern(r.raw_text);
        const e = by.get(key) ?? { key, text: r.raw_text, name: r.name, ids: [], from: [] };
        e.ids.push(r.id);
        if (!e.from.includes(r.category_id)) e.from.push(r.category_id);
        by.set(key, e);
      }
      return [...by.values()].sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name, 'pt'));
    },
  });

  const list = useMemo(() => items.data ?? [], [items.data]);
  const suggested = Object.keys(choices).length > 0;
  const byPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of index.byId.values()) if (c.kind === 'expense' && !c.archived) m.set(categoryPath(index, c.id), c.id);
    return m;
  }, [index]);

  const suggest = async () => {
    setError(null);
    setSaved(null);
    const out: Record<string, Choice> = {};
    try {
      const parts = chunks(list, BATCH);
      for (const [n, part] of parts.entries()) {
        setProgress(`A pedir sugestões… ${n * BATCH} de ${list.length}`);
        const res = await supabase.functions.invoke<{ suggestions: { key: string; category: string | null; confidence: number }[] }>(
          'categorise-lines',
          { body: { items: part.map((i) => ({ key: i.key, text: i.text, name: i.name })) } },
        );
        if (res.error) {
          const body = await (res.error as { context?: Response }).context?.json?.().catch(() => null);
          throw new Error(body?.error ?? res.error.message);
        }
        for (const s of res.data?.suggestions ?? []) {
          const id = s.category ? byPath.get(s.category) ?? null : null;
          const item = part.find((x) => x.key === s.key);
          out[s.key] = { category_id: item && unchanged(item, id) ? null : id, confidence: s.confidence };
        }
        setChoices({ ...out });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  const toMove = list.filter((i) => choices[i.key]?.category_id);

  const save = async () => {
    setError(null);
    setProgress('A guardar…');
    try {
      const byCat = new Map<string, Item[]>();
      for (const i of toMove) {
        const c = choices[i.key].category_id!;
        byCat.set(c, [...(byCat.get(c) ?? []), i]);
      }
      for (const [category_id, its] of byCat) {
        for (const part of chunks(its.flatMap((i) => i.ids), 100)) {
          const { error: e } = await supabase.from('line_items').update({ category_id, needs_review: false }).in('id', part).in('category_id', scope);
          if (e) throw new Error(e.message);
        }
        // rules learned for these products ("this text → Talho") follow the new category
        for (const part of chunks(its.map((i) => i.key), 100)) {
          const { error: e } = await supabase
            .from('rules')
            .update({ category_id })
            .eq('scope', 'line_item')
            .in('category_id', scope)
            .in('pattern', part);
          if (e) throw new Error(e.message);
        }
      }
      setSaved(toMove.reduce((s, i) => s + i.ids.length, 0));
      setChoices({});
      ['line_items', 'spend', 'explore', 'transactions', 'transaction', 'rules'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  // review: grouped by the suggested category
  const sections = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of list) {
      if (!(i.key in choices)) continue;
      const k = choices[i.key].category_id ?? '';
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : categoryPath(index, a[0]).localeCompare(categoryPath(index, b[0]), 'pt')));
  }, [list, choices, index]);

  if (isLoading || items.isLoading) return <ActivityIndicator style={{ marginTop: space.xl }} />;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        {items.error && <Text style={styles.error}>{items.error.message}</Text>}
        {saved != null && (
          <Card style={styles.ok}>
            <Text style={styles.h3}>{saved} produtos reorganizados ✓</Text>
            <Muted>Os que ficaram por mudar continuam onde estavam.</Muted>
          </Card>
        )}

        <Card>
          <Text style={styles.h3}>
            {list.length} {list.length === 1 ? 'produto diferente' : 'produtos diferentes'} por detalhar
          </Text>
          <Muted>
            Produtos de talões que estão numa categoria com subcategorias (ex.: só “Supermercado” ou só “Talho”). O Claude sugere a categoria mais detalhada de cada um (Talho › Porco, Garrafeira › Vinho tinto…). Revê as sugestões antes de guardar;
            nada muda até carregar em Guardar. Os produtos repetidos contam uma vez.
          </Muted>
          {list.length > 0 && !suggested && <Button label="Sugerir subcategorias" busy={!!progress} onPress={suggest} />}
          {progress && <Muted>{progress}</Muted>}
          {error && <Text style={styles.error}>{error}</Text>}
        </Card>

        {sections.map(([cat, its]) => (
          <Card key={cat || 'none'}>
            <Text style={styles.h3}>
              {cat ? categoryPath(index, cat) : 'Sem sugestão (ficam como estão)'} · {its.length}
            </Text>
            {its.map((i) => {
              const c = choices[i.key];
              return (
                <View key={i.key} style={styles.item}>
                  <Text style={styles.name}>
                    {i.name}
                    <Text style={styles.meta}>
                      {i.ids.length > 1 ? ` · ${i.ids.length}×` : ''}
                      {c.category_id && c.confidence < LOW ? ' · confirme' : ''}
                    </Text>
                  </Text>
                  <Muted>
                    {i.text} · agora: {i.from.map((f) => categoryPath(index, f).split(' › ').slice(-1)[0]).join(', ')}
                  </Muted>
                  <CategoryPicker
                    index={index}
                    kind="expense"
                    value={c.category_id}
                    onChange={(id) => setChoices((s) => ({ ...s, [i.key]: { category_id: unchanged(i, id) ? null : id, confidence: 1 } }))}
                  />
                </View>
              );
            })}
          </Card>
        ))}

        {suggested && (
          <Card>
            <Button
              label={`Guardar (${toMove.reduce((s, i) => s + i.ids.length, 0)} produtos)`}
              busy={progress === 'A guardar…'}
              disabled={!toMove.length || !!progress}
              onPress={save}
            />
            <Button label="Descartar sugestões" variant="secondary" disabled={!!progress} onPress={() => setChoices({})} />
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  item: { gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  name: { fontSize: 15, color: colors.ink, fontWeight: '600' },
  meta: { fontSize: 13, color: colors.warning, fontWeight: '400' },
  ok: { borderWidth: 1, borderColor: colors.income },
  error: { color: colors.danger, fontSize: 14 },
});
