export type LatencySummary={samples:number;p50Ms:number;p95Ms:number;maxMs:number};
export function summarize(samples:number[]):LatencySummary;
export function timingHeader(encoded:string|null):{authentication:number;application:number;total:number};
export function report(metrics:Record<string,number[]>,extra?:Record<string,unknown>):{schemaVersion:number;scope:string;homologated:boolean;metrics:Record<string,LatencySummary>;[key:string]:unknown};
