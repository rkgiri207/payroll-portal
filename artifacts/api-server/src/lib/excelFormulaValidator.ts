import * as XLSX from 'xlsx';

export interface FormulaDiscrepancy {
  cell: string;
  formula: string;
  excelValue: number;
  expectedValue: number;
  rowIndex: number;
  source?: 'formula' | 'formula-pattern';
}

type FormulaValue = number | number[];
type Token =
  | { type: 'number'; value: number }
  | { type: 'reference' | 'identifier' | 'operator'; value: string }
  | { type: 'leftParen' | 'rightParen' | 'comma' | 'colon' | 'percent' | 'end' };

const CURRENCY_TOLERANCE = 0.01;

class UnsupportedFormulaError extends Error {}

function translateFormula(formula: string, sourceAddress: string, targetAddress: string): string {
  const source = XLSX.utils.decode_cell(sourceAddress);
  const target = XLSX.utils.decode_cell(targetAddress);
  const rowOffset = target.r - source.r;
  const columnOffset = target.c - source.c;

  return formula.replace(/(?<![A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (_match, absoluteColumn, columnName, absoluteRow, rowNumber) => {
    const column = XLSX.utils.decode_col(columnName.toUpperCase());
    const row = Number(rowNumber) - 1;
    const translatedColumn = absoluteColumn ? column : column + columnOffset;
    const translatedRow = absoluteRow ? row : row + rowOffset;
    if (translatedColumn < 0 || translatedRow < 0) throw new UnsupportedFormulaError('Translated reference is outside the worksheet');
    return `${absoluteColumn}${XLSX.utils.encode_col(translatedColumn)}${absoluteRow}${translatedRow + 1}`;
  });
}

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < formula.length) {
    const remaining = formula.slice(offset);
    const whitespace = remaining.match(/^\s+/);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }

    const number = remaining.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) });
      offset += number[0].length;
      continue;
    }

    const reference = remaining.match(/^\$?[A-Za-z]{1,3}\$?\d+/);
    if (reference) {
      tokens.push({ type: 'reference', value: reference[0].replace(/\$/g, '').toUpperCase() });
      offset += reference[0].length;
      continue;
    }

    const identifier = remaining.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0].toUpperCase() });
      offset += identifier[0].length;
      continue;
    }

    const pair = remaining.slice(0, 2);
    if (['<=', '>=', '<>'].includes(pair)) {
      tokens.push({ type: 'operator', value: pair });
      offset += 2;
      continue;
    }

    const single: Record<string, Token> = {
      '+': { type: 'operator', value: '+' },
      '-': { type: 'operator', value: '-' },
      '*': { type: 'operator', value: '*' },
      '/': { type: 'operator', value: '/' },
      '^': { type: 'operator', value: '^' },
      '=': { type: 'operator', value: '=' },
      '<': { type: 'operator', value: '<' },
      '>': { type: 'operator', value: '>' },
      '(': { type: 'leftParen' },
      ')': { type: 'rightParen' },
      ',': { type: 'comma' },
      ':': { type: 'colon' },
      '%': { type: 'percent' },
    };
    const token = single[remaining[0]];
    if (!token) throw new UnsupportedFormulaError(`Unsupported token ${remaining[0]}`);
    tokens.push(token);
    offset++;
  }
  tokens.push({ type: 'end' });
  return tokens;
}

function scalar(value: FormulaValue): number {
  if (Array.isArray(value)) throw new UnsupportedFormulaError('A range cannot be used here');
  return value;
}

