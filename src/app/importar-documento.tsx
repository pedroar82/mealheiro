import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ReceiptReview } from '@/components/receipt-review';
import { Button, Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { errorText, pickFile } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import { buildDraft, discardDocument, DUPLICATE, loadLineRules, saveDraft, uploadAndExtract, type Draft } from '@/lib/receipt';
import { useSession } from '@/lib/session';

const MAX_SIDE = 2000; // the model downsizes larger images anyway; smaller uploads are faster

/** Photos → JPEG, longest side ≤ 2000 px. PDFs untouched. */
async function prepare(file: File): Promise<{ blob: Blob; ext: string; kind: Draft['kind'] }> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return { blob: file, ext: 'pdf', kind: 'pdf_invoice' };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Formato de imagem não suportado neste browser (use JPG ou PNG).');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao converter a imagem'))), 'image/jpeg', 0.85));
  return { blob, ext: 'jpg', kind: 'receipt' };
}

type Stage = 'pick' | 'uploading' | 'reading' | 'review' | 'saving' | 'done';

export default function ImportarDocumento() {
  const qc = useQueryClient();
  const { session } = useSession();
  const { index } = useCategories();
  const [stage, setStage] = useState<Stage>('pick');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.center}>
        <Muted>No iPhone, use Adicionar › Digitalizar.</Muted>
      </View>
    );
  }

  const choose = async () => {
    const uid = session?.user.id;
    if (!uid) return;
    setError(null);
    const file = await pickFile('image/*,application/pdf');
    if (!file) return;
    try {
      setStage('uploading');
      const { blob, ext, kind } = await prepare(file);
      setStage('reading');
      const up = await uploadAndExtract({ userId: uid, body: blob, ext: ext as 'jpg' | 'pdf', kind });
      setStoragePath(up.storagePath);
      setDraft(buildDraft(up.documentId, kind, up.extraction, index, await loadLineRules()));
      setStage('review');
    } catch (e) {
      setError(errorText(e));
      setStage('pick');
    }
  };

  const save = async (d: Draft) => {
    setError(null);
    setStage('saving');
    try {
      const id = await saveDraft(d, storagePath);
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['spend'] });
      setSavedId(id);
      setDraft(null);
      setStage('done');
    } catch (e) {
      setError(errorText(e) === DUPLICATE ? 'Esta fatura já foi registada (mesmo NIF e número de documento).' : errorText(e));
      setStage('review');
    }
  };

  const discard = async () => {
    if (draft) await discardDocument(draft.documentId, storagePath);
    setDraft(null);
    setStoragePath(null);
    setStage('pick');
  };

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll}>
      <View style={styles.inner}>
        {(stage === 'pick' || stage === 'done') && (
          <Card>
            <Text style={styles.h2}>Talão ou fatura</Text>
            <Muted>
              Foto de um talão (JPG/PNG) ou fatura em PDF. Os dados são lidos automaticamente; o ficheiro é apagado depois de
              guardar.
            </Muted>
            <Button label={stage === 'done' ? 'Importar outro' : 'Escolher ficheiro'} onPress={choose} />
          </Card>
        )}

        {stage === 'done' && savedId && (
          <Card style={styles.ok}>
            <Text style={styles.okText} accessibilityLiveRegion="polite">Guardado.</Text>
            <Button label="Ver movimento" variant="secondary" onPress={() => router.push({ pathname: '/movimento/[id]', params: { id: savedId } })} />
          </Card>
        )}

        {(stage === 'uploading' || stage === 'reading') && (
          <Card style={styles.progress}>
            <ActivityIndicator />
            <Text style={styles.progressText} accessibilityLiveRegion="polite">
              {stage === 'uploading' ? 'A enviar…' : 'A ler o documento… (pode demorar até um minuto)'}
            </Text>
          </Card>
        )}

        {error && stage === 'pick' && <Text style={styles.error}>{error}</Text>}

        {draft && (stage === 'review' || stage === 'saving') && (
          <ReceiptReview key={draft.documentId} initial={draft} index={index} busy={stage === 'saving'} error={error} onSave={save} onDiscard={discard} />
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, backgroundColor: colors.ground },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
  ok: { backgroundColor: '#DDF2E9' },
  okText: { color: '#11573F', fontSize: 15, fontWeight: '600' },
  progress: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  progressText: { fontSize: 15, color: colors.ink, flexShrink: 1 },
});
