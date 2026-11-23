"""The ``tradingagents market`` command: a market-wide scan before any ticker.

Kept in its own module so the per-ticker CLI (``cli.run``, ``cli.selections``,
``cli.display``) stays as upstream ships it; this module only reuses their
building blocks.
"""

import datetime
import hashlib
import os
import time
from collections import deque
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo

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

import cli.run
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
    prompt_openai_compatible_url,
    resolve_backend_url,
    select_deep_thinking_agent,
    select_llm_provider,
    select_shallow_thinking_agent,
)
from cli.selections import _check_tier_providers
from cli.stats_handler import StatsCallbackHandler
from tradingagents.dataflows.market_scan import resolve_sectors
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.market_graph import MarketAnalysisGraph, validate_market_credentials
from tradingagents.graph.market_setup import MARKET_STAGES
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.llm_clients.factory import REASONING_EFFORT_PROVIDERS

MARKET_WORKFLOW_STEPS = "Macro → Sector → Debate → Draft → Risk Review → Final Outlook"

# Filenames must match write_market_report_tree's, so the live copy written
# during the run and the final one land on the same file rather than two.
SCAN_REPORT_FILES = {
    "macro_report": "macro.md",
    "sector_report": "sector.md",
    "market_bull_case": "bull_case.md",
    "market_bear_case": "bear_case.md",
    "market_bull_rebuttal": "bull_rebuttal.md",
    "market_bear_rebuttal": "bear_rebuttal.md",
    "market_draft_report": "market_draft.md",
    "market_risk_review": "risk_review.md",
    "market_scan_report": "strategist.md",
}


# ---------------------------------------------------------------------------
# Live view
# ---------------------------------------------------------------------------


class ScanMessageBuffer:
    """Messages and tool calls of a scan, each attributed to the stage that made it."""

    def __init__(self, max_length=100):
        self.messages = deque(maxlen=max_length)
        self.tool_calls = deque(maxlen=max_length)
        self.message_agents = deque(maxlen=max_length)
        self.tool_call_agents = deque(maxlen=max_length)
        self.current_report = None
        self._processed_message_ids = set()

    def add_message(self, message_type, content, agent=None):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.messages.append((timestamp, message_type, content))
        self.message_agents.append(agent)

    def add_tool_call(self, tool_name, args, agent=None):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.tool_calls.append((timestamp, tool_name, args))
        self.tool_call_agents.append(agent)


def accumulate_stream_messages(buffer, chunk, agent=None, excluded_contents=()):
    """Keep unseen streamed messages even when the graph later clears its state."""
    excluded = {str(content).strip() for content in excluded_contents if content}
    for message in chunk.get("messages", []):
        msg_id = getattr(message, "id", None)
        if msg_id is not None:
            if msg_id in buffer._processed_message_ids:
                continue
            buffer._processed_message_ids.add(msg_id)

        msg_type, content = classify_message_type(message)
        if content and content.strip() and content not in excluded:
            buffer.add_message(msg_type, content, agent=agent)

        if hasattr(message, "tool_calls") and message.tool_calls:
            for tool_call in message.tool_calls:
                if isinstance(tool_call, dict):
                    buffer.add_tool_call(tool_call["name"], tool_call["args"], agent=agent)
                else:
                    buffer.add_tool_call(tool_call.name, tool_call.args, agent=agent)


def log_buffer_to_file(buffer, log_file):
    """Append every message and tool call to ``log_file`` as it lands."""
    add_message, add_tool_call = buffer.add_message, buffer.add_tool_call

    @wraps(add_message)
    def logged_add_message(*args, **kwargs):
        add_message(*args, **kwargs)
        timestamp, message_type, content = buffer.messages[-1]
        line = str(content).replace("\n", " ")
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"{timestamp} [{message_type}] {line}\n")

    @wraps(add_tool_call)
    def logged_add_tool_call(*args, **kwargs):
        add_tool_call(*args, **kwargs)
        timestamp, tool_name, tool_args = buffer.tool_calls[-1]
        args_str = ", ".join(f"{k}={v}" for k, v in tool_args.items())
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"{timestamp} [Tool Call] {tool_name}({args_str})\n")

    buffer.add_message = logged_add_message
    buffer.add_tool_call = logged_add_tool_call


