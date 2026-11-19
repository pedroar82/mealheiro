// One-time import of the old spreadsheet history (SPEC §7). Pure logic, no I/O:
// the screen reads the sheet with SheetJS and hands the raw rows (array of arrays) here.

import type { CategoryIndex } from '@/lib/categories';
import type { Account, Category, CategoryKind } from '@/lib/types';

export type ExcelRow = {
  line: number; // 1-based spreadsheet row, for error messages
  date: string; // 'YYYY-MM-DD' (time of day dropped, decision 19/11/2026)
  kind: CategoryKind;
  excelCategory: string; // as in the file, e.g. '🍜 Alimentação'
  description: string | null;
  amount_cents: number;
  fromBank: boolean; // Ativos = 'Banco' → bank account, anything else → Carteira
  rawKey: string; // stable text identifying the row, hashed into external_key
};

export type ParseResult = {
  rows: ExcelRow[];
  balanceFixes: number; // 'Modificar Saldo' rows, skipped
  errors: string[];
};

const REQUIRED = ['Período', 'Ativos', 'Categoria', 'Nota', 'EUR', 'Receita/Despesa'] as const;

const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();

/** Excel 1900 date serial (days since 1899-12-30, fraction = time) → 'YYYY-MM-DD'. */
export function serialToISO(serial: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** '🍜 Alimentação' → 'Alimentação' (drops leading emoji / symbols / spaces). */
export function stripEmoji(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function toDate(v: unknown): string | null {
  if (typeof v === 'number' && v > 1) return serialToISO(v);
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function toCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  // amounts are stored as floats (e.g. 6.800000000000001) → round to cents
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const str = (v: unknown) => (v == null ? '' : String(v)).trim();

export function parseSheet(table: unknown[][]): ParseResult {
  const errors: string[] = [];
  // header found by content, not position
  const headerAt = table.findIndex((r) => Array.isArray(r) && REQUIRED.every((h) => r.some((c) => norm(str(c)) === norm(h))));
  if (headerAt < 0) {
    return { rows: [], balanceFixes: 0, errors: [`Não encontrei o cabeçalho (${REQUIRED.join(', ')}).`] };
  }
  const header = table[headerAt].map((c) => norm(str(c)));
  // 'Ativos' appears twice; the first one is the account
  const col = Object.fromEntries(REQUIRED.map((h) => [h, header.indexOf(norm(h))])) as Record<(typeof REQUIRED)[number], number>;

  const rows: ExcelRow[] = [];
  let balanceFixes = 0;
  for (let i = headerAt + 1; i < table.length; i++) {
    const r = table[i];
    if (!Array.isArray(r) || r.every((c) => str(c) === '')) continue;
    const line = i + 1;
    const type = norm(str(r[col['Receita/Despesa']]));
    const categoria = str(r[col.Categoria]);

    if (type === 'ingreso de saldo' || norm(categoria) === 'modificar saldo') {
      balanceFixes++;
      continue;
    }
    const kind: CategoryKind | null = type === 'despesa' ? 'expense' : type === 'receita' ? 'income' : null;
    const date = toDate(r[col['Período']]);
    const cents = toCents(r[col.EUR]);
    if (!kind) { errors.push(`Linha ${line}: tipo desconhecido "${str(r[col['Receita/Despesa']])}".`); continue; }
    if (!date) { errors.push(`Linha ${line}: data inválida.`); continue; }
    if (cents == null || cents <= 0) { errors.push(`Linha ${line}: valor inválido.`); continue; }

    const ativos = str(r[col.Ativos]);
    const nota = str(r[col.Nota]);
    rows.push({
      line,
      date,
      kind,
      excelCategory: categoria,
      description: nota || null,
      amount_cents: cents,
      fromBank: norm(ativos) === 'banco',
      // raw period keeps the time of day, so rows on the same day stay distinct
      rawKey: [str(r[col['Período']]), type, categoria, nota, cents, ativos].join('|'),
    });
  }
  return { rows, balanceFixes, errors };
}

// ---------------------------------------------------------------------------
// Category mapping: Excel name → path in the app's tree (SPEC §7).
// ---------------------------------------------------------------------------
const ALIASES: Record<CategoryKind, Record<string, string[]>> = {
  expense: {
    'despesas de casa': ['Casa'],
    dom: ['Prendas'],
    eventos: ['Lazer', 'Eventos'],
    outro: ['Outras'],
  },
  income: { outro: ['Outras'] },
};

export const mappingKey = (kind: CategoryKind, excelCategory: string) => `${kind}|${excelCategory}`;

/** Category id for an Excel category, or null when the app has no match ("Por categorizar"). */
export function suggestCategory(idx: CategoryIndex, kind: CategoryKind, excelCategory: string): string | null {
  const name = stripEmoji(excelCategory);
  const path = ALIASES[kind][norm(name)] ?? [name];
  let parent: string | null = null;
  for (const part of path) {
    const found: Category | undefined = (idx.children.get(parent) ?? []).find((c) => c.kind === kind && norm(c.name) === norm(part));
    if (!found) return null;
    parent = found.id;
  }
  return parent;
}

export type MappingRow = {
  key: string;
  kind: CategoryKind;
  excelCategory: string;
  count: number;
  cents: number;
};

/** One entry per (kind, Excel category), biggest first. */
export function summariseCategories(rows: ExcelRow[]): MappingRow[] {
  const map = new Map<string, MappingRow>();
  for (const r of rows) {
    const key = mappingKey(r.kind, r.excelCategory);
    const m = map.get(key) ?? { key, kind: r.kind, excelCategory: r.excelCategory, count: 0, cents: 0 };
    m.count++;
    m.cents += r.amount_cents;
    map.set(key, m);
  }
  return [...map.values()].sort((a, b) => (a.kind === b.kind ? b.cents - a.cents : a.kind === 'expense' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Accounts + external keys
// ---------------------------------------------------------------------------
export function pickAccounts(accounts: Account[]) {
  const bank = accounts.find((a) => a.type === 'bank' && a.name === 'CGD à ordem') ?? accounts.find((a) => a.type === 'bank');
  const cash = accounts.find((a) => a.type === 'cash' && a.name === 'Carteira') ?? accounts.find((a) => a.type === 'cash');
  return { bank, cash };
}

async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Este browser não suporta SHA-256 (crypto.subtle). Abra a app em https ou localhost.');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `excel:<sha256>`; identical rows get an occurrence suffix so none is lost. */
export async function externalKeys(rows: ExcelRow[]): Promise<string[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    rows.map((r) => {
      const n = seen.get(r.rawKey) ?? 0;
      seen.set(r.rawKey, n + 1);
      return sha256Hex(n ? `${r.rawKey}#${n}` : r.rawKey).then((h) => `excel:${h}`);
    }),
  );
}
