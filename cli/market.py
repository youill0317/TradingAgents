"""The ``tradingagents market`` command: the market workflow, run the way ``cli.run`` runs a ticker.

The same steps and flags: a date (today or earlier), the report language,
the analysts, the research depth (debate and risk rounds), the provider and
models; a live view while it streams; the decision recorded in the memory log;
then the report saved and shown.
"""

import datetime
import os
import sys
import time
from collections import deque
from pathlib import Path

import questionary
import typer
from rich import box
from rich.align import Align
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.rule import Rule
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from cli.display import (
    classify_message_type,
    console,
    create_layout,
    format_tokens,
    format_tool_args,
)
from cli.prefs import load_last_run
from cli.prompts import (
    ask_anthropic_effort,
    ask_gemini_thinking_config,
    ask_glm_region,
    ask_minimax_region,
    ask_openai_reasoning_effort,
    ask_output_language,
    ask_qwen_region,
    confirm_ollama_endpoint,
    parse_analysis_date,
    prompt_openai_compatible_url,
    resolve_backend_url,
    select_deep_thinking_agent,
    select_llm_provider,
    select_research_depth,
    select_shallow_thinking_agent,
)
from cli.run import _open_page, _yes
from cli.selections import _check_tier_providers, depth_from_env
from cli.stats_handler import StatsCallbackHandler
from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.llm_clients.factory import REASONING_EFFORT_PROVIDERS
from tradingagents.market.analysts import ANALYST_SPECS
from tradingagents.market.graph import ASSET_TYPE, SUBJECT, MarketAnalysisGraph, market_call

WORKFLOW_STEPS = ("I. Analyst Team → II. Research Team → III. Sector Strategist → "
                  "IV. Risk Management → V. Chief Market Strategist")

FIXED_TEAMS = {
    "Research Team": ["Market Bull Researcher", "Market Bear Researcher", "Market Research Manager"],
    "Strategy": ["Sector Strategist"],
    "Risk Management": ["Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"],
    "Final Call": ["Chief Market Strategist"],
}


# ---------------------------------------------------------------------------
# Selections
# ---------------------------------------------------------------------------


def parse_market_analysts(value: str) -> list[str]:
    keys = [k.strip().lower() for k in value.split(",") if k.strip()]
    unknown = [k for k in keys if k not in ANALYST_SPECS]
    if unknown or not keys:
        raise ValueError(f"unknown market analyst(s) {unknown or value!r}; choose from {', '.join(ANALYST_SPECS)}")
    return [k for k in ANALYST_SPECS if k in keys]


def _from_flag(parse, value):
    try:
        return parse(value)
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from None


def unattended_gaps(flags) -> list[str]:
    """The flags and environment variables a run with no terminal still needs."""
    env = os.environ.get
    gaps = [f"--{name}" for name in ("date", "analysts") if flags.get(name) is None]
    gaps += [f"--{name} or --no-{name}" for name in ("save", "show") if flags.get(name) is None]
    if not env("TRADINGAGENTS_OUTPUT_LANGUAGE"):
        gaps.append("TRADINGAGENTS_OUTPUT_LANGUAGE")
    if not depth_from_env():
        gaps.append("TRADINGAGENTS_MAX_DEBATE_ROUNDS and TRADINGAGENTS_MAX_RISK_ROUNDS")
    if not env("TRADINGAGENTS_LLM_PROVIDER"):
        gaps.append("TRADINGAGENTS_LLM_PROVIDER")
    if not (env("TRADINGAGENTS_QUICK_THINK_LLM") or env("TRADINGAGENTS_DEEP_THINK_LLM")):
        gaps.append("TRADINGAGENTS_QUICK_THINK_LLM or TRADINGAGENTS_DEEP_THINK_LLM")
    return gaps


def _box(title, prompt, default=None):
    content = f"[bold]{title}[/bold]\n[dim]{prompt}[/dim]"
    if default:
        content += f"\n[dim]Default: {default}[/dim]"
    return Panel(content, border_style="blue", padding=(1, 2))


