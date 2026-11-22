// SK-108 read-only reporting, no fake hard-coded tariff. Execute inside the server environment.
import pg from 'pg';
import {loadGenerationAnalytics,analyticsText} from './image-analytics.js';
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
try{
 for(const period of ['today','week','month']){
  const report=await loadGenerationAnalytics(db,period,process.env);
  console.log(analyticsText(report,'cost')+'\n');
 }
}finally{await db.end();}
