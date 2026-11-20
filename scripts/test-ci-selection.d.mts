export interface Classification{executar:string[];requer?:Record<string,string>;laboratorio:Record<string,string>;excluido:Record<string,string>}
export interface Plan{executed:string[];skipped:{name:string;reason:string}[];laboratory:{name:string;reason:string}[];excluded:{name:string;reason:string}[];errors:string[]}
export const TEST_FILE:RegExp;
export function planSelection(names:string[],classification:Classification,context?:{includeHost?:boolean;happierBuilt?:boolean;env?:Record<string,string|undefined>}):Plan;
export function loadClassification(file:string):Promise<Classification>;
export function listTestFiles(root:string):Promise<string[]>;
export function selectTests(root:string,context?:{includeHost?:boolean;happierBuilt?:boolean;env?:Record<string,string|undefined>}):Promise<Plan>;
export function selectionReport(plan:Plan,results?:{failed?:string[];ran?:number}):string;
