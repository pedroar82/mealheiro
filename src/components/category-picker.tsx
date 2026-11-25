import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { normDesc } from '@/lib/cgd-import';
import { useCreateCategory } from '@/lib/queries';
import type { Category, CategoryKind } from '@/lib/types';

const MAX_RESULTS = 60;

/**
 * Field that opens a sheet to choose a category at any depth: search by name ("porco", "vinho") or browse level by
 * level (tap a name to choose it, › to see its subcategories). Opens at the level of the current value.
 */
export function CategoryPicker({
  index,
  kind,
  value,
  onChange,
}: {
  index: CategoryIndex;
  kind: CategoryKind;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<string | null>(null); // category whose children are listed (null = main categories)
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const create = useCreateCategory();
  // read outside the Modal: inside it the insets come back as 0 and "Fechar" ends up under the status bar
  const insets = useSafeAreaInsets();

  const childrenOf = (id: string | null) => (index.children.get(id) ?? []).filter((c) => c.kind === kind && !c.archived);
  const current = at ? index.byId.get(at) : undefined;
  const list = childrenOf(at);

  const results = useMemo(() => {
    const q = normDesc(query.trim());
    if (q.length < 2) return null;
    const hits: { c: Category; path: string; score: number }[] = [];
    for (const c of index.byId.values()) {
      if (c.kind !== kind || c.archived || hiddenByArchive(index, c)) continue;
      const name = normDesc(c.name);
      const path = categoryPath(index, c.id);
      const inName = name.includes(q);
      if (!inName && !normDesc(path).includes(q)) continue;
      // name starting with the query first, then name containing it, then path; shallower before deeper
      const score = (name.startsWith(q) ? 0 : inName ? 1 : 2) * 10 + path.split(' › ').length;
      hits.push({ c, path, score });
    }
    return hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path, 'pt')).slice(0, MAX_RESULTS);
  }, [query, index, kind]);

  const show = () => {
    const v = value ? index.byId.get(value) : undefined;
    setAt(v ? (childrenOf(v.id).length ? v.id : v.parent_id) : null); // open where the current choice is
    setQuery('');
    setAdding(false);
    setOpen(true);
  };

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setAdding(false);
  };

  const add = () => create.mutate({ name: newName, parent_id: at, kind }, { onSuccess: (c) => (setNewName(''), pick(c.id)) });

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Categoria: ${categoryPath(index, value)}`}
        onPress={show}
        style={styles.field}>
        <Text style={[styles.fieldText, !value && { color: colors.muted }]}>{value ? categoryPath(index, value) : 'Escolher categoria'}</Text>
        <Text style={styles.chev}>›</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Escolher categoria</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}>
              <Text style={styles.closeText}>Fechar</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Procurar (ex.: porco, vinho, detergente)"
            placeholderTextColor={colors.muted}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            accessibilityLabel="Procurar categoria"
          />

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            {results ? (
              <View style={styles.group}>
                {results.length === 0 && <Text style={styles.empty}>Nenhuma categoria com “{query.trim()}”.</Text>}
                {results.map(({ c, path }) => (
                  <Pressable key={c.id} accessibilityRole="button" onPress={() => pick(c.id)} style={styles.rowMain}>
                    <Text style={[styles.rowText, value === c.id && styles.selected]}>{c.name}</Text>
                    {path !== c.name && <Text style={styles.rowPath}>{path}</Text>}
                  </Pressable>
                ))}
              </View>
            ) : (
              <>
                {current && (
                  <View style={styles.crumbs}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Voltar ao nível anterior" onPress={() => setAt(current.parent_id)} style={styles.back}>
                      <Text style={styles.backText}>‹ Voltar</Text>
                    </Pressable>
                    <Text style={styles.crumbText} numberOfLines={2}>{categoryPath(index, current.id)}</Text>
                  </View>
                )}
                <View style={styles.group}>
                  {current && (
                    <Pressable accessibilityRole="button" onPress={() => pick(current.id)} style={styles.rowMain}>
                      <Text style={[styles.rowText, value === current.id && styles.selected]}>{current.name} (geral)</Text>
                      <Text style={styles.rowPath}>Sem detalhar mais</Text>
                    </Pressable>
                  )}
                  {list.map((c) => {
                    const subs = childrenOf(c.id).length;
                    const inside = value != null && value !== c.id && categoryPath(index, value).startsWith(`${categoryPath(index, c.id)} › `);
                    return (
                      <View key={c.id} style={styles.row}>
                        <Pressable accessibilityRole="button" onPress={() => pick(c.id)} style={[styles.rowMain, { flex: 1 }]}>
                          <Text style={[styles.rowText, (value === c.id || inside) && styles.selected]}>{c.name}</Text>
                        </Pressable>
                        {subs > 0 && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Ver subcategorias de ${c.name}`}
                            onPress={() => setAt(c.id)}
                            style={styles.expand}>
                            <Text style={styles.expandText}>{subs} ›</Text>
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                  {current &&
                    (adding ? (
                      <View style={styles.addRow}>
                        <TextInput
                          style={styles.addInput}
                          value={newName}
                          onChangeText={setNewName}
                          placeholder={`Nova subcategoria de ${current.name}`}
                          autoFocus
                          returnKeyType="done"
                          onSubmitEditing={add}
                          accessibilityLabel={`Nome da nova subcategoria de ${current.name}`}
                        />
                        <Pressable accessibilityRole="button" disabled={create.isPending} onPress={add} style={styles.addBtn}>
                          {create.isPending ? <ActivityIndicator color="#fff" /> : <Text style={styles.addBtnText}>Criar</Text>}
                        </Pressable>
                      </View>
                    ) : (
                      <Pressable accessibilityRole="button" onPress={() => (setAdding(true), setNewName(''), create.reset())} style={styles.rowMain}>
                        <Text style={styles.addText}>+ Nova subcategoria de {current.name}</Text>
                      </Pressable>
                    ))}
                </View>
                {adding && create.error && <Text style={styles.error}>{create.error.message}</Text>}
              </>
            )}
            <Pressable accessibilityRole="button" onPress={() => pick(null)} style={styles.none}>
              <Text style={styles.noneText}>Por categorizar</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