class FormulaParser {
  private position = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly resolveCell: (address: string) => number,
    private readonly resolveRange: (start: string, end: string) => number[],
  ) {}

  parse(): number {
    const result = scalar(this.comparison());
    if (this.peek().type !== 'end') throw new UnsupportedFormulaError('Formula was not fully evaluated');
    if (!Number.isFinite(result)) throw new UnsupportedFormulaError('Formula result is not finite');
    return result;
  }

  private comparison(): FormulaValue {
    let left = this.addition();
    while (this.peek().type === 'operator' && ['=', '<>', '<', '<=', '>', '>='].includes(this.peekValue())) {
      const operator = this.consumeValue();
      const a = scalar(left);
      const b = scalar(this.addition());
      left = Number(operator === '=' ? a === b : operator === '<>' ? a !== b : operator === '<' ? a < b : operator === '<=' ? a <= b : operator === '>' ? a > b : a >= b);
    }
    return left;
  }

  private addition(): FormulaValue {
    let left = this.multiplication();
    while (this.peek().type === 'operator' && ['+', '-'].includes(this.peekValue())) {
      const operator = this.consumeValue();
      const right = scalar(this.multiplication());
      left = operator === '+' ? scalar(left) + right : scalar(left) - right;
    }
    return left;
  }

  private multiplication(): FormulaValue {
    let left = this.power();
    while (this.peek().type === 'operator' && ['*', '/'].includes(this.peekValue())) {
      const operator = this.consumeValue();
      const right = scalar(this.power());
      left = operator === '*' ? scalar(left) * right : scalar(left) / right;
    }
    return left;
  }

  private power(): FormulaValue {
    let left = this.unary();
    if (this.peek().type === 'operator' && this.peekValue() === '^') {
      this.consume();
      left = Math.pow(scalar(left), scalar(this.power()));
    }
    return left;
  }

  private unary(): FormulaValue {
    if (this.peek().type === 'operator' && ['+', '-'].includes(this.peekValue())) {
      const operator = this.consumeValue();
      const value = scalar(this.unary());
      return operator === '-' ? -value : value;
    }
    let value = this.primary();
    while (this.peek().type === 'percent') {
      this.consume();
      value = scalar(value) / 100;
    }
    return value;
  }

  private primary(): FormulaValue {
    const token = this.consume();
    if (token.type === 'number') return token.value;
    if (token.type === 'reference') {
      if (this.peek().type === 'colon') {
        this.consume();
        const end = this.consume();
        if (end.type !== 'reference') throw new UnsupportedFormulaError('Invalid range');
        return this.resolveRange(token.value, end.value);
      }
      return this.resolveCell(token.value);
    }
    if (token.type === 'identifier' && this.peek().type === 'leftParen') return this.functionCall(token.value);
    if (token.type === 'leftParen') {
      const value = this.comparison();
      if (this.consume().type !== 'rightParen') throw new UnsupportedFormulaError('Missing closing parenthesis');
      return value;
    }
    throw new UnsupportedFormulaError('Unsupported formula expression');
  }

  private functionCall(name: string): number {
    this.consume();
    const args: FormulaValue[] = [];
    if (this.peek().type !== 'rightParen') {
      do {
        args.push(this.comparison());
        if (this.peek().type !== 'comma') break;
        this.consume();
      } while (true);
    }
    if (this.consume().type !== 'rightParen') throw new UnsupportedFormulaError('Missing function parenthesis');
    const values = args.flatMap(value => Array.isArray(value) ? value : [value]);
    if (name === 'SUM') return values.reduce((sum, value) => sum + value, 0);
    if (name === 'AVERAGE' && values.length > 0) return values.reduce((sum, value) => sum + value, 0) / values.length;
    if (name === 'MIN' && values.length > 0) return Math.min(...values);
    if (name === 'MAX' && values.length > 0) return Math.max(...values);
    if (name === 'ABS' && values.length === 1) return Math.abs(values[0]);
    if (['ROUND', 'ROUNDUP', 'ROUNDDOWN'].includes(name) && values.length === 2) {
      const factor = Math.pow(10, Math.trunc(values[1]));
      const scaled = values[0] * factor;
      const rounded = name === 'ROUND' ? Math.round(scaled) : name === 'ROUNDUP' ? Math.sign(scaled) * Math.ceil(Math.abs(scaled)) : Math.sign(scaled) * Math.floor(Math.abs(scaled));
      return rounded / factor;
    }
    throw new UnsupportedFormulaError(`Unsupported function ${name}`);
  }

  private peek(): Token { return this.tokens[this.position]; }
  private peekValue(): string {
    const token = this.peek();
    return 'value' in token ? String(token.value) : '';
  }
  private consume(): Token { return this.tokens[this.position++]; }
  private consumeValue(): string {
    const token = this.consume();
    if (!('value' in token)) throw new UnsupportedFormulaError('Expected a formula value');
    return String(token.value);
  }
}