def _status_cell(status):
    if status == "in_progress":
        return Spinner("dots", text="[blue]in_progress[/blue]", style="bold cyan")
    color = {"pending": "yellow", "completed": "green", "error": "red"}.get(status, "white")
    return f"[{color}]{status}[/{color}]"


def create_progress_panel(teams, statuses):
    table = Table(
        show_header=True, header_style="bold magenta", show_footer=False,
        box=box.SIMPLE_HEAD, title=None, padding=(0, 2), expand=True,
    )
    table.add_column("Team", style="cyan", justify="center", width=20)
    table.add_column("Agent", style="green", justify="center", width=20)
    table.add_column("Status", style="yellow", justify="center", width=20)
    for team, agents in teams.items():
        for index, agent in enumerate(agents):
            table.add_row(team if index == 0 else "", agent, _status_cell(statuses.get(agent, "pending")))
        table.add_row("─" * 20, "─" * 20, "─" * 20, style="dim")
    return Panel(table, title="Progress", border_style="cyan", padding=(1, 2))


def create_messages_panel(buffer):
    table = Table(
        show_header=True, header_style="bold magenta", show_footer=False, expand=True,
        box=box.MINIMAL, show_lines=True, padding=(0, 1),
    )
    table.add_column("Time", style="cyan", width=8, justify="center")
    table.add_column("Agent", style="green", width=18, justify="center")
    table.add_column("Type", style="green", width=10, justify="center")
    table.add_column("Content", style="white", no_wrap=False, ratio=1)

    rows = []
    for index, (timestamp, tool_name, args) in enumerate(buffer.tool_calls):
        rows.append((timestamp, buffer.tool_call_agents[index], "Tool",
                     f"{tool_name}: {format_tool_args(args)}"))
    for index, (timestamp, msg_type, content) in enumerate(buffer.messages):
        text = str(content) if content else ""
        if len(text) > 200:
            text = text[:197] + "..."
        rows.append((timestamp, buffer.message_agents[index], msg_type, text))
    rows.sort(key=lambda item: item[0], reverse=True)
    for timestamp, agent, msg_type, content in rows[:12]:
        table.add_row(timestamp, agent or "", msg_type, Text(content, overflow="fold"))
    return Panel(table, title="Messages & Tools", border_style="blue", padding=(1, 2))


def create_stats_footer(stats_handler, start_time, completed, total):
    parts = [f"Agents: {completed}/{total}"]
    if stats_handler:
        stats = stats_handler.get_stats()
        parts.append(f"LLM: {stats['llm_calls']}")
        parts.append(f"Tools: {stats['tool_calls']}")
        if stats["tokens_in"] > 0 or stats["tokens_out"] > 0:
            parts.append(f"Tokens: {format_tokens(stats['tokens_in'])}↑ "
                         f"{format_tokens(stats['tokens_out'])}↓")
        else:
            parts.append("Tokens: --")
    parts.append(f"Reports: {completed}/{total}")
    if start_time:
        elapsed = time.time() - start_time
        parts.append(f"⏱ {int(elapsed // 60):02d}:{int(elapsed % 60):02d}")
    table = Table(show_header=False, box=None, padding=(0, 2), expand=True)
    table.add_column("Stats", justify="center")
    table.add_row(" | ".join(parts))
    return Panel(table, border_style="grey50")


def format_scan_wall_time(agent_times):
    """Per-stage wall time of a scan, in the order the stages finished."""
    if not agent_times:
        return "Scan wall time: pending"
    return "Scan wall time: " + " | ".join(
        f"{agent.removesuffix(' Analyst')} {seconds:.2f}s"
        for agent, seconds in agent_times.items()
    )


def display_report_sections(title, sections):
    """Print the sections that have content; skip the ones a run never produced."""
    console.print()
    console.print(Rule(title, style="bold green"))
    for heading, panel_title, content, color in sections:
        if not content:
            continue
        console.print(Panel(f"[bold]{heading}[/bold]", border_style=color))
        console.print(Panel(Markdown(content), title=panel_title, border_style="blue", padding=(1, 2)))