/** A category under an archived parent doesn't appear in the choice either. */
function hiddenByArchive(idx: CategoryIndex, c: Category) {
  for (let p = c.parent_id ? idx.byId.get(c.parent_id) : undefined; p; p = p.parent_id ? idx.byId.get(p.parent_id) : undefined) {
    if (p.archived) return true;
  }
  return false;
}

const styles = StyleSheet.create({
  field: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  fieldText: { flex: 1, fontSize: 16, color: colors.ink },
  chev: { fontSize: 22, color: colors.muted },
  sheet: { flex: 1, backgroundColor: colors.ground },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingTop: space.md },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: colors.ink },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  closeText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  search: { marginHorizontal: space.md, marginTop: space.sm, minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.ink, backgroundColor: colors.card },
  body: { padding: space.md, gap: space.sm },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: { minHeight: 44, justifyContent: 'center', paddingRight: space.sm },
  backText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  crumbText: { flex: 1, fontSize: 14, color: colors.muted },
  group: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  rowMain: { minHeight: 50, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: 6 },
  rowText: { fontSize: 16, color: colors.ink },
  rowPath: { fontSize: 12, color: colors.muted, marginTop: 2 },
  expand: { minWidth: 64, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  expandText: { fontSize: 14, color: colors.accent, fontWeight: '600' },
  selected: { color: colors.accent, fontWeight: '700' },
  empty: { padding: space.md, fontSize: 15, color: colors.muted },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  addInput: { flex: 1, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink },
  addBtn: { minHeight: 44, minWidth: 72, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  addText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
  none: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md },
  noneText: { fontSize: 15, color: colors.warning, fontWeight: '600' },
});