def _env_or_prompt(env_var, config_key, label, title, body, prompt_fn):
    if os.environ.get(env_var):
        value = DEFAULT_CONFIG[config_key]
        console.print(f"[green]✓ {label} from environment:[/green] {value}")
        return value
    console.print(_box(title, body))
    return prompt_fn()


def _show_welcome():
    with open(Path(__file__).parent / "static" / "welcome.txt", encoding="utf-8") as f:
        welcome_ascii = f.read()
    console.print(Align.center(Panel(
        f"{welcome_ascii}\n[bold green]TradingAgents: Multi-Agents LLM Financial Trading Framework - CLI"
        f"[/bold green]\n\n[bold]Market Analysis Steps:[/bold]\n{WORKFLOW_STEPS}\n\n"
        "[dim]Built by [Tauric Research](https://github.com/TauricResearch)[/dim]",
        border_style="green", padding=(1, 2), title="Welcome to TradingAgents",
        subtitle="Multi-Agents LLM Financial Trading Framework",
    )))
    console.print()


def get_market_selections(flags) -> dict:
    """The run's settings, step by step; a flag or ``TRADINGAGENTS_*`` variable skips its step."""
    prefs = load_last_run()
    _show_welcome()

    if flags.get("date") is not None:
        analysis_date = _from_flag(parse_analysis_date, flags["date"])
        console.print(f"[green]✓ Analysis date from --date:[/green] {analysis_date}")
    else:
        today = datetime.date.today().isoformat()
        console.print(_box("Step 1: Analysis Date", "Enter the analysis date (YYYY-MM-DD)", today))
        while True:
            try:
                analysis_date = parse_analysis_date(typer.prompt("", default=today))
                break
            except ValueError as exc:
                console.print(f"[red]Error: {exc}[/red]")

    if os.environ.get("TRADINGAGENTS_OUTPUT_LANGUAGE"):
        output_language = DEFAULT_CONFIG["output_language"]
        console.print(f"[green]✓ Output language from environment:[/green] {output_language}")
    else:
        console.print(_box("Step 2: Output Language", "Select the language for the reports and final call"))
        output_language = ask_output_language(prefs.get("output_language"))

    if flags.get("analysts") is not None:
        analysts = _from_flag(parse_market_analysts, flags["analysts"])
    else:
        console.print(_box("Step 3: Analysts Team", "Select your market analysts"))
        analysts = questionary.checkbox(
            "Select Your [Market Analysts]:",
            choices=[questionary.Choice(spec.agent_node, value=key, checked=True)
                     for key, spec in ANALYST_SPECS.items()],
            validate=lambda x: len(x) > 0 or "You must select at least one analyst.",
        ).ask()
        if not analysts:
            console.print("\n[red]No analysts selected. Exiting...[/red]")
            raise typer.Exit(code=1)
    console.print(f"[green]Selected analysts:[/green] {', '.join(analysts)}")

    if depth_from_env():
        research_depth = DEFAULT_CONFIG["max_debate_rounds"]
        console.print(f"[green]✓ Research depth from environment:[/green] "
                      f"{DEFAULT_CONFIG['max_debate_rounds']} debate / "
                      f"{DEFAULT_CONFIG['max_risk_discuss_rounds']} risk rounds")
    else:
        console.print(_box("Step 4: Research Depth", "Select your research depth level"))
        research_depth = select_research_depth(prefs.get("research_depth"))

    provider_from_env = bool(os.environ.get("TRADINGAGENTS_LLM_PROVIDER"))
    if provider_from_env:
        provider = DEFAULT_CONFIG["llm_provider"].lower()
        backend_url = resolve_backend_url(provider, env_url=DEFAULT_CONFIG["backend_url"])
        console.print(f"[green]✓ LLM provider from environment:[/green] {provider}")
        console.print(f"[green]✓ Backend URL:[/green] {backend_url}")
    else:
        console.print(_box("Step 5: LLM Provider", "Select your LLM provider"))
        provider, backend_url = select_llm_provider(prefs.get("llm_provider"))
        if provider == "qwen":
            provider, backend_url = ask_qwen_region()
        elif provider == "minimax":
            provider, backend_url = ask_minimax_region()
        elif provider == "glm":
            provider, backend_url = ask_glm_region()
        backend_url = resolve_backend_url(provider, backend_url, env_url=DEFAULT_CONFIG["backend_url"])
        if provider == "openai_compatible" and not backend_url:
            remembered = prefs.get("backend_url") if prefs.get("llm_provider") == provider else None
            backend_url = prompt_openai_compatible_url(remembered)
        if provider == "ollama":
            confirm_ollama_endpoint(backend_url)
    _check_tier_providers(provider, backend_url)

    if os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM") or os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM"):
        quick, deep = DEFAULT_CONFIG["quick_think_llm"], DEFAULT_CONFIG["deep_think_llm"]
        console.print(f"[green]✓ Thinking agents from environment:[/green] quick={quick}, deep={deep}")
    else:
        console.print(_box("Step 6: Thinking Agents", "Select your thinking agents for analysis"))
        remembered = prefs if prefs.get("llm_provider") == provider else {}
        quick = select_shallow_thinking_agent(provider, remembered.get("quick_think_llm"))
        deep = select_deep_thinking_agent(provider, remembered.get("deep_think_llm"))

    thinking_level = reasoning_effort = anthropic_effort = None
    lower = provider.lower()
    if provider_from_env:
        thinking_level = DEFAULT_CONFIG["google_thinking_level"]
        reasoning_effort = DEFAULT_CONFIG["openai_reasoning_effort"]
        anthropic_effort = DEFAULT_CONFIG["anthropic_effort"]
    elif lower == "google":
        thinking_level = _env_or_prompt("TRADINGAGENTS_GOOGLE_THINKING_LEVEL", "google_thinking_level",
                                        "Gemini thinking mode", "Step 7: Thinking Mode",
                                        "Configure Gemini thinking mode", ask_gemini_thinking_config)
    elif lower in REASONING_EFFORT_PROVIDERS:
        reasoning_effort = _env_or_prompt("TRADINGAGENTS_OPENAI_REASONING_EFFORT", "openai_reasoning_effort",
                                          "Reasoning effort", "Step 7: Reasoning Effort",
                                          "Configure OpenAI reasoning effort level", ask_openai_reasoning_effort)
    elif lower == "anthropic":
        anthropic_effort = _env_or_prompt("TRADINGAGENTS_ANTHROPIC_EFFORT", "anthropic_effort",
                                          "Claude effort", "Step 7: Effort Level",
                                          "Configure Claude effort level", ask_anthropic_effort)

    return {
        "analysis_date": analysis_date, "analysts": analysts, "research_depth": research_depth,
        "llm_provider": lower, "backend_url": backend_url, "quick_think_llm": quick, "deep_think_llm": deep,
        "google_thinking_level": thinking_level, "openai_reasoning_effort": reasoning_effort,
        "anthropic_effort": anthropic_effort, "output_language": output_language,
    }


