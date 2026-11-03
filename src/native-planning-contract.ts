import {digest} from './contracts.ts';
export const nativePlanningExecutorDigest=(imageId:string)=>digest({contract:'native-planning-v1',imageId});
