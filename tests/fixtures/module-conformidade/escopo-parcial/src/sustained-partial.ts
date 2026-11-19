declare const syntheticRow: {cpf: string};
declare const fixture: {tag: string};
declare const logger: {info(value: unknown): void};
declare const db: {query(command: string, params: unknown[]): void};
declare const fetch: (url: string, init: unknown) => void;
declare const command: string;
declare const endpoint: string;

const payload = syntheticRow.cpf;
{
  const { tag } = fixture, payload = 'SYNTHETIC_TEXT';
  logger.info(payload);
}
db.query(command, [payload]);
fetch(endpoint, payload);
export {};