def build_market_config(selections: dict, checkpoint: bool | None) -> dict:
    """The run config, with the same env-precedence rules as the ticker run's."""
    config = DEFAULT_CONFIG.copy()
    for env_var, key in (("TRADINGAGENTS_MAX_DEBATE_ROUNDS", "max_debate_rounds"),
                         ("TRADINGAGENTS_MAX_RISK_ROUNDS", "max_risk_discuss_rounds")):
        if not os.environ.get(env_var):
            config[key] = selections["research_depth"]
    for key in ("llm_provider", "backend_url", "quick_think_llm", "deep_think_llm", "output_language"):
        config[key] = selections[key]
    for key in ("google_thinking_level", "openai_reasoning_effort", "anthropic_effort"):
        if selections.get(key) is not None:
            config[key] = selections[key]
    if checkpoint is not None:
        config["checkpoint_enabled"] = checkpoint
    return config


# ---------------------------------------------------------------------------
# Live view
# ---------------------------------------------------------------------------


class MarketView:
    """Agent statuses, messages and the latest report of one market run."""

    def __init__(self, analysts):
        self.teams = {"Analyst Team": [ANALYST_SPECS[k].agent_node for k in analysts], **FIXED_TEAMS}
        self.status = {agent: "pending" for agents in self.teams.values() for agent in agents}
        self.messages = deque(maxlen=100)
        self.tool_calls = deque(maxlen=100)
        self.current_report = None
        self.seen_ids = set()
        self.log_file = None

    def add_message(self, kind, content):
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.messages.append((stamp, kind, content))
        if self.log_file:
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(f"{stamp} [{kind}] {str(content).replace(chr(10), ' ')}\n")

    def add_tool_call(self, name, args):
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.tool_calls.append((stamp, name, args))
        if self.log_file:
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(f"{stamp} [Tool Call] {name}({', '.join(f'{k}={v}' for k, v in args.items())})\n")

    def set(self, agent, status):
        if agent in self.status and self.status[agent] != "completed":
            self.status[agent] = status

    def take_messages(self, messages):
        for message in messages:
            msg_id = getattr(message, "id", None)
            if msg_id is not None:
                if msg_id in self.seen_ids:
                    continue
                self.seen_ids.add(msg_id)
            kind, content = classify_message_type(message)
            if content and content.strip():
                self.add_message(kind, content)
            for call in getattr(message, "tool_calls", None) or []:
                if isinstance(call, dict):
                    self.add_tool_call(call["name"], call["args"])
                else:
                    self.add_tool_call(call.name, call.args)

    def take_state(self, chunk):
        """Advance the statuses from a streamed state or an analyst's filed report."""
        for spec in ANALYST_SPECS.values():
            if chunk.get(spec.report_key):
                self.set(spec.agent_node, "completed")
                self.current_report = f"### {spec.agent_node}\n{chunk[spec.report_key]}"
        debate = chunk.get("investment_debate_state") or {}
        for side, agent in (("bull_history", "Market Bull Researcher"), ("bear_history", "Market Bear Researcher")):
            if debate.get(side, "").strip():
                self.set(agent, "in_progress")
                self.current_report = f"### {agent}\n{debate[side].strip()}"
        if chunk.get("market_plan"):
            for agent in FIXED_TEAMS["Research Team"]:
                self.status[agent] = "completed"
            self.set("Sector Strategist", "in_progress")
            self.current_report = f"### Market Research Manager\n{chunk['market_plan']}"
        if chunk.get("sector_proposal"):
            self.status["Sector Strategist"] = "completed"
            self.current_report = f"### Sector Strategist\n{chunk['sector_proposal']}"
        risk = chunk.get("risk_debate_state") or {}
        for role in ("aggressive", "conservative", "neutral"):
            if risk.get(f"{role}_history", "").strip():
                agent = f"{role.capitalize()} Analyst"
                self.set(agent, "in_progress")
                self.current_report = f"### {agent}\n{risk[f'{role}_history'].strip()}"
        if chunk.get("final_market_decision"):
            for agent in FIXED_TEAMS["Risk Management"] + FIXED_TEAMS["Final Call"]:
                self.status[agent] = "completed"
            self.current_report = f"### Chief Market Strategist\n{chunk['final_market_decision']}"


