const {BOT_TOKEN,WEBHOOK_SECRET,PUBLIC_API_URL}=process.env;
if(!BOT_TOKEN||!WEBHOOK_SECRET||!PUBLIC_API_URL)throw Error('Missing environment variables');
const url=new URL('/telegram/webhook',PUBLIC_API_URL);
if(url.protocol!=='https:')throw Error('HTTPS required');
const response=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url.href,secret_token:WEBHOOK_SECRET,allowed_updates:['message']})});
const result=await response.json();if(!result.ok)throw Error('Webhook setup failed');console.log('Webhook configured');