def _show_welcome():
    with open(Path(__file__).parent / "static" / "welcome.txt", encoding="utf-8") as f:
        welcome_ascii = f.read()
    content = (
        f"{welcome_ascii}\n"
        "[bold green]TradingAgents: Multi-Agents LLM Financial Trading Framework - CLI[/bold green]\n\n"
        "[bold]Market Scan Steps:[/bold]\n"
        f"{MARKET_WORKFLOW_STEPS}\n\n"
        "[dim]Built by [Tauric Research](https://github.com/TauricResearch)[/dim]"
    )
    console.print(Align.center(Panel(
        content, border_style="green", padding=(1, 2),
        title="Welcome to TradingAgents", subtitle="Multi-Agents LLM Financial Trading Framework",
    )))
    console.print()


# ---------------------------------------------------------------------------
# Selections
# ---------------------------------------------------------------------------


def _question_box(title, prompt):
    return Panel(f"[bold]{title}[/bold]\n[dim]{prompt}[/dim]", border_style="blue", padding=(1, 2))


def _env_or_prompt(env_var, config_key, label, title, body, prompt_fn):
    if os.environ.get(env_var):
        value = DEFAULT_CONFIG[config_key]
        console.print(f"[green]✓ {label} from environment:[/green] {value}")
        return value
    console.print(_question_box(title, body))
    return prompt_fn()


def get_market_selections() -> dict:
    """Ask for what a scan needs: the report language and the LLM stack.

    The same steps, environment overrides and checks as the ticker workflow's
    selections; the ticker, date, analyst and depth questions do not apply.
    """
    prefs = load_last_run()

    if os.environ.get("TRADINGAGENTS_OUTPUT_LANGUAGE"):
        output_language = DEFAULT_CONFIG["output_language"]
        console.print(f"[green]✓ Output language from environment:[/green] {output_language}")
    else:
        console.print(_question_box("Step 1: Output Language", "Select the language for the scan reports"))
        output_language = ask_output_language(prefs.get("output_language"))

    provider_from_env = bool(os.environ.get("TRADINGAGENTS_LLM_PROVIDER"))
    if provider_from_env:
        provider = DEFAULT_CONFIG["llm_provider"].lower()
        backend_url = resolve_backend_url(provider, env_url=DEFAULT_CONFIG["backend_url"])
        console.print(f"[green]✓ LLM provider from environment:[/green] {provider}")
        console.print(f"[green]✓ Backend URL:[/green] {backend_url}")
    else:
        console.print(_question_box("Step 2: LLM Provider", "Select your LLM provider"))
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
        quick = DEFAULT_CONFIG["quick_think_llm"]
        deep = DEFAULT_CONFIG["deep_think_llm"]
        console.print(f"[green]✓ Thinking agents from environment:[/green] quick={quick}, deep={deep}")
    else:
        console.print(_question_box("Step 3: Thinking Agents", "Select your thinking agents for the scan"))
        remembered = prefs if prefs.get("llm_provider") == provider else {}
        quick = select_shallow_thinking_agent(provider, remembered.get("quick_think_llm"))
        deep = select_deep_thinking_agent(provider, remembered.get("deep_think_llm"))

    thinking_level = reasoning_effort = anthropic_effort = None
    provider_lower = provider.lower()
    if provider_from_env:
        thinking_level = DEFAULT_CONFIG["google_thinking_level"]
        reasoning_effort = DEFAULT_CONFIG["openai_reasoning_effort"]
        anthropic_effort = DEFAULT_CONFIG["anthropic_effort"]
    elif provider_lower == "google":
        thinking_level = _env_or_prompt(
            "TRADINGAGENTS_GOOGLE_THINKING_LEVEL", "google_thinking_level", "Gemini thinking mode",
            "Step 4: Thinking Mode", "Configure Gemini thinking mode", ask_gemini_thinking_config)
    elif provider_lower in REASONING_EFFORT_PROVIDERS:
        reasoning_effort = _env_or_prompt(
            "TRADINGAGENTS_OPENAI_REASONING_EFFORT", "openai_reasoning_effort", "Reasoning effort",
            "Step 4: Reasoning Effort", "Configure OpenAI reasoning effort level", ask_openai_reasoning_effort)
    elif provider_lower == "anthropic":
        anthropic_effort = _env_or_prompt(
            "TRADINGAGENTS_ANTHROPIC_EFFORT", "anthropic_effort", "Claude effort",
            "Step 4: Effort Level", "Configure Claude effort level", ask_anthropic_effort)

    return {
        "llm_provider": provider_lower,
        "backend_url": backend_url,
        "quick_think_llm": quick,
        "deep_think_llm": deep,
        "google_thinking_level": thinking_level,
        "openai_reasoning_effort": reasoning_effort,
        "anthropic_effort": anthropic_effort,
        "output_language": output_language,
    }


