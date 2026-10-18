# AI tools

An AI coding tool can build a Send to Live feature from these pages. The helpers below put the same few things in front of it: install `@lloydstellar/la2l`, pair with a code field, render WAV, give every sound `kind`, `role` and `bpm`, and test with the test receiver.

## The skill

`la2l-send-to-ableton` is an Agent Skill: the steps, the pitfalls, the API, and examples that are tested against the SDK.

| Tool | How |
|---|---|
| Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI | `npx skills add lloydstellar/Lloyds-app2live` |
| Claude Code, as a plugin | `/plugin marketplace add lloydstellar/Lloyds-app2live`, then `/plugin install la2l@la2l` |
| Lovable, Bolt, Replit | Import the skill from GitHub: `https://github.com/lloydstellar/Lloyds-app2live/tree/main/skills/la2l-send-to-ableton` |
| claude.ai | Upload a ZIP of that folder as a skill of your own. |

Agents leave a skill unused more often than you would think. Name it in your prompt: "Add a Send to Live button with LA2L. Use the la2l-send-to-ableton skill."

## A docs index in AGENTS.md

```bash
npm install @lloydstellar/la2l
npx @lloydstellar/la2l agents-md
```

This writes an index of the docs in `node_modules/@lloydstellar/la2l/docs` into `AGENTS.md`, and into `CLAUDE.md` when the project has one, with the rules that matter most. Agents read `AGENTS.md` at every task, so they find the docs of the version you installed instead of guessing. A new run, after an update of `@lloydstellar/la2l`, replaces the index.

## Lovable, Bolt and other builders without a terminal

Paste [the paste text](paste-text.md) into the knowledge of the project: in Lovable under Knowledge, in Bolt in the project's knowledge or system prompt. It works on its own: installing, the button, rendering a loop, the pitfalls, and where the docs are. Copy it from [its Markdown version](https://lloydstellar.nl/la2l/developers/paste-text.md) to keep the formatting.

## llms.txt

[llms.txt](../llms.txt) lists these pages for language models, and [llms-full.txt](../llms-full.txt) holds them all in one file. Every page is there as Markdown too: add `.md` to its address (the start page is `index.md`).

## Check what the tool built

Open [the test receiver](../receiver) in a second tab, pair the app with the code it shows, and send. The report says per sound what Live would do. A loop must show up as a loop at the tempo of the app, such as "Loop, warped in Beats mode at 120 BPM, 4 beats". When it says "One-shot", the app forgot `kind: 'loop'`. An agent that can run commands can test its own work: `npx @lloydstellar/la2l test-receiver --local` ([Testing](testing.md)).
