export const LABEL_INSTALLATION:'com.agent-control.installation';
export const LABEL_PROJECT:'com.agent-control.project';
export const LABEL_KIND:'com.agent-control.kind';
export type Owner={installation:string;project?:string;kind:string};
export function installationName(dataDirectory:string):string;
export function projectLabel(project:unknown):string|undefined;
export function ownerLabels(owner:Owner):Record<string,string>;
export function ownerLabelArgs(owner:Owner):string[];