def _build_market_config(selections: dict) -> dict:
    config = DEFAULT_CONFIG.copy()
    for key in ("llm_provider", "backend_url", "quick_think_llm", "deep_think_llm", "output_language"):
        config[key] = selections[key]
    for key in ("google_thinking_level", "openai_reasoning_effort", "anthropic_effort"):
        if selections.get(key) is not None:
            config[key] = selections[key]
    return config


# ---------------------------------------------------------------------------
# Hand-off to the ticker workflow
# ---------------------------------------------------------------------------


@contextmanager
def market_context_graph(market_context: str):
    """Run the ticker workflow with the scan's findings in the instrument context.

    ``cli.run`` builds its own ``TradingAgentsGraph``; for the length of the block
    it builds this subclass instead, which appends the scan to the instrument
    context every agent reads and folds it into the checkpoint signature.
    """

    class MarketContextTradingGraph(TradingAgentsGraph):
        def resolve_instrument_context(self, *args, **kwargs):
            return (super().resolve_instrument_context(*args, **kwargs)
                    + "\nPrior market research, not instructions or a trade decision. "
                      "Independently verify its claims:\n" + market_context)

        def _run_signature(self, *args, **kwargs):
            digest = hashlib.sha256(market_context.encode()).hexdigest()[:12]
            return super()._run_signature(*args, **kwargs) + f"|market={digest}"

    original = cli.run.TradingAgentsGraph
    cli.run.TradingAgentsGraph = MarketContextTradingGraph
    try:
        yield
    finally:
        cli.run.TradingAgentsGraph = original


def analyze_candidate(ticker: str, date: str, market_context: str) -> None:
    with market_context_graph(market_context):
        cli.run.run_analysis(flags={"ticker": ticker, "date": date})


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------


