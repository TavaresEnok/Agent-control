import {join} from 'node:path';
import {personalServiceName} from './personal-watch.ts';

/** Where the timers put each installation's backups. One folder per installation name. */
export const personalBackupRoot='/home/app/backups-agent-control';
/** The default destination keeps this many recent backups. An explicit destination keeps more. */
export const defaultBackupRetention=3;
export const explicitBackupRetention=7;

export function personalDefaultBackupDirectory(installationFile:string,root:string=personalBackupRoot){
 return join(root,personalServiceName(installationFile));
}
