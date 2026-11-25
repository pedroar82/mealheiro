import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, space } from '@/constants/theme';
import { normDesc } from '@/lib/cgd-import';
import { errorText } from '@/lib/import-io';
import { ensureProduct, useProducts } from '@/lib/products';

const MAX_RESULTS = 80;

/**
 * Field that opens a sheet to choose a product (generic name, every brand): search, or create one with the typed name.
 * `compact` shows a small link-style field (movement screen product lines).
 */
export function ProductPicker({
  value,
  onChange,
  placeholder = 'Escolher produto',
  compact,
  exclude,
  title = 'Escolher produto',
}: {
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  compact?: boolean;
  exclude?: string; // e.g. the product being merged
  title?: string;
}) {
  const qc = useQueryClient();
  const products = useProducts();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // read outside the Modal: inside it the insets come back as 0 (same as CategoryPicker)
  const insets = useSafeAreaInsets();

  const current = products.data?.find((p) => p.id === value);
  const q = normDesc(query.trim());
  const results = useMemo(() => {
    const list = (products.data ?? []).filter((p) => p.id !== exclude && (!q || normDesc(p.name).includes(q)));
    return list
      .sort((a, b) => Number(!normDesc(a.name).startsWith(q)) - Number(!normDesc(b.name).startsWith(q)) || a.name.localeCompare(b.name, 'pt'))
      .slice(0, MAX_RESULTS);
  }, [products.data, q, exclude]);
  const exact = (products.data ?? []).some((p) => normDesc(p.name) === q);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await ensureProduct(query);
      await qc.invalidateQueries({ queryKey: ['products'] });
      pick(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Produto: ${current?.name ?? 'nenhum'}`}
        onPress={() => (setQuery(''), setError(null), setOpen(true))}
        style={compact ? styles.compact : styles.field}>
        <Text style={[compact ? styles.compactText : styles.fieldText, !current && { color: colors.muted }]} numberOfLines={1}>
          {current?.name ?? placeholder}
        </Text>
        <Text style={styles.chev}>›</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}>
              <Text style={styles.closeText}>Fechar</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Procurar ou escrever um nome novo"
            placeholderTextColor={colors.muted}
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Procurar produto"
          />
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            {products.isLoading && <ActivityIndicator />}
            {error && <Text style={styles.error}>{error}</Text>}
            {query.trim().length >= 2 && !exact && (
              <Pressable accessibilityRole="button" onPress={create} disabled={busy} style={[styles.group, styles.rowMain]}>
                <Text style={styles.addText}>{busy ? 'A criar…' : `+ Criar “${query.trim()}”`}</Text>
              </Pressable>
            )}
            <View style={styles.group}>
              {products.data && results.length === 0 && <Text style={styles.empty}>Nenhum produto{q ? ` com “${query.trim()}”` : ''}.</Text>}
              {results.map((p, i) => (
                <Pressable key={p.id} accessibilityRole="button" onPress={() => pick(p.id)} style={[styles.rowMain, i > 0 && styles.border]}>
                  <Text style={[styles.rowText, value === p.id && styles.selected]}>{p.name}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  fieldText: { flex: 1, fontSize: 16, color: colors.ink },
  compact: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 4 },
  compactText: { flexShrink: 1, fontSize: 13, color: colors.accent },
  chev: { fontSize: 18, color: colors.muted },
  sheet: { flex: 1, backgroundColor: colors.ground },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingTop: space.md },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: colors.ink },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  closeText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  search: { marginHorizontal: space.md, marginTop: space.sm, minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.ink, backgroundColor: colors.card },
  body: { padding: space.md, gap: space.sm },
  group: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  rowMain: { minHeight: 50, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: 6 },
  border: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  rowText: { fontSize: 16, color: colors.ink },
  selected: { color: colors.accent, fontWeight: '700' },
  empty: { padding: space.md, fontSize: 15, color: colors.muted },
  addText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
});