def _status_cell(status):
    if status == "in_progress":
        return Spinner("dots", text="[blue]in_progress[/blue]", style="bold cyan")
    color = {"pending": "yellow", "completed": "green", "error": "red"}.get(status, "white")
    return f"[{color}]{status}[/{color}]"


def render(layout, view: MarketView, stats_handler, start_time):
    layout["header"].update(Panel(
        "[bold green]Welcome to TradingAgents CLI[/bold green]\n"
        "[dim]© [Tauric Research](https://github.com/TauricResearch)[/dim]",
        title="Welcome to TradingAgents", border_style="green", padding=(1, 2), expand=True))

    progress = Table(show_header=True, header_style="bold magenta", box=box.SIMPLE_HEAD,
                     padding=(0, 2), expand=True)
    for column in ("Team", "Agent", "Status"):
        progress.add_column(column, justify="center", width=20)
    for team, agents in view.teams.items():
        for i, agent in enumerate(agents):
            progress.add_row(team if i == 0 else "", agent, _status_cell(view.status[agent]))
        progress.add_row("─" * 20, "─" * 20, "─" * 20, style="dim")
    layout["progress"].update(Panel(progress, title="Progress", border_style="cyan", padding=(1, 2)))

    messages = Table(show_header=True, header_style="bold magenta", expand=True, box=box.MINIMAL,
                     show_lines=True, padding=(0, 1))
    messages.add_column("Time", style="cyan", width=8, justify="center")
    messages.add_column("Type", style="green", width=10, justify="center")
    messages.add_column("Content", style="white", no_wrap=False, ratio=1)
    rows = [(t, "Tool", f"{name}: {format_tool_args(args)}") for t, name, args in view.tool_calls]
    rows += [(t, kind, (str(c)[:197] + "...") if len(str(c)) > 200 else str(c)) for t, kind, c in view.messages]
    for t, kind, content in sorted(rows, key=lambda r: r[0], reverse=True)[:12]:
        messages.add_row(t, kind, Text(content, overflow="fold"))
    layout["messages"].update(Panel(messages, title="Messages & Tools", border_style="blue", padding=(1, 2)))

    report = Markdown(view.current_report) if view.current_report else "[italic]Waiting for analysis report...[/italic]"
    layout["analysis"].update(Panel(report, title="Current Report", border_style="green", padding=(1, 2)))

    done = sum(1 for s in view.status.values() if s == "completed")
    parts = [f"Agents: {done}/{len(view.status)}"]
    if stats_handler:
        stats = stats_handler.get_stats()
        parts += [f"LLM: {stats['llm_calls']}", f"Tools: {stats['tool_calls']}",
                  (f"Tokens: {format_tokens(stats['tokens_in'])}↑ {format_tokens(stats['tokens_out'])}↓"
                   if stats["tokens_in"] > 0 or stats["tokens_out"] > 0 else "Tokens: --")]
    elapsed = time.time() - start_time
    parts.append(f"⏱ {int(elapsed // 60):02d}:{int(elapsed % 60):02d}")
    footer = Table(show_header=False, box=None, padding=(0, 2), expand=True)
    footer.add_column("Stats", justify="center")
    footer.add_row(" | ".join(parts))
    layout["footer"].update(Panel(footer, border_style="grey50"))


