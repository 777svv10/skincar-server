export async function telegramCall(token,method,data){
 const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(8000)});
 const json=await response.json();if(!response.ok||!json.ok)throw Error('TELEGRAM_REQUEST_FAILED');return json.result;
}
export async function ensurePaymentWebhook(config=process.env){
 const current=await telegramCall(config.BOT_TOKEN,'getWebhookInfo',{});
 const url=current.url||config.PUBLIC_API_URL&&new URL('/telegram/webhook',config.PUBLIC_API_URL).href||'https://skincar-server-production.up.railway.app/telegram/webhook';
 if(!url.startsWith('https://'))throw Error('HTTPS_WEBHOOK_REQUIRED');
 await telegramCall(config.BOT_TOKEN,'setWebhook',{url,secret_token:config.WEBHOOK_SECRET,allowed_updates:['message','pre_checkout_query'],drop_pending_updates:false});
}
