import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ReceiptReview } from '@/components/receipt-review';
import { Button, Card, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText, pickFiles } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import {
  buildDraft,
  discardDocument,
  DUPLICATE,
  findDuplicate,
  findMatches,
  loadLineRules,
  saveDraft,
  uploadAndExtract,
  type Draft,
  type Match,
} from '@/lib/receipt';
import { useSession } from '@/lib/session';

// Bulk import of PDF invoices (web). Each file goes through the same pipeline as a single upload
// (upload → extract-receipt → draft); every invoice is still reviewed and saved one by one.

const PARALLEL = 2; // files read at the same time (Edge Function + Anthropic API)

type Status = 'queued' | 'reading' | 'ready' | 'duplicate' | 'error' | 'saved' | 'discarded';

type Item = {
  id: string;
  name: string;
  file: File;
  status: Status;
  draft?: Draft;
  storagePath?: string;
  matches?: Match[];
  error?: string;
  savedId?: string;
  seconds?: number;
};

const STATUS_TEXT: Record<Status, string> = {
  queued: 'Na fila',
  reading: 'A ler…',
  ready: 'Por rever',
  duplicate: 'Já registada',
  error: 'Erro',
  saved: 'Guardada',
  discarded: 'Descartada',
};

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

export default function ImportarFaturas() {
  const qc = useQueryClient();
  const { session } = useSession();
  const { index } = useCategories();
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState<string | null>(null); // item under review
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the latest list, for the workers and the clean-up on leave
  const itemsRef = useRef<Item[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const alive = useRef(true);

  const update = (id: string, patch: Partial<Item>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  // leaving the screen: unsaved drafts are discarded (uploaded file + document row), like the single import
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const it of itemsRef.current) if (it.status === 'ready' && it.draft) void discardDocument(it.draft.documentId, it.storagePath ?? null);
    };
  }, []);

  // closing/reloading the tab while files are being read or waiting for review
  const pending = items.some((it) => it.status === 'queued' || it.status === 'reading' || it.status === 'ready');
  useEffect(() => {
    if (Platform.OS !== 'web' || !pending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  const read = async (it: Item, uid: string, rules: Awaited<ReturnType<typeof loadLineRules>>) => {
    update(it.id, { status: 'reading' });
    const started = Date.now();
    try {
      const up = await uploadAndExtract({ userId: uid, body: it.file, ext: 'pdf', kind: 'pdf_invoice' });
      if (!alive.current) {
        await discardDocument(up.documentId, up.storagePath); // screen left meanwhile
        return;
      }
      const draft = buildDraft(up.documentId, 'pdf_invoice', up.extraction, index, rules);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (await findDuplicate(draft)) {
        await discardDocument(up.documentId, up.storagePath);
        update(it.id, { status: 'duplicate', draft, seconds });
        return;
      }
      const matches = await findMatches(draft.date, draft.totalCents);
      update(it.id, { status: 'ready', draft, storagePath: up.storagePath, matches, seconds });
    } catch (e) {
      update(it.id, { status: 'error', error: errorText(e) });
    }
  };

  const choose = async () => {
    const uid = session?.user.id;
    if (!uid) return;
    setError(null);
    const files = (await pickFiles('application/pdf')).sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) return;
    const skipped = files.filter((f) => !isPdf(f)).length;
    if (skipped) setError(`${skipped} ficheiro(s) ignorado(s): só PDF.`);
    const added: Item[] = files.filter(isPdf).map((file, i) => ({ id: `${Date.now()}-${i}`, name: file.name, file, status: 'queued' }));
    setItems((list) => [...list, ...added]);

    const rules = await loadLineRules();
    let next = 0;
    const worker = async () => {
      while (next < added.length && alive.current) await read(added[next++], uid, rules);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, added.length) }, worker));
  };

  const current = items.find((it) => it.id === open && it.status === 'ready');

  const openNext = (after: string) => {
    const list = itemsRef.current;
    const from = list.findIndex((it) => it.id === after);
    const next = [...list.slice(from + 1), ...list.slice(0, from)].find((it) => it.status === 'ready');
    setOpen(next?.id ?? null);
  };

  const save = async (d: Draft, mergeInto: string | null) => {
    if (!current) return;
    setError(null);
    setBusy(true);
    try {
      const id = await saveDraft(d, current.storagePath ?? null, mergeInto, index);
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['spend'] });
      update(current.id, { status: 'saved', savedId: id });
      openNext(current.id);
    } catch (e) {
      setError(errorText(e) === DUPLICATE ? 'Esta fatura já foi registada (mesmo NIF e número de documento).' : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!current?.draft) return;
    await discardDocument(current.draft.documentId, current.storagePath ?? null);
    update(current.id, { status: 'discarded' });
    openNext(current.id);
  };

  const count = (s: Status) => items.filter((it) => it.status === s).length;
  const reading = count('queued') + count('reading');

  if (current?.draft) {
    const pos = items.filter((it) => it.status === 'ready').findIndex((it) => it.id === current.id) + 1;
    return (
      <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
        <View style={styles.inner}>
          <Card>
            <Text style={styles.h2}>{current.name}</Text>
            <Muted>
              Por rever: {pos} de {count('ready')}
              {reading ? ` · ainda a ler ${reading}` : ''}
            </Muted>
            <Button label="Voltar à lista" variant="secondary" onPress={() => setOpen(null)} disabled={busy} />
          </Card>
          <ReceiptReview key={current.draft.documentId} initial={current.draft} index={index} busy={busy} error={error} onSave={save} onDiscard={discard} />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        <Card>
          <Text style={styles.h2}>Várias faturas em PDF</Text>
          <Muted>
            Escolha vários PDFs de uma vez. São lidos {PARALLEL} a {PARALLEL} (cerca de meio minuto cada); as já registadas são
            ignoradas. Depois reveja e guarde cada uma — se a compra já existir (mesmo valor, ±3 dias), é proposta a junção. Mantenha
            esta página aberta até terminar.
          </Muted>
          <Button label={items.length ? 'Adicionar mais' : 'Escolher ficheiros'} onPress={choose} />
        </Card>

        {error && <Text style={styles.error}>{error}</Text>}

        {items.length > 0 && (
          <Card>
            <Text style={styles.summary} accessibilityLiveRegion="polite">
              {[
                reading && `a ler ${reading}`,
                count('ready') && `por rever ${count('ready')}`,
                count('saved') && `guardadas ${count('saved')}`,
                count('duplicate') && `já registadas ${count('duplicate')}`,
                count('discarded') && `descartadas ${count('discarded')}`,
                count('error') && `erros ${count('error')}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {count('ready') > 0 && <Button label="Rever a primeira" onPress={() => setOpen(items.find((it) => it.status === 'ready')!.id)} />}

            {items.map((it) => (
              <Row key={it.id} it={it} onOpen={() => setOpen(it.id)} />
            ))}
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

function Row({ it, onOpen }: { it: Item; onOpen: () => void }) {
  const d = it.draft;
  const uncategorised = d ? d.lines.filter((l) => !l.category_id && l.total_cents > 0).length : 0;
  const sum = d ? d.lines.reduce((s, l) => s + l.total_cents, 0) : 0;
  const mismatch = !!d && d.lines.length > 0 && sum !== d.totalCents;
  const m = it.matches ?? [];
  const action = m.length === 0 ? 'Movimento novo' : m.length === 1 ? `Juntar a: ${m[0].description ?? m[0].source} (${formatDate(m[0].date)})` : `${m.length} movimentos possíveis — escolher`;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={it.status !== 'ready' && it.status !== 'saved'}
      onPress={it.status === 'saved' ? () => router.push({ pathname: '/movimento/[id]', params: { id: it.savedId! } }) : onOpen}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={styles.rowTop}>
        <Text style={styles.rowName} numberOfLines={1}>
          {d ? `${formatDate(d.date)} · ${d.merchantName || '—'}${d.storeName ? ` · ${d.storeName}` : ''}` : it.name}
        </Text>
        {it.status === 'reading' ? <ActivityIndicator size="small" /> : <Text style={[styles.badge, badgeStyle[it.status]]}>{STATUS_TEXT[it.status]}</Text>}
      </View>
      {d && (
        <Text style={styles.rowSub}>
          {formatEUR(d.totalCents)} · {d.lines.length} linhas
          {uncategorised ? ` · ${uncategorised} sem categoria` : ''}
          {it.seconds != null ? ` · ${it.seconds}s` : ''}
        </Text>
      )}
      {mismatch && <Text style={styles.warn}>Soma das linhas ({formatEUR(sum)}) diferente do total</Text>}
      {it.status === 'ready' && <Text style={styles.rowSub}>{action}</Text>}
      {it.status === 'error' && <Text style={styles.error}>{it.error}</Text>}
      {it.status === 'duplicate' && d && <Text style={styles.rowSub}>Documento {d.docNumber} já existe — ignorada.</Text>}
    </Pressable>
  );
}

const badgeStyle: Record<Status, { color: string }> = {
  queued: { color: colors.muted },
  reading: { color: colors.muted },
  ready: { color: colors.accent },
  duplicate: { color: colors.muted },
  error: { color: colors.danger },
  saved: { color: colors.income },
  discarded: { color: colors.muted },
};

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: space.md },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink },
  summary: { fontSize: 15, fontWeight: '600', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
  warn: { color: colors.warning, fontSize: 13 },
  row: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.sm, gap: 2, borderRadius: radius.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  rowName: { fontSize: 15, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  rowSub: { fontSize: 13, color: colors.muted },
  badge: { fontSize: 13, fontWeight: '600' },
});