def display_market_report(final_state):
    from tradingagents.market.reporting import report_parts

    console.print()
    console.print(Rule("Complete Market Analysis Report", style="bold green"))
    for heading, _folder, written in report_parts(final_state):
        console.print(Panel(f"[bold]{heading}[/bold]", border_style="cyan"))
        for agent, _file, text in written:
            console.print(Panel(Markdown(text), title=agent, border_style="blue", padding=(1, 2)))


def show_call(final_state):
    call = market_call(final_state)
    table = Table(title=f"Market regime: {call['regime']}", box=box.SIMPLE_HEAD)
    table.add_column("Sector")
    table.add_column("Outlook")
    colors = {"Bullish": "green", "Bearish": "red", "Neutral": "yellow"}
    for sector, rating in call["sector_ratings"].items():
        table.add_row(sector, f"[{colors.get(rating, 'magenta')}]{rating}[/]")
    console.print(table)
    if call["regime"] == RATING_REVIEW or RATING_REVIEW in call["sector_ratings"].values():
        console.print("[yellow]Some of the call could not be read from the final decision and is recorded "
                      "for review (REVIEW) rather than as a verdict. Re-run, or read the decision below.[/yellow]")


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def run_market_analysis(checkpoint: bool | None = None, flags=None):
    flags = flags or {}
    if not (sys.stdin and sys.stdin.isatty()):
        gaps = unattended_gaps(flags)
        if gaps:
            console.print("[red]No terminal to answer the setup questions. Set:[/red]")
            for gap in gaps:
                console.print(f"  {gap}")
            raise typer.Exit(code=1)

    selections = get_market_selections(flags)
    config = build_market_config(selections, checkpoint)
    stats_handler = StatsCallbackHandler()
    graph = MarketAnalysisGraph(selections["analysts"], config=config, debug=True, callbacks=[stats_handler])
    trade_date = selections["analysis_date"]

    run_dir = Path(config["results_dir"]) / SUBJECT / trade_date
    run_dir.mkdir(parents=True, exist_ok=True)
    view = MarketView(selections["analysts"])
    view.log_file = run_dir / "message_tool.log"
    view.log_file.touch(exist_ok=True)
    report_dir = run_dir / "reports"
    report_dir.mkdir(exist_ok=True)

    layout = create_layout()
    start_time = time.time()
    with Live(layout, refresh_per_second=4, screen=True):
        view.add_message("System", f"Analysis date: {trade_date}")
        view.add_message("System", f"Selected analysts: {', '.join(selections['analysts'])}")
        for agent in view.teams["Analyst Team"]:
            view.set(agent, "in_progress")
        render(layout, view, stats_handler, start_time)

        init_state = graph.create_run_state(trade_date)
        args = graph.propagator.get_graph_args(callbacks=[stats_handler])
        tid = graph.begin_checkpoint(SUBJECT, trade_date, ASSET_TYPE)
        if tid is not None:
            args.setdefault("config", {}).setdefault("configurable", {})["thread_id"] = tid
            view.add_message("System", ("Resuming the saved run" if graph._resuming else "Starting fresh")
                             + f" for {trade_date}")
        final_state = {}
        try:
            for messages, chunk in graph.stream_run(graph.checkpoint_input(init_state), **args):
                view.take_messages(messages)
                if chunk is not None:
                    view.take_state(chunk)
                    final_state.update(chunk)
                    for key in ("macro_report", "market_report", "news_report", "sentiment_report", "sector_report",
                                "market_plan", "sector_proposal", "final_market_decision"):
                        if chunk.get(key):
                            (report_dir / f"{key}.md").write_text(chunk[key], encoding="utf-8")
                render(layout, view, stats_handler, start_time)
            graph.record_decision(trade_date, final_state)
            graph.clear_checkpoint_on_success(SUBJECT, trade_date, ASSET_TYPE)
        finally:
            graph.end_checkpoint()
        for agent in view.status:
            view.status[agent] = "completed"
        view.add_message("System", f"Completed market analysis for {trade_date}")
        render(layout, view, stats_handler, start_time)

    console.print("\n[bold cyan]Market Analysis Complete![/bold cyan]\n")
    show_call(final_state)
    _offer_reports(final_state, graph, save=flags.get("save"), show=flags.get("show"), html=flags.get("html"))
    return final_state


