// pt-PT formatting done by hand so iOS (Hermes) and web render identically: "1 168,60 €", "17/11/2026".

const NBSP = ' ';

export function formatEUR(cents: number, opts: { sign?: boolean; decimals?: boolean } = {}) {
  const { sign = false, decimals = true } = opts;
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const intPart = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const body = decimals ? `${intPart},${String(abs % 100).padStart(2, '0')}` : String(Math.round(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const prefix = neg ? '−' : sign ? '+' : '';
  return `${prefix}${body}${NBSP}€`;
}

/** "12,34" | "12.34" | "1 234,5" | "1.234,50" → cents. Returns null when not a positive amount. */
export function parseAmount(input: string): number | null {
  let s = input.trim().replace(/[\s €]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 ? cents : null;
}

export function centsToInput(cents: number) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

// ---- dates (all local calendar dates as 'YYYY-MM-DD' strings) ----

export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toISO(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISO(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayISO = () => toISO(new Date());

export function addDays(iso: string, n: number) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Monday of the week containing `iso`. */
export function startOfWeek(iso: string) {
  const d = fromISO(iso);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  return addDays(iso, -dow);
}

export function monthStart(year: number, month0: number) {
  return toISO(new Date(year, month0, 1));
}

export function monthEnd(year: number, month0: number) {
  return toISO(new Date(year, month0 + 1, 0));
}

/** "17/11/2026" */
export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** "ter 17/11" */
export function formatDayShort(iso: string) {
  const d = fromISO(iso);
  return `${WEEKDAYS_SHORT[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** "dd/mm/aaaa" (also d/m/aa) → ISO, or null. */
export function parseDate(input: string): string | null {
  const m = input.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return toISO(d);
}
