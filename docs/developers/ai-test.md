# The AI test

Do AI coding tools build a working Send to Live feature with the helpers of LA2L? Measured before the launch (sdk/BUILD-PROMPT.md, section 10.3), and again after a change to the skill, the paste text or the docs. This file is not one of the developer pages: it is the record.

## The task

Each tool builds five times, each time in an empty project, with the skill (Claude Code, Cursor) or the paste text (Lovable) and nothing else, for this prompt:

> Build a small web drum machine with four sounds and a 16-step pattern. Add a Send to Live button that sends the loop to Ableton Live with LA2L.

## The check

A run passes when its package gets through the test receiver as a loop with a tempo.

1. Open https://lloydstellar.nl/la2l/receiver in a private window. It shows a code.
2. Open the app the tool built, make a pattern, click Send to Live, and type the code.
3. The receiver shows a report. The loop must say "Loop, warped in ... mode at N BPM", with N the tempo of the app. A one-shot, "Live guesses the tempo", an error, or no package at all: the run fails.

When a run fails, write down what went wrong, and improve the skill, the paste text or the docs. Never the test.

## How each tool runs it

- **Claude Code**: an empty folder with the skill (`npx skills add lloydstellar/Lloyds-app2live`), then `claude -p` with the prompt. Claude may run these itself when Erik agrees.
- **Cursor**: a new empty project with the skill, the prompt in Agent mode. Erik runs it.
- **Lovable**: a new project, the paste text under Knowledge, the prompt as the first message. Erik runs it.

The runs need `@lloydstellar/la2l` on npm and the repository public (for `npx skills add` and the imports of Lovable). Until then they cannot start.

## Results

The phase passes when at least four of the five runs pass for each tool.

| Date | Tool and version | Run | Passed | What went wrong |
|---|---|---|---|---|
| 2026-10-18 | Claude Code 2.1.292 (claude-opus-5-5) | 1 | Yes | Nothing that fails the check. The track names carry the app twice, "Kick (Web808) (Web808)": the run named its sounds "Kick (Web808)", as the `name` row of SKILL.md shows, and LA2L adds the app's name again. It also took the example's app name, Web808. |
| 2026-10-18 | Claude Code 2.1.292 (claude-opus-5-5) | 2 | Yes | The same as run 1. |
| 2026-10-18 | Claude Code 2.1.292 (claude-opus-5-5) | 3 | Yes | The same as run 1. |
| 2026-10-18 | Claude Code 2.1.292 (claude-opus-5-5) | 4 | Yes | Nothing. Its app is called "Web Drums". |
| 2026-10-18 | Claude Code 2.1.292 (claude-opus-5-5) | 5 | Yes | Nothing. Its app is called "Web Drums". |

Claude Code on 2026-10-18: five of five passed. Each run started in an empty folder with `npx skills add lloydstellar/Lloyds-app2live --skill la2l-send-to-ableton --agent claude-code --copy -y` (the flags make it run without questions), then `claude -p` with the prompt, without the user's settings, memory or MCP servers (`--setting-sources project --strict-mcp-config`). Edits were allowed, Bash only for npm, npx, node, ls, mkdir, cat and cd. Each run took 90 to 145 seconds and built one `index.html` with the button from jsDelivr, its integrity hash and `wavFromAudioBuffer`: one loop of 4 beats per row. None could open a browser there, so each checked its script with Node; runs 4 and 5 also sent through `startTestReceiver()`, none asked the live server for a code. The check ran in headless Chromium against the live test receiver: clear the pattern where the app has a Clear button, click steps in all four rows, Send to Live, type the code. Every run arrived as loops in Beats mode at 120 BPM, and again at 97 BPM after the app's tempo was changed (an extra check, outside the protocol).
