declare const db: {query(command: string, params: unknown[]): void};
declare const dynamicQuery: string;
declare const opaqueInput: unknown;

db.query(dynamicQuery, [opaqueInput]);
export {};
