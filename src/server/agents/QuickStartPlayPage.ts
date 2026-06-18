// Self-contained zero-install tester entry point ("/play"). A tester names an
// agent, picks ONE playstyle (each preset maps to Phase-2 binding directives so
// it genuinely plays differently — the Diplomat actually allies, the Conqueror
// commits to attacks), optionally tweaks a free-text doctrine, hits Play. A
// sponsored server-side LLM agent plays it out vs built-in nations; the page polls
// the job and links the replay.
//
// Deliberately minimal: one decision (the playstyle) + Play. No dependency on the
// large demo hub. Talks only to POST /api/quick-start and GET /api/jobs/:id.

export interface QuickStartPlayPageModel {
  replayPathPrefix?: string;
  betaLabel?: string;
}

export function renderQuickStartPlayHtml(
  model: QuickStartPlayPageModel = {},
): string {
  const replayPrefix = model.replayPathPrefix ?? "/proxywar-replay";
  const betaLabel = model.betaLabel ?? "Beta";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Proxy War — Field your agent</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0b0e14; --fg:#eef2f8; --muted:#8b97ad; --line:#222a38;
    --card:#11151e; --sel:#ff5a3c; --go:#ff5a3c; --link:#5b8cff; --ok:#37d39b;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; }
  main { max-width:560px; margin:0 auto; padding:56px 22px 80px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .brand b { font-weight:800; letter-spacing:.16em; font-size:20px; }
  .tag { font-size:10px; color:var(--muted); border:1px solid var(--line);
    border-radius:999px; padding:2px 8px; letter-spacing:.12em; text-transform:uppercase; }
  .sub { color:var(--muted); margin:0 0 34px; font-size:15px; }
  label { display:block; font-size:13px; color:var(--muted); margin:0 0 9px;
    letter-spacing:.02em; }
  input[type=text], textarea { width:100%; background:var(--card); color:var(--fg);
    border:1px solid var(--line); border-radius:11px; padding:13px 14px; font:inherit; }
  input[type=text]:focus, textarea:focus { outline:none; border-color:#39455a; }
  textarea { min-height:74px; resize:vertical; }
  .field { margin-bottom:28px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .pick { text-align:left; background:var(--card); border:1px solid var(--line);
    border-radius:13px; padding:15px 16px; cursor:pointer; color:var(--fg);
    font:inherit; transition:border-color .12s, background .12s; }
  .pick:hover { border-color:#39455a; }
  .pick[aria-pressed=true] { border-color:var(--sel); background:#1a130f; }
  .pick .ic { font-size:20px; }
  .pick .nm { font-weight:650; margin:6px 0 2px; }
  .pick .ds { font-size:12.5px; color:var(--muted); line-height:1.4; }
  .more { background:none; border:0; color:var(--link); font:inherit; cursor:pointer;
    padding:0; margin:6px 0 0; }
  .more:hover { text-decoration:underline; }
  .custom { display:none; margin-top:16px; }
  .custom.open { display:block; }
  .play { margin-top:30px; width:100%; background:var(--go); color:#1c0f09; border:0;
    border-radius:13px; padding:16px; font-size:17px; font-weight:800; cursor:pointer;
    letter-spacing:.01em; }
  .play:disabled { opacity:.5; cursor:default; }
  .status { margin-top:18px; color:var(--muted); font-size:14.5px; min-height:22px;
    text-align:center; }
  .status.run, .status.done, .status.err { color:var(--fg); }
  a.replay { display:inline-block; margin-top:6px; background:var(--link); color:#fff;
    padding:12px 18px; border-radius:11px; text-decoration:none; font-weight:700; }
  .spin { display:inline-block; width:13px; height:13px; border:2px solid #2a3344;
    border-top-color:var(--link); border-radius:50%; animation:s .8s linear infinite;
    vertical-align:-2px; margin-right:8px; }
  @keyframes s { to { transform:rotate(360deg); } }
  footer { color:var(--muted); font-size:12.5px; margin-top:40px; line-height:1.6; }
  code { color:#aeb8c8; }
</style>
</head>
<body>
<main>
  <div class="brand"><b>PROXY WAR</b><span class="tag">${betaLabel}</span></div>
  <p class="sub">Pick a strategy. Our AI plays it out in a live war. Watch the replay.</p>

  <div class="field">
    <label for="name">Agent name</label>
    <input id="name" type="text" maxlength="27" value="My Agent" autocomplete="off" />
  </div>

  <div class="field">
    <label>Playstyle</label>
    <div class="grid" id="styles">
      <button type="button" class="pick" data-k="conqueror" aria-pressed="true">
        <div class="ic">⚔️</div><div class="nm">Conqueror</div>
        <div class="ds">Attacks relentlessly. Never allies.</div></button>
      <button type="button" class="pick" data-k="diplomat" aria-pressed="false">
        <div class="ic">🤝</div><div class="nm">Diplomat</div>
        <div class="ds">Allies widely. Fights only if attacked.</div></button>
      <button type="button" class="pick" data-k="economist" aria-pressed="false">
        <div class="ic">🏛️</div><div class="nm">Economist</div>
        <div class="ds">Builds a strong economy. Avoids wars.</div></button>
      <button type="button" class="pick" data-k="defender" aria-pressed="false">
        <div class="ic">🛡️</div><div class="nm">Defender</div>
        <div class="ds">Fortifies and holds. Counters only.</div></button>
    </div>
    <button type="button" class="more" id="moreBtn">Customize the orders ▸</button>
    <div class="custom" id="custom">
      <label for="doctrine" style="margin-top:6px">Doctrine <span style="color:#6b7689">— optional free-text orders the AI reads each turn</span></label>
      <textarea id="doctrine" maxlength="600" placeholder="Leave blank to use the playstyle's default. e.g. Strike the strongest neighbor before they snowball; never fight two wars at once."></textarea>
    </div>
  </div>

  <button class="play" id="play">▶ Play a match</button>
  <div class="status" id="status">Takes about a minute. You'll get a replay link.</div>

  <footer>
    Your agent is a real LLM making every move from the legal options — it can't cheat.
    Matches run on us. Want to connect your own agent instead? See <code>/agent-start</code>.
  </footer>
</main>

<script>
(function(){
  var REPLAY_PREFIX = ${JSON.stringify(replayPrefix)};
  var PRESETS = {
    conqueror: { posture:"aggressive", objectiveBias:"military",
      preferredKinds:["attack","boat"],
      forbiddenKinds:["alliance_request","alliance_extend","break_alliance","alliance_reject"],
      doctrine:"Conquer. Commit decisively to crushing the weakest reachable rival. Never form alliances." },
    diplomat: { posture:"diplomatic", objectiveBias:"diplomacy",
      preferredKinds:["alliance_request","build","donate_gold"],
      forbiddenKinds:["nuke","break_alliance"],
      doctrine:"Ally with every neighbor you meet. Build economy, support your allies, and fight only if directly attacked. Never betray an ally." },
    economist: { posture:"defensive", objectiveBias:"economy",
      preferredKinds:["build","upgrade_structure"],
      forbiddenKinds:["nuke"],
      doctrine:"Grow a powerful economy. Expand into safe neutral land, build cities, and avoid costly wars." },
    defender: { posture:"defensive", objectiveBias:"survive",
      preferredKinds:["build","hold"],
      forbiddenKinds:["nuke"],
      doctrine:"Hold your ground. Fortify your borders and counterattack only when struck." }
  };
  var styles = document.getElementById('styles');
  var picked = 'conqueror';
  styles.addEventListener('click', function(e){
    var b = e.target.closest('.pick'); if(!b) return;
    picked = b.dataset.k;
    styles.querySelectorAll('.pick').forEach(function(x){ x.setAttribute('aria-pressed', String(x===b)); });
  });
  document.getElementById('moreBtn').addEventListener('click', function(){
    document.getElementById('custom').classList.toggle('open');
  });

  var statusEl = document.getElementById('status');
  var playBtn = document.getElementById('play');
  function setStatus(html, cls){ statusEl.className = 'status' + (cls?(' '+cls):''); statusEl.innerHTML = html; }

  function poll(jobID){
    fetch('/api/jobs/' + encodeURIComponent(jobID)).then(function(r){ return r.json(); }).then(function(j){
      if (j.status === 'completed') {
        if (j.latestRunID) setStatus('Done. <a class="replay" href="' + REPLAY_PREFIX + '/' + encodeURIComponent(j.latestRunID) + '">▶ Watch the replay</a>', 'done');
        else setStatus('Match finished but produced no replay. Try again.', 'err');
        playBtn.disabled = false; playBtn.textContent = '▶ Play again'; return;
      }
      if (j.status === 'failed') {
        setStatus('Match failed: ' + (j.errorSummary || 'unknown error') + '. Try again.', 'err');
        playBtn.disabled = false; playBtn.textContent = '▶ Play a match'; return;
      }
      setStatus('<span class="spin"></span>Your agent is ' + (j.status === 'running' ? 'playing' : 'queued') + '…', 'run');
      setTimeout(function(){ poll(jobID); }, 2500);
    }).catch(function(){ setTimeout(function(){ poll(jobID); }, 3500); });
  }

  playBtn.addEventListener('click', function(){
    var spec = JSON.parse(JSON.stringify(PRESETS[picked]));
    var custom = document.getElementById('doctrine').value.trim();
    if (custom) spec.doctrine = custom;
    playBtn.disabled = true;
    setStatus('<span class="spin"></span>Starting your match…', 'run');
    fetch('/api/quick-start', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentName: document.getElementById('name').value, strategySpec: spec })
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        if (!res.ok) { setStatus('Could not start: ' + (res.j.error || 'try again'), 'err'); playBtn.disabled = false; return; }
        poll(res.j.jobID);
      }).catch(function(){ setStatus('Network error. Try again.', 'err'); playBtn.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}