def _offer_reports(final_state, graph, save=None, show=None, html=None):
    asked = save is None
    if asked:
        save = _yes("Save report?")
    if save:
        save_path = graph.default_report_path()
        if asked:
            save_path = Path(typer.prompt("Save path (press Enter for default)", default=str(save_path)).strip())
        if html is None:
            html = _yes("Also save it as an HTML page?") if asked else True
        try:
            report_file = graph.save_reports(final_state, save_path, html=html)
            console.print(f"\n[green]✓ Report saved to:[/green] {save_path.resolve()}")
            console.print(f"  [dim]Complete report:[/dim] {report_file.name}")
            if html and asked:
                _open_page((save_path / "complete_report.html").resolve())
        except Exception as e:
            console.print(f"[red]Error saving report: {e}[/red]")
    if show is None:
        show = _yes("\nDisplay full report on screen?")
    if show:
        display_market_report(final_state)


def market(
    date: str = typer.Option(None, "--date", help="Analysis date, YYYY-MM-DD (today or earlier); skips the prompt"),
    analysts: str = typer.Option(
        None, "--analysts", help=f"Comma-separated analysts from {', '.join(ANALYST_SPECS)}; skips the prompt"),
    save: bool | None = typer.Option(None, "--save/--no-save", help="Save the report under results_dir without asking"),
    show: bool | None = typer.Option(None, "--show/--no-show", help="Show the full report at the end without asking"),
    html: bool | None = typer.Option(None, "--html/--no-html", help="Also save the report as one HTML page"),
    checkpoint: bool | None = typer.Option(
        None, "--checkpoint/--no-checkpoint",
        help="Save state after each step so a crashed run can resume. Omit to honor "
             "TRADINGAGENTS_CHECKPOINT_ENABLED."),
):
    """Analyse the market: the regime and a Bullish/Neutral/Bearish verdict on each US sector."""
    flags = {"date": date, "analysts": analysts, "save": save, "show": show, "html": html}
    run_market_analysis(checkpoint=checkpoint, flags=flags)
