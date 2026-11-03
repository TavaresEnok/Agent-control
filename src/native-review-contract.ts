import {z} from 'zod';
import {digest} from './contracts.ts';
const GitId=z.string().regex(/^[a-f0-9]{40}$/);
export const nativeReviewOutputSchema={type:'object',additionalProperties:false,required:['schemaVersion','kind','artifactId','policyRevision','commit','tree','base','verdict','findings'],properties:{schemaVersion:{const:1},kind:{type:'string',enum:['review','judge']},artifactId:{type:'string'},policyRevision:{type:'integer',minimum:1},commit:{type:'string'},tree:{type:'string'},base:{type:'string'},verdict:{type:'string',enum:['pass','reject']},findings:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['severity','summary'],properties:{severity:{type:'string',enum:['low','medium','high']},summary:{type:'string',minLength:1,maxLength:2000}}}}}};
export const NativeReviewVerdict=z.object({schemaVersion:z.literal(1),kind:z.enum(['review','judge']),artifactId:z.uuid(),policyRevision:z.number().int().positive(),commit:GitId,tree:GitId,base:GitId,
 verdict:z.enum(['pass','reject']),findings:z.array(z.object({severity:z.enum(['low','medium','high']),summary:z.string().min(1).max(2000)}).strict()).max(64)}).strict();
export const nativeReviewVerifierDigest=digest({contract:'native-review-verdict-v1',schema:nativeReviewOutputSchema});
