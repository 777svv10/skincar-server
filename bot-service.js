// SK-106: Telegram bot garage, media delivery, support, notifications and private admin.
// All permissions are resolved against PostgreSQL for the current Telegram from.id.
// No Telegram file_id, callback data or chat history authorizes access to a deleted image.
import {randomUUID} from 'node:crypto';
import {stageCreditAction,confirmCreditAction,cancelCreditAction,issuePromo,redeemPromo,promoSummary} from './bot-admin-ops.js';
import {loadGenerationAnalytics,analyticsText,periodFilter,periodLabel,loadGenerationExport,reportToCsv} from './image-analytics.js';

const PAGE_SIZE=6;
const JOB_PAGE_SIZE=5;
const MAX_MEDIA_BYTES=48*1024*1024;
const UUID_RE=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const isUuid=value=>typeof value==='string'&&UUID_RE.test(value);
const slice=(value,n=70)=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,n);
const num=(value)=>Number(value)||0;
const makeButtons=rows=>({inline_keyboard:rows});
const button=(text,callback_data)=>({text,callback_data});
const webButton=(text,url)=>({text,web_app:{url}});
const langOf=update=>['ru','kk','en'].includes(update?.from?.language_code)?update.from.language_code:'ru';
function tr(lang,ru,kk,en){return lang==='kk'?kk:lang==='en'?en:ru;}
const texts={
 home:l=>tr(l,'SkinCar · главное меню\nОткрой гараж, готовые образы или приложение.','SkinCar · негізгі мәзір\nГаражды, дайын бейнелерді немесе қолданбаны ашыңыз.','SkinCar · Main menu\nOpen your garage, finished looks or the app.'),
 garage:l=>tr(l,'🚗 Мой гараж','🚗 Менің гаражым','🚗 My garage'),
 empty:l=>tr(l,'В гараже пока нет автомобилей. Создай первый проект в SkinCar.','Гаражда әзірге көлік жоқ. SkinCar ішінде алғашқы жобаны жасаңыз.','No cars in the garage yet. Create your first SkinCar project.'),
 missing:l=>tr(l,'Этого автомобиля больше нет в твоём гараже. Ранее отправленные в Telegram фотографии останутся в истории чата.','Бұл көлік гаражыңызда жоқ. Telegram чатына бұрын жіберілген фотолар сақталады.','This car is no longer in your garage. Previously sent Telegram photos remain in chat history.'),
 missingJob:l=>tr(l,'Этот образ удалён или больше недоступен.','Бұл бейне жойылған немесе қолжетімсіз.','This look was deleted or is no longer available.'),
 works:l=>tr(l,'🖼 Готовые образы','🖼 Дайын бейнелер','🖼 Finished looks'),
 noWorks:l=>tr(l,'Для этого автомобиля пока нет готовых образов.','Бұл көлік үшін дайын бейнелер жоқ.','No finished looks for this car yet.'),
 original:l=>tr(l,'📷 Исходное фото','📷 Бастапқы фото','📷 Original photo'),
 preview:l=>tr(l,'👁 Посмотреть','👁 Қарау','👁 Preview'),
 file:l=>tr(l,'📥 Скачать файлом','📥 Файлды жүктеу','📥 Download file'),
 compare:l=>tr(l,'🔀 До / После','🔀 Дейін / Кейін','🔀 Before / After'),
 open:l=>tr(l,'↗️ Открыть SkinCar','↗️ SkinCar ашу','↗️ Open SkinCar'),
 menu:l=>tr(l,'☰ Меню','☰ Мәзір','☰ Menu'),
 back:l=>tr(l,'⬅️ Назад','⬅️ Артқа','⬅️ Back'),
 next:l=>tr(l,'Дальше ➡️','Келесі ➡️','Next ➡️'),
 balance:l=>tr(l,'💳 Мои генерации','💳 Менің генерацияларым','💳 My credits'),
 help:l=>tr(l,'❓ Справка','❓ Көмек','❓ Help'),
 support:l=>tr(l,'✉️ Поддержка','✉️ Қолдау','✉️ Support'),
 notif:l=>tr(l,'🔔 Уведомления','🔔 Хабарламалар','🔔 Notifications'),
 admin:l=>tr(l,'🔒 Админка','🔒 Әкімшілік','🔒 Admin'),
 cant:l=>tr(l,'Действие недоступно. Открой меню заново через /start.','Әрекет қолжетімсіз. /start арқылы мәзірді ашыңыз.','Action unavailable. Open the menu with /start.'),
 busy:l=>tr(l,'Слишком много запросов. Попробуй немного позже.','Өте көп сұрау. Сәл кейінірек қайталаңыз.','Too many requests. Try again shortly.'),
 mediaFail:l=>tr(l,'Не удалось отправить файл. Попробуй ещё раз или скачай его в SkinCar.','Файл жіберілмеді. Кейін қайталаңыз немесе SkinCar ішінен жүктеңіз.','Could not send the file. Try again or download it in SkinCar.'),
};
export function botAdminIds(config={}){
 return new Set(String(config.BOT_ADMIN_IDS||'').split(',').map(v=>v.trim()).filter(v=>/^[1-9]\d{3,19}$/.test(v)));
}
export function botCallback(data){
 if(typeof data!=='string'||data.length>64)return null;
 if(['m','h','q','s','n','a','t','u','z'].includes(data))return {type:data};
 const page=/^g:(\d{1,3})$/.exec(data);if(page)return {type:'garage',page:Math.min(100,Number(page[1]))};
 const vehicle=/^v:([a-f0-9-]{36})$/i.exec(data);if(vehicle&&isUuid(vehicle[1]))return {type:'vehicle',id:vehicle[1]};
 const works=/^r:([a-f0-9-]{36}):(\d{1,3})$/i.exec(data);if(works&&isUuid(works[1]))return {type:'works',id:works[1],page:Math.min(100,Number(works[2]))};
 const last=/^l:([a-f0-9-]{36})$/i.exec(data);if(last&&isUuid(last[1]))return {type:'last',id:last[1]};
 const media=/^([bwy]):([a-f0-9-]{36}):(p|f|c)$/i.exec(data);if(media&&isUuid(media[2]))return {type:'media',kind:media[1],id:media[2],operation:media[3]};
 const toggle=/^n:(on|off)$/.exec(data);if(toggle)return {type:'notify',enabled:toggle[1]==='on'};
 const photos=/^x:([a-f0-9-]{36}):(\d{1,3})$/i.exec(data);if(photos&&isUuid(photos[1]))return {type:'photos',id:photos[1],page:Math.min(100,Number(photos[2]))};
 const ticket=/^t:([a-f0-9-]{36})$/i.exec(data);if(ticket&&isUuid(ticket[1]))return {type:'ticket',id:ticket[1]};
 return null;
}
export function botMediaName(kind,id,mime='image/jpeg'){
 const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
 return `SkinCar_${kind}_${id.slice(0,8)}.${ext}`;
}
export async function telegramMultipart(token,method,{chat_id,field,bytes,mime='image/jpeg',filename,caption='',reply_markup},fetcher=fetch){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw Error('BOT_MEDIA_INVALID_SIZE');
 if(!['photo','document'].includes(field)||!['sendPhoto','sendDocument'].includes(method))throw Error('BOT_MEDIA_INVALID_TYPE');
 const form=new FormData();form.set('chat_id',String(chat_id));form.set(field,new Blob([bytes],{type:mime}),filename);
 if(caption)form.set('caption',slice(caption,900));
 if(reply_markup)form.set('reply_markup',JSON.stringify(reply_markup));
 const r=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('BOT_TELEGRAM_HTTP');
 const json=await r.json();if(!json.ok)throw Error('BOT_TELEGRAM_REJECTED');
 return json.result;
}
export const FAQ=[
 {id:'create',q:['Как создать образ?','Образ жасау жолы?','How to create a look?'],a:['Открой SkinCar → Создать, загрузи фото, выбери изменения и нажми «Создать образ».','SkinCar → Жасау: фото жүктеп, өзгертулерді таңдап, «Образ жасау» түймесін басыңыз.','Open SkinCar → Create, upload a photo, select changes, and create a look.']},
 {id:'quality',q:['Чем отличаются Стандарт и HD?','Стандарт пен HD айырмашылығы?','Standard vs HD?'],a:['Стандарт стоит 1 генерацию, HD — 3. Итоговая детализация зависит от исходного фото.','Стандарт — 1, HD — 3 генерация. Нәтиже бастапқы фотоға тәуелді.','Standard costs 1 credit; HD costs 3. Final detail also depends on the source photo.']},
 {id:'photos',q:['Где мои фотографии?','Фотоларым қайда?','Where are my photos?'],a:['Готовые образы — в гараже SkinCar и через кнопку «Мой гараж» в этом чате.','Дайын бейнелер SkinCar гаражында және осы чаттағы «Менің гаражым» бөлімінде.','Finished looks are in your SkinCar garage and the My Garage menu in this chat.']},
 {id:'deletion',q:['Что будет после удаления автомобиля?','Көлікті жойғаннан кейін не болады?','What happens when I delete a car?'],a:['Бот перестанет выдавать удалённые фото. Фотографии, которые он уже отправил в Telegram, останутся в истории твоего чата.','Бот жойылған фотоны қайта жібермейді. Telegram чатына бұрын жіберілген фотолар сол жерде қалады.','The bot cannot resend deleted photos. Copies already sent in Telegram remain in your chat history.']},
 {id:'credits',q:['Как работают генерации и Stars?','Генерациялар мен Stars қалай жұмыс істейді?','How do credits and Stars work?'],a:['Баланс виден в профиле SkinCar и по команде /balance. Покупки через Stars доступны только в разрешённом режиме.','Балансты SkinCar профилінен немесе /balance арқылы көріңіз. Stars сатып алулары рұқсат етілген режимде қолжетімді.','Check your balance in SkinCar or with /balance. Stars purchases are available only when enabled.']},
];
function faqMenu(lang){const i=lang==='kk'?1:lang==='en'?2:0;return makeButtons([...FAQ.map((f,idx)=>[button(f.q[i],`f:${idx}`)]),[button(texts.back(lang),'m')]]);}
function localizedFaq(lang,index){let i=lang==='kk'?1:lang==='en'?2:0;return FAQ[index]?`${FAQ[index].q[i]}\n\n${FAQ[index].a[i]}`:null;}
function normalizeText(text){return slice(text,1000).toLocaleLowerCase('ru').replace(/ё/g,'е');}
export function searchFaq(q){const words=normalizeText(q).split(/\s+/).filter(w=>w.length>2);if(!words.length)return [];
 return FAQ.map((item,i)=>({i,score:words.reduce((s,w)=>s+([item.q,...item.a].flat().some(t=>normalizeText(t).includes(w))?1:0),0)})).filter(x=>x.score).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.i);
}

