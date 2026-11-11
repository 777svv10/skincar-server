// Operator-only CLI: node refund-payment.js ORDER_UUID --confirm
// Run inside the service environment. Never paste tokens into arguments.
import pg from 'pg';
import {telegramCall} from './telegram.js';
import {applyRefund} from './payments.js';
import {uuid} from './generations.js';
const [id,confirm]=process.argv.slice(2);if(!uuid(id))throw Error('Usage: node refund-payment.js ORDER_UUID [--confirm]');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{const rows=(await db.query('SELECT * FROM payment_receipts WHERE order_id=$1 AND refunded_at IS NULL',[id])).rows;
 if(!rows.length){console.log('No unrefunded receipts.');}
 for(const r of rows){if(confirm!=='--confirm'){console.log('Refund preview:',{order:id,stars:r.stars,credits:r.credits});continue;}
 await telegramCall(process.env.BOT_TOKEN,'refundStarPayment',{user_id:Number(r.telegram_id),telegram_payment_charge_id:r.charge_id});
 await applyRefund(db,r.telegram_id,{currency:'XTR',total_amount:r.stars,telegram_payment_charge_id:r.charge_id});console.log('Refund completed:',id);}
}finally{await db.end();}
