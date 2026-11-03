import {digest} from './contracts.ts';
export const nativeExecutionExecutorDigest=(workerImage:string,toolsImage:string)=>digest({contract:'native-execution-v1',workerImage,toolsImage});