/* SK-107: Telegram supports only one native chat menu button. Two persistent
reply-keyboard actions keep both Mini App and bot menu visible in private chats. */
export function botPersistentKeyboard(lang,url){
 return {keyboard:[[ {text:texts.open(lang),web_app:{url}}, {text:texts.menu(lang)} ]],
 resize_keyboard:true,is_persistent:true,one_time_keyboard:false,
 input_field_placeholder:tr(lang,'Открыть приложение или меню','Қолданбаны немесе мәзірді ашу','Open app or menu')};
}
export function botStatusSummary(lang,rows){
 const recent=Array.isArray(rows)?rows.slice(0,8):[];
 if(!recent.length)return tr(lang,'Генераций пока нет.','Әзірге генерациялар жоқ.','No generations yet.');
 const names={queued:tr(lang,'В очереди','Кезекте','Queued'),processing:tr(lang,'Обрабатывается','Өңделуде','Processing'),done:tr(lang,'Готово','Дайын','Ready'),failed:tr(lang,'Ошибка','Қате','Failed')};
 const count={done:0,queued:0,processing:0,failed:0};
 for(const j of recent){if(Object.hasOwn(count,j.status))count[j.status]++;}
 const title=tr(lang,'📋 Статус работ · последние '+recent.length+' запросов','📋 Жұмыстар күйі · соңғы '+recent.length+' сұрау','📋 Job status · last '+recent.length+' requests');
 const summary=tr(lang,'✅ Готово: '+count.done+'   ⏳ В работе: '+(count.queued+count.processing)+'   ❌ Ошибки: '+count.failed,
 '✅ Дайын: '+count.done+'   ⏳ Өңделуде: '+(count.queued+count.processing)+'   ❌ Қателер: '+count.failed,
 '✅ Ready: '+count.done+'   ⏳ In progress: '+(count.queued+count.processing)+'   ❌ Failed: '+count.failed);
 const items=recent.slice(0,5).map((j,i)=>{
  const label=slice([j.vehicle_make,j.vehicle_model,j.vehicle_generation].filter(Boolean).join(' ')||j.vehicle_name||tr(lang,'Автомобиль недоступен','Көлік қолжетімсіз','Vehicle unavailable'),44);
  const mode=j.options?.qualityMode==='hd'?'HD':j.options?.qualityMode==='standard'?tr(lang,'Стандарт','Стандарт','Standard'):'—';
  const stat=names[j.status]||slice(j.status,24)||'—';
  let when='';
  if(j.created_at){
   const d=new Date(j.created_at);
   if(!Number.isNaN(d.getTime())){
    when=' · '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Qostanay',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d)+' '+tr(lang,'КЗ','ҚЗ','KZ');
   }
  }
  return (i+1)+'. '+label+' — '+stat+' · '+mode+when;
 }).join('\n');
 return title+'\n'+summary+'\n\n'+tr(lang,'Последние результаты:','Соңғы нәтижелер:','Recent results:')+'\n'+items;
}

function menuMarkup(lang,url,isAdmin=false,garageEnabled=true){const rows=[
 ...(garageEnabled?[[button(texts.garage(lang),'g:0'),webButton(texts.open(lang),url)]]:[[webButton(texts.open(lang),url)]]),
 [button(texts.balance(lang),'h'),button(texts.notif(lang),'n')],
 [button(texts.help(lang),'q'),button(texts.support(lang),'s')],
 [button('📜 Покупки','u'),button('⏳ Статус работ','z')]
 ];if(isAdmin)rows.push([button(texts.admin(lang),'a')]);return makeButtons(rows);
}

// SK-110.2 / Bot Admin UI: visible only after a fresh allowlist check.
export function adminHomeKeyboard(){return makeButtons([
 [button('📊 Статистика','a:stats_today'),button('💵 Себестоимость','a:cost_today')],
 [button('👥 Пользователи','a:users'),button('🖼 Генерации','a:jobs')],
 [button('🎟 Промокоды','a:promos'),button('💳 Балансы','a:credits')],
 [button('📨 Поддержка','a:support'),button('⚙️ Система','a:system')],
 [button('⬅️ В главное меню','m')]
]);}
const adminSectionKeyboard=(section,buttons)=>makeButtons([...buttons,[button('⬅️ Админка','a')]]);

