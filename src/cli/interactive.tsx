// Copyright 2026 Tauric Research
// SPDX-License-Identifier: Apache-2.0
// Changed in this fork of TradingAgents 1.0.0.
/**
 * The chat on this terminal, wired to the process: what `/status` and the header show, the input
 * history, `/new` and `/resume` over the session host, `/login` and `/model`, and the app drawn.
 */
import chalk from "chalk";
import { render } from "ink";
import { addToHistory, loadHistory, loadSettings, type Paths } from "../config/index.js";
import { errorText, type ModelRoute, message, type RouteName, VERSION } from "../contracts/index.js";
import {
  BUILT_IN,
  type Catalog,
  deleteSession,
  type EngineBuilder,
  listSessions,
  modelReplayKey,
  routeOf,
  Session,
} from "../engine/index.js";
import { NOTES } from "../fork/changelog.js";
import { ChatApp, type ChatControls, type ChatSessions, type InputHistory } from "./ChatApp.js";
import type { SessionInfo } from "./commands.js";
import type { SessionHost } from "./session-host.js";
import { setupActions, setupFacts } from "./setup/setup-actions.js";
import { switchingActions } from "./setup/switching.js";
import { themeFrom } from "./theme.js";
import { ThemeContext } from "./theme-context.js";
import { welcomeNews } from "./whats-new.js";

/** What a session runs with: its model, its context window and its engine. */
export type RunsOn = {
  model: ModelRoute;
  context: { window: number; input?: number; output?: number; notice?: string };
  build: EngineBuilder;
};

/** What the chat is opened with. */
type ChatWiring = {
  host: SessionHost;
  paths: Paths;
  /** What the first session runs with. */
  runsOn: RunsOn;
  catalog: Catalog | undefined;
  /** The limits given on the command line, read again with the settings for `/login` and `/model`. */
  limits: Record<string, unknown>;
  signedIn(): Promise<boolean>;
  /** Every key found; one stored during the session joins it. */
  liveKeys: string[];
  /** What a session started (no id) or resumed (`id`) in the chat runs with. */
  chooseFor(id?: string): Promise<RunsOn>;
  /** What the open session runs with once switched to `route` (/model, a key saved); refused when it cannot be used. */
  chooseRoute(route: RouteName): Promise<RunsOn>;
  report(problem: string): void;
  controls: ChatControls;
  /** Notices for the first screen; `early` is read as the app is drawn, so problems found until then join. */
  notices: readonly string[];
  early: readonly string[];
  resumed: boolean;
  /** A newer release, said when there is nothing new in this version to tell. */
  updateNotice: string | undefined;
};

/** The chat, drawn; `exited` resolves once it has gone and a turn it left running has stopped. */
type OpenChat = { exited: Promise<unknown>; kept(): Promise<unknown> };

