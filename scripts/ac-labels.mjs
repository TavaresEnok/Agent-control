// Ownership labels on every image, container, network and volume the Agent Control creates.
// The Docker daemon is shared with other projects of the user: these labels are what lets the space count and the retention
// tell what belongs to this installation (and to which project) without guessing by name.
import {basename} from 'node:path';

export const LABEL_INSTALLATION='com.agent-control.installation';
export const LABEL_PROJECT='com.agent-control.project';
export const LABEL_KIND='com.agent-control.kind';

const value=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The installation's name, the same one its services and dedicated builder use: the base name of its data directory.
 * Always a valid label value: invalid characters become '-', leading non-alphanumerics are dropped (`.agent-control` is
 * `agent-control`), it is cut at 128 characters, and an empty result is `installation`. A label never stops a launch. */
export function installationName(dataDirectory){
 return basename(String(dataDirectory)).replace(/[^A-Za-z0-9_-]/g,'-').replace(/^[^A-Za-z0-9]+/,'').slice(0,128)||'installation';
}

/** A project id as a label value, or undefined when it cannot be one; the labels then name only the installation. */
export function projectLabel(project){
 return typeof project==='string'&&value.test(project)?project:undefined;
}

/** Labels as a record, for the Docker API. A project is included only when known; malformed values are refused, never sanitized. */
export function ownerLabels({installation,project,kind}){
 for(const item of [installation,kind,...(project===undefined?[]:[project])])if(typeof item!=='string'||!value.test(item))throw new Error('AC_LABEL_INVALID');
 return {[LABEL_INSTALLATION]:installation,...(project===undefined?{}:{[LABEL_PROJECT]:project}),[LABEL_KIND]:kind};
}

/** The same labels as `--label key=value` arguments, for the Docker CLI (create, run, build, network create, volume create). */
export function ownerLabelArgs(owner){
 return Object.entries(ownerLabels(owner)).flatMap(([key,item])=>['--label',`${key}=${item}`]);
}
