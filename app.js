/*
  2026-2 학기 실행 관리. GitHub Pages-compatible static client.
  Local-first storage + authenticated Supabase per-user row synchronization.
  Do not add secret API keys here.
*/
const SEED = window.PLANNER_SEED;
const CONFIG = window.PLANNER_CONFIG || {};
const COURSES = SEED.courses;
const COURSE = Object.fromEntries(COURSES.map(c => [c.id, c]));
const GUEST_KEY = 'semester-execution-v3:guest';
const LOCAL_ACCOUNT = userId => `semester-execution-v3:user:${userId}`;
const OLD_KEY = 'semester-fall-2026-execution-v1';
const TIMEZONE = CONFIG.timezone || 'Asia/Seoul';
const $ = sel => document.querySelector(sel);
const esc = val => String(val ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = date => date ? `${date.slice(5,7)}.${date.slice(8,10)}` : '미정';
const fromISO = val => new Date(`${val}T12:00:00`);
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dateAdd = (date, days) => { const d = fromISO(date); d.setDate(d.getDate()+days); return isoLocal(d); };
const timezoneToday = () => {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const weekdays = ['일','월','화','수','목','금','토'];
const dayName = iso => weekdays[fromISO(iso).getDay()];
const weekStart = date => dateAdd(date,-((fromISO(date).getDay()+6)%7));
const dateDiff = (a,b) => Math.round((fromISO(a)-fromISO(b))/86400000);
const courseName = id => COURSE[id]?.name || '기타';
const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'new-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const alive = r => !r.deleted_at;
const isDone = r => r.status === 'done';
const asMap = arr => Object.fromEntries(arr.map(r=>[r.id,{...r}]));
const originalRecords = () => asMap(SEED.records.map(r => ({...r,modified_at:'2026-10-28T00:00:00.000Z'})));
const state = {
  today: timezoneToday(), view:'focus', week: weekStart(timezoneToday()), month:timezoneToday().slice(0,7), day:timezoneToday(), course:'east',
  records: originalRecords(), pending:{}, remote:null, user:null, supabase:null, authLoading:false,
  syncBusy:false, syncTimer:null, syncStatus:'local', cloudError:'', loadedFrom:'initial',
  filter:'active', expanded:new Set(), toastTimer:null, initializing:false
};

function legacyUpgrade(records){
  try{
    const old = JSON.parse(localStorage.getItem(OLD_KEY)||'null');
    if(!old || typeof old!=='object') return records;
    for(const [id,done] of Object.entries(old.checked||{})){
      const rid = id.startsWith('m') ? `event-${id}` : `task-${id}`;
      if(records[rid] && done) records[rid].status='done';
    }
    (old.custom||[]).forEach(t => {
      if(!t?.text || !COURSE[t.course]) return;
      const id = t.id?.startsWith('user-') ? `task-${t.id}` : `task-legacy-${uuid()}`;
      records[id] = {id,kind:'task',course:t.course,phase:t.phaseTitle||'추가 작업',phase_start:null,phase_end:null,title:t.text,due_date:t.due||null,status:old.checked?.[t.id]?'done':'todo',priority:2,event_type:null,note:'',origin:'import',deleted_at:null,modified_at:stamp()};
    });
    return records;
  }catch(e){return records;}
}
function readSnapshot(key){
  try {const raw=JSON.parse(localStorage.getItem(key)||'null');return raw?.records && typeof raw.records==='object'?raw:null;}catch(e){return null;}
}
function persist(){
  const k=state.user ? LOCAL_ACCOUNT(state.user.id) : GUEST_KEY;
  try {localStorage.setItem(k,JSON.stringify({version:3,records:state.records,pending:state.user?state.pending:{},saved_at:stamp()}));} catch(e) { notify('브라우저 저장 공간이 부족합니다. JSON으로 백업해 주세요.'); }
}
function initLocal(){
  const snap=readSnapshot(GUEST_KEY);
  state.records=snap?.records||legacyUpgrade(originalRecords());
  state.loadedFrom=snap?'guest':'seed';
  persist();
}
function recordValues(){return Object.values(state.records).filter(alive);}
function courseTasks(id){return recordValues().filter(r=>r.kind==='task' && (!id||r.course===id));}
function eventsInRange(start,end){return recordValues().filter(r=>r.due_date>=start && r.due_date<=end && (r.kind==='event'||r.kind==='task')).sort(compareEvent);}
function compareEvent(a,b){return (a.due_date||'9999').localeCompare(b.due_date||'9999') || (a.priority-b.priority) || a.title.localeCompare(b.title,'ko');}
function daysLabel(date){if(!date) return '일정 미정'; const n=dateDiff(date,state.today);return n===0?'오늘':n>0?`D-${n}`:`${-n}일 지남`;}
function labelKind(r){return r.kind==='task'?'작업':r.event_type==='확정'?'공식 일정':r.event_type==='정기'?'정기 미팅':'내부 목표';}
function metaCourse(r){return `<span class="c-dot" style="background:${esc(COURSE[r.course]?.color||'#8a9a8e')}"></span>${esc(courseName(r.course))}`;}
function selectedProject(){return COURSE[state.course]||COURSES[0];}
function toast(text){const t=$('#toast');t.textContent=text;t.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>t.classList.remove('show'),3200);}
function notify(text){toast(text);}
function saveRecord(row){
  const entry={...row,modified_at:stamp()};
  state.records[entry.id]=entry;
  if(state.user){state.pending[entry.id]=entry;state.syncStatus='pending';scheduleSync();}
  persist();render();
}
function toggleRecord(id){const r=state.records[id];if(!r||!alive(r))return;saveRecord({...r,status:r.status==='done'?'todo':'done'});}
function deleteRecord(id){const r=state.records[id];if(!r || !confirm(`「${r.title}」 항목을 삭제할까요?\n동기화된 다른 기기에서도 삭제됩니다.`))return;saveRecord({...r,deleted_at:stamp()});notify('삭제했습니다.');}
function stats(id){const rows=courseTasks(id);const done=rows.filter(isDone).length;return{done,total:rows.length,pct:rows.length?Math.round(done/rows.length*100):0};}
function activePhaseFor(courseId){
  const rows=courseTasks(courseId).filter(r=>!isDone(r));
  const options=rows.filter(r=>r.phase_start && r.phase_end);
  const now=state.today;
  const active=options.filter(r=>r.phase_start<=now && r.phase_end>=now);
  if(active.length)return active[0].phase;
  const upcoming=options.filter(r=>r.phase_start>=now).sort((a,b)=>a.phase_start.localeCompare(b.phase_start));
  if(upcoming.length)return upcoming[0].phase;
  return options.sort((a,b)=>(a.phase_end||'').localeCompare(b.phase_end||''))[0]?.phase||'추가 작업';
}
function prioritizedTasks(max=7){
  const rows=courseTasks().filter(r=>!isDone(r));
  const activePhases=Object.fromEntries(COURSES.map(c=>[c.id,activePhaseFor(c.id)]));
  const score=r=>{
    let v=0;
    if(r.due_date){const d=dateDiff(r.due_date,state.today);v+=d<0?-80:d===0?-60:d<=3?-42:d<=7?-26:10;}
    else if(r.phase===activePhases[r.course])v-=25;
    else if(r.phase_start && r.phase_start>state.today)v+=Math.min(35,dateDiff(r.phase_start,state.today));
    if(r.status==='doing')v-=35;
    if(r.priority===1)v-=7;
    return v;
  };
  // Ensure visible workload covers more than a single subject.
  const ordered=rows.sort((a,b)=>score(a)-score(b) || (a.phase_end||'9999').localeCompare(b.phase_end||'9999'));
  // 첫 화면에서 단일 과목의 작업이 모든 자리를 차지하지 않도록 과목당 1건을 먼저 선택.
  const out=[];const hit={};
  for(const r of ordered){if(hit[r.course])continue;out.push(r);hit[r.course]=1;if(out.length>=max)break;}
  for(const r of ordered){if(out.length>=max)break;if(out.some(x=>x.id===r.id)||hit[r.course]>=2)continue;out.push(r);hit[r.course]=(hit[r.course]||0)+1;}
  return out;
}
function eventRow(r){
  const overdue=!isDone(r)&&r.due_date<state.today;
  return `<div class="event-row ${isDone(r)?'done':''}">
    <div class="event-date">${fmt(r.due_date)}<span>${dayName(r.due_date)}요일</span></div>
    <div class="event-body"><b class="${isDone(r)?'subtle':''}">${esc(r.title)}</b><small>${esc(courseName(r.course))} · ${esc(labelKind(r))}${overdue?' · 지난 일정':''}</small></div>
    <button class="iconbutton" data-action="edit" data-id="${esc(r.id)}" aria-label="일정 편집">⋯</button></div>`;
}
function taskRow(r,more=true){
 const due=r.due_date?`<span class="pill ${!isDone(r)&&r.due_date<state.today?'overdue':''}">${fmt(r.due_date)} ${esc(daysLabel(r.due_date))}</span>`:'';
 return `<div class="list-row ${isDone(r)?'done':''}"><input type="checkbox" class="task-checkbox" data-action="toggle" data-id="${esc(r.id)}" ${isDone(r)?'checked':''} aria-label="${esc(r.title)} 완료 여부">
 <div class="row-body"><span class="row-title">${esc(r.title)}</span><div class="row-meta"><span>${esc(courseName(r.course))}</span>${r.phase?`<span>· ${esc(r.phase)}</span>`:''}${due}${r.status==='doing'&&!isDone(r)?'<span class="pill green">진행 중</span>':''}</div></div>${more?`<button class="iconbutton" data-action="edit" data-id="${esc(r.id)}" aria-label="작업 편집">⋯</button>`:''}</div>`;
}
function renderSidebar(){
  $('#navigation').querySelectorAll('[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===state.view));
  $('#courseLinks').innerHTML=COURSES.map(c=>{const s=stats(c.id);return `<button class="course-link" data-action="course" data-course="${c.id}"><span class="c-dot" style="background:${esc(c.color)}"></span><span class="name">${esc(c.name)}</span><em>${s.done}/${s.total}</em></button>`;}).join('');
  $('#accountText').textContent=state.user?state.user.email:'로컬 저장 모드';
  $('#accountButton').textContent=state.user?'계정 / 백업':'동기화 설정';
  $('#syncState').className=`sync-state ${state.syncStatus==='synced'?'online':state.syncStatus==='error'?'error':'local'}`;
  const names={local:'● 로컬 저장',pending:'● 동기화 대기',syncing:'● 저장 중',synced:'● 동기화됨',error:'● 연결 오류'};
  $('#syncState').textContent=names[state.syncStatus]||names.local;
  const labels={focus:'실행 현황',week:'주간 계획',projects:'과목별 진행',calendar:'월간 일정'};
  $('#breadcrumbs').innerHTML=`${labels[state.view]} <span>/ 2026-2학기</span>`;
}
function render(){renderSidebar();if(state.view==='focus')renderFocus();else if(state.view==='week')renderWeek();else if(state.view==='projects')renderProjects();else renderCalendar();}
function renderFocus(){
 const tasks=prioritizedTasks(7);
 const open=courseTasks().filter(r=>!isDone(r)).length;
 const overdue=recordValues().filter(r=>r.due_date&&r.due_date<state.today&&!isDone(r)).length;
 const imminent=recordValues().filter(r=>r.due_date&&r.due_date>=state.today&&r.due_date<=dateAdd(state.today,7)&&!isDone(r)).length;
 const future=recordValues().filter(r=>r.kind==='event'&&r.due_date>=state.today&&!isDone(r)).sort(compareEvent).slice(0,6);
 $('#content').innerHTML=`<div class="heading"><div><div class="eyebrow">OVERVIEW / 실행 현황</div><h1>${fmt(state.today)} ${dayName(state.today)}요일, 이번 주의 작업</h1><p class="heading-sub">해야 할 일과 가까운 마감을 먼저 확인합니다.</p></div></div>
 <div class="summary"><div class="summary-part"><strong>${open}</strong><small>남은 세부 작업</small></div><div class="summary-part"><strong>${imminent}</strong><small>7일 내 예정</small></div><div class="summary-part"><strong class="${overdue?'overdue-note':''}">${overdue}</strong><small>지난 일정</small></div></div>
 <div class="dashboard-grid"><section class="surface"><div class="surface-heading"><h2>우선 실행 작업</h2><span class="muted" style="font-size:11px">현재 단계 중심 · 최대 7건</span></div>${tasks.length?tasks.map(r=>taskRow(r)).join(''):'<div class="empty">남은 작업이 없습니다.</div>'}<div class="minor-action"><button class="textlink" data-action="goto" data-view="projects">과목별 전체 작업 보기 →</button></div></section>
 <div class="stack"><section class="surface"><div class="surface-heading"><h2>다가오는 주요 일정</h2><button class="textlink" data-action="goto" data-view="calendar">달력 보기</button></div>${future.length?future.map(eventRow).join(''):'<div class="empty">예정된 일정이 없습니다.</div>'}</section>
 <section class="surface"><div class="surface-heading"><h2>과목별 진행률</h2><span class="muted" style="font-size:11px">작업 완료 기준</span></div>${COURSES.map(c=>{const s=stats(c.id);return `<div class="progress-row" role="button" tabindex="0" data-action="course" data-course="${c.id}"><span class="c-dot" style="background:${esc(c.color)}"></span><span class="pname">${esc(c.name)}</span><span class="progress-track"><i style="width:${s.pct}%"></i></span><span class="pnum">${s.pct}%</span></div>`;}).join('')}</section></div></div>`;
}
function navigateWeek(offset){state.week=dateAdd(state.week,7*offset);state.day=state.week;render();}
function renderWeek(){
  const start=state.week,end=dateAdd(start,6);
  const weekEvents=eventsInRange(start,end);
  const recentPhases=COURSES.map(c=>({course:c, phase:activePhaseFor(c.id)}));
  $('#content').innerHTML=`<div class="heading"><div><div class="eyebrow">WEEK / 주간 실행</div><h1>주간 계획</h1><p class="heading-sub">날짜가 정해진 마감과 현재 단계의 작업을 구분합니다.</p></div></div>
  <div class="control-strip"><div class="view-nav"><button class="navarrow" data-action="weekPrev" aria-label="이전 주">‹</button><span class="period-label">${fmt(start)} — ${fmt(end)}</span><button class="navarrow" data-action="weekNext" aria-label="다음 주">›</button></div><button class="button button-light" data-action="weekToday">이번 주</button></div>
  <div class="week-grid">${Array.from({length:7},(_,i)=>{const d=dateAdd(start,i);const items=weekEvents.filter(r=>r.due_date===d);return `<div class="daycol ${d===state.today?'current':''} ${d===state.day?'selected':''}" tabindex="0" role="button" data-action="selectDay" data-date="${d}"><div class="dayhead"><span class="dayname">${dayName(d)}</span><strong>${d.slice(-2)}</strong>${d===state.today?'<span class="today-dot">오늘</span>':''}</div>${items.slice(0,4).map(r=>`<div class="mini-event ${r.kind==='event'&&r.event_type==='확정'?'official':''}"><span class="mini-kind">${esc(courseName(r.course))}</span>${esc(r.title)}</div>`).join('')}${items.length>4?`<div class="mini-count">+ ${items.length-4}건</div>`:''}</div>`;}).join('')}</div>
  <div class="agenda-panel"><section class="surface"><div class="surface-heading"><h2>${fmt(state.day)} 일정</h2><button class="textlink" data-action="newOnDate" data-date="${state.day}">＋ 일정 추가</button></div>${weekEvents.filter(r=>r.due_date===state.day).length?weekEvents.filter(r=>r.due_date===state.day).map(r=>r.kind==='task'?taskRow(r):eventRow(r)).join(''):'<div class="empty">해당 날짜에 등록된 일정이 없습니다.</div>'}</section>
  <section class="surface"><div class="surface-heading"><h2>현재 진행 단계</h2><button class="textlink" data-action="goto" data-view="projects">세부 작업</button></div><div class="stage-list">${recentPhases.map(x=>`<div class="stage-row"><span class="c-dot" style="background:${esc(x.course.color)};margin-top:6px"></span><span class="stage-name">${esc(x.course.name)}</span><span class="stage-phase">${esc(x.phase||'단계 미정')}</span></div>`).join('')}</div></section></div>`;
}
function projectPhases(courseId){
 const tasks=courseTasks(courseId);
 const grouped=new Map();
 for(const t of tasks){const name=t.phase||'추가 작업';if(!grouped.has(name))grouped.set(name,[]);grouped.get(name).push(t);}
 const items=[...grouped.entries()].map(([name,rows])=>({name,rows,start:rows.find(r=>r.phase_start)?.phase_start||null,end:rows.find(r=>r.phase_end)?.phase_end||null}));
 return items.sort((a,b)=>(a.start||'9999').localeCompare(b.start||'9999'));
}
function renderProjects(){
 const c=selectedProject(), s=stats(c.id),phases=projectPhases(c.id);
 const current=activePhaseFor(c.id);
 const courseEvents=recordValues().filter(r=>r.course===c.id&&r.kind==='event').sort(compareEvent);
 $('#content').innerHTML=`<div class="heading"><div><div class="eyebrow">PROJECTS / 과목별 진행</div><h1>과목별 진행 관리</h1><p class="heading-sub">각 단계의 할 일과 연구·실기 진행 기록을 남깁니다.</p></div></div>
 <div class="projects-layout"><div class="project-selector surface">${COURSES.map(x=>{const p=stats(x.id);return `<button class="project-choice ${x.id===c.id?'active':''}" data-action="course" data-course="${x.id}"><span class="c-dot" style="background:${esc(x.color)}"></span><span class="choice-name">${esc(x.name)}</span><small>${p.done}/${p.total}</small></button>`;}).join('')}</div>
 <div><div class="project-title"><div><div class="eyebrow">${esc(c.type)}</div><h1>${esc(c.name)}</h1><p class="goal">${esc(c.goal)}</p></div><span class="project-stats">${s.done} / ${s.total} 완료</span></div>
 <div class="control-strip"><div class="segmented"><button class="${state.filter==='active'?'active':''}" data-action="filter" data-filter="active">미완료만</button><button class="${state.filter==='all'?'active':''}" data-action="filter" data-filter="all">전체</button></div><button class="button button-light" data-action="newForCourse" data-course="${c.id}">＋ 작업 추가</button></div>
 <div>${phases.map((p,i)=>{const completed=p.rows.filter(isDone).length;const visible=p.rows.filter(r=>state.filter==='all'||!isDone(r));const currentPhase=p.name===current;const key=c.id+'|'+p.name;const open=state.expanded.has(key)||(state.expanded.size===0&&currentPhase);
 return `<details class="phase-block" data-phase="${esc(key)}" ${open?'open':''}><summary class="phase-head"><span class="phase-title">${esc(p.name)}</span>${p.start?`<span class="phase-dates">${fmt(p.start)}~${fmt(p.end)}</span>`:''}<span class="phase-counter">${completed}/${p.rows.length}</span><span class="phase-progress"><i style="width:${Math.round(completed/p.rows.length*100)}%"></i></span></summary><div class="phase-tasks">${visible.length?visible.map(r=>taskRow(r)).join(''):'<div class="empty">표시할 작업이 없습니다.</div>'}<div class="minor-action"><button class="textlink" data-action="newForPhase" data-course="${c.id}" data-phase="${esc(p.name)}" data-start="${p.start||''}" data-end="${p.end||''}">＋ 이 단계에 작업 추가</button></div></div></details>`;}).join('')||'<div class="empty">등록된 작업이 없습니다.</div>'}</div>
 <section class="surface project-nonphased"><div class="surface-heading"><h2>평가·미팅·내부 목표</h2><button class="textlink" data-action="newForCourse" data-course="${c.id}" data-kind="event">＋ 일정</button></div>${courseEvents.length?courseEvents.map(eventRow).join(''):'<div class="empty">등록된 일정이 없습니다.</div>'}</section></div></div>`;
}
function calendarDates(){const [y,m]=state.month.split('-').map(Number);const first=new Date(y,m-1,1,12), last=new Date(y,m,0,12);const start=dateAdd(isoLocal(first),-((first.getDay()+6)%7));const end=dateAdd(isoLocal(last),(7-((last.getDay()+6)%7)-1)%7);return {start,end};}
function shiftMonth(step){const [y,m]=state.month.split('-').map(Number);const n=new Date(y,m-1+step,1,12);state.month=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;render();}
function renderCalendar(){
 const {start,end}=calendarDates();const items=eventsInRange(start,end);
 const buckets=Object.groupBy?Object.groupBy(items,x=>x.due_date):items.reduce((o,r)=>{(o[r.due_date]??=[]).push(r);return o;},{});
 const totalDays=dateDiff(end,start)+1;
 $('#content').innerHTML=`<div class="heading"><div><div class="eyebrow">CALENDAR / 월간 일정</div><h1>월간 일정</h1><p class="heading-sub">확정된 날짜와 내부 목표만 달력에 표시합니다. 작업 단계는 과목별 진행에서 관리합니다.</p></div></div>
 <div class="control-strip"><div class="view-nav"><button class="navarrow" data-action="monthPrev" aria-label="이전 달">‹</button><span class="period-label">${state.month.slice(0,4)}년 ${Number(state.month.slice(5))}월</span><button class="navarrow" data-action="monthNext" aria-label="다음 달">›</button></div><button class="button button-light" data-action="monthToday">이번 달</button></div>
 <div class="calendar-grid">${['월','화','수','목','금','토','일'].map(x=>`<div class="month-weekday">${x}</div>`).join('')}${Array.from({length:totalDays},(_,i)=>{const date=dateAdd(start,i),monthOn=date.startsWith(state.month),es=buckets[date]||[];return `<div class="monthcell ${monthOn?'':'outside'} ${date===state.day?'selected':''} ${date===state.today?'today':''}" data-action="selectMonthDay" data-date="${date}" role="button" tabindex="0"><span class="monthnum">${Number(date.slice(-2))}</span>${es.slice(0,3).map(r=>`<div class="monthline ${r.kind==='event'&&r.event_type==='확정'?'off':''} ${isDone(r)?'done':''}" title="${esc(r.title)}">${esc(r.title)}</div>`).join('')}${es.length>3?`<span class="monthmore">+ ${es.length-3}</span>`:''}</div>`;}).join('')}</div>
 <section class="surface calendar-bottom"><div class="surface-heading"><h2>${fmt(state.day)} ${dayName(state.day)}요일</h2><button class="textlink" data-action="newOnDate" data-date="${state.day}">＋ 일정 추가</button></div>${(buckets[state.day]||[]).length?(buckets[state.day]||[]).map(r=>r.kind==='task'?taskRow(r):eventRow(r)).join(''):'<div class="empty">해당 날짜의 일정이 없습니다.</div>'}</section>`;
}
function openDialog(pref={}){
 const row=typeof pref==='string'?state.records[pref]:null;
 const r=row || {id:'',kind:pref.kind||'task',course:pref.course||state.course,phase:pref.phase||'',phase_start:pref.phase_start||null,phase_end:pref.phase_end||null,title:'',due_date:pref.date||null,status:'todo',priority:2,event_type:'확정',note:''};
 $('#dialogTitle').textContent=row?'항목 수정':'새 항목';
 $('#recordId').value=r.id;
 $('#formKind').value=r.kind;
 $('#formCourse').innerHTML=COURSES.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
 $('#formCourse').value=r.course;
 $('#formTitle').value=r.title;
 $('#formDate').value=r.due_date||'';
 $('#formStatus').value=r.status;
 $('#formPriority').value=String(r.priority);
 $('#formPhase').value=r.phase||'';
 $('#formNote').value=r.note||'';
 $('#formEventType').value=r.event_type||'확정';
 $('#deleteButton').hidden=!row;
 $('#formKind').disabled=!!row;
 $('#recordDialog').dataset.phaseStart=r.phase_start||'';
 $('#recordDialog').dataset.phaseEnd=r.phase_end||'';
 toggleFormFields();$('#recordDialog').showModal();
}
function toggleFormFields(){const event=$('#formKind').value==='event';$('#phaseLabel').hidden=event;$('#eventLabel').hidden=!event;}
function formSubmit(e){
 e.preventDefault();
 const id=$('#recordId').value||`user-${uuid()}`;
 const existing=state.records[id]||{};
 const title=$('#formTitle').value.trim();if(!title){notify('제목을 입력해 주세요.');return;}
 const kind=$('#formKind').value;
 const due_date=$('#formDate').value||null;
 const entry={id,kind,course:$('#formCourse').value,phase:kind==='task'?$('#formPhase').value.trim():'',phase_start:kind==='task'?(existing.phase_start||$('#recordDialog').dataset.phaseStart||null):null,phase_end:kind==='task'?(existing.phase_end||$('#recordDialog').dataset.phaseEnd||null):null,title,due_date,status:$('#formStatus').value,priority:Number($('#formPriority').value),event_type:kind==='event'?$('#formEventType').value:null,note:$('#formNote').value.trim(),origin:existing.origin||'user',deleted_at:null};
 $('#recordDialog').close();saveRecord(entry);notify('저장했습니다.');
}
function setView(view){state.view=view;render();window.scrollTo({top:0,behavior:'smooth'});}
function onAction(event){
 const target=event.target.closest('[data-action]');if(!target)return;
 const a=target.dataset.action,id=target.dataset.id;
 if(a==='toggle'){toggleRecord(id);return;}
 if(a==='edit')openDialog(id);
 if(a==='goto')setView(target.dataset.view);
 if(a==='course'){state.course=target.dataset.course;state.expanded.clear();setView('projects');}
 if(a==='filter'){state.filter=target.dataset.filter;render();}
 if(a==='weekPrev')navigateWeek(-1);
 if(a==='weekNext')navigateWeek(1);
 if(a==='weekToday'){state.week=weekStart(state.today);state.day=state.today;render();}
 if(a==='monthPrev')shiftMonth(-1);
 if(a==='monthNext')shiftMonth(1);
 if(a==='monthToday'){state.month=state.today.slice(0,7);state.day=state.today;render();}
 if(a==='selectDay'){state.day=target.dataset.date;render();}
 if(a==='selectMonthDay'){state.day=target.dataset.date;if(!state.day.startsWith(state.month))state.month=state.day.slice(0,7);render();}
 if(a==='newOnDate')openDialog({kind:'event',date:target.dataset.date});
 if(a==='newForCourse')openDialog({kind:target.dataset.kind||'task',course:target.dataset.course});
 if(a==='newForPhase')openDialog({kind:'task',course:target.dataset.course,phase:target.dataset.phase,phase_start:target.dataset.start,phase_end:target.dataset.end});
}
// ---- Cloud: Supabase Auth + per-user RLS storage + realtime ----
const TABLE='planner_records';
const HAS_CLOUD=Boolean(CONFIG.supabaseUrl && CONFIG.supabasePublishableKey && /^https:\/\//.test(CONFIG.supabaseUrl));
const cols = ['id','kind','course','phase','phase_start','phase_end','title','due_date','status','priority','event_type','note','origin','deleted_at','modified_at'];
const dbRow = (r,userId) => Object.fromEntries([['user_id',userId],...cols.map(k=>[k,r[k]??null])]);
const fromDbRow = r => Object.fromEntries(cols.map(k=>[k,r[k]]));
let remoteRefreshTimer=null, retryTimer=null;

async function createSupabase(){
 if(!HAS_CLOUD)return;
 try {
  const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb=createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}});
  state.supabase=sb;
  sb.auth.onAuthStateChange((_event,session)=>{
    if(session?.user){queueMicrotask(()=>activateUser(session.user));}
    else if(_event==='SIGNED_OUT'){stopSubscription();state.user=null;state.pending={};const snap=readSnapshot(GUEST_KEY);state.records=snap?.records||originalRecords();state.syncStatus='local';persist();render();}
  });
  const {data:{session},error}=await sb.auth.getSession();
  if(error)throw error;
  if(session?.user)await activateUser(session.user);
 }catch(e){console.error('Cloud initialization failed:',e);state.syncStatus='error';state.cloudError='동기화 서비스 연결에 실패했습니다.';render();}
}
async function selectAllRemote(){
 const result=[];
 for(let offset=0;offset<100000;offset+=1000){
  const {data,error}=await state.supabase.from(TABLE).select('*').order('id').range(offset,offset+999);
  if(error)throw error;
  result.push(...(data||[]));
  if(!data||data.length<1000)break;
 }
 return result.map(fromDbRow);
}
async function activateUser(user){
 if(!user?.id || state.initializing || state.user?.id===user.id)return;
 state.initializing=true;
 try {
  stopSubscription();
  const guestSnap=readSnapshot(GUEST_KEY);
  state.user=user;
  const cache=readSnapshot(LOCAL_ACCOUNT(user.id));
  if(cache){state.records=cache.records;state.pending=cache.pending||{};}
  else {state.records=originalRecords();state.pending={};}
  state.syncStatus='syncing';render();
  const remote=await selectAllRemote();
  if(!remote.length){
   // First account sign-in: move local tasks/edits into this new cloud account.
   state.records=guestSnap?.records||originalRecords();
   state.pending={...state.records};
   persist();
   await flushSync();
   notify('첫 동기화를 완료했습니다.');
  }else{
   mergeRemote(remote);
   if(Object.keys(state.pending).length)await flushSync();
  }
  subscribeRemote();
  state.syncStatus=Object.keys(state.pending).length?'pending':'synced';
  persist();render();
 }catch(e){console.error(e);state.syncStatus='error';state.cloudError=e?.message||'원격 데이터 읽기에 실패했습니다.';persist();render();notify('동기화 오류: 계정 설정과 SQL 정책을 확인해 주세요.');}
 finally{state.initializing=false;}
}
function mergeRemote(remote){
 const incoming=asMap(remote);
 const pending=state.pending;
 state.records={...incoming,...pending};
 persist();render();
}
function scheduleSync(){
 if(!state.user)return;
 clearTimeout(state.syncTimer);
 state.syncTimer=setTimeout(()=>{flushSync().catch(console.error);},550);
}
async function flushSync(){
 if(!state.user||!state.supabase||state.syncBusy)return;
 if(!navigator.onLine){state.syncStatus='pending';renderSidebar();return;}
 if(!Object.keys(state.pending).length){state.syncStatus='synced';renderSidebar();return;}
 state.syncBusy=true;state.syncStatus='syncing';renderSidebar();
 try{
  while(Object.keys(state.pending).length){
   const chunk=Object.entries(state.pending).slice(0,45);
   const rows=chunk.map(([,r])=>dbRow(r,state.user.id));
   const {error}=await state.supabase.from(TABLE).upsert(rows,{onConflict:'user_id,id'});
   if(error)throw error;
   for(const [id,snap] of chunk){
    if(state.pending[id]?.modified_at===snap.modified_at)delete state.pending[id];
   }
   persist();
  }
  state.syncStatus='synced';state.cloudError='';
 }catch(e){console.error('Unable to synchronize data:',e);state.cloudError=e?.message||'서버 저장 실패';state.syncStatus='error';
  clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(state.user&&navigator.onLine)flushSync();},18000);
 }finally{state.syncBusy=false;persist();renderSidebar();}
}
async function refreshRemote(){
 if(!state.user || !state.supabase || state.initializing)return;
 try {
  const rows=await selectAllRemote();
  mergeRemote(rows);
  state.syncStatus=Object.keys(state.pending).length?'pending':'synced';renderSidebar();
 }catch(e){state.syncStatus='error';state.cloudError=e?.message||'읽기 실패';renderSidebar();}
}
function subscribeRemote(){
 if(!state.user||!state.supabase)return;
 const currentUser=state.user.id;
 const channel=state.supabase.channel('semester-planner-'+currentUser)
  .on('postgres_changes',{event:'*',schema:'public',table:TABLE,filter:`user_id=eq.${currentUser}`},()=>{
   clearTimeout(remoteRefreshTimer);remoteRefreshTimer=setTimeout(refreshRemote,400);
  }).subscribe();
 state.remote=channel;
}
function stopSubscription(){if(state.remote&&state.supabase)state.supabase.removeChannel(state.remote);state.remote=null;}
function accountPanel(){
 const p=$('#accountPanel');
 if(!HAS_CLOUD){p.innerHTML='<div class="account-box"><p><b>현재: 브라우저 로컬 저장</b></p><p class="account-sub">기기 간 동기화는 아직 설정되지 않았습니다. 제공된 <b>설치 안내(README.md)</b>에 따라 Supabase 프로젝트를 만들고 config.js에 URL과 Publishable Key를 넣으면 로그인 기능이 활성화됩니다.</p></div>';return;}
 if(!state.supabase){p.innerHTML=`<div class="account-box"><p>로그인 서비스를 연결하지 못했습니다.</p><div class="account-sub">${esc(state.cloudError||'네트워크를 확인해 주세요.')}</div></div>`;return;}
 if(state.user){p.innerHTML=`<div class="account-box"><p><b>${esc(state.user.email||'연결된 계정')}</b></p><p class="account-sub">동기화 상태: ${esc(state.syncStatus)} · 대기 중인 변경: ${Object.keys(state.pending).length}건</p>${state.cloudError?`<p class="account-sub overdue-note">${esc(state.cloudError)}</p>`:''}<div class="account-row"><button type="button" class="button button-primary" id="refreshSync">지금 동기화</button><button type="button" class="button button-outline" id="importGuest">기기 자료 병합</button><button type="button" class="button button-light" id="signOut">로그아웃</button></div></div>`;
  $('#refreshSync').addEventListener('click',async()=>{await flushSync();await refreshRemote();accountPanel();notify('동기화를 확인했습니다.');});
  $('#importGuest').addEventListener('click',importGuest);
  $('#signOut').addEventListener('click',async()=>{await state.supabase.auth.signOut();$('#accountDialog').close();});
  return;
 }
 p.innerHTML=`<div class="account-box"><p><b>이메일로 로그인</b></p><p class="account-sub">같은 이메일 계정으로 로그인하면 PC·모바일에서 일정을 공유합니다. 최초 로그인 시 이 기기의 로컬 작업을 가져옵니다.</p><form id="loginForm" class="account-row"><input class="account-input" type="email" id="emailLogin" required autocomplete="email" placeholder="이메일 주소"><button class="button button-primary" type="submit">로그인 링크 전송</button></form><p class="account-sub" id="loginInfo">로그인 이메일에 포함된 링크를 눌러 이 페이지로 돌아오세요.</p></div>`;
 $('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const email=$('#emailLogin').value.trim();
  const button=$('#loginForm button');button.disabled=true;
  try{const {error}=await state.supabase.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});if(error)throw error;$('#loginInfo').textContent='이메일을 발송했습니다. 메일함에서 로그인 링크를 확인하세요.';}
  catch(err){$('#loginInfo').textContent='전송 실패: '+err.message;}finally{button.disabled=false;}
 });
}
function importGuest(){
 const local=readSnapshot(GUEST_KEY);
 if(!local){notify('병합할 기기 자료가 없습니다.');return;}
 if(!confirm('이 기기의 저장 기록을 클라우드에 병합할까요? 동일한 항목은 기기 자료로 덮어씁니다. 필요한 경우 먼저 JSON 백업을 만들어 주세요.'))return;
 for(const r of Object.values(local.records||{})){
  if(!r?.id)continue;
  const value={...r,modified_at:stamp()};
  state.records[value.id]=value;state.pending[value.id]=value;
 }
 persist();render();scheduleSync();notify('기기 자료를 동기화 목록에 추가했습니다.');
}
function downloadBackup(){
 const payload={app:'semester-execution-v3',exported_at:stamp(),timezone:TIMEZONE,records:Object.values(state.records)};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`2026_2학기_플래너_백업_${state.today}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),600);
}
function validateImport(obj){
 if(!obj||obj.app!=='semester-execution-v3'||!Array.isArray(obj.records))throw Error('호환되지 않는 백업 파일입니다.');
 if(obj.records.length>5000)throw Error('5,000개 이상의 항목은 가져올 수 없습니다.');
 const safe=[];
 for(const r of obj.records){
  if(typeof r.id!=='string'||r.id.length>130||!['task','event'].includes(r.kind)||!COURSE[r.course]||typeof r.title!=='string'||r.title.length>180)continue;
  const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;
  safe.push({id:r.id,kind:r.kind,course:r.course,phase:String(r.phase||'').slice(0,100),phase_start:validDate(r.phase_start),phase_end:validDate(r.phase_end),title:r.title,due_date:validDate(r.due_date),status:['todo','doing','done'].includes(r.status)?r.status:'todo',priority:[1,2,3].includes(Number(r.priority))?Number(r.priority):2,event_type:['확정','내부','정기'].includes(r.event_type)?r.event_type:null,note:String(r.note||'').slice(0,3000),origin:'import',deleted_at:r.deleted_at?stamp():null,modified_at:stamp()});
 }
 if(!safe.length)throw Error('가져올 수 있는 항목이 없습니다.');
 return safe;
}
async function handleImport(e){
 const file=e.target.files[0];if(!file)return;
 try{
  const rows=validateImport(JSON.parse(await file.text()));
  if(!confirm(`백업의 ${rows.length}개 항목을 현재 데이터에 병합할까요? 같은 ID의 항목은 덮어씁니다.`))return;
  for(const r of rows){state.records[r.id]=r;if(state.user)state.pending[r.id]=r;}
  persist();if(state.user)scheduleSync();render();notify(`${rows.length}개 항목을 가져왔습니다.`);$('#accountDialog').close();
 }catch(err){notify('가져오기 실패: '+err.message);}
 finally{e.target.value='';}
}
function handlers(){
 $('#content').addEventListener('click',onAction);
 $('#content').addEventListener('change',e=>{if(e.target.dataset.action==='toggle'){} });
 $('#content').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.dataset.action&&e.target.getAttribute('role')==='button'){e.preventDefault();e.target.click();}});
 $('#content').addEventListener('toggle',e=>{if(!e.target.matches('details[data-phase]'))return;const key=e.target.dataset.phase;if(e.target.open)state.expanded.add(key);else state.expanded.delete(key);},true);
 $('#navigation').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)setView(b.dataset.view);});
 $('#courseLinks').addEventListener('click',onAction);
 $('#todayButton').addEventListener('click',()=>{state.today=timezoneToday();state.week=weekStart(state.today);state.day=state.today;state.month=state.today.slice(0,7);setView('focus');});
 $('#addButton').addEventListener('click',()=>openDialog());
 $('#recordForm').addEventListener('submit',formSubmit);
 $('#formKind').addEventListener('change',toggleFormFields);
 $('#deleteButton').addEventListener('click',()=>{const id=$('#recordId').value;$('#recordDialog').close();deleteRecord(id);});
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
 $('#accountButton').addEventListener('click',()=>{accountPanel();$('#accountDialog').showModal();});
 $('#syncState').addEventListener('click',()=>{accountPanel();$('#accountDialog').showModal();});
 $('#exportButton').addEventListener('click',downloadBackup);
 $('#importFile').addEventListener('change',handleImport);
 window.addEventListener('online',()=>{if(state.user){flushSync();refreshRemote();}});
 window.addEventListener('focus',()=>{checkToday();if(state.user)refreshRemote();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){checkToday();if(state.user){flushSync();refreshRemote();}}});
 window.addEventListener('storage',e=>{const key=state.user?LOCAL_ACCOUNT(state.user.id):GUEST_KEY;if(e.key!==key||!e.newValue)return;const snap=readSnapshot(key);if(snap){state.records=snap.records;if(state.user)state.pending={...state.pending,...snap.pending};render();}});
 window.addEventListener('keydown',e=>{const d=document.activeElement;if(e.key==='Escape')return;if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();openDialog();}if(e.key==='n'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(d?.tagName)&&!document.querySelector('dialog[open]'))openDialog();});
}
function checkToday(){const next=timezoneToday();if(state.today!==next){state.today=next;render();}}
initLocal();handlers();render();createSupabase();setInterval(checkToday,60000);
