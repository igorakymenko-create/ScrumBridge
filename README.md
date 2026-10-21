# ScrumBridge

**A team of AI roles that plans with you, and hands only the approved result to your IDE agent.**

ScrumBridge is a small local app. You describe a task in a chat, a team of LLM roles (business analyst, architect, UX, QA, security, devops, …) discusses it with you, and you, as the Product Owner, make the decisions. Your IDE agent (Claude Code, Antigravity, Cursor, VS Code Copilot, …) then receives **only what you approved**: the decisions, a technical brief, the plan and a test plan, not the whole discussion. Status, questions and blockers flow back to the chat.

> Status: an early prototype (version 0.3). It works end to end with Claude Code; see [What is verified](#what-is-verified).

## How it works

```
 you ⇄ chat (browser) ⇄ ScrumBridge (local Node app) ⇄ MCP ⇄ IDE agent
         team of LLM roles                 .ai-team/ in your project
```

1. **Discuss.** The team asks you questions with options and a recommendation, and you decide. Decisions are logged and binding.
2. **Plan.** The team produces stories with acceptance criteria, a technical brief and a Definition of Done. Specialists (UX, security, devops, …) add short, concrete instructions for the agent, which you can edit.
3. **Test plan.** QA designs numbered test cases (`TC-…`) for every acceptance criterion. You can edit, replace, remove or add cases.
4. **Check.** A plan check looks for work nobody delivers, contradictions and criteria that cannot be verified. Some checks need no model at all (for example, a plan that names a test file that already exists).
5. **Implement.** The IDE agent works through the stories with MCP tools (`get_next_story`, `update_story`, `ask_po`, …). When it is unsure it calls `ask_po`, which waits for your answer in the chat.
6. **Verify.** "Done" is refused until every automated case is reported. Optionally, you approve one test command and ScrumBridge runs it and reads the JUnit report itself, so a case is proven by a test that really passed.

## Quick start

Requires Node.js 20 or newer.

**One line, no clone** (run it in the project you want to work on; the first start compiles the app and takes a little while):

```bash
cd /path/to/your/project
npx github:igorakymenko-create/ScrumBridge
```

**Or from a clone:**

```bash
git clone https://github.com/igorakymenko-create/ScrumBridge.git
cd ScrumBridge
npm install
npm run build

# run it from the project you want to work on (state goes to <project>/.ai-team/)
cd /path/to/your/project
node /path/to/scrumbridge/dist/index.js
# or, from this folder:  npm start -- --dir /path/to/your/project
```

The terminal prints a link with an access token, for example `http://127.0.0.1:4700/?token=…`. Open that link once; the browser keeps a cookie. The port can be changed with the `PORT` environment variable.

Then:

1. **Settings → providers.** Add an API key for Google Gemini, Anthropic or an OpenAI-compatible service (or set `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). You can choose a different model per role.
2. **Session tab → Connect an IDE.** One click writes the MCP entry and short rules for the agent into your project. Restart the IDE or refresh its MCP list.
3. Describe your task in the chat, answer the team, and review the **Plan** tab.
4. **Session tab → Copy the START command**, and paste it into your IDE agent.

For an existing project, use the **Context** tab: an agent summarises the repository once, you confirm it, and it is added to the team's prompts.

## Security

- The app listens on `127.0.0.1` only and requires an access token (stored in your user config folder, not in the project). Browser requests are also checked for `Host` and `Origin`.
- API keys are kept in the operating system's credential store (a file in the user config folder with restricted permissions is the fallback), never in the browser and never in the project.
- The test command you approve is stored outside the project, out of the agent's reach.
- Each browser tab is bound to one project, so an old tab cannot overwrite another project's session. Sessions are backed up before they are replaced.
- The LLM calls go from your machine to the provider you configured. Nothing is sent anywhere else.

## What is stored where

| What | Where |
|---|---|
| Session (chat, decisions, plan, test plan) | `<project>/.ai-team/session.json` (written by the chat) |
| Progress (story status, test results, questions) | `<project>/.ai-team/progress.json` (written by the server) |
| Token, keys fallback, approved test command, settings | your user config folder (`%APPDATA%\scrumbridge` or `~/.config/scrumbridge`) |

Decide for yourself whether `.ai-team/` belongs in version control: it contains your discussion.

## What is verified

- **Claude Code (VS Code):** the full loop, including blocking `ask_po`, works. It is the only IDE with an **autopilot** (the app starts a headless `claude -p` and resumes it after your answer).
- **Antigravity:** a project-level MCP config is written. It is not verified end to end.
- **Cursor, VS Code Copilot:** config formats are written according to their documentation and are **not verified** on real installations.
- `ask_po` waits up to 10 minutes by default (configurable). An IDE that cuts long tool calls may need you to type "continue" after answering.
- The interface is complete in English and Russian; other languages fall back to English.
- Test cases in Python or other languages work in principle (a test name must contain the case ID, and the test command must write a JUnit report), but this has only been exercised with Node's built-in test runner.

## Development

```bash
npm test      # compiles, then runs the node:test suite (server, MCP, page tests in jsdom)
npm run dev   # compile and start
```

## License

Apache License 2.0, see [LICENSE](LICENSE). Copyright 2026 Igor Akymenko.
