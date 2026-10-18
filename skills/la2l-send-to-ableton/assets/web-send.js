// A complete send from a web app, with the @lloydstellar/la2l package: pair once, then send a rendered loop
// and a one-shot, and follow them into Live. Adapt the names, the sounds and the elements.
import { LA2L, La2lError, wavFromAudioBuffer, wavFromSamples } from '@lloydstellar/la2l';

const la2l = new LA2L({ appName: 'My app' }); // Live shows "Paired with My app"

// Call this from the click handler of the code field.
export async function pairWith(code) {
  try {
    const { deviceName } = await la2l.pair(code);
    return `Paired with ${deviceName}.`;
  } catch (e) {
    return e instanceof La2lError ? e.message : String(e);
  }
}

// loopBuffer: an AudioBuffer of exactly one bar at `bpm`; hit: mono samples at 48 kHz.
export async function sendToLive({ loopBuffer, hit, bpm, onStatus }) {
  if (!la2l.paired) return onStatus('Pair first: in Live, click Pair app in LA2L and type the code it shows.');
  try {
    const delivery = await la2l.send({
      title: `Beat at ${bpm} BPM`,
      bpm,
      sounds: [
        { name: 'Beat', audio: wavFromAudioBuffer(loopBuffer), kind: 'loop', role: 'drums', lengthBeats: 4 },
        { name: 'Hit', audio: wavFromSamples(hit, 48000), kind: 'oneshot', role: 'fx' },
      ],
      onProgress: (share) => onStatus(`Sending… ${Math.round(share * 100)}%`),
    });
    onStatus('Waiting for Import in Live');
    const result = await delivery.imported();
    onStatus(result.status === 'imported' ? 'In Live' : 'In Live, partly');
  } catch (e) {
    if (e instanceof La2lError && e.code === 'not_paired') return onStatus('Pair again: the code field is back.');
    onStatus(e instanceof La2lError ? e.message : String(e));
  }
}
