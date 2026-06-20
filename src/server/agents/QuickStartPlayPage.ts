// Self-contained zero-install tester entry point ("/play"). A tester names an
// agent and WRITES a free-text war strategy (no presets — the prompt is the whole
// input), then joins a lobby. When 4 players have joined, one shared match runs
// with all 4 agents, each driven by its joiner's prompt; the page polls the lobby
// and links the shared replay.
//
// Deliberately minimal. Talks only to POST /api/lobby/join and GET /api/lobby/:id.

export interface QuickStartPlayPageModel {
  replayPathPrefix?: string;
  betaLabel?: string;
}

export function renderQuickStartPlayHtml(
  model: QuickStartPlayPageModel = {},
): string {
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
    --card:#11151e; --go:#ff5a3c; --link:#5b8cff; --ok:#37d39b;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; }
  main { max-width:600px; margin:0 auto; padding:56px 22px 80px; }
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
  textarea { min-height:128px; resize:vertical; line-height:1.5; }
  .field { margin-bottom:26px; }
  .examples { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .ex { text-align:left; background:var(--card); border:1px solid var(--line);
    border-radius:999px; padding:7px 13px; cursor:pointer; color:#c7d0de;
    font:inherit; font-size:12.5px; transition:border-color .12s, color .12s; }
  .ex:hover { border-color:#39455a; color:var(--fg); }
  .matches { display:flex; flex-direction:column; gap:8px; }
  .match { display:flex; align-items:center; gap:10px; background:var(--card);
    border:1px solid var(--line); border-radius:11px; padding:11px 14px; font-size:13.5px; }
  .match .who { flex:1; color:#c7d0de; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .match .st { font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
  .match.live .st { color:var(--ok); }
  .match a.w { color:var(--link); text-decoration:none; font-weight:700; white-space:nowrap; }
  .match a.w:hover { text-decoration:underline; }
  .play { margin-top:10px; width:100%; background:var(--go); color:#1c0f09; border:0;
    border-radius:13px; padding:16px; font-size:17px; font-weight:800; cursor:pointer;
    letter-spacing:.01em; }
  .play:disabled { opacity:.5; cursor:default; }
  .status { margin-top:18px; color:var(--muted); font-size:14.5px; min-height:22px;
    text-align:center; }
  .status.run, .status.done, .status.err { color:var(--fg); }
  .lobbycount { font-weight:800; color:var(--ok); }
  a.replay { display:inline-block; margin-top:6px; background:var(--link); color:#fff;
    padding:12px 18px; border-radius:11px; text-decoration:none; font-weight:700; }
  .spin { display:inline-block; width:13px; height:13px; border:2px solid #2a3344;
    border-top-color:var(--link); border-radius:50%; animation:s .8s linear infinite;
    vertical-align:-2px; margin-right:8px; }
  @keyframes s { to { transform:rotate(360deg); } }
  footer { color:var(--muted); font-size:12.5px; margin-top:40px; line-height:1.6; }
  code { color:#aeb8c8; }
  details.tune { margin:-8px 0 26px; border:1px solid var(--line); border-radius:11px;
    background:var(--card); }
  details.tune > summary { cursor:pointer; padding:12px 14px; color:var(--muted);
    font-size:13px; list-style:none; letter-spacing:.02em; }
  details.tune > summary::-webkit-details-marker { display:none; }
  details.tune > summary::before { content:"⚙ "; }
  details.tune[open] > summary { border-bottom:1px solid var(--line); color:var(--fg); }
  .tune-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:14px; }
  .tune-row label { margin-bottom:6px; }
  .tune select { width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--line);
    border-radius:9px; padding:10px 11px; font:inherit; }
  .tune-checks { display:flex; flex-wrap:wrap; gap:8px 18px; padding:0 14px 14px; }
  label.chk { display:flex; align-items:center; gap:7px; color:#c7d0de; font-size:13.5px;
    margin:0; cursor:pointer; }
  label.chk input { accent-color:var(--go); width:15px; height:15px; }
  .tune-note { color:var(--muted); font-size:11.5px; padding:0 14px 13px; margin:0; }
</style>
</head>
<body>
<main>
  <div class="brand"><b>PROXY WAR</b><span class="tag">${betaLabel}</span></div>
  <p class="sub">Write your war strategy. We field your agent in a 4-player match. Watch it play out.</p>

  <div class="field">
    <label for="name">Agent name</label>
    <input id="name" type="text" maxlength="27" value="My Agent" autocomplete="off" />
  </div>

  <div class="field">
    <label for="prompt">Your strategy <span style="color:#6b7689">— tell your agent how to play; it reads this every turn</span></label>
    <textarea id="prompt" maxlength="600" placeholder="e.g. Build a strong economy with factories and ports. Ally with neighbors early. Only attack someone once you clearly outproduce them — then commit."></textarea>
    <div class="examples" id="examples"></div>
  </div>

  <details class="tune">
    <summary>Fine-tune (optional)</summary>
    <div class="tune-grid">
      <div class="tune-row">
        <label for="lean">Strategy lean</label>
        <select id="lean">
          <option value="">Auto — let the prompt decide</option>
          <option value="expand">Expand fast</option>
          <option value="economy">Economy &amp; build</option>
          <option value="military">Military</option>
          <option value="diplomacy">Diplomacy</option>
          <option value="survive">Survive</option>
        </select>
      </div>
      <div class="tune-row">
        <label for="posture">Posture</label>
        <select id="posture">
          <option value="">Auto</option>
          <option value="aggressive">Aggressive</option>
          <option value="defensive">Defensive</option>
          <option value="diplomatic">Diplomatic</option>
          <option value="opportunistic">Opportunistic</option>
        </select>
      </div>
    </div>
    <div class="tune-checks">
      <label class="chk"><input type="checkbox" id="allow-alliances" checked /> Allow alliances</label>
      <label class="chk"><input type="checkbox" id="allow-betrayal" checked /> Allow betrayal</label>
      <label class="chk"><input type="checkbox" id="allow-nukes" checked /> Allow nukes</label>
    </div>
    <p class="tune-note">These bind your agent: a forbidden action is never taken, and a lean steers what it builds and whether it allies. Leave on Auto to let your written strategy drive.</p>
  </details>

  <button class="play" id="play">▶ Find a 4-player match</button>
  <div class="status" id="status">When 4 players have joined, the match begins. You'll get a replay link.</div>
  <section id="result-card" style="margin-top:24px; display:none;"></section>

  <section id="matches-wrap" style="margin-top:40px; display:none;">
    <label style="margin-bottom:12px">Recent matches</label>
    <div class="matches" id="matches"></div>
  </section>

  <footer>
    Four players, four strategies, one war — each agent is a real LLM making every move from the legal options.
    Matches run on us. Want to connect your own agent instead? See <code>/agent-start</code>.
  </footer>
</main>

<script>
(function(){
  var EXAMPLES = [
    "Turtle: build a strong economy with factories and ports, fortify your borders, and only fight if you are attacked.",
    "Diplomat: ally with everyone you meet, support allies with gold, and never strike first.",
    "Warlord: expand fast and conquer the weakest neighbor you can reach. Never ally.",
    "Opportunist: ally early, then betray your strongest ally the moment you can take their land.",
    "Economist: max out cities and factories, avoid wars, and win on production."
  ];
  var promptEl = document.getElementById('prompt');
  var ex = document.getElementById('examples');
  EXAMPLES.forEach(function(text){
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ex';
    b.textContent = text.split(':')[0];
    b.title = text;
    b.addEventListener('click', function(){ promptEl.value = text; promptEl.focus(); });
    ex.appendChild(b);
  });

  var statusEl = document.getElementById('status');
  var playBtn = document.getElementById('play');
  function setStatus(html, cls){ statusEl.className = 'status' + (cls?(' '+cls):''); statusEl.innerHTML = html; }

  function poll(lobbyId){
    fetch('/api/lobby/' + encodeURIComponent(lobbyId)).then(function(r){ return r.json(); }).then(function(j){
      if (j.status === 'completed') {
        setStatus(j.replayUrl ? 'Match complete.' : 'Match finished but produced no replay.', j.replayUrl ? 'done' : 'err');
        renderResultCard(j.result, j.replayUrl);
        playBtn.disabled = false; playBtn.textContent = '▶ Find another match'; return;
      }
      if (j.status === 'failed') {
        setStatus('Match failed: ' + (j.error || 'unknown error') + '. Try again.', 'err');
        playBtn.disabled = false; playBtn.textContent = '▶ Find a 4-player match'; return;
      }
      if (j.status === 'running' || j.status === 'starting') {
        setStatus('<span class="spin"></span>Lobby full — your 4-player match is playing…', 'run');
      } else {
        var c = (j.count || 1), n = (j.size || 4);
        setStatus('<span class="spin"></span>Waiting for players — <span class="lobbycount">' + c + '/' + n + '</span> in the lobby. The match starts when it fills.', 'run');
      }
      setTimeout(function(){ poll(lobbyId); }, 2500);
    }).catch(function(){ setTimeout(function(){ poll(lobbyId); }, 3500); });
  }

  function buildSpec(doctrine){
    var spec = { doctrine: doctrine };
    var lean = document.getElementById('lean').value;
    if (lean) spec.objectiveBias = lean;
    var posture = document.getElementById('posture').value;
    if (posture) spec.posture = posture;
    var forbid = [];
    if (!document.getElementById('allow-alliances').checked) { forbid.push('alliance_request'); forbid.push('alliance_extend'); }
    if (!document.getElementById('allow-betrayal').checked) forbid.push('break_alliance');
    if (!document.getElementById('allow-nukes').checked) forbid.push('nuke');
    if (forbid.length) spec.forbiddenKinds = forbid;
    return spec;
  }

  playBtn.addEventListener('click', function(){
    var doctrine = promptEl.value.trim();
    if (!doctrine) { setStatus('Write a strategy first — a sentence or two on how your agent should play.', 'err'); promptEl.focus(); return; }
    playBtn.disabled = true;
    setStatus('<span class="spin"></span>Joining the lobby…', 'run');
    fetch('/api/lobby/join', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentName: document.getElementById('name').value, strategySpec: buildSpec(doctrine) })
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        if (!res.ok) { setStatus('Could not join: ' + (res.j.error || 'try again'), 'err'); playBtn.disabled = false; return; }
        poll(res.j.lobbyId);
      }).catch(function(){ setStatus('Network error. Try again.', 'err'); playBtn.disabled = false; });
  });

  function esc(s){ var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function renderResultCard(result, replayUrl){
    var box = document.getElementById('result-card');
    if (!box) return;
    var parts = [];
    if (result && result.standings && result.standings.length){
      parts.push('<label style="margin-bottom:10px">Final standing</label>');
      parts.push(result.standings.map(function(s,i){
        return '<div class="match"><span class="who">' + (i===0?'🏆 ':(i+1)+'. ') + esc(s.name||'agent') + (s.alive===false?' <span class="muted">(out)</span>':'') + '</span><span class="st">' + Number(s.tiles||0).toLocaleString() + ' tiles</span></div>';
      }).join(''));
    }
    if (result && result.story){
      var st = result.story;
      parts.push('<label style="margin:18px 0 10px">What happened</label>');
      parts.push('<p class="muted" style="margin:0 0 8px">' + (st.alliancesFormed||0) + ' alliances · ' + (st.betrayals||0) + ' betrayals · ' + (st.eliminations||0) + ' eliminations' + (st.grade?(' · '+esc(st.grade)):'') + '</p>');
      if (st.moments && st.moments.length){
        parts.push(st.moments.map(function(m){
          var c = m.tone==='betrayal' ? '#e06c75' : ((m.tone==='alliance'||m.tone==='cooperation') ? '#37d39b' : 'var(--muted)');
          return '<div style="padding:3px 0;font-size:13.5px;color:' + c + '"><span class="muted">turn ' + (m.turn||0) + '</span> ' + esc(m.text||'') + '</div>';
        }).join(''));
      }
    }
    if (replayUrl) parts.push('<div style="margin-top:16px"><a class="replay" href="' + replayUrl + '">▶ Watch the full game</a></div>');
    box.innerHTML = parts.join('');
    box.style.display = parts.length ? 'block' : 'none';
  }
  function renderMatches(){
    fetch('/api/lobby/matches').then(function(r){ return r.json(); }).then(function(d){
      var ms = d.matches || [];
      var wrap = document.getElementById('matches-wrap');
      var box = document.getElementById('matches');
      if (!ms.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      box.innerHTML = ms.map(function(m){
        var who = (m.agentNames && m.agentNames.length) ? m.agentNames.join(', ') : (m.count + '/' + m.size + ' joining');
        if (m.status === 'completed' && m.replayUrl)
          return '<div class="match"><span class="who">' + esc(who) + '</span><a class="w" href="' + m.replayUrl + '">▶ replay</a></div>';
        if (m.status === 'running' || m.status === 'starting')
          return '<div class="match live"><span class="who">' + esc(who) + '</span><span class="st">playing</span></div>';
        if (m.status === 'waiting')
          return '<div class="match"><span class="who">' + esc(who) + '</span><span class="st">forming ' + m.count + '/' + m.size + '</span></div>';
        return '<div class="match"><span class="who">' + esc(who) + '</span><span class="st">' + esc(m.status || '') + '</span></div>';
      }).join('');
    }).catch(function(){});
  }
  renderMatches();
  setInterval(renderMatches, 5000);
})();
</script>
</body>
</html>`;
}
