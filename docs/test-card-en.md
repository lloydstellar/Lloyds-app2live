# LA2L 0.1.1 test card

One test in Live, about fifteen minutes. Steps 1 to 5 check the Live side of the device; step 6 checks pairing and Import through the server at `https://lloydstellar.nl/la2l/`.

**You need:** Live 12.4 or newer with Max for Live, on Windows or a Mac.

**New in 0.1.1**, so check these first:

- The tempo of a loop is now right when the Set has another tempo. In 0.1.0 a 135 BPM loop in a Set at 120 BPM came out at 150.15 BPM.
- In Session View the new scene goes to the top instead of the bottom.
- Self test says "no App2Live server at lloydstellar.nl" instead of "server answered 200" when something other than an App2Live server answers.

## 1. Load the device

1. Quit Live and start it again. Live keeps devices in memory, so an older copy could still be used.
2. Open a new, empty Live Set.
3. Drag `devices/la2l/Lloyds App2Live.amxd` onto the first audio track. Leave the other files of `devices/la2l` next to it.

**You should see:** the Lloyd Stellar logo top left, "Lloyd's App2Live" and "v0.1.1", a Settings button on the right, the text "Send sounds from your apps to Live." with a Pair app button, and "Ready." at the bottom.

## 2. Test import in the Arrangement

1. Set the Set tempo to **120**. The test file is 135 BPM, so this is the case that went wrong in 0.1.0.
2. Make sure the playhead is somewhere in the Arrangement, for example at bar 3.
3. Click **Settings**, then **Test import**. The test file is 95 MB, so the download takes a moment.

**You should see:**

- The status line: "Downloading the test file...", then "Test: placing 1 sound in Live...", then **"Test done. Snare (LA2L) is in Live at 135 BPM."**
- If it says "but not at exactly 135 BPM" instead, Live did not take the tempo. Send the log; it has Live's warp markers.
- If it adds "The test file did not download so the built-in loop was used.", the device could not get the WAV from lloydstellar.nl. The rest of the test still counts; the log says why.
- A new audio track **right after** the track with the device, named **Snare (LA2L)**, with a colour.
- In the Arrangement, one clip on that track starting at the bar nearest the playhead.
- Click the clip and look at its Clip View: **Warp** on, mode **Beats**, **Seg. BPM 135.00**, **Start 1.1.1**, **Loop** on over the whole file.
- Play with the metronome on: the snare is in time at 120. Set the tempo to 100 and to 135: it stays in time.

If Start shows a position before 1.1.1 but Seg. BPM is 135.00, LA2L used its second way to set the tempo. That is fine: the clip still plays from the start of the file and stays in time. The log then says `exact (first marker)`.

## 3. Test import in Session View

1. In Settings, set **New sounds go to** to **Session**.
2. Click **Test import** again.

**You should see:** a new scene **at the top** of the Session named **Test import (LA2L)**. The scenes that were there move down one row. In that scene, one clip on a new track Snare (LA2L), with the same warp settings as in step 2. Launch the scene: the snare plays in time.

## 4. A saved Set

1. Save the Set (File > Save Live Set As...) to a new folder.
2. Click **Test import** once more.

**You should see:** the WAV file in the project folder of that Set, under `Samples/LA2L/<date> <time> Test import/`. Before saving, files go to `Documents/Lloyds App2Live/Inbox` instead.

## 5. Self test

Click **Self test**.

**You should see** a line like "Self test: Node v22... / folder OK / Live 12.4.x OK / server OK / not paired". When this computer is paired, it ends with "paired with 0 waiting": the number of packages that wait on the server.

## 6. Pairing and Import

You need a browser, on this computer or on a phone, and the test file saved from `http://lloydstellar.nl/test/test-file-voor-max.wav`.

1. Click **Pair app**. The device shows a code of six characters.
2. Open `https://lloydstellar.nl/la2l/`, type the code and click **Pair**.
3. Under **Send sounds**, set BPM to **135** and choose the test file. In its row, set Name to **Snare**, leave Type on **Loop** and set Role to **drums**. Click **Send**.
4. Click **Import** in the device.
5. Click **Settings**, then **Unpair**, twice.

**You should see:**

- After step 2: the device says "Paired with LA2L Sender. Send a sound from it and click Import." and the page says "Paired with" and the name of this computer.
- After step 3: the page says "Waiting for Import in Live."
- After step 4: a new track **Snare (LA2L Sender)** with Warp on and **Seg. BPM 135.00** in its Clip View. The page says "In Live: 1 of 1 sound."
- After step 5: the device says "Unpaired. Apps can no longer send sounds to this computer." When you reload the page, it asks for a code again.

## 7. Send back

1. Click **Open folder**. It opens `Documents/Lloyds App2Live`.
2. Send `la2l.log`, plus a screenshot of the device and one of the Clip View of the new clip from step 2.

The log shows how Live answered every step: which path form loaded the file, the warp markers Live made and the ones LA2L left, and whether the tempo is exact. Send it also when everything looks fine; it settles the open questions in [design-notes.md](design-notes.md#proven-and-not-yet-proven-in-a-real-live).

## If something does not work

| What you see | What it means |
|---|---|
| The device stays on "Starting LA2L..." | Node did not start. Click Edit on the device title bar, then Window > Max Console in Max, and send what is in red. |
| "The Live part of LA2L does not answer. LA2L needs Live 12.4 or newer." | The v8 script did not load or Live is too old. Check that `la2l-live.js` sits next to the `.amxd`, and send the Max Console. |
| No logo | `la2l-logo.png` is not next to the `.amxd`. |
| The device still shows v0.1.0 | Live still has the old device in memory. Quit Live completely and start it again. |
| "Test failed. Snare ..." | Live could not place the file. The rest of the message and the log say why. |