/** Open the chat on this terminal. `kept` resolves once every question added to the history is written. */
export async function openChat(wiring: ChatWiring): Promise<OpenChat> {
  const { host, paths, controls, report } = wiring;
  const session = host.current;
  const info = sessionInfo(session, wiring.runsOn, wiring.catalog);
  const theme = themeFrom(process.env);
  const { history, kept } = await inputHistory(paths, report);
  // No colour means none anywhere: Ink and the Markdown renderer share this chalk.
  if (theme.colours === "none") chalk.level = 0;
  // The model the session open now runs on: /new and /resume may move it.
  let runsOnNow: ModelRoute = wiring.runsOn.model;
  const sessions = chatSessions(wiring, (next) => {
    runsOnNow = next.model;
  });
  // One slot under the header: what's new in this version (once), else a newer release.
  const news = await welcomeNews({
    resumed: wiring.resumed,
    updateNotice: wiring.updateNotice,
    version: VERSION,
    statePath: paths.state,
    notes: NOTES,
  });
  // The welcome starts at the top: the visible screen is erased (ED 2) and the cursor homed (CUP). The
  // scrollback is left as it is.
  process.stdout.write("\u001b[2J\u001b[H");
  const app = render(
    <ThemeContext.Provider value={theme}>
      <ChatApp
        news={news}
        engine={host}
        sessions={sessions}
        notices={[...wiring.notices, ...wiring.early]}
        earlier={session.replay}
        controls={controls}
        info={info}
        history={history}
        setup={{
          // Read again each time: a key or model saved earlier in the session counts.
          facts: async () =>
            setupFacts(
              await loadSettings(process.env, { limits: wiring.limits, paths }),
              await wiring.signedIn(),
              {
                provider: runsOnNow.provider,
                model: runsOnNow.model,
                ...("reasoning" in runsOnNow && runsOnNow.reasoning
                  ? { reasoning: runsOnNow.reasoning }
                  : {}),
              },
            ),
          actions: (say, shown) =>
            switchingActions(setupActions({ paths, say, added: (key) => wiring.liveKeys.push(key) }), {
              choose: wiring.chooseRoute,
              current: () => runsOnNow,
              endpointOf: (next) => ("baseURL" in next.model ? next.model.baseURL : undefined),
              async apply(next) {
                host.current.switchTo({
                  build: next.build,
                  route: routeOf(next.model),
                  replayKey: modelReplayKey(next.model),
                });
                runsOnNow = next.model;
                shown(sessionInfo(host.current, next, wiring.catalog));
              },
            }),
        }}
      />
    </ThemeContext.Provider>,
    // Only the rows that changed are redrawn as an answer streams.
    // Shift+Enter is told apart from Enter where the terminal speaks the kitty keyboard protocol.
    {
      // Only ever at a terminal: drawn as it changes, also where CI is set.
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
      kittyKeyboard: { mode: "auto" },
    },
  );
  return { exited: app.waitUntilExit().then(() => controls.settled), kept };
}

/** The session as `/status` and the header describe it. */
function sessionInfo(
  session: Session,
  { model, context }: RunsOn,
  catalog: Catalog | undefined,
): SessionInfo {
  return {
    version: VERSION,
    model: model.model,
    provider: model.provider,
    contextWindow: context.window,
    session: session.id,
    data: message("app.dataYahoo"),
    ...(catalog
      ? (() => {
          // Whether each is offered depends on the data this session's sources serve.
          const offered = session.engine.offered();
          const item =
            (names: string[]) =>
            ({ name, description, source }: { name: string; description: string; source: string }) => ({
              name,
              description,
              source,
              builtIn: source === BUILT_IN,
              available: names.includes(name),
            });
          return {
            agents: catalog.agents.map(item(offered.agents)),
            skills: catalog.skills.map(item(offered.skills)),
          };
        })()
      : {}),
  };
}

/**
 * Earlier questions for Up/Down and Ctrl+R, kept one at a time in order; a list that cannot be kept is
 * said once.
 */
async function inputHistory(
  paths: Paths,
  report: (problem: string) => void,
): Promise<{ history: InputHistory; kept(): Promise<unknown> }> {
  let warned = false;
  let keeping: Promise<unknown> = Promise.resolve();
  const history: InputHistory = {
    entries: await loadHistory(paths),
    add(question) {
      keeping = keeping
        .then(() => addToHistory(question, paths))
        .catch((error: unknown) => {
          if (warned) return;
          warned = true;
          report(message("app.historyUnsaved", { reason: errorText(error) }));
        });
    },
  };
  return { history, kept: () => keeping };
}

/** `/new` and `/resume` over the session host; `moved` is told what each switched-to session runs on. */
function chatSessions(
  { host, paths, chooseFor, report }: ChatWiring,
  moved: (next: RunsOn) => void,
): ChatSessions {
  return {
    list: () => listSessions(paths.home, { limit: 50 }),
    current: () => host.current.id,
    delete: (id) => deleteSession(paths.home, id),
    startNew: async () => {
      const next = await chooseFor();
      const started = await host.replaceWith(() => Session.start(paths.home, next.build, report));
      moved(next);
      return {
        id: started.id,
        model: next.model.model,
        provider: next.model.provider,
        contextWindow: next.context.window,
      };
    },
    open: async (id) => {
      const next = await chooseFor(id);
      const opened = await host.replaceWith(() =>
        Session.resume(paths.home, id, modelReplayKey(next.model), next.build, report),
      );
      moved(next);
      return {
        id: opened.id,
        earlier: opened.replay,
        model: next.model.model,
        provider: next.model.provider,
        contextWindow: next.context.window,
      };
    },
  };
}
