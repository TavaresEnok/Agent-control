import {Ledger} from './ledger.ts';
import {Refusal} from './contracts.ts';
import {configureRecoveryInventory,inspectRecoveryInventory,type RecoveryInventoryConfig} from './recovery-inventory.ts';

/** Attach only a pre-provisioned, matching inventory. This does not create a
 * catalog, alter its policy, or reopen restored admission. */
export async function bootstrapRecoveryInventory(ledger:Ledger,config?:RecoveryInventoryConfig){
 const row=(await ledger.pool.query('SELECT required FROM ac_recovery_inventory_policy WHERE singleton')).rows[0];
 if(!row)throw new Refusal('RECOVERY_INVENTORY_POLICY_MISSING');
 if(config){await inspectRecoveryInventory(config);await configureRecoveryInventory(ledger,config);return;}
 if(row.required)throw new Refusal('RECOVERY_INVENTORY_REQUIRED');
}
