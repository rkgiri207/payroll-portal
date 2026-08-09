// Format number as Indian Rupees: ₹1,23,456.78
export function formatINR(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format date string for display
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Format month number as name
export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function monthName(n: number): string { return MONTHS[n - 1] ?? String(n); }
