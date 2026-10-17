# LA2L 0.2.1 test card

One test in Live, about twenty minutes. Steps 1 to 5 check the Live side of the device; steps 6 and 7 check pairing and Import through the server at `https://lloydstellar.nl/la2l/`. Version 0.2.0 passed all steps on Windows on 2026-10-17, so on that computer steps 1, 6 and 7 are enough for 0.2.1. On a Mac, do them all.

**You need:** Live 12.4 or newer with Max for Live, on Windows or a Mac. For step 7 the server must be version 0.6.0 or newer: `https://lloydstellar.nl/la2l/api/health` shows the version.

**New in 0.2.1**, so check these first:

- When no app is paired any more, the device shows **Pair app** again instead of Import, as when it is not paired. This computer keeps its pairing on the server, so Pair app then adds an app to it, as Add app does. In 0.2.0 the device kept the Import button and said "No app paired. Add one in Settings."
- While a code shows, **Copy code** puts it on the clipboard, so you can paste it in an app on this computer, such as LA2L Sender in a browser.

**New in 0.2.0:**

- In the Arrangement, new sounds always start at **1.1.1**, wherever the playhead is. In 0.1.1 they started at the playhead, which after playing could be minutes into the Set.
- "Paired with ..." shows only the apps that are still paired. An app that unpaired itself drops out when Live starts, after an Import and at Self test.
- Self test says how many apps are paired: "paired with 1 app / 0 waiting".
- When a download fails, the status line also shows the server's reason, for example "The file is gone. Send it again."

## 1. Load the device

1. Quit Live and start it again. Live keeps devices in memory, so an older copy could still be used.
2. Open a new, empty Live Set.
3. Drag `devices/la2l/Lloyds App2Live.amxd` onto the first audio track. Leave the other files of `devices/la2l` next to it.

**You should see:** the Lloyd Stellar logo top left, "Lloyd's App2Live" and "v0.2.1", a Settings button on the right, the text "Send sounds from your apps to Live." with a Pair app button, and "Ready." at the bottom. If this computer is still paired from an earlier test, you see the Import button instead; that is fine.

## 2. Test import in the Arrangement

1. Set the Set tempo to **120**. The test file is 135 BPM, so the device has to set the tempo of the clip.
2. Click in the Arrangement at **bar 9**, so the playhead is there. You can also play the Set for a while and stop.
3. Click **Settings**, then **Test import**. The test file is 95 MB, so the download takes a moment.

**You should see:**

- The status line: "Downloading the test file...", then "Test: placing 1 sound in Live...", then **"Test done. Snare (LA2L) is in Live at 135 BPM."**
- If it says "but not at exactly 135 BPM" instead, Live did not take the tempo. Send the log; it has Live's warp markers.
- If it adds "The test file did not download so the built-in loop was used.", the device could not get the WAV from lloydstellar.nl. The rest of the test still counts; the log says why.
- A new audio track **right after** the track with the device, named **Snare (LA2L)**, with a colour.
- In the Arrangement, one clip on that track starting at **1.1.1**, not at bar 9.
- Click the clip and look at its Clip View: **Warp** on, mode **Beats**, **Seg. BPM 135.00**, **Start 1.1.1**, **Loop** on over the whole file.
- Play with the metronome on: the snare is in time at 120. Set the tempo to 100 and to 135: it stays in time.

If Start shows a position before 1.1.1 but Seg. BPM is 135.00, LA2L used its second way to set the tempo. That is fine: the clip still plays from the start of the file and stays in time. The log then says `exact (first marker)`.

## 3. Test import in Session View

1. In Settings, set **New sounds go to** to **Session**.
2. Click **Test import** again.
3. Set **New sounds go to** back to **Arrangement**.

**You should see:** a new scene **at the top** of the Session named **Test import (LA2L)**. The scenes that were there move down one row. In that scene, one clip on a new track Snare (LA2L), with the same warp settings as in step 2. Launch the scene: the snare plays in time.

## 4. A saved Set

1. Save the Set (File > Save Live Set As...) to a new folder.
2. Click **Test import** once more.

