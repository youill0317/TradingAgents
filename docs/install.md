# Install

TradingAgents is one executable file. This fork publishes no releases: you build it from source, on the machine that runs it. Upstream builds it for Linux (x64 and arm64, glibc) and macOS (Intel and Apple silicon).

## From source

You need Git and Node.js 22 or later, with npm; `npm ci` installs everything else the build uses, Bun among it. This fork's code is on the `claude/dazzling-fermat-ik4q5y` branch (`main` mirrors upstream):

```bash
git clone --branch claude/dazzling-fermat-ik4q5y https://github.com/youill0317/TradingAgents.git
cd TradingAgents
npm ci
npm run compile
```

`npm run compile` builds the executable for this machine, `dist-bin/tradingagents`, which then runs without Node.js or the checkout. Put it on your `PATH`:

```bash
mkdir -p ~/.local/bin
cp dist-bin/tradingagents ~/.local/bin/tradingagents
```

If `~/.local/bin` is not on your `PATH` yet, add it in your shell's profile.

## Updates

To update, pull the branch and build again:

```bash
git pull
npm ci
npm run compile
cp dist-bin/tradingagents ~/.local/bin/tradingagents
```

A session in the terminal checks for a newer release of this fork at most once a day, in the background. The check is a plain request for the latest release: no identifier, and nothing about your questions. This fork has no release, so the check finds none and `tradingagents update` has nothing to install. `TRADINGAGENTS_NO_UPDATE_CHECK=1` turns the check off.

`/changelog` shows what is new in the version you run; the first session of a newer version shows it once.