async function ensureUser(db,from){
 const lang=langOf({from});const name=slice([from.first_name,from.last_name].filter(Boolean).join(' ')||'SkinCar User',80)||'SkinCar User';
 await db.query(`INSERT INTO users (telegram_id,display_name,lang,telegram_username) VALUES($1,$2,$3,$4)
 ON CONFLICT (telegram_id) DO UPDATE SET telegram_username=EXCLUDED.telegram_username,updated_at=now()`,[from.id,name,lang,typeof from.username==='string'?slice(from.username,64):null]);
}
async function checkRate(db,userId,scope,limit,seconds){
 const result=await db.query(`INSERT INTO bot_rate_limits (telegram_id,scope,window_start,hits)
 VALUES($1,$2,now(),1) ON CONFLICT(telegram_id,scope)
 DO UPDATE SET hits=CASE WHEN bot_rate_limits.window_start<now()-($3::integer*interval '1 second') THEN 1 ELSE bot_rate_limits.hits+1 END,
 window_start=CASE WHEN bot_rate_limits.window_start<now()-($3::integer*interval '1 second') THEN now() ELSE bot_rate_limits.window_start END
 RETURNING hits`,[userId,scope,seconds]);
 return Number(result.rows[0].hits)<=limit;
}
export function createBotService({db,config,send,upload}){
 const appUrl=config.APP_URL||'https://skincar01.netlify.app/';
 const admins=botAdminIds(config);
 const garageEnabled=config.BOT_GARAGE_ENABLED!=='false';
 const creditAdminEnabled=config.BOT_CREDIT_ADMIN_ENABLED==='true';
 const promosEnabled=config.BOT_PROMOS_ENABLED==='true';
 const isAdmin=id=>admins.has(String(id));
 const tell=(id,text,reply_markup)=>send('sendMessage',{chat_id:id,text,...(reply_markup?{reply_markup}:{})});
 const reply=(id,lang,text,markup)=>tell(id,text,markup);
 const guarded=async(uid,lang,scope,limit,secs)=>{if(await checkRate(db,uid,scope,limit,secs))return true;await reply(uid,lang,texts.busy(lang));return false;};
 const replyMenu=(uid,lang)=>reply(uid,lang,tr(lang,
 'SkinCar · выбери действие ниже: «Открыть SkinCar» или «Меню».',
 'SkinCar · «SkinCar ашу» немесе «Мәзір» түймесін таңдаңыз.',
 'SkinCar · choose "Open SkinCar" or "Menu" below.'),botPersistentKeyboard(lang,appUrl));
 const showInlineMenu=(uid,lang)=>reply(uid,lang,texts.home(lang),menuMarkup(lang,appUrl,isAdmin(uid),garageEnabled));
 const oneOwnerVehicle=async(uid,vehicleId)=> (await db.query('SELECT id,name,make,model,generation,nickname FROM vehicles WHERE id=$1 AND telegram_id=$2',[vehicleId,uid])).rows[0];
 const vehicleLabel=v=>slice([v.make,v.model,v.generation].filter(Boolean).join(' ')||v.name||'Автомобиль',70);
 async function garage(uid,lang,page=0){
  if(!garageEnabled)return reply(uid,lang,'Гараж через бота временно недоступен. Открой SkinCar.',makeButtons([[webButton(texts.open(lang),appUrl)]]));
  const total=num((await db.query('SELECT count(*) AS n FROM vehicles WHERE telegram_id=$1',[uid])).rows[0]?.n);
  if(!total)return reply(uid,lang,texts.empty(lang),makeButtons([[webButton(texts.open(lang),appUrl)],[button(texts.back(lang),'m')]]));
  const maxPage=Math.max(0,Math.ceil(total/PAGE_SIZE)-1);page=Math.min(page,maxPage);
  const rows=(await db.query(`SELECT v.id,v.name,v.make,v.model,v.generation,v.nickname,
   (SELECT count(*) FROM generations g WHERE g.telegram_id=$1 AND g.options->>'vehicleId'=v.id::text AND g.status='done' AND NOT g.archived AND g.result_image IS NOT NULL) AS looks
   FROM vehicles v WHERE v.telegram_id=$1 ORDER BY v.created_at DESC,v.id DESC LIMIT $2 OFFSET $3`,[uid,PAGE_SIZE,page*PAGE_SIZE])).rows;
  const buttons=rows.map(v=>[button(`🚗 ${vehicleLabel(v)} · ${num(v.looks)}`,`v:${v.id}`)]);
  const nav=[];if(page)nav.push(button('⬅️',`g:${page-1}`));nav.push(button(`${page+1}/${maxPage+1}`,`g:${page}`));if(page<maxPage)nav.push(button('➡️',`g:${page+1}`));buttons.push(nav,[button(texts.back(lang),'m')]);
  return reply(uid,lang,`${texts.garage(lang)} · ${total}`,makeButtons(buttons));
 }
 async function vehicle(uid,lang,id){const v=await oneOwnerVehicle(uid,id);if(!v)return reply(uid,lang,texts.missing(lang),makeButtons([[button(texts.garage(lang),'g:0')]]));
  const counts=(await db.query(`SELECT count(*) AS looks FROM generations WHERE telegram_id=$1 AND NOT archived AND status='done' AND result_image IS NOT NULL AND options->>'vehicleId'=$2`,[uid,id])).rows[0];
  const looks=num(counts?.looks);
  return reply(uid,lang,`🚗 ${vehicleLabel(v)}\n${tr(lang,'Готовых образов','Дайын бейнелер','Finished looks')}: ${looks}`,makeButtons([
   [button(`${texts.works(lang)} (${looks})`,`r:${id}:0`)],
   [button(texts.original(lang),`b:${id}:p`),button(texts.file(lang),`b:${id}:f`)],
   [button('📸 Все фото автомобиля',`x:${id}:0`)],
   ...(looks?[[button(tr(lang,'✨ Последний образ','✨ Соңғы бейне','✨ Latest look'),`l:${id}`)]]:[]),
   [webButton(texts.open(lang),appUrl)],
   [button(texts.back(lang),'g:0')]
  ]));
 }
 async function works(uid,lang,vehicleId,page=0){const v=await oneOwnerVehicle(uid,vehicleId);if(!v)return reply(uid,lang,texts.missing(lang));
  const total=num((await db.query(`SELECT count(*) AS n FROM generations WHERE telegram_id=$1 AND options->>'vehicleId'=$2 AND status='done' AND NOT archived AND result_image IS NOT NULL`,[uid,vehicleId])).rows[0]?.n);
  if(!total)return reply(uid,lang,texts.noWorks(lang),makeButtons([[button(texts.back(lang),`v:${vehicleId}`)]]));
  const maxPage=Math.max(0,Math.ceil(total/JOB_PAGE_SIZE)-1);page=Math.min(page,maxPage);
  const jobs=(await db.query(`SELECT id,created_at,options FROM generations WHERE telegram_id=$1 AND options->>'vehicleId'=$2 AND status='done' AND NOT archived AND result_image IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,[uid,vehicleId,JOB_PAGE_SIZE,page*JOB_PAGE_SIZE])).rows;
  const rows=jobs.flatMap((job,i)=>{
   const name=slice((job.options?.filmSku?'Плёнка · ':'')+(job.options?.wheelSku?'Диски · ':'')+ (job.options?.qualityMode==='hd'?'HD':'Стандарт'),38);
   return [[button(`${i+1+page*JOB_PAGE_SIZE}. ${name}`,`w:${job.id}:p`)],
   [button(texts.file(lang),`w:${job.id}:f`),button(texts.compare(lang),`w:${job.id}:c`)]];
  });
  const nav=[];if(page)nav.push(button('⬅️',`r:${vehicleId}:${page-1}`));nav.push(button(`${page+1}/${maxPage+1}`,`r:${vehicleId}:${page}`));if(page<maxPage)nav.push(button('➡️',`r:${vehicleId}:${page+1}`));rows.push(nav,[button(texts.back(lang),`v:${vehicleId}`)]);
  return reply(uid,lang,`${texts.works(lang)} · ${vehicleLabel(v)}`,makeButtons(rows));
 }
 async function vehiclePhotos(uid,lang,vehicleId,page=0){
  if(!garageEnabled)return reply(uid,lang,texts.cant(lang));
  const v=await oneOwnerVehicle(uid,vehicleId);if(!v)return reply(uid,lang,texts.missing(lang));
  const total=num((await db.query('SELECT count(*) AS n FROM vehicle_photos WHERE vehicle_id=$1 AND telegram_id=$2',[vehicleId,uid])).rows[0]?.n);
  const maxPage=Math.max(0,Math.ceil(total/PAGE_SIZE)-1);page=Math.min(page,maxPage);
  const photos=(await db.query('SELECT id,created_at FROM vehicle_photos WHERE vehicle_id=$1 AND telegram_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',[vehicleId,uid,PAGE_SIZE,page*PAGE_SIZE])).rows;
  const rows=[[button('📷 Основное фото',`b:${vehicleId}:p`),button('📥 Оригинал',`b:${vehicleId}:f`)]];
  for(let i=0;i<photos.length;i++)rows.push([button(`📷 Фото ${i+1+page*PAGE_SIZE}`,`y:${photos[i].id}:p`),button('📥 Файл',`y:${photos[i].id}:f`)]);
  const nav=[];if(page)nav.push(button('⬅️',`x:${vehicleId}:${page-1}`));if(page<maxPage)nav.push(button('➡️',`x:${vehicleId}:${page+1}`));if(nav.length)rows.push(nav);
  rows.push([button(texts.back(lang),`v:${vehicleId}`)]);
  return reply(uid,lang,`${vehicleLabel(v)} · фото ${total+1}`,makeButtons(rows));
 }
 async function latest(uid,lang,vehicleId){const v=await oneOwnerVehicle(uid,vehicleId);if(!v)return reply(uid,lang,texts.missing(lang));
  const item=(await db.query(`SELECT id FROM generations WHERE telegram_id=$1 AND options->>'vehicleId'=$2 AND status='done' AND NOT archived AND result_image IS NOT NULL ORDER BY created_at DESC LIMIT 1`,[uid,vehicleId])).rows[0];
  if(!item)return reply(uid,lang,texts.noWorks(lang));return media(uid,lang,'w',item.id,'p');
 }
 async function media(uid,lang,kind,id,operation){
  if(!garageEnabled)return reply(uid,lang,texts.cant(lang));
  if(!await guarded(uid,lang,'media',12,60))return;
  let row;
  if(kind==='y'){
   row=(await db.query(`SELECT p.id,p.source_image,p.original_image,p.original_mime FROM vehicle_photos p
   JOIN vehicles v ON v.id=p.vehicle_id AND v.telegram_id=$2
   WHERE p.id=$1 AND p.telegram_id=$2`,[id,uid])).rows[0];
   if(!row)return reply(uid,lang,texts.missing(lang));
  }else if(kind==='b'){
   row=(await db.query(`SELECT v.id,v.name,v.source_image,v.original_image,v.original_mime FROM vehicles v WHERE v.id=$1 AND v.telegram_id=$2`,[id,uid])).rows[0];
   if(!row)return reply(uid,lang,texts.missing(lang));
  }else{
   row=(await db.query(`SELECT g.id,g.source_image,g.result_image,g.thumbnail,g.options,g.charged_credits FROM generations g
   JOIN vehicles v ON v.id::text=(g.options->>'vehicleId') AND v.telegram_id=$2
   WHERE g.id=$1 AND g.telegram_id=$2 AND NOT g.archived AND g.status='done' AND g.result_image IS NOT NULL`,[id,uid])).rows[0];
   if(!row)return reply(uid,lang,texts.missingJob(lang));
  }
  if(operation==='c'&&kind==='w'){
   const before=Buffer.from(row.source_image||[]);
   if(before.length)await upload('sendPhoto',{chat_id:uid,field:'photo',bytes:before,mime:'image/jpeg',filename:botMediaName('before',id),caption:tr(lang,'До','Дейін','Before')});
   // Re-check ownership before the second send: an intervening delete should not release a new image.
   const available=(await db.query(`SELECT g.id,g.result_image FROM generations g JOIN vehicles v ON v.id::text=(g.options->>'vehicleId') AND v.telegram_id=$2 WHERE g.id=$1 AND g.telegram_id=$2 AND NOT g.archived AND g.status='done'`,[id,uid])).rows[0];
   if(!available?.result_image)return reply(uid,lang,texts.missingJob(lang));
   return upload('sendPhoto',{chat_id:uid,field:'photo',bytes:Buffer.from(available.result_image),mime:'image/jpeg',filename:botMediaName('after',id),caption:tr(lang,'После','Кейін','After')});
  }
  const source=(kind==='b'||kind==='y')
   ?operation==='f'?(row.original_image||row.source_image):row.source_image
   :operation==='p'?(row.thumbnail||row.result_image):row.result_image;
  const mime=(kind==='b'||kind==='y')&&operation==='f'?(row.original_mime||'image/jpeg'):'image/jpeg';
  const bytes=Buffer.from(source||[]);if(!bytes.length)return reply(uid,lang,texts.mediaFail(lang));
  const field=operation==='f'?'document':'photo';
  const caption=(kind==='b'||kind==='y')?texts.original(lang):`${texts.works(lang)} · ${row.options?.qualityMode==='hd'?'HD':row.options?.qualityMode==='standard'?'Стандарт':'—'}`;
  const file=botMediaName((kind==='b'||kind==='y')?'original':'result',id,mime);
  return upload(field==='photo'?'sendPhoto':'sendDocument',{chat_id:uid,field,bytes,mime,filename:file,caption,
    reply_markup:makeButtons([[button(texts.garage(lang),'g:0')]])});
 }
 async function balance(uid,lang){const v=(await db.query('SELECT balance,credit_debt FROM users WHERE telegram_id=$1',[uid])).rows[0];
  return reply(uid,lang,`${texts.balance(lang)}\n${tr(lang,'Доступно','Қолжетімді','Available')}: ${num(v?.balance)}\n${num(v?.credit_debt)>0?`Задолженность: ${num(v.credit_debt)}\n`:''}${tr(lang,'Стандарт — 1, HD — 3 генерации.','Стандарт — 1, HD — 3 генерация.','Standard — 1, HD — 3 credits.')}`,makeButtons([[webButton(texts.open(lang),appUrl)],[button(texts.back(lang),'m')]]));
 }
 async function purchases(uid,lang){
  const list=(await db.query(`SELECT r.stars,r.credits,r.created_at,r.refunded_at FROM payment_receipts r
   WHERE r.telegram_id=$1 ORDER BY r.created_at DESC LIMIT 8`,[uid])).rows;
  const msg=list.length?list.map(x=>`${x.refunded_at?'↩':'⭐'} ${num(x.stars)} Stars · ${num(x.credits)} ${tr(lang,'генераций','генерация','credits')}${x.refunded_at?' · возврат':''}`).join('\n')
    :tr(lang,'Покупок пока нет.','Әзірге сатып алулар жоқ.','No purchases yet.');
  return reply(uid,lang,msg,makeButtons([[button(texts.back(lang),'m')]]));
 }
 async function jobStatus(uid,lang){
  const rows=(await db.query("SELECT g.id,g.status,g.created_at,g.options,v.name AS vehicle_name,v.make AS vehicle_make,v.model AS vehicle_model,v.generation AS vehicle_generation,v.id AS vehicle_id FROM generations g LEFT JOIN vehicles v ON v.id::text=g.options->>'vehicleId' AND v.telegram_id=g.telegram_id WHERE g.telegram_id=$1 AND NOT g.archived ORDER BY g.created_at DESC LIMIT 8",[uid])).rows;
  const previews=rows.filter(j=>j.status==='done'&&j.vehicle_id&&isUuid(j.id)).slice(0,3)
    .map(j=>[button('👁 '+slice([j.vehicle_make,j.vehicle_model].filter(Boolean).join(' ')||j.vehicle_name||'Образ',32),'w:'+j.id+':p')]);
  return reply(uid,lang,botStatusSummary(lang,rows),makeButtons([...previews,[button(texts.garage(lang),'g:0')],[button(texts.back(lang),'m')]]));
 }
 async function showNotifications(uid,lang){const p=(await db.query('SELECT notify_ready FROM bot_preferences WHERE telegram_id=$1',[uid])).rows[0];const on=!!p?.notify_ready;
  return reply(uid,lang,`${texts.notif(lang)}\n${on?tr(lang,'Включены','Қосулы','Enabled'):tr(lang,'Выключены','Өшірулі','Disabled')}\n${tr(lang,'Сообщения о готовой генерации только по согласию.','Дайын бейне туралы хабарламалар тек келісіммен.','Ready notifications are opt-in only.')}`,makeButtons([[button(on?'🔕 Выключить':'🔔 Включить',`n:${on?'off':'on'}`)],[button(texts.back(lang),'m')]]));
 }
 async function toggleNotifications(uid,lang,enabled){await db.query(`INSERT INTO bot_preferences(telegram_id,notify_ready) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET notify_ready=EXCLUDED.notify_ready,updated_at=now()`,[uid,enabled]);
  return showNotifications(uid,lang);
 }
 async function startSupport(uid,lang){await db.query(`INSERT INTO bot_support_state(telegram_id,awaiting) VALUES($1,true) ON CONFLICT(telegram_id) DO UPDATE SET awaiting=true,updated_at=now()`,[uid]);
  return reply(uid,lang,tr(lang,'Напиши одним сообщением, что произошло, и мы зарегистрируем обращение. Не отправляй пароли, токены или данные карты. Для отмены — /cancel.','Мәселені бір хабарламамен жазыңыз. Құпиясөздер мен карта деректерін жібермеңіз. Болдырмау — /cancel.','Describe the issue in one message. Never send passwords, tokens or card details. /cancel to stop.'));
 }
 async function supportMessage(uid,lang,body){
  if(body.length<5||body.length>1500)return reply(uid,lang,tr(lang,'Сообщение должно быть от 5 до 1500 символов.','Хабарлама 5–1500 таңба болуы керек.','Message must be 5–1500 characters.'));
  const id=randomUUID();const inserted=await db.query(`INSERT INTO bot_tickets(id,telegram_id,subject,status) SELECT $1,$2,$3,'open' WHERE EXISTS (SELECT 1 FROM bot_support_state WHERE telegram_id=$2 AND awaiting=true) RETURNING id`,[id,uid,slice(body,1500)]);
  if(!inserted.rows.length)return;
  await db.query('UPDATE bot_support_state SET awaiting=false,updated_at=now() WHERE telegram_id=$1',[uid]);
  await reply(uid,lang,tr(lang,`Обращение создано: ${id.slice(0,8)}. Ответ придёт сюда в чат.`,`Өтініш тіркелді: ${id.slice(0,8)}. Жауап осы чатқа келеді.`,`Ticket created: ${id.slice(0,8)}. We will reply here.`));
  for(const adminId of admins){try{await tell(adminId,`✉️ Новый тикет ${id}\nПользователь: ${uid}\n${slice(body,1300)}`);}catch{ /* Don't expose contact details or fail the user ticket. */ }}
 }
 async function myTickets(uid,lang){const rows=(await db.query('SELECT id,status,created_at FROM bot_tickets WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 8',[uid])).rows;
  return reply(uid,lang,rows.length?rows.map(x=>`${x.id.slice(0,8)} · ${x.status}`).join('\n'):tr(lang,'Обращений пока нет.','Әзірге өтініштер жоқ.','No tickets yet.'));
 }
 const periodsMenu=(type,range)=>makeButtons([
  [button('24 ч',`a:${type}_today`),button('7 д',`a:${type}_week`),button('30 д',`a:${type}_month`)],
  [button('90 д',`a:${type}_quarter`),button('365 д',`a:${type}_year`),button('Всё время',`a:${type}_all`)],
  [button('📥 Скачать CSV',`a:export_${range}`)],
  [button(type==='cost'?'📊 Статистика':'💵 Себестоимость',`a:${type==='cost'?'stats':'cost'}_${range}`)],
  [button('⬅️ Админка','a')]
 ]);

 async function setAdminInput(uid,action,ticketId=null,payload={}){
  await db.query(`INSERT INTO bot_admin_input_state(telegram_id,action,ticket_id,payload,updated_at)
   VALUES($1,$2,$3,$4,now()) ON CONFLICT(telegram_id)
   DO UPDATE SET action=EXCLUDED.action,ticket_id=EXCLUDED.ticket_id,payload=EXCLUDED.payload,updated_at=now()`,
   [uid,action,ticketId,JSON.stringify(payload)]);
 }
 async function clearAdminInput(uid){await db.query('DELETE FROM bot_admin_input_state WHERE telegram_id=$1',[uid]);}
 async function readAdminInput(uid){
  const r=await db.query(`SELECT action,ticket_id,payload FROM bot_admin_input_state
   WHERE telegram_id=$1 AND updated_at>now()-interval '10 minutes'`,[uid]);
  return r.rows[0]||null;
 }
 async function takeAdminInput(uid,action){
  const r=await db.query(`DELETE FROM bot_admin_input_state WHERE telegram_id=$1 AND action=$2
   AND updated_at>now()-interval '10 minutes' RETURNING action,ticket_id,payload`,[uid,action]);
  return r.rows[0]||null;
 }
 async function adminUsers(uid){
  const a=(await db.query('SELECT count(*) AS n FROM users')).rows[0]||{};
  const g=(await db.query('SELECT count(*) AS n FROM generations')).rows[0]||{};
  return tell(uid,`👥 Пользователи SkinCar\n\nВсего аккаунтов: ${num(a.n)}\nВсего созданных генераций: ${num(g.n)}\n\nЛичные данные пользователей здесь не выводятся.`,adminSectionKeyboard('users',[
   [button('📊 Статистика','a:stats_today')],[button('🖼 Генерации','a:jobs')]
  ]));
 }
 async function adminJobs(uid){return tell(uid,'🖼 Генерации\n\nРаботы, модели, токены и выгрузки.',adminSectionKeyboard('jobs',[
  [button('🕒 Последние 10','a:jobs:last'),button('🧠 Модели','a:jobs:models')],
  [button('📊 Статистика','a:stats_today'),button('📥 Скачать CSV','a:export_month')]
 ]));}
 async function adminCreditsMenu(uid){return tell(uid,'💳 Управление балансами\n\nНачисления и списания требуют подтверждения и записываются в журнал. Доступ — только двум разрешённым администраторам.',adminSectionKeyboard('credits',[
  [button('➕ Начислить','a:input:credit'),button('➖ Списать','a:input:debit')],
  [button('📊 Финансовая статистика','a:cost_today')]
 ]));}
 async function adminPromosMenu(uid){return tell(uid,'🎟 Промокоды SkinCar\n\nВыпуск, сроки, количество активаций и общая статистика.',adminSectionKeyboard('promos',[
  [button('➕ Создать промокод','a:input:promo')],
  [button('📊 Статистика промокодов','a:promos:stats')]
 ]));}
 async function adminSupportMenu(uid){return tell(uid,'📨 Поддержка SkinCar\n\nОткрой обращение кнопкой, ответь пользователю или закрой тикет.',adminSectionKeyboard('support',[
  [button('📥 Обращения','a:tickets')]
 ]));}
 async function adminSystemMenu(uid){return tell(uid,'⚙️ Система SkinCar\n\nСостояние сервера и лимиты. Настройка прав производится через Railway.',adminSectionKeyboard('system',[
  [button('🟢 Статус бота','a:system:status'),button('🛡 Лимиты','a:system:limits')],
  [button('🧠 Модели','a:jobs:models')]
 ]));}
 async function adminStartInput(uid,action){
  if(action==='credit'||action==='debit'){
   if(!creditAdminEnabled)return tell(uid,'Управление балансами отключено в Railway.');
   await setAdminInput(uid,action);
   return tell(uid,`${action==='credit'?'➕ Начисление':'➖ Списание'}\n\nОтправь сообщением: ID пользователя, количество от 1 до 100, причина (не менее 3 символов).\n\nПример: 123456789 5 Тестовое начисление\n\nСледующий шаг — отдельное подтверждение.`,makeButtons([[button('❌ Отмена','a:input:cancel')],[button('⬅️ Балансы','a:credits')]]));
  }
  if(action==='promo'){
   if(!promosEnabled)return tell(uid,'Промокоды отключены в Railway.');
   await setAdminInput(uid,'promo');
   return tell(uid,'🎟 Создание промокода\n\nОтправь три числа через пробел: генераций (1–20), количество активаций (1–100), срок действия в днях (1–30).\n\nПример: 3 10 7\n\nПеред выпуском я покажу подтверждение.',makeButtons([[button('❌ Отмена','a:input:cancel')],[button('⬅️ Промокоды','a:promos')]]));
  }
 }
 async function adminInputMessage(uid,lang,text,state){
  if(state.action==='credit'||state.action==='debit'){
   const claimed=await takeAdminInput(uid,state.action);
   if(!claimed)return tell(uid,'Запрос уже использован или устарел. Открой раздел «Балансы» заново.');
   return adminCredit(uid,lang,text,state.action==='credit'?1:-1);
  }
  if(state.action==='ticket_reply'){
   const consumed=await takeAdminInput(uid,'ticket_reply');
   if(!consumed?.ticket_id||!isUuid(consumed.ticket_id))return tell(uid,'Обращение устарело, открой его снова.');
   if(text.trim().length<2||text.length>1500)return tell(uid,'Ответ должен содержать от 2 до 1500 символов. Открой обращение и попробуй снова.');
   return adminReply(uid,String(consumed.ticket_id)+' '+text);
  }
  if(state.action==='promo_confirm')return tell(uid,'Промокод ещё не выпущен. Нажми кнопку подтверждения или отмены.',makeButtons([[button('✅ Выпустить промокод','a:promo:confirm')],[button('❌ Отмена','a:input:cancel')]]));
  if(state.action==='promo'){
   const m=/^(\d{1,2})\s+(\d{1,3})\s+(\d{1,2})$/.exec(text.trim());
   if(!m||Number(m[1])<1||Number(m[1])>20||Number(m[2])<1||Number(m[2])>100||Number(m[3])<1||Number(m[3])>30)
    return tell(uid,'Неверные параметры. Пример: 3 10 7. Допустимо: 1–20 генераций, 1–100 активаций, 1–30 дней.',makeButtons([[button('❌ Отмена','a:input:cancel')]]));
   await setAdminInput(uid,'promo_confirm',null,{credits:Number(m[1]),maxUses:Number(m[2]),days:Number(m[3])});
   return tell(uid,`🎟 Подтверждение выпуска\n\nГенераций: ${m[1]}\nАктиваций: ${m[2]}\nСрок: ${m[3]} дней\n\nПромокод пока НЕ создан.`,makeButtons([[button('✅ Выпустить промокод','a:promo:confirm')],[button('❌ Отмена','a:input:cancel')]]));
  }
 }
 async function adminPromoConfirm(uid){
  if(!promosEnabled)return tell(uid,'Промокоды выключены в Railway.');
  const state=await takeAdminInput(uid,'promo_confirm');
  if(!state)return tell(uid,'Подтверждение истекло или уже использовано.',makeButtons([[button('⬅️ Промокоды','a:promos')]]));
  const v=state.payload||{};
  if(!Number.isSafeInteger(v.credits)||!Number.isSafeInteger(v.maxUses)||!Number.isSafeInteger(v.days))return tell(uid,'Параметры промокода недействительны.');
  // Reuse centralized limits, token hashing, audit and random-code generation.
  return adminPromo(uid,`${v.credits} ${v.maxUses} ${v.days}`);
 }

 async function adminStats(uid,range='today'){
  const report=await loadGenerationAnalytics(db,range,config);
  const filter=periodFilter(range);
  const users=(await db.query('SELECT count(*) AS n FROM users')).rows[0]||{};
  const revenue=(await db.query(`SELECT coalesce(sum(stars),0) AS stars FROM payment_receipts ${filter.where?filter.where+' AND refunded_at IS NULL':'WHERE refunded_at IS NULL'}`,filter.params)).rows[0]||{};
  const title=`Пользователей всего: ${num(users.n)}\nStars за период (без возвратов): ${num(revenue.stars)}\n\n`;
  return tell(uid,title+analyticsText(report,'stats'),periodsMenu('stats',range));
 }
 async function exportStats(uid,range='month'){
  if(!await checkRate(db,uid,'admin_export',6,3600))return tell(uid,'Лимит выгрузок: 6 файлов за час.');
  const report=await loadGenerationExport(db,range,config);
  if(report.truncated)return tell(uid,'В выбранном периоде больше 10 000 записей. Для полной выгрузки выбери меньший период; частичный CSV не отправляется.');
  const bytes=reportToCsv(report);
  if(bytes.length>48*1024*1024)return tell(uid,'Выгрузка слишком большая. Выбери меньший период.');
  const stamp=new Date().toISOString().slice(0,10);
  await upload('sendDocument',{chat_id:uid,field:'document',bytes,mime:'text/csv; charset=utf-8',filename:`SkinCar_analytics_${range}_${stamp}.csv`,caption:`SkinCar · ${periodLabel(range)} · ${report.rows.length} записей · CSV (Excel). Стоимость — оценка, не инвойс OpenAI.`});
 }
 async function adminModels(uid){
  const data=(await db.query(`SELECT model,count(*) AS total,count(*) FILTER(WHERE status='done') AS done,
   coalesce(sum(CASE WHEN usage->>'total_tokens' ~ '^[0-9]+$' THEN (usage->>'total_tokens')::bigint ELSE 0 END),0) AS tokens
   FROM generations GROUP BY model ORDER BY total DESC LIMIT 10`)).rows;
  return tell(uid,data.length?'Модели (все даты):\n'+data.map(x=>`${slice(x.model,45)}: ${num(x.total)} всего, ${num(x.done)} успешно, ${num(x.tokens)} токенов`).join('\n'):'Моделей в статистике пока нет.',adminSectionKeyboard('jobs',[[button('⬅️ Генерации','a:jobs')]]));
 }
 async function adminLast(uid){
  const data=(await db.query(`SELECT id,model,status,created_at,options->>'qualityMode' AS quality,
   CASE WHEN usage->>'total_tokens' ~ '^[0-9]+$' THEN (usage->>'total_tokens')::bigint ELSE NULL END AS tokens
   FROM generations ORDER BY created_at DESC LIMIT 10`)).rows;
  return tell(uid,data.length?'Последние генерации (без фото):\n'+data.map(x=>`${x.id.slice(0,8)} · ${slice(x.model,24)} · ${x.status} · ${x.quality||'—'} · ${x.tokens??'?'} ток.`).join('\n'):'Генераций пока нет.',adminSectionKeyboard('jobs',[[button('⬅️ Генерации','a:jobs')]]));
 }
 async function adminCost(uid,range='today'){
  const report=await loadGenerationAnalytics(db,range,config);
  return tell(uid,analyticsText(report,'cost'),periodsMenu('cost',range));
 }
 async function adminCredit(uid,lang,arg,deltaSign){
  if(!creditAdminEnabled)return tell(uid,'Управление балансом отключено. Для включения нужен BOT_CREDIT_ADMIN_ENABLED=true в Railway.');
  const m=/^([1-9]\d{3,15})\s+(\d{1,3})\s+([\s\S]{3,160})$/.exec(arg.trim());
  if(!m)return tell(uid,'Синтаксис: /credit <telegram_id> <1–100> <причина> или /debit ...');
  try{
   if(!await checkRate(db,uid,'admin_credit',8,3600))return tell(uid,'Лимит запросов админа: 8 в час.');
   const entry=await stageCreditAction(db,{adminId:uid,targetId:m[1],delta:deltaSign*Number(m[2]),reason:m[3]});
   return tell(uid,`Подтверди изменение: пользователь ${entry.targetId}, ${entry.delta>0?'+':''}${entry.delta} генераций, текущий баланс ${entry.balance}, долг ${entry.debt}. Действует 10 минут.`,makeButtons([[button('✅ Подтвердить',`c:${entry.id}`)],[button('❌ Отмена',`k:${entry.id}`)]]));
  }catch(e){return tell(uid,`Отказано: ${e.code||'INVALID_ACTION'}`);}
 }
 async function adminPromo(uid,arg){
  if(!promosEnabled)return tell(uid,'Промокоды отключены. Для включения нужен BOT_PROMOS_ENABLED=true в Railway.');
  const m=/^(\d{1,2})\s+(\d{1,3})\s+(\d{1,2})$/.exec(arg.trim());
  if(!m)return tell(uid,'Синтаксис: /makepromo <1–20 генераций> <1–100 активаций> <1–30 дней>');
  if(!await checkRate(db,uid,'admin_promo',5,3600))return tell(uid,'Лимит промокодов на час исчерпан.');
  try{const p=await issuePromo(db,{adminId:uid,credits:Number(m[1]),maxUses:Number(m[2]),days:Number(m[3]),botToken:config.BOT_TOKEN});
   return tell(uid,`Промокод: ${p.code}\n${p.credits} генераций; ${p.maxUses} активаций; ${p.days} дней. Код отображается один раз; сохрани его. Пользователь активирует /promo КОД.`);
  }catch(e){return tell(uid,`Невозможно выпустить промокод: ${e.code||'INVALID_PROMO'}`);}
 }
 async function userPromo(uid,lang,code){
  if(!promosEnabled)return reply(uid,lang,'Активация промокодов сейчас недоступна.');
  try{const x=await redeemPromo(db,{userId:uid,code:code.trim(),botToken:config.BOT_TOKEN});
   return reply(uid,lang,`✅ Промокод активирован. ${x.credits} генераций учтено; баланс пополнен на ${x.added}.`);
  }catch(e){return reply(uid,lang,e.code==='PROMO_ALREADY_USED'?'Ты уже активировал этот код.':'Промокод не найден, истёк или недоступен.');}
 }
 async function confirmCredit(uid,id,confirm){
  try{
   if(!confirm){const result=await cancelCreditAction(db,{adminId:uid,id});return tell(uid,result?'Отменено.':'Заявка не найдена.');}
   const out=await confirmCreditAction(db,{adminId:uid,id});
   await tell(uid,`✅ Изменение проведено: ${out.targetId}, ${out.delta>0?'+':''}${out.delta}; баланс изменён на ${out.applied}, погашено долга ${out.debtRepaid}. Аудит сохранён.`);
   try{await tell(out.targetId,`💳 Баланс SkinCar изменён администратором: ${out.delta>0?'+':''}${out.delta}. Проверить: /balance`);}catch{}
  }catch(e){return tell(uid,`Заявка недоступна: ${e.code||'ACTION_ERROR'}`);}
 }
 async function adminTickets(uid){
  const rows=(await db.query(`SELECT id,telegram_id,subject,status FROM bot_tickets
   WHERE status IN ('open','answered') ORDER BY created_at DESC LIMIT 10`)).rows;
  const nav=rows.map((r,i)=>[button(`📩 ${i+1}. ${slice(r.subject,28)} · ${r.status==='answered'?'ответили':'новое'}`,`a:ticket:${r.id}`)]);
  nav.push([button('🔄 Обновить','a:tickets')],[button('⬅️ Поддержка','a:support')]);
  return tell(uid,rows.length?`📨 Обращения · ${rows.length} последних\n\nВыбери заявку, чтобы ответить или закрыть.`:'📨 Сейчас нет открытых обращений.',makeButtons(nav));
 }
 async function adminTicket(uid,id){
  if(!isUuid(id))return tell(uid,'Некорректный идентификатор обращения.');
  const row=(await db.query('SELECT id,telegram_id,subject,status,created_at FROM bot_tickets WHERE id=$1',[id])).rows[0];
  if(!row)return tell(uid,'Обращение не найдено.',makeButtons([[button('⬅️ Обращения','a:tickets')]]));
  const actions=row.status==='closed'?[]:[
   [button('✉️ Ответить','a:ticket:reply:'+id)],
   [button('✅ Закрыть обращение','a:ticket:close:'+id)]
  ];
  return tell(uid,`📨 Обращение ${id.slice(0,8)}\nСтатус: ${row.status}\nПользователь: ${row.telegram_id}\nСоздано: ${new Date(row.created_at).toISOString()}\n\n${slice(row.subject,1000)}`,
   makeButtons([...actions,[button('⬅️ Обращения','a:tickets')]]));
 }
 async function adminClose(uid,arg){
  const id=arg.trim();if(!isUuid(id))return tell(uid,'Используй: /close <UUID тикета>');
  const r=await db.query(`UPDATE bot_tickets SET status='closed' WHERE id=$1 AND status IN ('open','answered') RETURNING telegram_id`,[id]);
  if(!r.rows.length)return tell(uid,'Тикет уже закрыт или не найден.');
  await tell(uid,'✅ Обращение закрыто.',makeButtons([[button('⬅️ К обращениям','a:tickets')],[button('⬅️ Админка','a')]]));
  try{await tell(r.rows[0].telegram_id,`✅ Обращение ${id.slice(0,8)} закрыто.`);}catch{}
 }
 async function adminReply(uid,body){const m=/^([a-f0-9-]{36})\s+([\s\S]{2,1500})$/i.exec(body.trim());if(!m||!isUuid(m[1]))return tell(uid,'Используй: /reply <UUID тикета> <текст>');
  const t=(await db.query(`SELECT id,telegram_id FROM bot_tickets WHERE id=$1 AND status IN ('open','answered')`,[m[1]])).rows[0];if(!t)return tell(uid,'Тикет не найден или уже закрыт.');
  await tell(t.telegram_id,`✉️ Поддержка SkinCar\nОбращение ${t.id.slice(0,8)}:\n${slice(m[2],1500)}`);
  await db.query(`UPDATE bot_tickets SET status='answered',answer=$2,answered_at=now(),admin_id=$3 WHERE id=$1 AND status IN ('open','answered')`,[t.id,slice(m[2],1500),uid]);
  return tell(uid,'✉️ Ответ отправлен.',makeButtons([[button('⬅️ К обращению',`a:ticket:${t.id}`)],[button('⬅️ К обращениям','a:tickets')]]));
 }
 async function adminMenu(uid){
  await clearAdminInput(uid);
  return tell(uid,'🔒 Администрация SkinCar\n\nВыбери раздел ниже. Статистика, расходы, поддержка, промокоды и балансы теперь управляются кнопками.\n\nОперации с генерациями и выпуском промокодов требуют подтверждения.',adminHomeKeyboard());
 }
 async function callback(uid,lang,data){
  if(data==='m')return showInlineMenu(uid,lang);
  if(data==='h')return balance(uid,lang);
  if(data==='u')return purchases(uid,lang);
  if(data==='z')return jobStatus(uid,lang);
  if(data==='q')return reply(uid,lang,texts.help(lang),faqMenu(lang));
  if(data==='s')return startSupport(uid,lang);
  if(data==='n')return showNotifications(uid,lang);
  if(data==='a'&&isAdmin(uid))return adminMenu(uid);
  if(data?.startsWith('a:')&&!isAdmin(uid))return reply(uid,lang,texts.cant(lang));
  if(data?.startsWith('a:')&&!data.startsWith('a:input:')&&data!=='a:promo:confirm')await clearAdminInput(uid);
  if(/^f:[0-4]$/.test(data)){const answer=localizedFaq(lang,Number(data[2]));return reply(uid,lang,answer,makeButtons([[button(texts.back(lang),'q')]]));}
  if(data==='a:tickets'&&isAdmin(uid))return adminTickets(uid);
  if(data==='a:users')return adminUsers(uid);
  if(data==='a:jobs')return adminJobs(uid);
  if(data==='a:credits')return adminCreditsMenu(uid);
  if(data==='a:promos')return adminPromosMenu(uid);
  if(data==='a:support')return adminSupportMenu(uid);
  if(data==='a:system')return adminSystemMenu(uid);
  if(data==='a:jobs:last')return adminLast(uid);
  if(data==='a:jobs:models')return adminModels(uid);
  if(data==='a:promos:stats'){
   if(!promosEnabled)return tell(uid,'Промокоды отключены в Railway.');
   const r=await promoSummary(db);
   return tell(uid,`🎟 Промокоды\nВсего: ${num(r.count)}\nАктиваций: ${num(r.activations)}\nВыдано генераций: ${num(r.credits_issued)}`,adminSectionKeyboard('promos',[[button('➕ Создать промокод','a:input:promo')]]));
  }
  if(data==='a:system:status')return tell(uid,`🟢 Сервис SkinCar\nГараж: ${garageEnabled?'включён':'отключён'}\nАдминистраторов: ${admins.size}\nStars: ${config.PAYMENTS_MODE||'off'}\nНачисления: ${creditAdminEnabled?'включены':'выключены'}\nПромокоды: ${promosEnabled?'включены':'выключены'}`,adminSectionKeyboard('system',[]));
  if(data==='a:system:limits')return tell(uid,'🛡 Лимиты\n10 генераций / 24 ч (кроме разрешённых тестировщиков); до 1 активной генерации на аккаунт; отдельная защита API от частых запросов. Баланс OpenAI в реальном времени не запрашиваем.',adminSectionKeyboard('system',[]));
  if(/^a:input:(credit|debit|promo)$/.test(data))return adminStartInput(uid,data.split(':')[2]);
  if(data==='a:input:cancel'){await clearAdminInput(uid);return adminMenu(uid);}
  if(data==='a:promo:confirm')return adminPromoConfirm(uid);
  const ticketMatch=/^a:ticket:([a-f0-9-]{36})$/i.exec(data);
  if(ticketMatch&&isUuid(ticketMatch[1]))return adminTicket(uid,ticketMatch[1]);
  const ticketReply=/^a:ticket:reply:([a-f0-9-]{36})$/i.exec(data);
  if(ticketReply&&isUuid(ticketReply[1])){
   const row=(await db.query(`SELECT id FROM bot_tickets WHERE id=$1 AND status IN ('open','answered')`,[ticketReply[1]])).rows[0];
   if(!row)return tell(uid,'Обращение уже закрыто или удалено.');
   await setAdminInput(uid,'ticket_reply',ticketReply[1]);
   return tell(uid,`✉️ Ответ на обращение ${ticketReply[1].slice(0,8)}\n\nОтправь следующим сообщением текст ответа от 2 до 1500 символов. Он будет доставлен пользователю.`,makeButtons([[button('❌ Отмена','a:input:cancel')],[button('⬅️ Обращение',`a:ticket:${ticketReply[1]}`)]]));
  }
  const ticketClose=/^a:ticket:close:([a-f0-9-]{36})$/i.exec(data);
  if(ticketClose&&isUuid(ticketClose[1]))return tell(uid,`Закрыть обращение ${ticketClose[1].slice(0,8)}?`,makeButtons([[button('✅ Да, закрыть',`a:ticket:confirm:${ticketClose[1]}`)],[button('❌ Нет',`a:ticket:${ticketClose[1]}`)]]));
  const ticketConfirm=/^a:ticket:confirm:([a-f0-9-]{36})$/i.exec(data);
  if(ticketConfirm&&isUuid(ticketConfirm[1]))return adminClose(uid,ticketConfirm[1]);

  if(/^c:[a-f0-9-]{36}$/i.test(data)&&isAdmin(uid))return confirmCredit(uid,data.slice(2),true);
  if(/^k:[a-f0-9-]{36}$/i.test(data)&&isAdmin(uid))return confirmCredit(uid,data.slice(2),false);
  if(/^a:(today|week|month)$/.test(data)&&isAdmin(uid))return adminStats(uid,data.split(':')[1]);
  if(/^a:(stats|cost|export)_(today|week|month|quarter|year|all)$/.test(data)&&isAdmin(uid)){
   const [,type,period]=data.match(/^a:(stats|cost|export)_(today|week|month|quarter|year|all)$/);
   return type==='stats'?adminStats(uid,period):type==='cost'?adminCost(uid,period):exportStats(uid,period);
  }
  const c=botCallback(data);if(!c)return reply(uid,lang,texts.cant(lang));
  if(!garageEnabled&&['garage','vehicle','works','last','photos','media'].includes(c.type))return reply(uid,lang,'Гараж через бота временно недоступен. Открой SkinCar.');
  switch(c.type){
   case 'garage':return garage(uid,lang,c.page);
   case 'vehicle':return vehicle(uid,lang,c.id);
   case 'works':return works(uid,lang,c.id,c.page);
   case 'photos':return vehiclePhotos(uid,lang,c.id,c.page);
   case 'last':return latest(uid,lang,c.id);
   case 'media':return media(uid,lang,c.kind,c.id,c.operation);
   case 'notify':return toggleNotifications(uid,lang,c.enabled);
   default:return reply(uid,lang,texts.cant(lang));
  }
 }
 async function message(uid,lang,text){
  const parsed=/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text||'');
  const cmd=parsed?.[1]?.toLowerCase(),arg=parsed?.[2]||'';
  if(cmd==='start')return replyMenu(uid,lang);
  if(cmd==='menu'||normalizeText(text)===normalizeText(texts.menu(lang))||normalizeText(text)==='меню'||normalizeText(text)==='menu'||normalizeText(text)==='мәзір')return showInlineMenu(uid,lang);
  if(cmd==='garage')return garage(uid,lang);
  if(cmd==='balance')return balance(uid,lang);
  if(cmd==='purchases')return purchases(uid,lang);
  if(cmd==='status')return jobStatus(uid,lang);
  if(cmd==='help'||cmd==='faq'){
   const hits=cmd==='faq'&&arg?searchFaq(arg):[];
   if(hits.length)return reply(uid,lang,hits.map(i=>localizedFaq(lang,i)).join('\n\n'),faqMenu(lang));
   return reply(uid,lang,texts.help(lang),faqMenu(lang));
  }
  if(cmd==='support'||cmd==='paysupport')return startSupport(uid,lang);
  if(cmd==='mytickets')return myTickets(uid,lang);
  if(cmd==='notifications')return showNotifications(uid,lang);
  if(cmd==='promo')return userPromo(uid,lang,arg);
  if(cmd==='cancel'){await db.query('UPDATE bot_support_state SET awaiting=false WHERE telegram_id=$1',[uid]);return replyMenu(uid,lang);}
  if(isAdmin(uid)){
   if(cmd==='admin')return adminMenu(uid);
   if(cmd==='stats')return adminStats(uid,'today');
   if(cmd==='stats_week')return adminStats(uid,'week');
   if(cmd==='stats_month')return adminStats(uid,'month');
   if(cmd==='stats_quarter')return adminStats(uid,'quarter');
   if(cmd==='stats_year')return adminStats(uid,'year');
   if(cmd==='stats_all')return adminStats(uid,'all');
   if(cmd==='tickets')return adminTickets(uid);
   if(cmd==='reply')return adminReply(uid,arg);
   if(cmd==='close')return adminClose(uid,arg);
   if(cmd==='botstatus')return tell(uid,`Сервис бота: ${garageEnabled?'гараж доступен':'гараж выключен'}; настроено админов ${admins.size}; уведомления только по согласию; Stars ${config.PAYMENTS_MODE||'off'}.`);
   if(cmd==='credit')return adminCredit(uid,lang,arg,1);
   if(cmd==='debit')return adminCredit(uid,lang,arg,-1);
   if(cmd==='makepromo')return adminPromo(uid,arg);
   if(cmd==='promos'){if(!promosEnabled)return tell(uid,'Промокоды отключены.');const r=await promoSummary(db);return tell(uid,`Промокоды: ${num(r.count)}; активаций ${num(r.activations)}; выдано генераций ${num(r.credits_issued)}`);}
   if(cmd==='models')return adminModels(uid);
   if(cmd==='last')return adminLast(uid);
   if(cmd==='cost')return adminCost(uid);
   if(cmd==='cost_week')return adminCost(uid,'week');
   if(cmd==='cost_month')return adminCost(uid,'month');
   if(cmd==='cost_quarter')return adminCost(uid,'quarter');
   if(cmd==='cost_year')return adminCost(uid,'year');
   if(cmd==='cost_all')return adminCost(uid,'all');
   if(/^export_(today|week|month|quarter|year|all)$/.test(cmd))return exportStats(uid,cmd.slice(7));
   if(cmd==='limits')return tell(uid,'Лимиты задаются сервером: 10 генераций за 24 ч (кроме разрешённых тестеров), до 1 активной задачи на пользователя, защита от очередей. Баланс OpenAI в реальном времени недоступен.');
  }
  if(isAdmin(uid)&&!parsed&&text){const adminState=await readAdminInput(uid);if(adminState)return adminInputMessage(uid,lang,text,adminState);}
  if(!parsed&&text){const state=(await db.query('SELECT awaiting FROM bot_support_state WHERE telegram_id=$1',[uid])).rows[0];if(state?.awaiting)return supportMessage(uid,lang,text);}
  return replyMenu(uid,lang);
 }
 return async function handleBotUpdate(update){
  const cb=update?.callback_query,m=update?.message;
  const from=cb?.from||m?.from;
  const chat=cb?.message?.chat||m?.chat;
  if(!from||!Number.isSafeInteger(from.id)||chat?.type!=='private'||String(chat.id)!==String(from.id))return;
  const uid=from.id,lang=langOf({from});
  await ensureUser(db,from);
  if(!await checkRate(db,uid,'updates',60,60))return reply(uid,lang,texts.busy(lang));
  if(cb){
   try{await send('answerCallbackQuery',{callback_query_id:cb.id,cache_time:0});}catch{}
   try{return await callback(uid,lang,cb.data);}catch(err){console.error('Bot callback:',err.code||err.name);return reply(uid,lang,texts.mediaFail(lang));}
  }
  if(typeof m?.text==='string')return message(uid,lang,m.text.slice(0,2000));
 };
}

// Durable ready-to-send notification rows are never sent unless the user opted in.
export async function queueReadyNotification(db,jobId,userId){
 await db.query(`INSERT INTO bot_notification_outbox(generation_id,telegram_id)
 SELECT g.id,g.telegram_id FROM generations g
 JOIN bot_preferences p ON p.telegram_id=g.telegram_id AND p.notify_ready=true
 JOIN vehicles v ON v.telegram_id=g.telegram_id AND v.id::text=(g.options->>'vehicleId')
 WHERE g.id=$1 AND g.telegram_id=$2 AND g.status='done' AND NOT g.archived
 ON CONFLICT DO NOTHING`,[jobId,userId]);
}
export async function flushReadyNotifications(db,send,config={}){
 // Claim the next batch atomically, so multiple Railway replicas do not send duplicate notices.
 const rows=(await db.query(`WITH next_batch AS (
  SELECT n.generation_id FROM bot_notification_outbox n
  JOIN bot_preferences p ON p.telegram_id=n.telegram_id AND p.notify_ready=true
  JOIN generations g ON g.id=n.generation_id AND g.telegram_id=n.telegram_id AND g.status='done' AND NOT g.archived
  JOIN vehicles v ON v.telegram_id=g.telegram_id AND v.id::text=(g.options->>'vehicleId')
  WHERE n.sent_at IS NULL AND n.attempts<5 AND n.next_try_at<=now()
  ORDER BY n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT 5
 ) UPDATE bot_notification_outbox n SET attempts=n.attempts+1,next_try_at=now()+interval '5 minutes'
 FROM next_batch b WHERE n.generation_id=b.generation_id RETURNING n.generation_id,n.telegram_id`)).rows;
 for(const r of rows){
  // Revalidate the active car and image before sending; notification contains no photo or file_id.
  const valid=(await db.query(`SELECT g.id FROM generations g JOIN bot_preferences p ON p.telegram_id=g.telegram_id AND p.notify_ready=true
   JOIN vehicles v ON v.id::text=(g.options->>'vehicleId') AND v.telegram_id=g.telegram_id
   WHERE g.id=$1 AND g.telegram_id=$2 AND g.status='done' AND NOT g.archived AND g.result_image IS NOT NULL`,[r.generation_id,r.telegram_id])).rows[0];
  if(!valid){await db.query('UPDATE bot_notification_outbox SET sent_at=now() WHERE generation_id=$1',[r.generation_id]);continue;}
  try{
   await send('sendMessage',{chat_id:r.telegram_id,text:'✨ Образ SkinCar готов! Открой «Мой гараж», чтобы посмотреть результат или скачать его файлом.',reply_markup:makeButtons([[button('👁 Посмотреть',`w:${r.generation_id}:p`)],[button('🚗 Мой гараж','g:0')]])});
   await db.query('UPDATE bot_notification_outbox SET sent_at=now() WHERE generation_id=$1',[r.generation_id]);
  }catch(e){/* already claimed; reattempt after the database lease expires */}
 }
 return rows.length;
}
