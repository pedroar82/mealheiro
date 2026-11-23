import { useQueryClient } from '@tanstack/react-query';
import { CameraView, scanFromURLAsync, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReceiptReview } from '@/components/receipt-review';
import { Button, Card, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import {
  base64ToBytes,
  buildDraft,
  discardDocument,
  DUPLICATE,
  findDuplicate,
  loadLineRules,
  parseAtQr,
  saveDraft,
  uploadAndExtract,
  type AtQr,
  type Draft,
} from '@/lib/receipt';
import { useSession } from '@/lib/session';

type Stage = 'camera' | 'reading' | 'review' | 'saving';

export default function Digitalizar() {
  const qc = useQueryClient();
  const { para } = useLocalSearchParams<{ para?: string }>(); // attach to this movement (from "Compras sem talão")
  const { session } = useSession();
  const { index } = useCategories();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<Stage>('camera');
  const [qr, setQr] = useState<AtQr | null>(null);
  const [duplicate, setDuplicate] = useState<{ issue_date: string | null } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // explicit insets: the overlay sits on top of the camera in a full-screen modal (status bar / Dynamic Island)
  const insets = useSafeAreaInsets();

  const close = () => (router.canGoBack() ? router.back() : router.replace('/adicionar'));

  if (Platform.OS === 'web') {
    return (
      <View style={styles.center}>
        <Muted>No computador, use Adicionar › Importar talão ou fatura.</Muted>
      </View>
    );
  }

  const onQr = (r: BarcodeScanningResult) => {
    if (qr) return;
    const parsed = parseAtQr(r.data);
    if (!parsed) return; // some other QR (e.g. a promo link) — keep looking
    setQr(parsed);
    findDuplicate({ sellerNif: parsed.sellerNif, docNumber: parsed.docNumber }).then(setDuplicate);
  };

  /** Send the image to the reader and open the review. */
  const read = async (uid: string, base64: string, ext: 'jpg' | 'png', code: AtQr | null) => {
    setStage('reading');
    const up = await uploadAndExtract({ userId: uid, body: base64ToBytes(base64), ext, kind: 'receipt', qrRaw: code?.raw });
    setStoragePath(up.storagePath);
    setDraft(buildDraft(up.documentId, 'receipt', up.extraction, index, await loadLineRules(), code));
    setStage('review');
  };

  const shoot = async () => {
    const uid = session?.user.id;
    if (!uid || !camera.current) return;
    setError(null);
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.5, base64: true, shutterSound: false });
      if (!pic?.base64) throw new Error('A câmara não devolveu a imagem.');
      await read(uid, pic.base64, 'jpg', qr);
    } catch (e) {
      setError(errorText(e));
      setStage('camera');
    }
  };

  /** A receipt photo already in the gallery: same pipeline; the invoice QR is looked for in the image. */
  const fromGallery = async () => {
    const uid = session?.user.id;
    if (!uid) return;
    setError(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.5,
        base64: true,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset?.base64) throw new Error('Não foi possível ler a imagem.');
      let code = qr;
      if (!code) {
        const found = await scanFromURLAsync(asset.uri, ['qr']).catch(() => []);
        code = found.map((r) => parseAtQr(r.data)).find((x) => x != null) ?? null;
        if (code) {
          setQr(code);
          const dup = await findDuplicate({ sellerNif: code.sellerNif, docNumber: code.docNumber });
          if (dup) {
            setDuplicate(dup);
            return;
          }
        }
      }
      await read(uid, asset.base64, asset.mimeType === 'image/png' ? 'png' : 'jpg', code);
    } catch (e) {
      setError(errorText(e));
      setStage('camera');
    }
  };

  const save = async (d: Draft, mergeInto: string | null) => {
    setError(null);
    setStage('saving');
    try {
      const id = await saveDraft(d, storagePath, mergeInto, index);
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['spend'] });
      router.replace({ pathname: '/movimento/[id]', params: { id } });
    } catch (e) {
      setError(errorText(e) === DUPLICATE ? 'Esta fatura já foi registada (mesmo NIF e número de documento).' : errorText(e));
      setStage('review');
    }
  };

  const discard = async () => {
    if (draft) await discardDocument(draft.documentId, storagePath);
    setDraft(null);
    setStoragePath(null);
    setQr(null);
    setDuplicate(null);
    setStage('camera');
  };

  if (draft && (stage === 'review' || stage === 'saving')) {
    return (
      <SafeAreaView edges={['top']} style={styles.page}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text accessibilityRole="header" style={styles.title}>Rever talão</Text>
          <ReceiptReview key={draft.documentId} targetId={para} initial={draft} index={index} busy={stage === 'saving'} error={error} onSave={save} onDiscard={discard} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!permission) return <View style={styles.page} />;
  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.page, styles.center]}>
        <Card>
          <Text style={styles.h2}>Acesso à câmara</Text>
          <Muted>Para digitalizar talões, o Mealheiro precisa da câmara. As fotos são apagadas depois de guardar.</Muted>
          <Button label="Permitir câmara" onPress={requestPermission} />
          <Button label="Escolher foto da galeria" variant="secondary" onPress={fromGallery} />
          {error && <Text style={{ color: colors.danger }}>{error}</Text>}
          <Button label="Fechar" variant="secondary" onPress={close} />
        </Card>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraPage}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing="back"
        autofocus="on"
        active={stage === 'camera'}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={qr ? undefined : onQr}
        onCameraReady={() => setReady(true)}
      />
      <View style={[styles.overlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Fechar" onPress={close} style={styles.roundBtn}>
            <Text style={styles.roundText}>✕</Text>
          </Pressable>
          <View style={[styles.qrPill, qr && styles.qrPillOk]} accessibilityLiveRegion="polite">
            <Text style={styles.qrText}>
              {qr
                ? `QR lido ✓ · ${qr.totalCents != null ? formatEUR(qr.totalCents) : ''}${qr.date ? ` · ${formatDate(qr.date)}` : ''}`
                : 'À procura do código QR…'}
            </Text>
          </View>
        </View>

        {duplicate && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              Esta fatura já foi registada{duplicate.issue_date ? ` (${formatDate(duplicate.issue_date)})` : ''}.
            </Text>
            <Button label="Fechar" variant="secondary" onPress={close} />
          </View>
        )}

        {error && (
          <View style={styles.banner}>
            <Text style={[styles.bannerText, { color: colors.danger }]}>{error}</Text>
          </View>
        )}

        <View style={styles.bottom}>
          {stage === 'reading' ? (
            <View style={styles.reading}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.readingText}>A ler o talão… (pode demorar até um minuto)</Text>
            </View>
          ) : (
            <>
              <Text style={styles.hint}>Enquadre o talão inteiro, com boa luz. O QR é lido automaticamente.</Text>
              <View style={styles.controls}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Escolher foto da galeria"
                  disabled={!!duplicate}
                  onPress={fromGallery}
                  style={({ pressed }) => [styles.side, duplicate && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
                  <Text style={styles.sideIcon}>🖼</Text>
                  <Text style={styles.sideText}>Galeria</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Fotografar talão"
                  disabled={!ready || !!duplicate}
                  onPress={shoot}
                  style={({ pressed }) => [styles.shutter, (!ready || duplicate) && { opacity: 0.4 }, pressed && { transform: [{ scale: 0.94 }] }]}>
                  <View style={styles.shutterInner} />
                </Pressable>
                <View style={styles.side} />
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  title: { fontSize: 28, fontWeight: '700', color: colors.ink, marginTop: space.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink },
  cameraPage: { flex: 1, backgroundColor: '#000' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  roundBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  roundText: { color: '#fff', fontSize: 18 },
  qrPill: { flexShrink: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.55)' },
  qrPillOk: { backgroundColor: 'rgba(17,87,63,0.9)' },
  qrText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  banner: { marginHorizontal: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.card, gap: space.sm },
  bannerText: { fontSize: 15, color: colors.ink, fontWeight: '600' },
  bottom: { alignItems: 'center', gap: space.md, paddingBottom: space.lg, paddingHorizontal: space.md },
  hint: { color: '#fff', fontSize: 14, textAlign: 'center', textShadowColor: '#000', textShadowRadius: 4 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: space.lg },
  side: { width: 76, minHeight: 60, alignItems: 'center', justifyContent: 'center', gap: 2 },
  sideIcon: { fontSize: 26 },
  sideText: { color: '#fff', fontSize: 13, fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  reading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: 'rgba(0,0,0,0.6)' },
  readingText: { color: '#fff', fontSize: 15 },
});