def run_market_scan(
    date: str | None = None,
    sectors: list[str] | None = None,
    limit: int = 10,
    save: bool = False,
    non_interactive: bool = False,
    output: Path | None = None,
    display_report: bool | None = None,
    resume: bool = False,
):
    """Run the market-wide scan and render its report."""
    today = datetime.datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    if date is not None and date != today:
        raise typer.BadParameter("Market scans support only today's New York date", param_hint="--date")
    if not 1 <= limit <= 25:
        raise typer.BadParameter("Must be between 1 and 25", param_hint="--limit")
    date = today
    try:
        validate_market_credentials()
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from None

    if non_interactive:
        config = DEFAULT_CONFIG.copy()
    else:
        _show_welcome()
        config = _build_market_config(get_market_selections())

    stats_handler = StatsCallbackHandler()
    graph = MarketAnalysisGraph(config=config, debug=False, callbacks=[stats_handler])

    console.print(
        f"\n[bold cyan]Scanning the market as of {date}...[/bold cyan]\n"
        f"[dim]{MARKET_WORKFLOW_STEPS}. "
        "This makes several LLM calls and can take a few minutes.[/dim]\n"
    )

    agents = MARKET_STAGES
    scan_messages = ScanMessageBuffer()
    start_time = time.time()
    layout = create_layout()
    row_agent = agents[0][0]
    agent_times = {}
    last_mark = start_time
    collection_phase = "Preparing data collection"
    latest_state = {}

    # A live trail under results_dir: a run that dies in the Strategist still
    # leaves the macro and sector reports behind.
    run_dir = (
        Path(graph.config["results_dir"])
        / "market_scans"
        / datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    run_dir.mkdir(parents=True, exist_ok=True)
    log_file = run_dir / "message_tool.log"
    log_file.touch(exist_ok=True)
    log_buffer_to_file(scan_messages, log_file)

    scan_messages.add_message("System", f"Scan date: {date}")
    scan_messages.add_message(
        "System", f"Sectors: {', '.join(sectors)}" if sectors else "Sectors: analyst's choice",
    )
    scan_messages.add_message("System", f"Candidate limit: {limit}")

    def active_agent(state):
        if state.get("market_scan_report"):
            return None
        return next((agent for agent, key in agents if not state.get(key)), None)

    teams = {
        "Analyst Team": [agent for agent, _ in agents[:2]],
        "Research Team": [agent for agent, _ in agents[2:6]],
        "Strategy Draft": [agents[6][0]],
        "Risk Management": [agents[7][0]],
        "Market Strategy": [agents[8][0]],
    }
    # Three 20-character columns, and all team rows at 120x40.
    layout["progress"].minimum_size = 82
    layout["upper"].minimum_size = len(agents) + len(teams) + 8

    def update_scan_display(state, finished=False):
        layout["header"].update(Panel(
            "[bold green]Welcome to TradingAgents CLI[/bold green]\n"
            "[dim]© [Tauric Research](https://github.com/TauricResearch)[/dim]",
            title="Welcome to TradingAgents", border_style="green", padding=(1, 2), expand=True,
        ))
        current_agent = None if finished or collection_phase != "Analysis" else active_agent(state)
        statuses = {
            agent: ("completed" if state.get(key) else "in_progress" if agent == current_agent
                    else "not run" if finished else "pending")
            for agent, key in agents
        }
        layout["progress"].update(create_progress_panel(teams, statuses))
        layout["messages"].update(create_messages_panel(scan_messages))
        report = Markdown(scan_messages.current_report) if scan_messages.current_report else Text(collection_phase)
        layout["analysis"].update(Panel(report, title="Current Report", border_style="green", padding=(1, 2)))
        completed = sum(1 for _, key in agents if state.get(key))
        layout["footer"].update(create_stats_footer(stats_handler, start_time, completed, len(agents)))

    update_scan_display({})
    with Live(layout, console=console, refresh_per_second=4, screen=True):
        def on_progress(phase):
            nonlocal collection_phase, last_mark
            collection_phase = phase
            scan_messages.add_message("System", phase)
            if phase == "Analysis":
                last_mark = time.time()
            update_scan_display(latest_state)

        def on_chunk(chunk):
            nonlocal row_agent, last_mark, latest_state
            latest_state = chunk
            for agent, key in agents:
                if chunk.get(key) and agent not in agent_times:
                    now = time.time()
                    agent_times[agent] = now - last_mark if collection_phase == "Analysis" else 0
                    last_mark = now
                    (run_dir / SCAN_REPORT_FILES[key]).write_text(chunk[key], encoding="utf-8")
            reports = [(agent, chunk[key]) for agent, key in agents if chunk.get(key)]
            if reports:
                agent, content = reports[-1]
                scan_messages.current_report = f"### {agent}\n{content}"
            accumulate_stream_messages(
                scan_messages, chunk, agent=row_agent,
                excluded_contents=[content for _, content in reports],
            )
            row_agent = active_agent(chunk) or row_agent
            update_scan_display(chunk)

        try:
            final_state = graph.scan(
                trade_date=date, sectors=sectors, candidate_limit=limit,
                on_chunk=on_chunk, on_progress=on_progress, resume=resume,
            )
        except (Exception, KeyboardInterrupt):
            console.print("[yellow]Scan stopped. Once analysis has started, retry with tradingagents market "
                          "--resume and the same date/settings. Collection failures require a fresh run.[/yellow]")
            raise
        wall_time_summary = format_scan_wall_time(agent_times)
        scan_messages.add_message("System", f"Completed market scan for {date}")
        scan_messages.add_message("System", wall_time_summary)
        update_scan_display(final_state, finished=True)

    console.print(f"\n[bold cyan]Market Scan: {final_state.get('scan_status', 'INCOMPLETE')}[/bold cyan]\n")
    console.print(f"[dim]{wall_time_summary}[/dim]")
    console.print(f"[dim]Run log:[/dim] {run_dir.resolve()}")
    # Always persist collection/validation evidence, even when the user declines
    # an additional export or the final shortlist is incomplete.
    graph.save_reports(final_state, save_path=run_dir)

    display_report_sections(
        "Final Market Scan Report",
        (("III. Market Strategist", "Market Strategist", final_state.get("market_scan_report"), "green"),),
    )

    should_save = save or non_interactive or output is not None
    if not should_save:
        should_save = typer.prompt("Save report?", default="Y").strip().upper() in ("Y", "YES", "")
    if should_save:
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        default_path = Path.cwd() / "reports" / f"market_scan_{stamp}"
        save_path = output or Path(
            str(default_path)
            if save or non_interactive
            else typer.prompt("Save path (press Enter for default)", default=str(default_path)).strip()
        )
        try:
            report_file = graph.save_reports(final_state, save_path=save_path)
            console.print(f"\n[green]✓ Report saved to:[/green] {save_path.resolve()}")
            console.print(f"  [dim]Complete report:[/dim] {report_file.name}")
        except Exception as e:
            console.print(f"[red]Error saving report: {e}[/red]")
            raise typer.Exit(code=1) from None

    if display_report is None:
        display_full = False if non_interactive else typer.prompt(
            "\nDisplay full report on screen?", default="Y"
        ).strip().upper() in ("Y", "YES", "")
    else:
        display_full = display_report
    if display_full:
        display_report_sections(
            "Complete Market Scan Report",
            (
                ("I. Macro Analyst", "Macro Analyst", final_state.get("macro_report"), "cyan"),
                ("II. Sector Analyst", "Sector Analyst", final_state.get("sector_report"), "magenta"),
                *[(title, title, final_state.get(key), "yellow") for title, key in agents[2:-1]],
                ("Final Market Strategist", "Market Strategist", final_state.get("market_scan_report"), "green"),
            ),
        )

    console.print(Panel(
        "A shortlist is a starting point, not a decision. Run "
        "[bold]tradingagents --ticker <TICKER>[/bold] on a name to analyse it in depth.",
        border_style="yellow", title="Next step",
    ))
    if not non_interactive:
        candidates = final_state.get("market_scan_result", {}).get("candidates", [])
        if candidates and final_state.get("scan_status") != "INCOMPLETE":
            choices = {c["ticker"]: c for c in candidates}
            while True:
                ticker = typer.prompt(
                    "Analyze a candidate now? Enter ticker or press Enter to finish", default=""
                ).strip().upper()
                if not ticker:
                    break
                if ticker not in choices:
                    console.print(f"[yellow]Choose from: {', '.join(choices)}[/yellow]")
                    continue
                candidate = choices[ticker]
                context = (f"Market scan {final_state.get('run_id')} as of {final_state.get('as_of_utc')}.\n"
                           f"Selected candidate: {ticker}; {candidate['thesis']}\n\n"
                           + final_state.get("market_scan_report", ""))
                analyze_candidate(ticker, date, context)
                break
    return final_state


def market(
    resume: bool = typer.Option(
        False, "--resume",
        help="Resume an interrupted scan from today with the same code/settings and original data snapshot.",
    ),
    date: str = typer.Option(
        None, "--date", help="Compatibility option: only today's New York date is accepted."
    ),
    sectors: str = typer.Option(
        None, "--sectors",
        help="Comma-separated sectors to screen (e.g. 'Technology,Energy'). "
        "Omit to let the Sector Analyst choose.",
    ),
    limit: int = typer.Option(10, "--limit", help="Maximum number of shortlist candidates."),
    save: bool = typer.Option(
        False, "--save",
        help="Save the report without asking (skips the save prompt). Reports "
        "are written under results_dir as the scan runs either way.",
    ),
    non_interactive: bool = typer.Option(
        False, "--non-interactive", help="Use configured provider/model values and do not prompt."
    ),
    output: Path | None = typer.Option(  # noqa: B008 - Typer declaration
        None, "--output", help="Directory for the report tree; implies --save."
    ),
    display_report: bool = typer.Option(
        False, "--display-report", help="Display all report sections after completion."
    ),
):
    """Scan the market: global regime, US sector rotation, and research candidates."""
    sector_list = [s.strip() for s in sectors.split(",") if s.strip()] if sectors else None
    if sector_list:
        # Reject a typo here rather than letting the Sector Analyst find out, and
        # canonicalise case so "technology" reaches the prompt as "Technology".
        try:
            sector_list = resolve_sectors(sector_list)
        except ValueError as e:
            raise typer.BadParameter(str(e), param_hint="--sectors") from None

    result = run_market_scan(
        date=date,
        sectors=sector_list,
        limit=limit,
        save=save,
        non_interactive=non_interactive,
        output=output,
        display_report=display_report if non_interactive else None,
        resume=resume,
    )
    if isinstance(result, dict) and result.get("scan_status") == "INCOMPLETE":
        raise typer.Exit(code=1)
