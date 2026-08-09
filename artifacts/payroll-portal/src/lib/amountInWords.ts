/**
 * Convert a numeric (Indian Rupee) amount to words.
 * Supports Indian number system: ones, thousands, lakhs, crores.
 * Handles whole rupees, paise, and zero.
 *
 * Examples:
 *   26000    → "Rupees Twenty-Six Thousand Only"
 *   32100.50 → "Rupees Thirty-Two Thousand One Hundred and Fifty Paise Only"
 *   0        → "Zero Rupees Only"
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

function twoDigits(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  const ten = TENS[Math.floor(n / 10)];
  const one = ONES[n % 10];
  return one ? `${ten}-${one}` : ten;
}

function threeDigits(n: number): string {
  if (n === 0) return '';
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundred > 0) parts.push(`${ONES[hundred]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Convert a non-negative integer to words using the Indian numbering system. */
function integerToWords(n: number): string {
  if (n === 0) return 'Zero';

  const parts: string[] = [];

  // Crores (10 million)
  if (n >= 10_000_000) {
    parts.push(`${threeDigits(Math.floor(n / 10_000_000))} Crore`);
    n %= 10_000_000;
  }
  // Lakhs (100 thousand)
  if (n >= 100_000) {
    parts.push(`${twoDigits(Math.floor(n / 100_000))} Lakh`);
    n %= 100_000;
  }
  // Thousands
  if (n >= 1_000) {
    parts.push(`${twoDigits(Math.floor(n / 1_000))} Thousand`);
    n %= 1_000;
  }
  // Hundreds + rest
  if (n > 0) {
    parts.push(threeDigits(n));
  }

  return parts.join(' ');
}

/**
 * Convert a rupee amount (as string or number) to Indian words.
 * @param amount — numeric value (e.g. "26000.50" or 26000.5)
 * @returns human-readable string, e.g. "Rupees Twenty-Six Thousand and Fifty Paise Only"
 */
export function amountInWords(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'Zero Rupees Only';

  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(value)) return 'Zero Rupees Only';

  const rounded = Math.round(value * 100); // convert to paise to avoid float issues
  const rupees = Math.floor(rounded / 100);
  const paise = rounded % 100;

  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  const parts: string[] = [];

  if (rupees > 0) {
    parts.push(`Rupees ${integerToWords(rupees)}`);
  }

  if (paise > 0) {
    const connector = rupees > 0 ? ' and ' : 'Rupees ';
    parts.push(`${connector}${twoDigits(paise)} Paise`);
  }

  return `${parts.join('')} Only`;
}

/** Format a numeric string as Indian ₹ amount with comma separators */
export function formatINRAmount(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '₹0.00';
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(value)) return '₹0.00';

  // Indian number format: last 3 digits grouped, then groups of 2
  const [intPart, decPart] = value.toFixed(2).split('.');
  const lastThree = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const formatted = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
    : lastThree;

  return `\u20B9${formatted}.${decPart}`;
}
