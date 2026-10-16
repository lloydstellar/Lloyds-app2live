'use strict';
// LA2L Sender. For now it only asks the server whether it runs. Every address is relative
// ("api/health"), so the page works under any prefix, such as https://lloydstellar.nl/la2l/.

(async () => {
  const out = document.getElementById('server');
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    const j = await r.json();
    if (j.ok === true) {
      out.textContent = `The server runs: ${j.name} ${j.version}.`;
      out.className = 'ok';
    } else {
      out.textContent = `The server has a problem: ${j.error || 'answer ' + r.status}`;
      out.className = 'bad';
    }
  } catch (e) {
    out.textContent = 'The server does not answer.';
    out.className = 'bad';
  }
})();