export function findFormulaDiscrepancies(worksheet: XLSX.WorkSheet): FormulaDiscrepancy[] {
  const evaluated = new Map<string, number>();
  const evaluating = new Set<string>();

  const evaluateCell = (address: string): number => {
    const normalized = address.replace(/\$/g, '').toUpperCase();
    const cached = evaluated.get(normalized);
    if (cached !== undefined) return cached;
    if (evaluating.has(normalized)) throw new UnsupportedFormulaError('Circular formula dependency');
    const cell = worksheet[normalized] as XLSX.CellObject | undefined;
    if (!cell) return 0;
    if (typeof cell.f === 'string' && cell.f.trim()) {
      evaluating.add(normalized);
      try {
        const result = new FormulaParser(tokenize(cell.f), evaluateCell, evaluateRange).parse();
        evaluated.set(normalized, result);
        return result;
      } finally {
        evaluating.delete(normalized);
      }
    }
    if (typeof cell.v === 'number') return cell.v;
    if (typeof cell.v === 'boolean') return Number(cell.v);
    if (cell.v === null || cell.v === undefined || cell.v === '') return 0;
    const number = Number(cell.v);
    if (Number.isFinite(number)) return number;
    throw new UnsupportedFormulaError(`Cell ${normalized} is not numeric`);
  };

  const evaluateRange = (start: string, end: string): number[] => {
    const range = XLSX.utils.decode_range(`${start}:${end}`);
    const values: number[] = [];
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let column = range.s.c; column <= range.e.c; column++) {
        values.push(evaluateCell(XLSX.utils.encode_cell({ r: row, c: column })));
      }
    }
    return values;
  };

  const discrepancies: FormulaDiscrepancy[] = [];
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith('!')) continue;
    const cell = worksheet[address] as XLSX.CellObject;
    if (typeof cell.f !== 'string' || !cell.f.trim() || typeof cell.v !== 'number') continue;
    try {
      const expectedValue = evaluateCell(address);
      const difference = Math.abs(expectedValue - cell.v);
      const tolerance = Math.max(CURRENCY_TOLERANCE, Math.abs(expectedValue) * 1e-10);
      if (difference > tolerance) {
        discrepancies.push({
          cell: address,
          formula: cell.f,
          excelValue: cell.v,
          expectedValue,
          rowIndex: XLSX.utils.decode_cell(address).r + 1,
          source: 'formula',
        });
      }
    } catch (error) {
      if (!(error instanceof UnsupportedFormulaError)) throw error;
    }
  }

  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  const formulaCellsByColumn = new Map<number, Array<{ address: string; formula: string }>>();
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith('!')) continue;
    const cell = worksheet[address] as XLSX.CellObject;
    if (typeof cell.f !== 'string' || !cell.f.trim()) continue;
    const column = XLSX.utils.decode_cell(address).c;
    const formulas = formulaCellsByColumn.get(column) ?? [];
    formulas.push({ address, formula: cell.f });
    formulaCellsByColumn.set(column, formulas);
  }

  for (const [column, formulas] of formulaCellsByColumn) {
    const anchorAddress = XLSX.utils.encode_cell({ r: range.s.r + 1, c: column });
    let canonicalFormula: string;
    try {
      canonicalFormula = translateFormula(formulas[0].formula, formulas[0].address, anchorAddress);
      const consistentPattern = formulas.every(candidate =>
        translateFormula(candidate.formula, candidate.address, anchorAddress) === canonicalFormula,
      );
      if (!consistentPattern) continue;
    } catch (error) {
      if (error instanceof UnsupportedFormulaError) continue;
      throw error;
    }

    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[address] as XLSX.CellObject | undefined;
      if (!cell || typeof cell.f === 'string' || typeof cell.v !== 'number') continue;
      try {
        const inferredFormula = translateFormula(formulas[0].formula, formulas[0].address, address);
        const expectedValue = new FormulaParser(tokenize(inferredFormula), evaluateCell, evaluateRange).parse();
        const difference = Math.abs(expectedValue - cell.v);
        const tolerance = Math.max(CURRENCY_TOLERANCE, Math.abs(expectedValue) * 1e-10);
        if (difference > tolerance) {
          discrepancies.push({
            cell: address,
            formula: inferredFormula,
            excelValue: cell.v,
            expectedValue,
            rowIndex: row + 1,
            source: 'formula-pattern',
          });
        }
      } catch (error) {
        if (!(error instanceof UnsupportedFormulaError)) throw error;
      }
    }
  }
  return discrepancies;
}
