(() => {
  const $ = (id) => document.getElementById(id);
  const API = (window.STATUSWATCH_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
  const popular = [
    {name:"Google",url:"https://www.google.com",mark:"G"},
    {name:"YouTube",url:"https://www.youtube.com",mark:"▶"},
    {name:"Discord",url:"https://discord.com",mark:"D"},
    {name:"Netflix",url:"https://www.netflix.com",mark:"N"},
    {name:"Steam",url:"https://store.steampowered.com",mark:"S"},
    {name:"GitHub",url:"https://github.com",mark:"⌘"},
    {name:"Microsoft 365",url:"https://www.microsoft.com",mark:"M"},
    {name:"PlayStation",url:"https://www.playstation.com",mark:"P"},
    {name:"Reddit",url:"https://www.reddit.com",mark:"r"},
    {name:"Spotify",url:"https://www.spotify.com",mark:"♪"}
  ];
  let monitors = JSON.parse(localStorage.getItem("statuswatch-monitors") || "[]");
  let checks = 0, latencies = [];
  const save = () => localStorage.setItem("statuswatch-monitors", JSON.stringify(monitors));
  const safeUrl = (value) => {
    let raw = value.trim();
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    const u = new URL(raw);
    if (!["http:","https:"].includes(u.protocol) || !u.hostname || u.username || u.password) throw new Error("Enter a valid public website address.");
    return u.href;
  };
  const hostOf = (url) => new URL(url).hostname.replace(/^www\./,"");
  const timeAgo = (date) => {
    if (!date) return "Not checked";
    const seconds = Math.max(0, Math.floor((Date.now()-new Date(date).getTime())/1000));
    if (seconds < 10) return "Just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
    return `${Math.floor(seconds/3600)}h ago`;
  };
  const toast = (message) => {
    const el = $("toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.classList.remove("show"),2600);
  };
  const statusText = (m) => m.status === "up" ? "Online" : m.status === "down" ? "Issue detected" : "Not checked";
  function render() {
    $("monitor-count").textContent = monitors.length;
    $("watchlist-count").textContent = monitors.length;
    $("check-count").textContent = checks;
    $("avg-latency").textContent = latencies.length ? Math.round(latencies.reduce((a,b)=>a+b,0)/latencies.length) : "—";
    $("avg-unit").textContent = latencies.length ? "ms" : "";
    const body = $("monitor-list");
    if (!monitors.length) {
      body.innerHTML = `<tr class="empty-row"><td colspan="5"><div class="empty-state"><div class="empty-icon">⌁</div><strong>No monitors yet</strong><span>Add a website to start tracking its availability.</span><button class="text-button" id="empty-add-button">Add your first monitor →</button></div></td></tr>`;
      $("empty-add-button").addEventListener("click", openModal);
    } else {
      body.innerHTML = monitors.map((m,i)=>`<tr>
        <td><div class="site-cell"><div class="site-favicon">${escapeHtml((m.name||hostOf(m.url)).slice(0,1).toUpperCase())}</div><div><div class="site-name">${escapeHtml(m.name||hostOf(m.url))}</div><div class="site-url">${escapeHtml(hostOf(m.url))}</div></div></div></td>
        <td><span class="status-label ${m.status==="up"?"status-up":m.status==="down"?"status-down":"status-unknown"}">${statusText(m)}</span></td>
        <td class="latency">${m.latency != null ? `${m.latency} ms` : "—"}</td>
        <td class="last-checked">${timeAgo(m.checkedAt)}</td>
        <td><div class="row-actions"><button class="mini-action" data-check="${i}">Check</button><button class="mini-action" data-remove="${i}" aria-label="Remove monitor">×</button></div></td>
      </tr>`).join("");
      body.querySelectorAll("[data-check]").forEach(b=>b.addEventListener("click",()=>checkMonitor(Number(b.dataset.check))));
      body.querySelectorAll("[data-remove]").forEach(b=>b.addEventListener("click",async()=>{try{await removeMonitor(Number(b.dataset.remove));}catch(e){toast(e.message);}}));
    }
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  async function apiRequest(path, options={}) {
    if (!API) throw new Error("Connect the Cloudflare Worker API to run live server-side checks. See README.md.");
    const response = await fetch(`${API}${path}`, {headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
    const data = await response.json().catch(()=>({error:"The monitoring API returned an invalid response."}));
    if (!response.ok) throw new Error(data.error || `Monitoring API error (${response.status})`);
    return data;
  }
  const apiCheck = (url) => apiRequest("/api/check", {method:"POST",body:JSON.stringify({url})});
  async function loadRemoteMonitors() {
    if (!API) return;
    try {
      const data = await apiRequest("/api/monitors");
      monitors = (data.monitors || []).map(m => ({...m, status:m.latest?.ok===true?"up":m.latest?.ok===false?"down":"unknown", latency:m.latest?.latencyMs??null, checkedAt:m.latest?.checkedAt??null}));
      save(); render();
    } catch (error) { toast(`Could not load saved monitors: ${error.message}`); }
  }
  async function runCheck(url, target) {
    const button = target;
    if (button) {button.disabled=true;button.dataset.oldText=button.innerHTML;button.innerHTML="Checking…";}
    try {
      const result = await apiCheck(url);
      checks++;
      if (result.ok && Number.isFinite(result.latencyMs)) latencies.push(result.latencyMs);
      $("check-result").hidden=false;
      $("check-result").className=`check-result ${result.ok?"good":"bad"}`;
      $("check-result").innerHTML = `<strong>${escapeHtml(hostOf(url))}: ${result.ok?"Responding":"Not responding as expected"}</strong><br>${result.ok?"Received an HTTP response":"The request failed or returned an error"}${result.httpStatus?` · HTTP ${result.httpStatus}`:""}${result.latencyMs!=null?` · ${result.latencyMs} ms`:""}${result.checkedAt?` · Checked ${new Date(result.checkedAt).toLocaleTimeString()}`:""}`;
      return result;
    } finally {
      if (button) {button.disabled=false;button.innerHTML=button.dataset.oldText||"Check status";}
    }
  }
  async function checkMonitor(index) {
    const m=monitors[index]; if(!m)return;
    try {
      const r=await runCheck(m.url);
      m.status=r.ok?"up":"down";m.latency=r.latencyMs??null;m.checkedAt=r.checkedAt||new Date().toISOString();save();render();
      toast(r.ok?"Website responded successfully":"Check completed — issue detected");
    } catch(e) {toast(e.message);}
  }
  async function refreshAll() {
    if(!monitors.length){toast("Add a monitor first");return;}
    $("refresh-button").disabled=true;
    for(let i=0;i<monitors.length;i++) await checkMonitor(i);
    $("refresh-button").disabled=false;
  }
  function openModal(){ $("monitor-dialog").showModal(); }
  async function addMonitor(url,name) {
    const normalized=safeUrl(url);
    if(monitors.some(m=>m.url===normalized)) throw new Error("That website is already on your watchlist.");
    const displayName=name.trim()||hostOf(normalized);
    if (API) {
      const data = await apiRequest("/api/monitors", {method:"POST",body:JSON.stringify({url:normalized,name:displayName})});
      monitors.push({...data.monitor,status:"unknown",latency:null,checkedAt:null});
    } else {
      monitors.push({url:normalized,name:displayName,status:"unknown",latency:null,checkedAt:null});
    }
    save();render();
  }
  async function removeMonitor(index) {
    const monitor=monitors[index]; if(!monitor)return;
    if(API && monitor.id) await apiRequest(`/api/monitors/${encodeURIComponent(monitor.id)}`,{method:"DELETE"});
    monitors.splice(index,1);save();render();toast("Monitor removed");
  }
  $("check-form").addEventListener("submit",async e=>{
    e.preventDefault();let url;
    try{url=safeUrl($("url-input").value);}catch(err){toast(err.message);return;}
    const button=$("check-button");
    try{await runCheck(url,button);}catch(err){$("check-result").hidden=false;$("check-result").className="check-result bad";$("check-result").textContent=err.message;}
  });
  $("add-monitor-button").addEventListener("click",openModal);
  $("empty-add-button")?.addEventListener("click",openModal);
  $("refresh-button").addEventListener("click",refreshAll);
  $("monitor-form").addEventListener("submit",e=>{
    if(e.submitter?.value==="cancel")return;
    e.preventDefault();
    (async()=>{try{await addMonitor($("monitor-url").value,$("monitor-name").value);$("monitor-dialog").close();$("monitor-url").value="";$("monitor-name").value="";toast(API?"Monitor saved for scheduled checks":"Monitor saved in this browser");}
    catch(err){toast(err.message);}})();
  });
  $("popular-grid").innerHTML=popular.map(p=>`<button class="popular-card" data-url="${p.url}"><span class="popular-logo">${p.mark}</span><span class="popular-info"><strong>${p.name}</strong><span>Run availability check</span></span><span class="popular-arrow">↗</span></button>`).join("");
  $("popular-grid").querySelectorAll("[data-url]").forEach(b=>b.addEventListener("click",async()=>{ $("url-input").value=b.dataset.url;window.scrollTo({top:0,behavior:"smooth"});try{await runCheck(b.dataset.url,$("check-button"));}catch(e){$("check-result").hidden=false;$("check-result").className="check-result bad";$("check-result").textContent=e.message;}}));
  $("theme-toggle").addEventListener("click",()=>{document.body.classList.toggle("dark");localStorage.setItem("statuswatch-dark",document.body.classList.contains("dark")?"1":"0");});
  if(localStorage.getItem("statuswatch-dark")==="1")document.body.classList.add("dark");
  $("year").textContent=new Date().getFullYear();
  if(API){$("api-state").textContent="Configured";$("api-foot").textContent="Worker URL is set";$("system-label").textContent="API CONFIGURED";$("watchlist-note").textContent="Your monitors are saved in Cloudflare KV and checked automatically every five minutes.";loadRemoteMonitors();}
  render();
})();