**You should see:** the WAV file in the project folder of that Set, under `Samples/LA2L/<date> <time> Test import/`. Before saving, files go to `Documents/Lloyds App2Live/Inbox` instead.

## 5. Self test

Click **Self test**.

**You should see** a line like "Self test: Node v22... / folder OK / Live 12.4.x OK / server OK / not paired". When this computer is paired, it ends with "paired with 1 app / 0 waiting": how many apps can send to this computer, and how many packages wait on the server.

## 6. Pairing and Import

You need a browser, on this computer or on a phone, and the test file saved from `http://lloydstellar.nl/test/test-file-voor-max.wav`. If the device still shows Import from an earlier test, click **Settings**, then **Unpair** twice first.

1. Put the playhead at bar 9 again.
2. Click **Pair app**. The device shows a code of six characters.
3. Click **Copy code**. Open `https://lloydstellar.nl/la2l/`, paste the code (Ctrl+V on Windows, Cmd+V on a Mac) and click **Pair**. On a phone, type the code instead.
4. Under **Send sounds**, set BPM to **135** and choose the test file. In its row, set Name to **Snare**, leave Type on **Loop** and set Role to **drums**. Click **Send**.
5. Click **Import** in the device.
6. Click **Settings**, then **Self test**.

**You should see:**

- After step 3: Copy code makes the status line say "Code copied. Paste it in your app." After Pair, the device says "Paired with LA2L Sender. Send a sound from it and click Import." and the page says "Paired with" and the name of this computer.
- After step 4: the page says "Waiting for Import in Live."
- After step 5: a new track **Snare (LA2L Sender)** with a clip at **1.1.1**, Warp on and **Seg. BPM 135.00** in its Clip View. The page says "In Live: 1 of 1 sound."
- After step 6: the Self test line ends with "server OK / paired with 1 app / 0 waiting". If it ends with "server OK / paired / 0 waiting", the server is older than 0.6.0: update it before step 7.

## 7. An app that unpairs itself

This step needs server 0.6.0 or newer. Open `https://lloydstellar.nl/la2l/api/health` first: it must show `"version":"0.6.0"` or higher.

1. On the page, click **Unpair this browser**.
2. In the device, click **Self test** (Settings is still open), then **Close**.
3. Click **Pair app**, then **Copy code**. Paste the code on the page and click **Pair**.
4. Click **Settings**, then **Unpair**, twice.

**You should see:**

- After step 2: the Self test line ends with "no app paired / 0 waiting". After Close the device shows **Pair app** again instead of Import. If the Self test line ends with "paired / 0 waiting" and Import is still there, the server is older than 0.6.0: the rest of the device still works, but it cannot see that the app left.
- After step 3: "Paired with LA2L Sender." and the Import button again.
- After step 4: the device says "Unpaired. Apps can no longer send sounds to this computer." When you reload the page, it asks for a code again.

## 8. Send back

1. Click **Open folder**. It opens `Documents/Lloyds App2Live`.
2. Send `la2l.log`, plus a screenshot of the device and one of the Arrangement with the clips from steps 2 and 6.

The log shows how Live answered every step: which path form loaded the file, the warp markers Live made and the ones LA2L left, whether the tempo is exact, and which apps the server listed. Send it also when everything looks fine; it settles the open questions in [design-notes.md](design-notes.md#proven-and-not-yet-proven-in-a-real-live).

## If something does not work

| What you see | What it means |
|---|---|
| The device stays on "Starting LA2L..." | Node did not start. Click Edit on the device title bar, then Window > Max Console in Max, and send what is in red. |
| "The Live part of LA2L does not answer. LA2L needs Live 12.4 or newer." | The v8 script did not load or Live is too old. Check that `la2l-live.js` sits next to the `.amxd`, and send the Max Console. |
| No logo | `la2l-logo.png` is not next to the `.amxd`. |
| The device still shows an older version | Live still has the old device in memory. Quit Live completely and start it again. |
| "Test failed. Snare ..." | Live could not place the file. The rest of the message and the log say why. |
| The clip still starts at bar 9 | A device older than 0.2.0 is still loaded: check the version under the name. |
| "Could not copy the code. Type it in your app." | The log says why, on a line that starts with `Copy code:`. Type the code and send the log. |
