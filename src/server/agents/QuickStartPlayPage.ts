// Self-contained zero-install tester entry point ("/play"). A tester writes a
// strategy (posture + focus + a couple of rules + an optional doctrine), hits
// Play, and a sponsored server-side LLM agent (planner-openrouter / deepseek)
// plays it out vs built-in nations; the page polls the job and links the replay.
//
// Intentionally standalone HTML/CSS/JS — no dependency on the large demo hub
// template — so the tester surface stays simple and hard to break. The page only
// talks to POST /api/quick-start and GET /api/jobs/:id.

export interface QuickStartPlayPageModel {
  /** Replay route prefix, e.g. "/proxywar-replay". */
  replayPathPrefix?: string;
  /** Optional beta label shown in the header. */
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
  :root { color-scheme: dark; --bg:#0c0f17; --card:#141a26; --line:#26303f;
    --ink:#e8edf6; --muted:#9aa7bd; --accent:#ff5a3c; --accent2:#3c7bff; --ok:#37d39b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:32px 20px 64px; }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:8px; }
  .word { font-weight:800; letter-spacing:.14em; font-size:22px; }
  .pill { font-size:11px; color:var(--muted); border:1px solid var(--line);
    border-radius:999px; padding:2px 8px; text-transform:uppercase; letter-spacing:.1em; }
  .lede { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:22px; }
  label { display:block; font-weight:600; margin:18px 0 8px; }
  .hint { color:var(--muted); font-weight:400; font-size:13px; }
  input[type=text], textarea, select { width:100%; background:#0e131d; color:var(--ink);
    border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
  textarea { min-height:84px; resize:vertical; }
  .row { display:flex; flex-wrap:wrap; gap:10px; }
  .seg { display:flex; flex-wrap:wrap; gap:8px; }
  .seg button { flex:1 1 auto; background:#0e131d; color:var(--ink); border:1px solid var(--line);
    border-radius:10px; padding:10px 12px; cursor:pointer; font:inherit; }
  .seg button[aria-pressed=true] { border-color:var(--accent); background:#1b1410; color:#fff; }
  .checks { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .check { display:flex; gap:9px; align-items:flex-start; background:#0e131d;
    border:1px solid var(--line); border-radius:10px; padding:10px 12px; cursor:pointer; }
  .check input { margin-top:3px; }
  .play { margin-top:26px; width:100%; background:var(--accent); color:#1a0d08; border:0;
    border-radius:12px; padding:15px; font-size:17px; font-weight:800; cursor:pointer;
    letter-spacing:.02em; }
  .play:disabled { opacity:.55; cursor:default; }
  .status { margin-top:18px; padding:14px 16px; border:1px solid var(--line); border-radius:12px;
    background:#0e131d; min-height:24px; }
  .status.run { border-color:var(--accent2); }
  .status.done { border-color:var(--ok); }
  .status.err { border-color:var(--accent); }
  a.replay { display:inline-block; margin-top:10px; color:#fff; background:var(--accent2);
    padding:11px 16px; border-radius:10px; text-decoration:none; font-weight:700; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid var(--muted);
    border-top-color:var(--accent2); border-radius:50%; animation:s 0.8s linear infinite;
    vertical-align:-2px; margin-right:8px; }
  @keyframes s { to { transform:rotate(360deg); } }
  footer { color:var(--muted); font-size:13px; margin-top:28px; }
  code { background:#0e131d; border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
</style>
</head>
<body>
<div class="wrap">
  <header><span class="word">PROXY WAR</span><span class="pill">${betaLabel}</span></header>
  <p class="lede">Write a strategy. An AI agent plays it out in a live territorial-war match. Watch the replay.</p>

  <div class="card">
    <label for="agentName">Agent name</label>
    <input id="agentName" type="text" maxlength="27" value="My Agent" />

    <label>Posture <span class="hint">— how it weighs aggression vs. caution vs. diplomacy</span></label>
    <div class="seg" id="posture">
      <button type="button" data-v="aggressive" aria-pressed="true">Aggressive</button>
      <button type="button" data-v="opportunistic" aria-pressed="false">Balanced</button>
      <button type="button" data-v="diplomatic" aria-pressed="false">Diplomatic</button>
      <button type="button" data-v="defensive" aria-pressed="false">Defensive</button>
    </div>

    <label>Focus <span class="hint">— what it should prioritize</span></label>
    <div class="seg" id="focus">
      <button type="button" data-v="military" aria-pressed="true">Conquest</button>
      <button type="button" data-v="expand" aria-pressed="false">Expansion</button>
      <button type="button" data-v="economy" aria-pressed="false">Economy</button>
      <button type="button" data-v="diplomacy" aria-pressed="false">Diplomacy</button>
    </div>

    <label>Rules <span class="hint">— hard limits the agent must obey</span></label>
    <div class="checks" id="rules">
      <label class="check"><input type="checkbox" data-rule="noNukes" /> Never use nukes</label>
      <label class="check"><input type="checkbox" data-rule="noBetrayal" /> Never betray an ally</label>
      <label class="check"><input type="checkbox" data-rule="noAlliances" /> Go it alone (no alliances)</label>
      <label class="check"><input type="checkbox" data-rule="noNavy" /> No naval invasions</label>
    </div>

    <label for="doctrine">Doctrine <span class="hint">— optional free-text orders the AI reads each turn</span></label>
    <textarea id="doctrine" maxlength="600" placeholder="e.g. Strike the strongest neighbor early before they snowball; never fight two wars at once."></textarea>

    <button class="play" id="play">▶ Play a match</button>
    <div class="status" id="status">Pick a strategy and hit play. A match takes ~1–2 minutes.</div>
  </div>

  <footer>
    Your agent is a real LLM making every decision from the legal moves — it can't cheat or send raw commands.
    Matches run on us. Want to connect your own agent instead? See <code>/agent-start</code>.
  </footer>
</div>

<script>
(function(){
  var REPLAY_PREFIX = ${JSON.stringify(replayPrefix)};
  function seg(id){
    var box = document.getElementById(id);
    box.addEventListener('click', function(e){
      var b = e.target.closest('button'); if(!b) return;
      box.querySelectorAll('button').forEach(function(x){ x.setAttribute('aria-pressed', String(x===b)); });
    });
    return function(){ var b = box.querySelector('button[aria-pressed=true]'); return b ? b.dataset.v : null; };
  }
  var getPosture = seg('posture'), getFocus = seg('focus');
  var FOCUS_PREFERRED = {
    military: ['attack','boat'], expand: ['attack','boat'],
    economy: ['build','upgrade_structure'], diplomacy: ['alliance_request','build']
  };
  var RULE_FORBID = {
    noNukes: ['nuke'], noBetrayal: ['break_alliance'],
    noAlliances: ['alliance_request','alliance_extend','alliance_reject','break_alliance'],
    noNavy: ['boat']
  };
  function buildSpec(){
    var posture = getPosture(), focus = getFocus();
    var preferred = (FOCUS_PREFERRED[focus] || []).slice();
    var forbidden = [];
    document.querySelectorAll('#rules input:checked').forEach(function(c){
      (RULE_FORBID[c.dataset.rule] || []).forEach(function(k){ if(forbidden.indexOf(k)<0) forbidden.push(k); });
    });
    // Don't both prefer and forbid a kind.
    preferred = preferred.filter(function(k){ return forbidden.indexOf(k)<0; });
    var doctrine = document.getElementById('doctrine').value.trim();
    var spec = { posture: posture, objectiveBias: focus };
    if (preferred.length) spec.preferredKinds = preferred;
    if (forbidden.length) spec.forbiddenKinds = forbidden;
    if (doctrine) spec.doctrine = doctrine;
    return spec;
  }
  var statusEl = document.getElementById('status');
  var playBtn = document.getElementById('play');
  function setStatus(html, cls){ statusEl.className = 'status' + (cls?(' '+cls):''); statusEl.innerHTML = html; }

  function poll(jobID){
    fetch('/api/jobs/' + encodeURIComponent(jobID)).then(function(r){ return r.json(); }).then(function(j){
      var st = j.status;
      if (st === 'completed') {
        var runID = j.latestRunID;
        if (runID) {
          setStatus('Match complete. <a class="replay" href="' + REPLAY_PREFIX + '/' + encodeURIComponent(runID) + '">▶ Watch the replay</a>', 'done');
        } else {
          setStatus('Match finished but no replay was produced. Try again.', 'err');
        }
        playBtn.disabled = false; playBtn.textContent = '▶ Play another';
        return;
      }
      if (st === 'failed') {
        setStatus('Match failed: ' + (j.errorSummary || 'unknown error') + '. Try again.', 'err');
        playBtn.disabled = false; playBtn.textContent = '▶ Play a match';
        return;
      }
      setStatus('<span class="spin"></span>Your agent is ' + (st === 'running' ? 'playing the match' : 'queued') + '… (~1–2 min)', 'run');
      setTimeout(function(){ poll(jobID); }, 2500);
    }).catch(function(){ setTimeout(function(){ poll(jobID); }, 3500); });
  }

  playBtn.addEventListener('click', function(){
    playBtn.disabled = true;
    setStatus('<span class="spin"></span>Starting your match…', 'run');
    fetch('/api/quick-start', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentName: document.getElementById('agentName').value, strategySpec: buildSpec() })
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        if (!res.ok) {
          setStatus('Could not start: ' + (res.j.error || 'try again'), 'err');
          playBtn.disabled = false; return;
        }
        poll(res.j.jobID);
      }).catch(function(){ setStatus('Network error starting the match. Try again.', 'err'); playBtn.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}
