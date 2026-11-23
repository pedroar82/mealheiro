// Export of all the user's data: a readable spreadsheet and a complete JSON backup.
import { File as DeviceFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { categoryPath, indexCategories } from '@/lib/categories';
import { fetchAll } from '@/lib/import-io';
import { supabase } from '@/lib/supabase';
import type { Category } from '@/lib/types';

/** Every table that holds the user's data (RLS limits each to their own rows). */
export const TABLES = [
  'accounts',
  'categories',
  'merchants',
  'stores',
  'products',
  'documents',
  'imports',
  'transactions',
  'line_items',
  'bank_lines',
  'rules',
] as const;

type Row = Record<string, unknown>;
export type Backup = { app: 'mealheiro'; version: 1; exported_at: string; tables: Record<string, Row[]> };

export async function loadAll(onProgress?: (table: string) => void): Promise<Backup> {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES) {
    onProgress?.(t);
    tables[t] = await fetchAll<Row>((a, b) => supabase.from(t).select('*').order('id').range(a, b));
  }
  return { app: 'mealheiro', version: 1, exported_at: new Date().toISOString(), tables };
}

const KIND: Record<string, string> = {
  expense: 'Despesa',
  income: 'Receita',
  transfer: 'Transferência',
  refund: 'Reembolso',
  settlement: 'Acerto da casa',
  payback: 'Acerto de contas',
};
const SCOPE: Record<string, string> = { line_item: 'Produto do talão', bank_desc: 'Descrição do banco', note: 'Nota' };
const eur = (c: unknown) => (typeof c === 'number' ? c / 100 : null);
const str = (v: unknown) => (v == null ? '' : String(v));

/** Readable workbook: Movimentos, Produtos, Categorias, Regras. Amounts in euros, dates as YYYY-MM-DD. */
export async function buildWorkbook(b: Backup): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const T = b.tables;
  const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id as string, r]));
  const cats = indexCategories(T.categories as unknown as Category[]);
  const cat = (id: unknown) => (id ? categoryPath(cats, id as string) : '');
  const accounts = byId(T.accounts);
  const merchants = byId(T.merchants);
  const stores = byId(T.stores);
  const txs = byId(T.transactions);
  const shopOf = (r: Row | undefined) => {
    if (!r) return { shop: '', locality: '' };
    const s = stores.get(r.store_id as string);
    const m = merchants.get((s?.merchant_id ?? r.merchant_id) as string);
    return { shop: str(m?.name ?? s?.name), locality: str(s?.locality) };
  };

  const movements = [...T.transactions]
    .sort((x, y) => str(y.date).localeCompare(str(x.date)))
    .map((t) => {
      const { shop, locality } = shopOf(t);
      const amount = eur(t.amount_cents) ?? 0;
      const half = str(t.external_key).startsWith('shared:');
      const share = t.share_pct == null || half ? 100 : Number(t.share_pct);
      return {
        Data: str(t.date),
        Descrição: str(t.description),
        Tipo: KIND[str(t.kind)] ?? str(t.kind),
        Valor: amount,
        // what counts as the user's spending (a split bill: the part computed by the database)
        'A sua parte': t.kind !== 'expense' ? null : t.split_people != null && t.my_cents != null ? eur(t.my_cents) : Math.round(amount * share) / 100,
        'Dividido por': t.split_people != null ? Number(t.split_people) : null,
        Categoria: cat(t.category_id),
        Loja: shop,
        Localidade: locality,
        Conta: str(accounts.get(t.account_id as string)?.name),
        'Para a conta': str(accounts.get(t.to_account_id as string)?.name),
        Recorrente: t.recurring ? 'sim' : '',
        Origem: str(t.source),
      };
    });

  const products = [...T.line_items]
    .map((l) => ({ l, t: txs.get(l.transaction_id as string) }))
    .sort((x, y) => str(y.t?.date).localeCompare(str(x.t?.date)) || Number(x.l.position) - Number(y.l.position))
    .map(({ l, t }) => {
      const { shop, locality } = shopOf(t);
      return {
        Data: str(t?.date),
        Loja: shop,
        Localidade: locality,
        Produto: str(l.name),
        'Texto do talão': str(l.raw_text),
        Quantidade: l.quantity == null ? null : Number(l.quantity),
        Unidade: str(l.unit),
        'Preço unitário': eur(l.unit_price_cents),
        Total: eur(l.total_cents),
        Consumi: t?.split_people != null && l.consumed === false ? 'não' : '',
        Categoria: cat(l.category_id),
      };
    });

  const categories = [...T.categories]
    .map((c) => ({
      Categoria: cat(c.id),
      Tipo: c.kind === 'income' ? 'Receita' : 'Despesa',
      Arquivada: c.archived ? 'sim' : '',
    }))
    .sort((x, y) => x.Tipo.localeCompare(y.Tipo) || x.Categoria.localeCompare(y.Categoria, 'pt'));

  const productNames = byId(T.products);
  const rules = T.rules.map((r) => ({
    Âmbito: SCOPE[str(r.scope)] ?? str(r.scope),
    Texto: str(r.pattern),
    Correspondência: str(r.match),
    Categoria: cat(r.category_id),
    Loja: str(merchants.get(r.merchant_id as string)?.name),
    Produto: str(productNames.get(r.product_id as string)?.name),
    Origem: str(r.origin),
  }));

  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: Row[], widths: number[]) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add('Movimentos', movements, [11, 40, 14, 10, 11, 30, 22, 14, 18, 18, 11, 9]);
  add('Produtos', products, [11, 22, 14, 30, 30, 11, 8, 13, 10, 30]);
  add('Categorias', categories, [40, 10, 10]);
  add('Regras', rules, [18, 30, 14, 30, 20, 20, 8]);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Web: download. iPhone/Android: write to the cache and open the share sheet (save to Files, AirDrop, mail…). */
export async function saveFile(name: string, data: Uint8Array | string, mimeType: string, uti: string) {
  if (Platform.OS === 'web') {
    const blob = new Blob([data as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  const file = new DeviceFile(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(data);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Partilha indisponível neste dispositivo.');
  await Sharing.shareAsync(file.uri, { mimeType, UTI: uti });
}
